'use strict';
const { WebSocketServer, WebSocket } = require('ws');
const { RateLimiter } = require('../util/rate-limit');

// WebSocket 连接管理（设计文档第 5 节）：
// - 挂在 http 服务器的 upgrade 上（路径 /ws），接受连接前用 repos.sessions.resolve 校验令牌，失败回 401。
//   令牌优先取 Authorization: Bearer 头（不会出现在访问日志里），没有时取 ?token=；
// - 每个用户建立连接的频率有限（默认突发 10 次、每 6 秒恢复 1 次），超出回 429；
// - 每个用户只保留一条连接：新连接建立后旧连接收到 { t: 'kicked', reason: 'replaced' } 并以 4001 关闭；
// - 每 25 秒发 WebSocket ping，连续两次没有 pong 就断开；
// - 单条消息 ≤ 16KB（超出由 ws 以 1009 关闭）；每个用户每秒 ≤ 20 条（按用户计，重连不清零），超出以 4008 关闭；
// - 对方不读数据、发送缓冲积压超过 1MB 的连接直接断开（防止内存被慢读客户端耗尽）；
// - 推送：send(userId) 发给用户当前连接，sendGame(userId, gameId) 只发给订阅了该局的连接；
//   batch(fn) 期间的推送先排队，fn 结束后再发，保证请求的 res 先于它引起的推送到达。

const PING_INTERVAL_MS = 25000;
const MAX_MISSED_PONGS = 2;
const MAX_PAYLOAD = 16 * 1024;
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 1000;
const MAX_SUBSCRIPTIONS = 32;
const CLOSE_REPLACED = 4001;
const CLOSE_RATE_LIMITED = 4008;
const CLOSE_SHUTDOWN = 1001;
const SHUTDOWN_GRACE_MS = 1000;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const UPGRADE_BURST = 10;
const UPGRADE_REFILL_MS = 6000;
const BEARER_RE = /^Bearer[ \t]+([^\s]+)[ \t]*$/i;

const STATUS_TEXT = {
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

function rejectUpgrade(socket, status, code, msg) {
  if (socket.destroyed) return;
  const body = JSON.stringify({ error: { code, msg } });
  try {
    socket.once('finish', () => socket.destroy());
    socket.end(
      `HTTP/1.1 ${status} ${STATUS_TEXT[status] || 'Error'}\r\n` +
        'Connection: close\r\n' +
        'Content-Type: application/json; charset=utf-8\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
        body,
    );
  } catch {
    socket.destroy();
  }
}

// 令牌：Authorization: Bearer <token> 优先，其次 ?token=
function tokenOf(req, url) {
  const h = req.headers && req.headers.authorization;
  if (typeof h === 'string' && h) {
    const m = BEARER_RE.exec(h);
    if (m) return m[1];
  }
  return url.searchParams.get('token');
}

class Connection {
  constructor(hub, ws, userId, id) {
    this.hub = hub;
    this.ws = ws;
    this.userId = userId;
    this.id = id;
    this.subs = new Set();
    this.missedPongs = 0;
    this.closing = false;
    this.replaced = false;
  }

  subscribe(gameId) {
    if (this.subs.has(gameId)) return;
    if (this.subs.size >= MAX_SUBSCRIPTIONS) this.subs.delete(this.subs.values().next().value);
    this.subs.add(gameId);
  }

  isSubscribed(gameId) {
    return this.subs.has(gameId);
  }

  // 立即发送（不经过 batch 队列）。对方长期不读、积压超过上限时断开连接
  sendNow(msg) {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    if (this.ws.bufferedAmount > this.hub.maxBufferedBytes) {
      this.hub.logger.warn(`用户 ${this.userId} 的连接发送积压 ${this.ws.bufferedAmount} 字节，断开`);
      this.closing = true;
      this.ws.terminate();
      return false;
    }
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      this.hub.logger.warn(`发送给用户 ${this.userId} 失败`, err);
      return false;
    }
  }

  close(code, reason) {
    this.closing = true;
    try {
      this.ws.close(code, reason);
    } catch (err) {
      this.hub.logger.debug('关闭连接出错', err);
      this.ws.terminate();
    }
  }
}

