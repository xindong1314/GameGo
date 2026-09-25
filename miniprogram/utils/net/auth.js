'use strict';

/**
 * 登录与会话（设计文档 8.2、第 4 节）。
 *
 *   ensureLogin() → Promise<User>   有令牌直接返回；否则 wx.login → POST /api/auth/login；
 *                                   收到 503 wx_not_configured（或 wx.login 本身失败）且 config.DEV_LOGIN
 *                                   → 用本机 deviceId 调 POST /api/auth/dev-login。并发调用只登录一次。
 *   getToken() → string             没有时为 ''
 *   getUser() → User|null           User = { id, nickname, avatarUrl }
 *   setUser(user)                   资料修改后更新本地缓存（需已登录）
 *   needProfile() → bool            还没有昵称
 *   clear()                         清除令牌与用户（deviceId 保留，开发账号不变）
 *   invalidate(token) → bool        仅当当前令牌就是 token 时清除（401 重试用，避免清掉别人刚换的新令牌）
 *   getDeviceId() → string
 *
 * 失败时 reject { code, msg, status }。
 *
 * 用法：const auth = require('../../utils/net/auth');  或  const { ensureLogin } = require(...)
 * 测试：createAuth({ wx, config, logger }) 创建独立实例。
 */

const appConfig = require('../../config');
const { lazy, netError, joinUrl, wxRequest, unwrap, errorFromWxFail } = require('./http');

const SESSION_KEY = 'gg.session'; // { token, user }
const DEVICE_KEY = 'gg.deviceId';
const DEVICE_ID_RE = /^[a-z0-9]{16,64}$/;
const LOGIN_TIMEOUT_MS = 10000;

function isValidUser(user) {
  return !!user && typeof user === 'object' && !Array.isArray(user)
    && (typeof user.id === 'number' || (typeof user.id === 'string' && user.id !== ''));
}

function isValidSession(s) {
  return !!s && typeof s === 'object' && typeof s.token === 'string' && s.token !== '' && isValidUser(s.user);
}

// 24 位小写字母数字。开发登录只需要"本机稳定、不同机器不同"，不需要密码学强度。
function generateDeviceId() {
  let id = Date.now().toString(36);
  while (id.length < 24) id += Math.floor(Math.random() * 36).toString(36);
  return id.slice(0, 24);
}

function createAuth({ wx, config, logger = console } = {}) {
  const getWx = lazy(wx);
  const getConfig = lazy(config);

  let session; // undefined：尚未读取本地存储；null：未登录
  let deviceId = '';
  let pending = null;

  function load() {
    if (session !== undefined) return session;
    session = null;
    try {
      const saved = getWx().getStorageSync(SESSION_KEY);
      if (isValidSession(saved)) session = { token: saved.token, user: saved.user };
      else if (saved) logger.warn('[auth] 本地登录信息格式不对，已忽略');
    } catch (err) {
      logger.warn('[auth] 读取本地登录信息失败', err);
    }
    return session;
  }

  function save(next) {
    session = next;
    try {
      if (next) getWx().setStorageSync(SESSION_KEY, { token: next.token, user: next.user });
      else getWx().removeStorageSync(SESSION_KEY);
    } catch (err) {
      // 存储失败不影响本次运行（内存里还有），只是下次启动要重新登录
      logger.error('[auth] 保存登录信息失败', err);
    }
  }

  function getDeviceId() {
    if (deviceId) return deviceId;
    let saved = '';
    try {
      saved = getWx().getStorageSync(DEVICE_KEY);
    } catch (err) {
      logger.warn('[auth] 读取 deviceId 失败', err);
    }
    if (typeof saved === 'string' && DEVICE_ID_RE.test(saved)) {
      deviceId = saved;
      return deviceId;
    }
    deviceId = generateDeviceId();
    try {
      getWx().setStorageSync(DEVICE_KEY, deviceId);
    } catch (err) {
      logger.error('[auth] 保存 deviceId 失败（本次运行仍使用同一个）', err);
    }
    return deviceId;
  }

  function wxLogin() {
    return new Promise((resolve, reject) => {
      try {
        getWx().login({
          timeout: LOGIN_TIMEOUT_MS,
          success: (res) => {
            if (res && typeof res.code === 'string' && res.code) resolve(res.code);
            else reject(netError('wx_login_failed', '微信登录失败：没有拿到 code', 0));
          },
          fail: (err) => {
            const e = errorFromWxFail(err);
            reject(netError('wx_login_failed', '微信登录失败', 0, e.detail));
          },
        });
      } catch (err) {
        reject(netError('wx_login_failed', '微信登录失败', 0, String(err && err.message)));
      }
    });
  }

  async function post(path, data) {
    const res = await wxRequest(getWx(), {
      url: joinUrl(getConfig().API_BASE, path),
      method: 'POST',
      data,
      timeout: LOGIN_TIMEOUT_MS,
    });
    return unwrap(res);
  }

  function accept(body) {
    if (!body || typeof body !== 'object' || typeof body.token !== 'string' || !body.token || !isValidUser(body.user)) {
      throw netError('bad_response', '登录响应格式错误', 200);
    }
    save({ token: body.token, user: body.user });
    return body.user;
  }

  async function devLogin() {
    try {
      return accept(await post('/api/auth/dev-login', { deviceId: getDeviceId() }));
    } catch (err) {
      if (err && err.status === 404) {
        throw netError('login_unavailable', '服务器未配置微信登录，也未开启开发登录', 404);
      }
      throw err;
    }
  }

  async function doLogin() {
    const devAllowed = !!getConfig().DEV_LOGIN;
    let code = '';
    try {
      code = await wxLogin();
    } catch (err) {
      if (!devAllowed) throw err;
      logger.warn('[auth] wx.login 失败，改用开发登录', err);
    }
    if (code) {
      try {
        return accept(await post('/api/auth/login', { code }));
      } catch (err) {
        const notConfigured = err && err.status === 503 && err.code === 'wx_not_configured';
        if (!(notConfigured && devAllowed)) throw err;
        logger.info('[auth] 服务端未配置微信登录，改用开发登录');
      }
    }
    return devLogin();
  }

  function ensureLogin() {
    const s = load();
    if (s) return Promise.resolve(s.user);
    if (!pending) {
      pending = doLogin().then(
        (user) => {
          pending = null;
          return user;
        },
        (err) => {
          pending = null;
          throw err;
        },
      );
    }
    return pending;
  }

  function getToken() {
    const s = load();
    return s ? s.token : '';
  }

  function getUser() {
    const s = load();
    return s ? s.user : null;
  }

  function setUser(user) {
    if (!isValidUser(user)) throw new TypeError('setUser：user 必须是含 id 的对象');
    const s = load();
    if (!s) throw new Error('setUser：尚未登录');
    save({ token: s.token, user });
    return user;
  }

  function needProfile() {
    const user = getUser();
    return !(user && typeof user.nickname === 'string' && user.nickname.trim() !== '');
  }

  function clear() {
    save(null);
  }

  function invalidate(token) {
    const s = load();
    if (!s || !token || s.token !== token) return false;
    save(null);
    return true;
  }

  return { ensureLogin, getToken, getUser, setUser, needProfile, clear, invalidate, getDeviceId };
}

// 默认单例：运行时才读取全局 wx，Node 里 require 本文件不会出错
const defaultAuth = createAuth({
  wx: () => wx, // eslint-disable-line no-undef
  config: appConfig,
});

module.exports = defaultAuth;
module.exports.createAuth = createAuth;
module.exports.SESSION_KEY = SESSION_KEY;
module.exports.DEVICE_KEY = DEVICE_KEY;
