'use strict';

// 微信内容安全检测（用户资料会显示在排行榜和对手的对局页上，属于用户产生内容）：
//   昵称 → msgSecCheck 2.0（scene 1 = 资料），头像 → imgSecCheck（同步接口，图片 ≤1MB、≤750×1334）。
// 客户端的昵称输入框与 chooseAvatar 也会检测，但直接调接口可以绕过，所以服务端还要再查一次。
//
// 配置 SEC_CHECK（config.secCheck）：
//   off    不检测；
//   on     检测（默认）：判定违规（risky）的拒绝；微信那边出错（接口异常、超时、配额用完等）时放行并记日志；
//   strict 与 on 相同，但微信那边出错时也拒绝。
// 用户自己能控制的情况在任何模式下都拒绝，不能靠它绕过检测（LS-3 / LS-4）：
//   - 头像超出 imgSecCheck 的限制（1MB、750×1334）→ too_large（客户端上传前应压缩）；
//   - 昵称检测返回 61010（该用户近两小时没有访问过小程序：直接调接口、不打开小程序）→ visit_expired。
// 只有配置了 WX_APPID/WX_SECRET 才会检测；开发登录的用户（openid 为 dev:…）没有真实 openid，跳过。
// 注意：imgSecCheck 是 1.0 版同步接口，微信已停止更新并下线了文档（2.0 只有异步的 mediaCheckAsync，
// 需要配置消息推送）。它目前仍可调用，但只能算尽力而为，见 docs/deploy.md 的内容安全一节（LS-5）。
//
// 文档：
//   https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/sec-center/sec-check/msgSecCheck.html
//   https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/sec-center/sec-check/imgSecCheck.html
//   https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/mp-access-token/getStableAccessToken.html

const STABLE_TOKEN_URL = 'https://api.weixin.qq.com/cgi-bin/stable_token';
const MSG_SEC_CHECK_URL = 'https://api.weixin.qq.com/wxa/msg_sec_check';
const IMG_SEC_CHECK_URL = 'https://api.weixin.qq.com/wxa/img_sec_check';
const TIMEOUT_MS = 6000;
const TOKEN_ERRCODES = new Set([40001, 40014, 42001]); // access_token 无效 / 过期 → 刷新后重试一次
const RISKY_ERRCODE = 87014; // imgSecCheck：内容含有违法违规内容
// msgSecCheck：用户近两小时没有访问过小程序（openid 的访问记录超时）。只有绕过小程序直接调接口才会出现
const VISIT_EXPIRED_ERRCODE = 61010;
const IMG_MAX_BYTES = 1024 * 1024;
const IMG_MAX_WIDTH = 750;
const IMG_MAX_HEIGHT = 1334;
const MIME = { png: 'image/png', jpg: 'image/jpeg' };

class SecCheckError extends Error {
  constructor(msg, { errcode = null, cause } = {}) {
    super(msg, cause ? { cause } : undefined);
    this.name = 'SecCheckError';
    this.errcode = errcode;
  }
}

