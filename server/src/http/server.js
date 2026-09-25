'use strict';
const http = require('node:http');
const { createRouter } = require('./router');
const { readJson } = require('./body');
const { HttpError, badRequest, notFound } = require('./errors');
const { validateNickname, parseLimit, parseTimestamp } = require('./validate');
const { createViewContext, gameSummary, gameRecord } = require('./views');
const { createAvatarStore } = require('./avatars');
const { createAuth } = require('../auth');
const { createWxSecurity } = require('../auth/wx-security');
const { publicUser, publicStats, avatarUrl } = require('../util/public-user');
const { RateLimiter, createConcurrencyLimit } = require('../util/rate-limit');
const { LEADERBOARD_TYPES } = require('../db/repos');
const { silentLogger } = require('../logger');

// REST 服务（设计文档第 4 节）。返回未 listen 的 http.Server；WebSocket 由 realtime 模块挂在同一个 server 上。

const GAME_ID_PARAM_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LEADERBOARD_MAX = 100;
const GAMES_PAGE_MAX = 50;

// 应用层限流（nginx 的 limit_req 之外再兜一层，见 docs/deploy.md 第 6 节）。limits 参数可覆盖（测试用）。
const DEFAULT_LIMITS = Object.freeze({
  loginBurst: 30, // 登录接口（不需要令牌）：每个 IP 突发 30 次（开发登录的客户端每次登录先试微信登录，算 2 次）
  loginPerSec: 1, // 之后每秒 1 次
  loginConcurrent: 16, // 同时在请求微信 code2Session 的登录数
  apiBurst: 60, // 需要令牌的接口：每个用户突发 60 次
  apiPerSec: 10, // 之后每秒 10 次
  avatarBurst: 5, // 头像上传：每个用户突发 5 次
  avatarPerSec: 1 / 12, // 之后每 12 秒 1 次
  uploadConcurrent: 4, // 同时在处理的头像上传（每个要把整张图读进内存）
});

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// 客户端 IP：只有请求来自本机（nginx 反向代理）时才相信 X-Real-IP，否则用 TCP 对端地址
function clientIp(req) {
  const peer = (req.socket && req.socket.remoteAddress) || '';
  const real = req.headers['x-real-ip'];
  if (LOOPBACK.has(peer) && typeof real === 'string' && real && real.length <= 64) return real.trim();
  return peer;
}

function rateLimited(limiter, key, msg) {
  const secs = Math.max(1, Math.ceil(limiter.retryAfterMs(key) / 1000));
  return new HttpError(429, 'rate_limited', msg || '请求太频繁，请稍后再试', { headers: { 'Retry-After': String(secs) } });
}

function sendJson(res, status, data, headers) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(headers || {}),
  });
  res.end(body);
}