class Hub {
  // handlers: { onOpen(conn), onClose(conn), onMessage(conn, msg), onReplace?(conn) }
  // limits（可选，测试用）：{ maxBufferedBytes, upgradeBurst, upgradeRefillMs }
  constructor({ httpServer, repos, logger, now = Date.now, timers, path = '/ws', handlers, limits = {} }) {
    if (!httpServer || typeof httpServer.on !== 'function') throw new TypeError('Hub: 需要 http 服务器');
    if (!repos || !repos.sessions || typeof repos.sessions.resolve !== 'function') {
      throw new TypeError('Hub: 需要 repos.sessions.resolve');
    }
    this.httpServer = httpServer;
    this.repos = repos;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.path = path;
    this.handlers = handlers;
    this.conns = new Map(); // userId → 当前连接
    this.all = new Set(); // 所有未关闭的连接（含被顶替、正在关闭的）
    this.seq = 0;
    this.outbox = null;
    this.closed = false;
    this.closing = null;
    this.pingTimer = null;
    this.maxBufferedBytes = limits.maxBufferedBytes || MAX_BUFFERED_BYTES;
    this.msgTimes = new Map(); // userId → 最近的消息时刻（按用户限流，换连接不清零）
    this.upgradeLimit = new RateLimiter({
      capacity: limits.upgradeBurst || UPGRADE_BURST,
      refillPerSec: 1000 / (limits.upgradeRefillMs || UPGRADE_REFILL_MS),
      now,
    });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, clientTracking: false });
    this.wss.on('error', (err) => this.logger.error('WebSocketServer 出错', err));
    this._onUpgrade = this._onUpgrade.bind(this);
  }

  start() {
    this.httpServer.on('upgrade', this._onUpgrade);
    this.pingTimer = this.timers.setInterval(() => this._heartbeat(), PING_INTERVAL_MS);
  }

  isOnline(userId) {
    return this.conns.has(userId);
  }

  connectionOf(userId) {
    return this.conns.get(userId) || null;
  }

  get connectionCount() {
    return this.conns.size;
  }

  send(userId, msg) {
    this._enqueue({ userId, gameId: null, msg });
  }

  sendGame(userId, gameId, msg) {
    this._enqueue({ userId, gameId, msg });
  }

  _enqueue(item) {
    if (this.outbox) this.outbox.push(item);
    else this._deliver(item);
  }

  _deliver({ userId, gameId, msg }) {
    const conn = this.conns.get(userId);
    if (!conn || conn.closing) return;
    if (gameId && !conn.isSubscribed(gameId)) return;
    conn.sendNow(msg);
  }

  // fn 执行期间的推送先排队，结束后按顺序发出（可嵌套）
  batch(fn) {
    if (this.outbox) return fn();
    this.outbox = [];
    try {
      return fn();
    } finally {
      const box = this.outbox;
      this.outbox = null;
      for (const item of box) this._deliver(item);
    }
  }

  _safe(fn) {
    try {
      fn();
    } catch (err) {
      this.logger.error('WebSocket 处理出错', err);
    }
  }

  _onUpgrade(req, socket, head) {
    socket.on('error', (err) => this.logger.debug('upgrade socket 出错', err));
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      rejectUpgrade(socket, 400, 'bad_request', '地址不合法');
      return;
    }
    if (url.pathname !== this.path) {
      rejectUpgrade(socket, 404, 'not_found', '不存在');
      return;
    }
    if (this.closed) {
      rejectUpgrade(socket, 503, 'shutting_down', '服务器正在关闭');
      return;
    }
    const token = tokenOf(req, url);
    let userId = null;
    if (token && token.length <= 256) {
      try {
        userId = this.repos.sessions.resolve(token, this.now());
      } catch (err) {
        this.logger.error('校验 WebSocket 令牌失败', err);
        rejectUpgrade(socket, 500, 'internal', '服务器内部错误');
        return;
      }
    }
    if (typeof userId === 'bigint') userId = Number(userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      rejectUpgrade(socket, 401, 'unauthorized', '登录已失效');
      return;
    }
    if (!this.upgradeLimit.take(userId)) {
      this.logger.warn(`用户 ${userId} 重连过于频繁，拒绝`);
      rejectUpgrade(socket, 429, 'rate_limited', '连接过于频繁，请稍后再试');
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this._accept(ws, userId));
  }

  _accept(ws, userId) {
    if (this.closed) {
      ws.close(CLOSE_SHUTDOWN, 'server_shutdown');
      return;
    }
    this.seq += 1;
    const conn = new Connection(this, ws, userId, this.seq);
    const old = this.conns.get(userId);
    this.conns.set(userId, conn);
    this.all.add(conn);
    ws.on('message', (data, isBinary) => this._onMessage(conn, data, isBinary));
    ws.on('pong', () => {
      conn.missedPongs = 0;
    });
    ws.on('close', () => this._onClose(conn));
    ws.on('error', (err) => this.logger.debug(`用户 ${userId} 的连接出错：${err && err.message}`));
    if (old) {
      old.replaced = true;
      old.sendNow({ t: 'kicked', reason: 'replaced' });
      old.close(CLOSE_REPLACED, 'replaced');
      this.logger.info(`用户 ${userId} 的新连接顶替了旧连接`);
      if (typeof this.handlers.onReplace === 'function') this._safe(() => this.handlers.onReplace(conn));
    } else {
      this.logger.debug(`用户 ${userId} 已连接`);
      this._safe(() => this.handlers.onOpen(conn));
    }
  }

  _onMessage(conn, data, isBinary) {
    if (conn.closing || conn.replaced) return;
    conn.missedPongs = 0; // 任何消息都说明连接还活着（慢读客户端由发送积压上限处理）
    const t = this.now();
    let times = this.msgTimes.get(conn.userId);
    if (!times) {
      times = [];
      this.msgTimes.set(conn.userId, times);
    }
    if (times.length >= RATE_LIMIT && t - times[0] < RATE_WINDOW_MS) {
      this.logger.warn(`用户 ${conn.userId} 发送过快，断开连接`);
      conn.close(CLOSE_RATE_LIMITED, 'rate_limited');
      return;
    }
    times.push(t);
    if (times.length > RATE_LIMIT) times.shift();
    if (isBinary) {
      this.logger.debug(`用户 ${conn.userId} 发来二进制消息，忽略`);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      this.logger.debug(`用户 ${conn.userId} 发来无法解析的消息，忽略`);
      return;
    }
    this._safe(() => this.handlers.onMessage(conn, msg));
  }

  _onClose(conn) {
    conn.closing = true;
    this.all.delete(conn);
    if (this.conns.get(conn.userId) === conn) {
      this.conns.delete(conn.userId);
      this.logger.debug(`用户 ${conn.userId} 已断开`);
      this._safe(() => this.handlers.onClose(conn));
    }
  }

  _heartbeat() {
    // 清理早已过了限流窗口的记录
    const t = this.now();
    for (const [uid, times] of this.msgTimes) {
      if (!times.length || t - times[times.length - 1] >= RATE_WINDOW_MS) this.msgTimes.delete(uid);
    }
    this.upgradeLimit.prune(t);
    for (const conn of this.all) {
      if (conn.missedPongs >= MAX_MISSED_PONGS) {
        this.logger.info(`用户 ${conn.userId} 的连接无响应，断开`);
        conn.closing = true;
        conn.ws.terminate();
        continue;
      }
      conn.missedPongs += 1;
      try {
        conn.ws.ping();
      } catch (err) {
        this.logger.debug('发送 ping 失败', err);
      }
    }
  }

  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.httpServer.off('upgrade', this._onUpgrade);
    if (this.pingTimer !== null) this.timers.clearInterval(this.pingTimer);
    this.pingTimer = null;
    const conns = [...this.all];
    const waits = conns.map(
      (conn) =>
        new Promise((resolve) => {
          if (conn.ws.readyState === WebSocket.CLOSED) {
            resolve();
            return;
          }
          conn.ws.once('close', resolve);
          conn.close(CLOSE_SHUTDOWN, 'server_shutdown');
        }),
    );
    // 关机不依赖注入的定时器：客户端不回应关闭握手时强制断开
    const force = setTimeout(() => {
      for (const conn of conns) conn.ws.terminate();
    }, SHUTDOWN_GRACE_MS);
    if (typeof force.unref === 'function') force.unref();
    this.closing = Promise.all(waits)
      .then(() => new Promise((resolve) => this.wss.close(() => resolve())))
      .finally(() => clearTimeout(force));
    return this.closing;
  }
}

module.exports = {
  Hub,
  Connection,
  PING_INTERVAL_MS,
  MAX_MISSED_PONGS,
  MAX_PAYLOAD,
  RATE_LIMIT,
  RATE_WINDOW_MS,
  CLOSE_REPLACED,
  CLOSE_RATE_LIMITED,
  MAX_BUFFERED_BYTES,
};
