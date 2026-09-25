'use strict';
const { code2Session: defaultCode2Session } = require('./wechat');
const { publicUser } = require('../util/public-user');
const { HttpError, badRequest, unauthorized, notFound } = require('../http/errors');

// 登录与鉴权（设计文档第 4 节）：
//   login(code)        微信登录：code → openid → 查找或创建用户 → 发令牌
//   devLogin(deviceId) 开发登录：仅 DEV_LOGIN=1；openid 为 'dev:<deviceId>'
//   authenticate(authorizationHeader) → User（失败抛 401）

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
// wx.login 的 code 是可见 ASCII 字符串（通常 32 位左右），这里只做宽松的格式校验
const WX_CODE_RE = /^[\x21-\x7e]{1,256}$/;
const BEARER_RE = /^Bearer[ \t]+([^\s]+)[ \t]*$/i;

function createAuth({ config, repos, now = Date.now, logger, code2Session = defaultCode2Session, fetch } = {}) {
  if (!config || !repos) throw new TypeError('createAuth: 需要 config 与 repos');

  function wxConfigured() {
    return Boolean(config.wx && config.wx.appId && config.wx.secret);
  }

  // 查找或创建用户、记录登录时间、发令牌。全部同步执行，中间没有 await，不存在并发重复创建。
  function issue(openid) {
    const t = now();
    const { user, token } = repos.transaction(() => {
      let u = repos.users.findByOpenid(openid);
      if (!u) {
        u = repos.users.create({ openid }, t);
      } else {
        repos.users.touchLogin(u.id, t);
        u = repos.users.findById(u.id);
      }
      return { user: u, token: repos.sessions.create(u.id, t) };
    });
    return { token, user: publicUser(user, config.publicBaseUrl), needProfile: !user.nickname };
  }

  async function login(code) {
    if (!wxConfigured()) throw new HttpError(503, 'wx_not_configured', '服务器未配置微信登录');
    if (typeof code !== 'string' || !WX_CODE_RE.test(code)) throw badRequest('缺少或无效的登录凭证 code');
    let session;
    try {
      session = await code2Session(config.wx.appId, config.wx.secret, code, fetch ? { fetch } : {});
    } catch (err) {
      if (logger) logger.warn('微信登录失败：%s%s', err.message, err.errcode ? `（errcode ${err.errcode}）` : '');
      throw new HttpError(502, 'wx_login_failed', err.code === 'wx_login_failed' ? err.message : '微信登录失败', {
        cause: err,
      });
    }
    return issue(session.openid);
  }

  function devLogin(deviceId) {
    // 未开启时假装接口不存在
    if (!config.devLogin) throw notFound('接口不存在');
    if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) {
      throw badRequest('deviceId 须为 8~64 位字母、数字、下划线或连字符');
    }
    return issue(`dev:${deviceId}`);
  }

  // 解析 Authorization 头，返回 { user, token }
  function authenticate(header) {
    if (typeof header !== 'string' || !header) throw unauthorized('请先登录');
    const m = BEARER_RE.exec(header);
    if (!m) throw unauthorized('登录凭证格式不正确');
    const token = m[1];
    const userId = repos.sessions.resolve(token, now());
    if (!userId) throw unauthorized('登录已失效，请重新登录');
    const user = repos.users.findById(userId);
    if (!user) throw unauthorized('用户不存在，请重新登录');
    return { user, token };
  }

  return { login, devLogin, authenticate, wxConfigured };
}

module.exports = { createAuth, DEVICE_ID_RE };
