'use strict';

// 微信小程序登录：用 wx.login 得到的 code 换取 openid。
// 文档：https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/user-login/code2Session.html

const JSCODE2SESSION_URL = 'https://api.weixin.qq.com/sns/jscode2session';
const DEFAULT_TIMEOUT_MS = 8000;

// 常见错误码的中文说明（msg 会返回给客户端，不含任何密钥）
const ERRCODE_MSG = {
  '-1': '微信系统繁忙，请稍后再试',
  40029: '登录凭证无效或已过期，请重新登录',
  40163: '登录凭证已被使用，请重新登录',
  45011: '登录过于频繁，请稍后再试',
  40226: '该微信账号存在风险，登录被拦截',
  40013: '服务器配置的 AppID 无效',
  40125: '服务器配置的 AppSecret 无效',
};

class WxLoginError extends Error {
  constructor(msg, { errcode = null, cause } = {}) {
    super(msg, cause ? { cause } : undefined);
    this.name = 'WxLoginError';
    this.code = 'wx_login_failed';
    this.errcode = errcode;
  }
}

// → Promise<{ openid, sessionKey, unionid }>；失败 reject WxLoginError
async function code2Session(appId, secret, code, { fetch = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!appId || !secret) throw new WxLoginError('服务器未配置微信 AppID/AppSecret');
  if (typeof code !== 'string' || !code) throw new WxLoginError('缺少登录凭证 code');
  if (typeof fetch !== 'function') throw new WxLoginError('当前运行环境没有 fetch');

  const url =
    `${JSCODE2SESSION_URL}?appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(secret)}` +
    `&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;

  const controller = new AbortController();
  let timer;
  // 同时用 AbortSignal 与竞速超时：即使注入的 fetch 不理会 signal 也能按时返回
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new WxLoginError('连接微信服务器超时'));
    }, timeoutMs);
  });

  let text;
  try {
    const res = await Promise.race([fetch(url, { method: 'GET', signal: controller.signal }), timeout]);
    if (!res || !res.ok) {
      throw new WxLoginError(`微信服务器返回 HTTP ${res ? res.status : '空响应'}`);
    }
    text = await Promise.race([res.text(), timeout]);
  } catch (err) {
    if (err instanceof WxLoginError) throw err;
    throw new WxLoginError('无法连接微信服务器', { cause: err });
  } finally {
    clearTimeout(timer);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new WxLoginError('微信服务器返回了无法解析的数据', { cause: err });
  }
  if (!data || typeof data !== 'object') throw new WxLoginError('微信服务器返回了无法解析的数据');

  const errcode = data.errcode === undefined || data.errcode === null ? 0 : Number(data.errcode);
  if (errcode !== 0) {
    const known = ERRCODE_MSG[errcode];
    const detail = typeof data.errmsg === 'string' ? data.errmsg.slice(0, 200) : '';
    throw new WxLoginError(known || `微信登录失败（${errcode}${detail ? '：' + detail : ''}）`, { errcode });
  }
  if (typeof data.openid !== 'string' || !data.openid || data.openid.length > 128) {
    throw new WxLoginError('微信服务器没有返回 openid');
  }
  return {
    openid: data.openid,
    sessionKey: typeof data.session_key === 'string' ? data.session_key : '',
    unionid: typeof data.unionid === 'string' ? data.unionid : '',
  };
}

module.exports = { code2Session, WxLoginError, JSCODE2SESSION_URL };
