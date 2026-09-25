'use strict';

// wx.request / wx.uploadFile 的 Promise 封装与统一错误对象 { code, msg, status }。
// 这里不处理鉴权（auth.js 登录时也要用），带令牌与 401 重试在 api.js 里。
//
// 服务端错误格式（设计文档第 4 节）：HTTP 4xx/5xx + { error: { code, msg } }。

const DEFAULT_TIMEOUT_MS = 10000;

function netError(code, msg, status = 0, detail) {
  const err = { code, msg, status };
  if (detail) err.detail = detail;
  return err;
}

// 允许传入 wx 对象，或返回 wx 的函数（默认单例用函数，运行时才取全局 wx）
function lazy(value) {
  return typeof value === 'function' ? value : () => value;
}

function trimSlash(base) {
  return String(base || '').replace(/\/+$/, '');
}

// { a: 1, b: undefined } → '?a=1'；null / undefined 的值跳过
function toQuery(params) {
  if (!params || typeof params !== 'object') return '';
  const parts = [];
  for (const key of Object.keys(params)) {
    const v = params[key];
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join('&');
}

function joinUrl(base, path, query) {
  const q = toQuery(query);
  const url = trimSlash(base) + path;
  if (!q) return url;
  return url + (url.includes('?') ? '&' : '?') + q;
}

// 解析响应体：wx.request 已按 JSON 解析过的对象原样返回；字符串再尝试 JSON.parse
function parseBody(data) {
  if (typeof data !== 'string') return { ok: true, value: data === undefined ? null : data };
  if (data === '') return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(data) };
  } catch (err) {
    return { ok: false, value: data };
  }
}

function defaultMsg(status) {
  if (status === 401) return '登录已失效，请重试';
  if (status === 403) return '没有权限';
  if (status === 404) return '内容不存在';
  if (status === 413) return '内容过大';
  if (status === 429) return '操作太频繁，请稍后再试';
  if (status >= 500) return '服务器繁忙，请稍后再试';
  return `请求失败（${status}）`;
}

// HTTP 状态码 + 响应体 → 统一错误对象
function errorFromResponse(status, body) {
  const e = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : null;
  const code = e && typeof e.code === 'string' && e.code
    ? e.code
    : status === 401 ? 'unauthorized' : `http_${status}`;
  const msg = e && typeof e.msg === 'string' && e.msg ? e.msg : defaultMsg(status);
  return netError(code, msg, status);
}

// wx 回调 fail 的 errMsg → 统一错误对象
function errorFromWxFail(err) {
  const errMsg = (err && (err.errMsg || err.message)) || String(err || '');
  if (/timeout|超时/i.test(errMsg)) return netError('timeout', '请求超时，请检查网络', 0, errMsg);
  return netError('network', '网络连接失败，请检查网络', 0, errMsg);
}

// 把 { status, body, parsed } 变成最终结果：2xx 返回响应体，否则 reject 统一错误
function unwrap(res) {
  if (res.status >= 200 && res.status < 300) {
    if (!res.parsed) throw netError('bad_response', '服务器响应格式错误', res.status);
    return res.body;
  }
  throw errorFromResponse(res.status, res.parsed ? res.body : null);
}

// 发一个 JSON 请求。resolve { status, body, parsed }（任何 HTTP 状态都 resolve），网络失败 reject。
function wxRequest(wx, { url, method = 'GET', data, header, timeout = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const opts = {
      url,
      method,
      header: Object.assign({ 'content-type': 'application/json' }, header),
      timeout,
      dataType: 'json',
      responseType: 'text',
      success: (res) => {
        const parsed = parseBody(res.data);
        resolve({ status: Number(res.statusCode) || 0, body: parsed.value, parsed: parsed.ok });
      },
      fail: (err) => reject(errorFromWxFail(err)),
    };
    if (data !== undefined) opts.data = data;
    try {
      wx.request(opts);
    } catch (err) {
      reject(errorFromWxFail(err));
    }
  });
}

// 上传文件。wx.uploadFile 的 res.data 是字符串，这里统一 JSON.parse。
function wxUpload(wx, { url, filePath, name = 'file', header, formData, timeout = 30000 }) {
  return new Promise((resolve, reject) => {
    const opts = {
      url,
      filePath,
      name,
      header: Object.assign({}, header),
      timeout,
      success: (res) => {
        const parsed = parseBody(res.data);
        resolve({ status: Number(res.statusCode) || 0, body: parsed.value, parsed: parsed.ok });
      },
      fail: (err) => reject(errorFromWxFail(err)),
    };
    if (formData) opts.formData = formData;
    try {
      wx.uploadFile(opts);
    } catch (err) {
      reject(errorFromWxFail(err));
    }
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  netError,
  lazy,
  toQuery,
  joinUrl,
  parseBody,
  errorFromResponse,
  errorFromWxFail,
  unwrap,
  wxRequest,
  wxUpload,
};
