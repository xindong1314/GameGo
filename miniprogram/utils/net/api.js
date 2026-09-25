'use strict';

/**
 * REST 请求（设计文档第 4 节、8.2）。
 *
 *   request({ method = 'GET', path, data, auth = true, timeout = 10000 }) → Promise<响应体>
 *       path 写完整路径，如 '/api/me'（省略 '/api' 前缀也可以：'/me' 会补成 '/api/me'）；
 *       GET 的 data 拼成查询串（跳过 null / undefined），其他方法作为 JSON 请求体；
 *       自动登录并带 Authorization: Bearer <token>；401 时清令牌 → 重新登录 → 重试一次；
 *       失败 reject { code, msg, status }：服务端错误用其 error.code / error.msg，
 *       网络失败 code='network'、超时 code='timeout'（status 均为 0），响应不是 JSON 为 'bad_response'。
 *   request('/api/me') 等价于 request({ path: '/api/me' })。
 *   get(path, query) / post(path, data) / put(path, data)   便捷写法
 *   uploadAvatar(tempFilePath) → Promise<{ user }>   wx.uploadFile 字段名 'file'；成功后自动 auth.setUser(user)
 *
 * 测试：createApi({ wx, config, auth }) 创建独立实例。
 */

const appConfig = require('../../config');
const defaultAuth = require('./auth');
const { lazy, netError, joinUrl, wxRequest, wxUpload, unwrap, DEFAULT_TIMEOUT_MS } = require('./http');

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
const UPLOAD_TIMEOUT_MS = 30000;

// '/me' → '/api/me'；'/api/...'、'/avatars/...'、'/healthz' 原样
function apiPath(path) {
  if (/^\/(api|avatars)(\/|$|\?)/.test(path) || /^\/healthz(\?|$)/.test(path)) return path;
  return `/api${path}`;
}

function createApi({ wx, config, auth, logger = console } = {}) {
  const getWx = lazy(wx);
  const getConfig = lazy(config);
  if (!auth) throw new TypeError('createApi 需要 auth');

  async function currentToken() {
    await auth.ensureLogin();
    const token = auth.getToken();
    if (!token) throw netError('unauthorized', '登录失败，请重试', 401);
    return token;
  }

  // 带令牌执行 send(token)；401 时换新令牌重试一次
  async function withAuth(send) {
    let token = await currentToken();
    let res = await send(token);
    if (res.status === 401) {
      logger.info('[api] 令牌失效，重新登录后重试');
      auth.invalidate(token);
      token = await currentToken();
      res = await send(token);
    }
    return res;
  }

  function request(arg, extra) {
    const opts = typeof arg === 'string' ? Object.assign({}, extra, { path: arg }) : arg;
    if (!opts || typeof opts !== 'object') {
      return Promise.reject(netError('bad_request', 'request 参数必须是对象', 0));
    }
    const method = String(opts.method || 'GET').toUpperCase();
    const { path, data, timeout = DEFAULT_TIMEOUT_MS } = opts;
    const needAuth = opts.auth !== false;
    if (!METHODS.includes(method)) {
      return Promise.reject(netError('bad_request', `不支持的请求方法 ${opts.method}`, 0));
    }
    if (typeof path !== 'string' || path[0] !== '/') {
      return Promise.reject(netError('bad_request', `请求路径必须以 / 开头：${path}`, 0));
    }
    if (method === 'GET' && data != null && (typeof data !== 'object' || Array.isArray(data))) {
      return Promise.reject(netError('bad_request', 'GET 的 data 必须是对象', 0));
    }

    const isGet = method === 'GET' || method === 'DELETE';
    const url = joinUrl(getConfig().API_BASE, apiPath(path), isGet ? data : null);
    const body = isGet ? undefined : data === undefined ? {} : data;
    const send = (token) => wxRequest(getWx(), {
      url,
      method,
      data: body,
      header: token ? { Authorization: `Bearer ${token}` } : {},
      timeout,
    });

    return (needAuth ? withAuth(send) : send(null)).then(unwrap);
  }

  function get(path, query, options) {
    return request(Object.assign({}, options, { method: 'GET', path, data: query }));
  }

  function post(path, data, options) {
    return request(Object.assign({}, options, { method: 'POST', path, data }));
  }

  function put(path, data, options) {
    return request(Object.assign({}, options, { method: 'PUT', path, data }));
  }

  async function uploadAvatar(tempFilePath) {
    if (typeof tempFilePath !== 'string' || !tempFilePath) {
      throw netError('bad_request', '没有选择头像图片', 0);
    }
    const url = joinUrl(getConfig().API_BASE, '/api/me/avatar');
    const res = await withAuth((token) => wxUpload(getWx(), {
      url,
      filePath: tempFilePath,
      name: 'file',
      header: { Authorization: `Bearer ${token}` },
      timeout: UPLOAD_TIMEOUT_MS,
    }));
    const body = unwrap(res);
    const user = body && typeof body === 'object' ? body.user : null;
    if (!user || typeof user !== 'object' || user.id === undefined || user.id === null) {
      throw netError('bad_response', '头像上传响应格式错误', res.status);
    }
    try {
      auth.setUser(user);
    } catch (err) {
      // 上传本身已成功，缓存更新失败只记日志，页面仍拿到新的 user
      logger.error('[api] 头像上传成功，但更新本地用户缓存失败', err);
    }
    return body;
  }

  return { request, get, post, put, uploadAvatar };
}

const defaultApi = createApi({
  wx: () => wx, // eslint-disable-line no-undef
  config: appConfig,
  auth: defaultAuth,
});

module.exports = defaultApi;
module.exports.createApi = createApi;
module.exports.apiPath = apiPath;