function createHttpServer({ config, repos, ai, logger = silentLogger, now = Date.now, getActiveGames, fetch, limits } = {}) {
  if (!config || !repos) throw new TypeError('createHttpServer: 需要 config 与 repos');
  const base = config.publicBaseUrl;
  const auth = createAuth({ config, repos, now, logger, fetch });
  const security = createWxSecurity({ config, fetch: fetch || globalThis.fetch, logger, now });
  const avatars = createAvatarStore({ avatarDir: config.avatarDir, repos, logger, now, security });
  const router = createRouter();
  const lim = { ...DEFAULT_LIMITS, ...(limits || {}) };
  const loginLimit = new RateLimiter({ capacity: lim.loginBurst, refillPerSec: lim.loginPerSec, now });
  const apiLimit = new RateLimiter({ capacity: lim.apiBurst, refillPerSec: lim.apiPerSec, now });
  const avatarLimit = new RateLimiter({ capacity: lim.avatarBurst, refillPerSec: lim.avatarPerSec, now });
  const loginSlots = createConcurrencyLimit(lim.loginConcurrent);
  const uploadSlots = createConcurrencyLimit(lim.uploadConcurrent);

  function activeGameIds(userId) {
    if (typeof getActiveGames !== 'function') return [];
    try {
      const list = getActiveGames(userId) || [];
      return list.map((g) => g && g.id).filter((id) => typeof id === 'string');
    } catch (err) {
      // 首页依赖 /api/me，这里出错只记日志，不让整个接口失败
      logger.error('获取进行中的对局失败（用户 %d）：', userId, err);
      return [];
    }
  }

  // ---------- 路由 ----------

  router.add('GET', '/healthz', () => ({ ok: true }));

  router.add(
    'POST',
    '/api/auth/login',
    async ({ req }) => {
      const body = await readJson(req);
      // 每次登录都要请求一次微信 code2Session：限制同时在途的数量，防止刷接口占满连接、耗尽调用额度
      const release = loginSlots.acquire();
      if (!release) throw new HttpError(429, 'rate_limited', '登录的人太多了，请稍后再试', { headers: { 'Retry-After': '2' } });
      try {
        return await auth.login(body.code);
      } finally {
        release();
      }
    },
    { loginLimit: true },
  );

  router.add(
    'POST',
    '/api/auth/dev-login',
    async ({ req }) => {
      if (!config.devLogin) throw notFound('接口不存在'); // 未开启时连请求体都不读
      const body = await readJson(req);
      return auth.devLogin(body.deviceId);
    },
    { loginLimit: true },
  );

  // 注销当前令牌（其他设备上的令牌不受影响；已建立的 WebSocket 连接在断开前不受影响）
  router.add(
    'POST',
    '/api/auth/logout',
    ({ token }) => {
      repos.sessions.revoke(token);
      return { ok: true };
    },
    { auth: true },
  );

  router.add(
    'GET',
    '/api/me',
    ({ user }) => ({
      user: publicUser(user, base),
      needProfile: !user.nickname,
      stats: publicStats(repos.stats.get(user.id)),
      ai: repos.games.aiRecord(user.id),
      activeGameIds: activeGameIds(user.id),
    }),
    { auth: true },
  );

  router.add(
    'PUT',
    '/api/me/profile',
    async ({ req, user }) => {
      const body = await readJson(req);
      const nickname = validateNickname(body.nickname);
      if (nickname !== user.nickname) {
        const r = await security.checkText(nickname, { openid: user.openid });
        if (!r.ok) {
          if (r.reason === 'risky') throw new HttpError(400, 'content_risky', '昵称含有不合适的内容，请修改');
          // 微信要求被检测的用户近两小时访问过小程序：绕过小程序直接调接口会走到这里（LS-4）
          if (r.reason === 'visit_expired') throw new HttpError(400, 'sec_check_retry', '请重新打开小程序后再修改昵称');
          throw new HttpError(503, 'sec_check_unavailable', '暂时无法检测昵称内容，请稍后再试', { cause: r.error });
        }
      }
      const updated = repos.users.updateProfile(user.id, { nickname }, now());
      if (!updated) throw notFound('用户不存在');
      return { user: publicUser(updated, base) };
    },
    { auth: true },
  );

  router.add(
    'POST',
    '/api/me/avatar',
    async ({ req, user }) => {
      if (!avatarLimit.take(user.id)) throw rateLimited(avatarLimit, user.id, '上传太频繁，请稍后再试');
      const release = uploadSlots.acquire();
      if (!release) throw new HttpError(429, 'rate_limited', '上传的人太多了，请稍后再试', { headers: { 'Retry-After': '3' } });
      try {
        const updated = await avatars.upload(req, user.id, { openid: user.openid });
        return { user: publicUser(updated, base) };
      } finally {
        release();
      }
    },
    { auth: true },
  );

  router.add(
    'GET',
    '/api/leaderboard',
    ({ query, user }) => {
      const type = query.get('type') || 'streak';
      if (!LEADERBOARD_TYPES.includes(type)) throw badRequest(`type 必须是 ${LEADERBOARD_TYPES.join(' / ')}`);
      const limit = parseLimit(query.get('limit'), 50, LEADERBOARD_MAX);
      const minGames = config.minGamesWinrate;
      const items = repos.stats.leaderboard(type, limit, { minGames }).map((it) => ({
        rank: it.rank,
        userId: it.userId,
        nickname: it.nickname,
        avatarUrl: avatarUrl(it.avatar, base),
        value: it.value,
        games: it.games,
        wins: it.wins,
      }));
      const r = repos.stats.rankOf(type, user.id, { minGames });
      return {
        type,
        items,
        me: { rank: r.rank, value: r.value, games: r.games, wins: r.wins, need: r.need },
        minGames,
      };
    },
    { auth: true },
  );

  router.add(
    'GET',
    '/api/games',
    ({ query, user }) => {
      const before = parseTimestamp(query.get('before'), 'before');
      const limit = parseLimit(query.get('limit'), 20, GAMES_PAGE_MAX);
      // 多取一条判断是否还有下一页
      const rows = repos.games.listByUser(user.id, { before, limit: limit + 1 });
      const page = rows.slice(0, limit);
      const ctx = createViewContext({ repos, ai, publicBaseUrl: base, logger });
      return {
        items: page.map((g) => gameSummary(g, user.id, ctx)),
        next: rows.length > limit ? page[page.length - 1].createdAt : null,
      };
    },
    { auth: true },
  );

  router.add(
    'GET',
    '/api/games/:id',
    ({ params, user }) => {
      const id = params.id;
      // 只能看自己参与的对局；看不到的一律 404，不暴露对局是否存在
      const game = GAME_ID_PARAM_RE.test(id) ? repos.games.findById(id) : null;
      if (!game || (game.blackId !== user.id && game.whiteId !== user.id)) throw notFound('对局不存在');
      const ctx = createViewContext({ repos, ai, publicBaseUrl: base, logger });
      return gameRecord(game, user.id, ctx);
    },
    { auth: true },
  );

  router.add('GET', '/api/ai/levels', () => {
    if (!ai) return { available: false, levels: [] };
    const levels = (ai.levels() || []).map((l) => ({
      id: String(l.id),
      name: String(l.name == null ? l.id : l.name),
      desc: String(l.desc == null ? '' : l.desc),
    }));
    return { available: Boolean(ai.available()), levels };
  });

  router.add('GET', '/avatars/:file', async ({ req, res, params }) => {
    await avatars.serve(req, res, params.file);
    return undefined; // 已自行写响应
  });

  // ---------- 请求处理 ----------

  async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      throw badRequest('请求地址不正确');
    }
    const hit = router.match(req.method, url.pathname);
    if (!hit) throw notFound('接口不存在');
    if (!hit.route) {
      throw new HttpError(405, 'method_not_allowed', '请求方法不被允许', { headers: { Allow: hit.allowed.join(', ') } });
    }
    const ctx = { req, res, params: hit.params, query: url.searchParams, user: null, token: null };
    const opts = hit.route.options;
    if (opts.loginLimit) {
      const ip = clientIp(req);
      if (!loginLimit.take(ip)) throw rateLimited(loginLimit, ip, '登录太频繁，请稍后再试');
    }
    if (opts.auth) {
      const a = auth.authenticate(req.headers.authorization);
      ctx.user = a.user;
      ctx.token = a.token;
      if (!apiLimit.take(a.user.id)) throw rateLimited(apiLimit, a.user.id);
    }
    const data = await hit.route.handler(ctx);
    if (data !== undefined && !res.headersSent) sendJson(res, 200, data);
  }

  function handleError(err, req, res) {
    const aborted = err && (err.code === 'ECONNRESET' || err.code === 'ERR_STREAM_PREMATURE_CLOSE');
    if (res.headersSent || res.destroyed || aborted) {
      // 已经开始写响应（如文件传输中断）或客户端已断开：无法再回错误，记录后关闭连接
      if (!aborted) logger.error('响应过程中出错 %s %s：', req.method, req.url, err);
      res.destroy();
      return;
    }
    let status = 500;
    let code = 'internal';
    let msg = '服务器内部错误';
    let headers = {};
    if (err instanceof HttpError) {
      ({ status, code } = err);
      msg = err.msg;
      headers = err.headers || {};
      // wx_not_configured 是预期状态（开发环境未配置微信登录，客户端据此改走 dev-login），每次登录都会出现，不算错误
      if (status >= 500 && code !== 'wx_not_configured') {
        // 附上底层原因（如微信接口的 errcode），否则日志里只有给用户看的笼统提示（LS-6）
        const cause = err.cause && err.cause.message ? `（${err.cause.message}）` : '';
        logger.error('%s %s → %d %s：%s%s', req.method, req.url, status, code, err.message, cause);
      } else {
        logger.debug('%s %s → %d %s', req.method, req.url, status, code);
      }
    } else {
      logger.error('处理请求出错 %s %s：', req.method, req.url, err);
    }
    // 请求体没读完就回错误时关闭连接，避免残留数据被当成下一个请求
    if (!req.complete) headers = { ...headers, Connection: 'close' };
    sendJson(res, status, { error: { code, msg } }, headers);
    if (!req.complete) req.resume();
  }

  const server = http.createServer((req, res) => {
    const started = Date.now();
    res.on('finish', () => {
      logger.debug('%s %s %d %dms', req.method, req.url, res.statusCode, Date.now() - started);
    });
    handle(req, res).catch((err) => handleError(err, req, res));
  });
  server.requestTimeout = 60000; // 整个请求（含 2MB 头像上传）须在 60 秒内收完
  server.headersTimeout = 20000;
  // 限流表里已经补满的条目定期清掉
  const pruneTimer = setInterval(() => {
    loginLimit.prune();
    apiLimit.prune();
    avatarLimit.prune();
  }, 60000);
  if (typeof pruneTimer.unref === 'function') pruneTimer.unref();
  server.on('close', () => clearInterval(pruneTimer));
  return server;
}

module.exports = { createHttpServer, sendJson, clientIp, DEFAULT_LIMITS };