function createWxSecurity({ config, fetch = globalThis.fetch, logger, now = Date.now } = {}) {
  const mode = (config && config.secCheck) || 'on';
  const wx = (config && config.wx) || {};
  const enabled = mode !== 'off' && Boolean(wx.appId && wx.secret) && typeof fetch === 'function';
  let token = null; // { value, expiresAt }
  let tokenPromise = null;

  async function fetchJson(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (!res || !res.ok) throw new SecCheckError(`微信接口返回 HTTP ${res ? res.status : '空响应'}`);
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (err) {
        throw new SecCheckError('微信接口返回了无法解析的数据', { cause: err });
      }
      if (!data || typeof data !== 'object') throw new SecCheckError('微信接口返回了无法解析的数据');
      return data;
    } catch (err) {
      if (err instanceof SecCheckError) throw err;
      throw new SecCheckError(controller.signal.aborted ? '连接微信接口超时' : '无法连接微信接口', { cause: err });
    } finally {
      clearTimeout(timer);
    }
  }

  // 稳定版 access_token（不会让别处获取的令牌失效），缓存到过期前 5 分钟
  function accessToken(forceRefresh) {
    if (!forceRefresh && token && token.expiresAt > now()) return Promise.resolve(token.value);
    if (tokenPromise) return tokenPromise;
    tokenPromise = (async () => {
      const data = await fetchJson(STABLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: 'client_credential', appid: wx.appId, secret: wx.secret, force_refresh: false }),
      });
      if (typeof data.access_token !== 'string' || !data.access_token) {
        throw new SecCheckError(`获取 access_token 失败（${data.errcode} ${data.errmsg || ''}）`, { errcode: data.errcode });
      }
      const ttl = Math.max(600, Number(data.expires_in) || 7200) * 1000;
      token = { value: data.access_token, expiresAt: now() + ttl - 300000 };
      return token.value;
    })();
    tokenPromise.then(
      () => {
        tokenPromise = null;
      },
      () => {
        tokenPromise = null;
      },
    );
    return tokenPromise;
  }

  // 带 access_token 调用；令牌失效时刷新后重试一次
  async function callWithToken(send) {
    for (let attempt = 0; ; attempt++) {
      const t = await accessToken(attempt > 0);
      const data = await send(t);
      const code = Number(data.errcode || 0);
      if (TOKEN_ERRCODES.has(code) && attempt === 0) {
        token = null;
        continue;
      }
      return data;
    }
  }

  // 微信那边出错：两种模式都记下错误码（方便排查 IP 白名单 40164、配额 45009 等），on 放行、strict 拒绝
  function unavailable(what, err) {
    const code = err && err.errcode !== null && err.errcode !== undefined ? `（errcode ${err.errcode}）` : '';
    if (mode === 'strict') {
      if (logger) logger.warn('%s内容安全检测失败%s，SEC_CHECK=strict 拒绝保存：%s', what, code, err && err.message);
      return { ok: false, reason: 'unavailable', error: err };
    }
    if (logger) logger.warn('%s内容安全检测未完成%s，按 SEC_CHECK=on 放行：%s', what, code, err && err.message);
    return { ok: true, unchecked: true };
  }

  function skip(openid) {
    return !enabled || typeof openid !== 'string' || !openid || openid.startsWith('dev:');
  }

  // 昵称 → { ok: true } | { ok: false, reason: 'risky' | 'unavailable' }
  async function checkText(content, { openid } = {}) {
    if (skip(openid)) return { ok: true, skipped: true };
    try {
      const data = await callWithToken((t) =>
        fetchJson(`${MSG_SEC_CHECK_URL}?access_token=${encodeURIComponent(t)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content, version: 2, scene: 1, openid }),
        }),
      );
      const code = Number(data.errcode || 0);
      // 访问记录超时是调用方（用户）造成的：任何模式都拒绝，让他打开小程序后再改
      if (code === VISIT_EXPIRED_ERRCODE) return { ok: false, reason: 'visit_expired' };
      if (code !== 0) throw new SecCheckError(`msgSecCheck 出错（${code} ${data.errmsg || ''}）`, { errcode: code });
      const suggest = data.result && data.result.suggest;
      if (suggest === 'risky') return { ok: false, reason: 'risky' };
      if (suggest === 'review' && logger) logger.info('昵称内容安全检测建议人工复核：%s（trace %s）', content, data.trace_id || '');
      return { ok: true };
    } catch (err) {
      return unavailable('昵称', err);
    }
  }

  // 头像（已通过 inspectImage 的 PNG/JPEG）→ { ok: true } | { ok: false, reason: 'risky' | 'unavailable' | 'too_large' }
  async function checkImage(buffer, { openid, type, width, height } = {}) {
    if (skip(openid)) return { ok: true, skipped: true };
    if (buffer.length > IMG_MAX_BYTES || width > IMG_MAX_WIDTH || height > IMG_MAX_HEIGHT) {
      // imgSecCheck 只收 1MB、750×1334 以内的图片：送不了检的一律不保存（任何模式），
      // 否则直接调接口传一张 751 像素宽的图就能绕过检测（LS-3）
      return { ok: false, reason: 'too_large' };
    }
    try {
      const data = await callWithToken((t) => {
        const form = new FormData();
        form.append('media', new Blob([buffer], { type: MIME[type] || 'application/octet-stream' }), `avatar.${type || 'png'}`);
        return fetchJson(`${IMG_SEC_CHECK_URL}?access_token=${encodeURIComponent(t)}`, { method: 'POST', body: form });
      });
      const code = Number(data.errcode || 0);
      if (code === RISKY_ERRCODE) return { ok: false, reason: 'risky' };
      if (code !== 0) throw new SecCheckError(`imgSecCheck 出错（${code} ${data.errmsg || ''}）`, { errcode: code });
      return { ok: true };
    } catch (err) {
      return unavailable('头像', err);
    }
  }

  return { enabled, mode, checkText, checkImage };
}

module.exports = {
  createWxSecurity,
  SecCheckError,
  STABLE_TOKEN_URL,
  MSG_SEC_CHECK_URL,
  IMG_SEC_CHECK_URL,
  IMG_MAX_BYTES,
  IMG_MAX_WIDTH,
  IMG_MAX_HEIGHT,
};
