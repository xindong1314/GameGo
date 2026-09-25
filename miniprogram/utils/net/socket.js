'use strict';

/**
 * WebSocket 单例（协议见设计文档第 5 节、8.2）。
 *
 * 公共接口：
 *   connect({ timeout = 10000 }?) → Promise<Hello>
 *       开始（或保持）连接：确保登录 → wx.connectSocket({ url: WS_URL, header: { Authorization: 'Bearer ' + token } })
 *       （令牌不放进 URL，不会出现在服务器与代理的日志里）→ 连上后自动发 hello。
 *       已就绪时立即 resolve 最近一次 hello 结果；timeout 内没就绪 reject { code: 'offline' }（后台继续重连）；
 *       被踢 / close() 时 reject { code: 'kicked' | 'closed' }。只调用不 await 也不会报"未处理的 rejection"。
 *       被踢之后再调用 connect() 视为用户主动重连。
 *   close()
 *       主动断开，不再自动重连；未完成的请求 reject { code: 'closed' }。
 *   request(t, params?, { timeout = 10000 }?) → Promise<data>
 *       自动分配 rid；成功 resolve data（服务端没给 data 时为 {}）；失败 reject { code, msg }：
 *       服务端错误原样（如 'illegal'、'stale'、'in_game'，服务端附带的其他字段如 reason/expected/version
 *       也一并带上）；timeout 内没连上 'offline'；
 *       已发出但 timeout 内没回应 'timeout'；发出后连接断开 'offline'；被踢 'kicked'；close() 'closed'。
 *       未连接时自动 connect() 并排队，连上后（hello 之后）按调用顺序发出。
 *   on(t, fn) → 取消订阅函数；off(t, fn)；once(t, fn)
 *       服务端推送：fn(msg)，msg 是原始消息对象（含 t），如 on('game.move', (m) => m.idx)
 *       'status'：fn('connecting' | 'open' | 'closed')
 *       'ready' ：fn(hello)，每次（重新）连上并完成 hello 后触发，hello = { activeGames, room, matching }
 *       'kicked'：fn({ t: 'kicked', reason })，之后不再自动重连
 *   getStatus() → 'connecting' | 'open' | 'closed'；isReady() → bool；getReadyData() → Hello | null
 *   isKicked() → bool   被顶号后为真，直到再次 connect()（由用户主动发起）。自动联网的页面据此不去重连。
 *
 * 行为：
 *   - 断线自动重连，间隔 1s、2s、4s…最多 15s，完成 hello 后清零；被踢（kicked 消息或 4001 关闭码）
 *     或主动 close() 后不重连；wx.onAppShow / 网络恢复时若未连接立即重连，已连接则立即发一次心跳探活。
 *   - 心跳：每 20s 发 { t: 'ping' }，10s 内没收到 pong 视为断线并重连。
 *   - 连接在打开前就被拒绝/关闭（例如令牌过期，服务端 upgrade 阶段回 401）连续 2 次时，
 *     下次重连前先 GET /api/me 校验令牌（401 时 api 会清令牌、重新登录），再用新令牌连接。
 *   - 任何时刻最多一个活动的 SocketTask；旧 SocketTask 的迟到回调一律忽略（迟到的 onOpen 会顺手关掉它）。
 *   - wx.connectSocket 带 timeout（= 单次打开超时），放弃一次连接时原生连接也随之放弃。
 *   - 自己顶自己：弱网下被放弃的连接可能在服务端迟到建立，服务端把它当成"新连接"顶掉当前连接。
 *     放弃一次正在建立的连接（或它迟到打开）后的 selfKickWindowMs 内收到 kicked，视为这种情况，
 *     按普通断线重连一次，而不是进入被踢状态。
 *
 * 用法：const socket = require('../../utils/net/socket');  或  const { socket } = require(...)
 * 测试：createSocket({ wx, config, auth, api, timers, logger, options }) 创建独立实例。
 */

const appConfig = require('../../config');
const defaultAuth = require('./auth');
const defaultApi = require('./api');
const { Emitter } = require('./emitter');
const { lazy } = require('./http');

const DEFAULTS = {
  requestTimeoutMs: 10000,
  connectWaitMs: 10000, // connect() 等待就绪的默认超时
  openTimeoutMs: 10000, // 单次 wx.connectSocket 等待 onOpen 的超时
  heartbeatMs: 20000,
  pongTimeoutMs: 10000,
  backoffBaseMs: 1000,
  backoffMaxMs: 15000,
  tokenCheckAfter: 2, // 连续几次"打开前就失败"后校验令牌
  selfKickWindowMs: 15000, // 放弃正在建立的连接后，多久内收到的 kicked 可能是被自己的旧连接顶掉
  maxMessageBytes: 16 * 1024,
};

const KICKED_CLOSE_CODE = 4001;
const RESERVED_EVENTS = ['status', 'ready'];

// 运行时才取全局定时器函数（避免个别环境下脱离 this 调用报错）
const defaultTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
};

function noop() {}

function sockError(code, msg) {
  return { code, msg };
}

// 服务端的 err：{ code, msg, ...extra }（如 illegal 带 reason，stale 带 expected/version）。
// 保留附加字段，code/msg 规范化。
function serverError(e) {
  const src = e && typeof e === 'object' && !Array.isArray(e) ? e : {};
  const out = {};
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
  }
  out.code = typeof src.code === 'string' && src.code ? src.code : 'internal';
  out.msg = typeof src.msg === 'string' && src.msg ? src.msg : '请求失败';
  return out;
}

// UTF-8 字节数（服务端限制单条消息 ≤ 16KB）
function utf8Length(str) {
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdfff) n += 2; // 代理对两个码元合计 4 字节
    else n += 3;
  }
  return n;
}

function normalizeHello(data) {
  const d = data && typeof data === 'object' ? data : {};
  return Object.assign({}, d, {
    activeGames: Array.isArray(d.activeGames) ? d.activeGames : [],
    room: d.room && typeof d.room === 'object' ? d.room : null,
    matching: d.matching && typeof d.matching === 'object' ? d.matching : null,
  });
}

function createSocket({ wx, config, auth, api = null, timers = defaultTimers, logger = console, options } = {}) {
  if (!auth) throw new TypeError('createSocket 需要 auth');
  const getWx = lazy(wx);
  const getConfig = lazy(config);
  const T = timers;
  const opt = Object.assign({}, DEFAULTS, options);
  const bus = new Emitter({ logger });

  let status = 'closed';
  let wanted = false; // 是否应保持连接：connect() 后为真，close() / 被踢后为假
  let kicked = false;
  let current = null; // 当前连接尝试 { task, opened, token }；null 表示没有连接也没在连
  let ready = false;
  let readyData = null;
  let attempts = 0; // 连续重连次数，决定退避时长
  let preOpenFailures = 0; // 连续"打开前就失败"的次数
  let lastToken = '';
  let nextRid = 1;
  const pending = new Map(); // rid → 已发出、等回应的请求
  let queue = []; // 等待连接的请求
  let waiters = []; // connect() 的等待者
  let reconnectTimer = null;
  let openTimer = null;
  let heartbeatTimer = null;
  let pongTimer = null;
  let selfKickTimer = null; // 非 null：刚放弃过一次正在建立的连接，收到的 kicked 可能是自己顶自己
  let hooksInstalled = false;

  // ---------- 小工具 ----------

  function setStatus(next) {
    if (status === next) return;
    status = next;
    bus.emit('status', next);
  }

  function clearTimeoutSafe(id) {
    if (id !== null) T.clearTimeout(id);
    return null;
  }

  function isOpen() {
    return !!current && current.opened;
  }

  function safeClose(task) {
    if (!task || typeof task.close !== 'function') return;
    try {
      task.close({ code: 1000, reason: 'client', fail: noop });
    } catch (err) {
      // 关闭已经断开的连接可能抛错，这是预期情况
    }
  }

  // ---------- 请求 ----------

  // entry.state：queued（等连接）→ sent（等回应）→ done
  function createEntry(t, params, timeout) {
    let entry = null;
    const promise = new Promise((resolve, reject) => {
      entry = { t, params, resolve, reject, state: 'new', rid: 0, timer: null };
    });
    entry.timer = T.setTimeout(() => {
      entry.timer = null;
      if (entry.state === 'sent') settle(entry, sockError('timeout', '服务器响应超时'));
      else settle(entry, sockError('offline', '未连接到服务器'));
    }, timeout);
    return { entry, promise };
  }

  function settle(entry, err, data) {
    if (entry.state === 'done') return;
    if (entry.state === 'queued') {
      const i = queue.indexOf(entry);
      if (i >= 0) queue.splice(i, 1);
    } else if (entry.state === 'sent') {
      pending.delete(entry.rid);
    }
    entry.state = 'done';
    entry.timer = clearTimeoutSafe(entry.timer);
    if (err) entry.reject(err);
    else entry.resolve(data);
  }

  // 同步发送一条消息；返回 null 表示已交给 SocketTask，否则返回错误对象
  function rawSend(msg, onFail) {
    const att = current;
    if (!att || !att.opened || !att.task) return sockError('offline', '未连接到服务器');
    let data;
    try {
      data = JSON.stringify(msg);
    } catch (err) {
      return sockError('bad_request', '请求参数无法序列化');
    }
    if (utf8Length(data) > opt.maxMessageBytes) return sockError('too_large', '消息过大');
    try {
      att.task.send({ data, fail: (err) => onFail(err) });
    } catch (err) {
      return sockError('offline', '连接已断开');
    }
    return null;
  }

  function transmit(entry) {
    const rid = nextRid++;
    entry.rid = rid;
    entry.state = 'sent';
    pending.set(rid, entry);
    const msg = Object.assign({}, entry.params, { t: entry.t, rid });
    const err = rawSend(msg, (failErr) => {
      logger.warn(`[socket] 发送 ${entry.t} 失败`, failErr);
      settle(entry, sockError('offline', '连接已断开'));
    });
    if (err) settle(entry, err);
  }

  function flushQueue() {
    const list = queue;
    queue = [];
    for (const entry of list) {
      if (entry.state === 'queued') transmit(entry);
    }
  }

  function failPending(err) {
    for (const entry of Array.from(pending.values())) settle(entry, err);
  }

  function failQueue(err) {
    for (const entry of queue.slice()) settle(entry, err);
  }

  function settleWaiters(err, data) {
    const list = waiters;
    waiters = [];
    for (const w of list) {
      w.timer = clearTimeoutSafe(w.timer);
      if (err) w.reject(err);
      else w.resolve(data);
    }
  }

  function request(t, params, options) {
    if (typeof t !== 'string' || !t) {
      return Promise.reject(sockError('bad_request', '消息类型 t 必须是非空字符串'));
    }
    if (params !== undefined && params !== null && (typeof params !== 'object' || Array.isArray(params))) {
      return Promise.reject(sockError('bad_request', '请求参数必须是对象'));
    }
    const timeout = options && options.timeout > 0 ? options.timeout : opt.requestTimeoutMs;
    if (kicked) return Promise.reject(sockError('kicked', '账号已在其他设备登录'));
    const { entry, promise } = createEntry(t, params || null, timeout);
    if (isOpen()) {
      transmit(entry);
    } else {
      entry.state = 'queued';
      queue.push(entry);
      if (!wanted) connect();
    }
    return promise;
  }

  // ---------- 连接 ----------

  function connect(options) {
    const timeout = options && options.timeout > 0 ? options.timeout : opt.connectWaitMs;
    kicked = false;
    wanted = true;
    installHooks();
    let p;
    if (ready) {
      p = Promise.resolve(readyData);
    } else {
      p = new Promise((resolve, reject) => {
        const w = { resolve, reject, timer: null };
        w.timer = T.setTimeout(() => {
          w.timer = null;
          waiters = waiters.filter((x) => x !== w);
          reject(sockError('offline', '连接服务器超时'));
        }, timeout);
        waiters.push(w);
      });
      // 标记为已处理：页面只调用 connect() 不 await 时不会报"未处理的 rejection"；await 它的调用方照常收到错误
      p.catch(noop);
    }
    if (!current) {
      // 用户主动发起：取消退避，立即连接
      attempts = 0;
      reconnectTimer = clearTimeoutSafe(reconnectTimer);
      openConnection();
    }
    return p;
  }

  function close() {
    wanted = false;
    reconnectTimer = clearTimeoutSafe(reconnectTimer);
    const att = current;
    current = null;
    ready = false;
    openTimer = clearTimeoutSafe(openTimer);
    stopHeartbeat();
    if (att && att.task) safeClose(att.task);
    const err = sockError('closed', '连接已关闭');
    failPending(err);
    failQueue(err);
    settleWaiters(err);
    setStatus('closed');
  }

  function openConnection() {
    const att = { task: null, opened: false, token: '' };
    current = att;
    ready = false;
    setStatus('connecting');
    startAttempt(att).catch((err) => {
      // startAttempt 内部已处理预期的错误，这里只兜住意外异常
      logger.error('[socket] 连接流程异常', err);
      handleDisconnect(att, { reason: 'internal' });
    });
  }

  async function startAttempt(att) {
    try {
      if (preOpenFailures >= opt.tokenCheckAfter) await verifyToken();
      if (att !== current) return;
      await auth.ensureLogin();
    } catch (err) {
      if (att !== current) return;
      logger.warn('[socket] 登录失败，稍后重试', err);
      handleDisconnect(att, { reason: 'login_failed' });
      return;
    }
    if (att !== current) return;
    const token = auth.getToken();
    if (!token) {
      logger.warn('[socket] 没有登录令牌，稍后重试');
      handleDisconnect(att, { reason: 'no_token' });
      return;
    }
    att.token = token;
    lastToken = token;
    // 令牌放在握手的 Authorization 头里，不放进 URL：URL 会出现在 nginx 的访问/错误日志与各级代理日志里
    const url = String(getConfig().WS_URL || '');

    let task;
    try {
      task = getWx().connectSocket({
        url,
        header: { Authorization: `Bearer ${token}` },
        // 基础库 2.10.0+：原生连接与本地的打开超时同时放弃，不会在后台继续连（也不占用 5 个连接的名额）
        timeout: opt.openTimeoutMs,
        fail: (err) => {
          if (att === current) logger.warn('[socket] connectSocket 失败', err);
          handleDisconnect(att, { reason: 'connect_fail' });
        },
      });
    } catch (err) {
      logger.warn('[socket] connectSocket 抛错', err);
      handleDisconnect(att, { reason: 'connect_fail' });
      return;
    }
    if (att !== current) {
      // fail 回调同步触发、或期间 close() 了
      safeClose(task);
      return;
    }
    if (!task || typeof task.onOpen !== 'function') {
      logger.error('[socket] wx.connectSocket 没有返回 SocketTask');
      handleDisconnect(att, { reason: 'no_task' });
      return;
    }
    att.task = task;
    task.onOpen(() => onOpen(att));
    task.onMessage((res) => onMessage(att, res));
    task.onClose((res) => {
      if (att === current) logger.info('[socket] 连接关闭', res && res.code, res && res.reason);
      handleDisconnect(att, { code: res && res.code, reason: res && res.reason });
    });
    task.onError((err) => {
      if (att === current) logger.warn('[socket] 连接出错', err);
      handleDisconnect(att, { reason: 'error' });
    });
    openTimer = T.setTimeout(() => {
      openTimer = null;
      if (att !== current || att.opened) return;
      logger.warn('[socket] 连接超时');
      handleDisconnect(att, { reason: 'open_timeout' });
    }, opt.openTimeoutMs);
  }

  function onOpen(att) {
    if (att !== current) {
      // 已被放弃的连接迟到地打开了：关掉，避免同时存在两个连接。
      // 服务端可能已把它当成新连接顶掉了当前连接，随后到达的 kicked 不能当真
      safeClose(att.task);
      if (att.abandoned) markSelfKickWindow();
      return;
    }
    att.opened = true;
    openTimer = clearTimeoutSafe(openTimer);
    preOpenFailures = 0;
    sayHello(att); // hello 必须是第一条
    flushQueue();
    startHeartbeat();
    setStatus('open');
  }

  function sayHello(att) {
    const { entry, promise } = createEntry('hello', null, opt.requestTimeoutMs);
    transmit(entry);
    promise.then(
      (data) => {
        if (att !== current) return;
        ready = true;
        readyData = normalizeHello(data);
        attempts = 0;
        settleWaiters(null, readyData);
        bus.emit('ready', readyData);
      },
      (err) => {
        if (att !== current) return; // 连接已断开，断线逻辑已处理
        logger.error('[socket] hello 失败，重新连接', err);
        handleDisconnect(att, { reason: 'hello_failed' });
      },
    );
  }

  function onMessage(att, res) {
    if (att !== current) return;
    const raw = res ? res.data : undefined;
    if (typeof raw !== 'string') {
      logger.warn('[socket] 忽略非文本消息');
      return;
    }
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      logger.error('[socket] 收到的消息不是合法 JSON', raw.slice(0, 200));
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string' || !msg.t) {
      logger.error('[socket] 收到的消息缺少 t', raw.slice(0, 200));
      return;
    }
    if (msg.t === 'res') {
      handleRes(msg);
      return;
    }
    if (msg.t === 'kicked') {
      handleDisconnect(att, { code: KICKED_CLOSE_CODE, kickedMsg: msg });
      return;
    }
    if (msg.t === 'pong') pongTimer = clearTimeoutSafe(pongTimer);
    if (RESERVED_EVENTS.includes(msg.t)) {
      logger.warn(`[socket] 忽略名称为保留事件的推送 ${msg.t}`);
      return;
    }
    bus.emit(msg.t, msg);
  }

  function handleRes(msg) {
    const entry = pending.get(msg.rid);
    if (!entry) return; // 已超时或已断开的请求的迟到回应
    if (msg.ok === true) {
      settle(entry, null, msg.data === undefined || msg.data === null ? {} : msg.data);
      return;
    }
    settle(entry, serverError(msg.err));
  }

  function handleDisconnect(att, info) {
    if (att !== current) return; // 旧连接的迟到回调
    current = null;
    ready = false;
    openTimer = clearTimeoutSafe(openTimer);
    stopHeartbeat();
    if (att.task) {
      safeClose(att.task);
      if (!att.opened) preOpenFailures += 1;
      if (!att.opened && info.reason === 'open_timeout') {
        // 放弃一个还在建立的连接：它的握手仍可能迟到地到达服务端
        att.abandoned = true;
        markSelfKickWindow();
      }
    }
    if (info.code === KICKED_CLOSE_CODE) {
      if (selfKickTimer === null) {
        becomeKicked(info.kickedMsg || { t: 'kicked', reason: info.reason || 'replaced' });
        return;
      }
      // 多半是被自己刚放弃的旧连接顶掉：按普通断线重连（只宽容一次）
      selfKickTimer = clearTimeoutSafe(selfKickTimer);
      logger.warn('[socket] 连接被顶替，但刚放弃过一次连接，可能是自己迟到的旧连接，重新连接');
    }
    // 已发出的请求等不到回应了；排队的请求继续等下一次连接（各自有超时）
    failPending(sockError('offline', '连接已断开'));
    setStatus('closed');
    if (wanted) scheduleReconnect();
  }

  function markSelfKickWindow() {
    selfKickTimer = clearTimeoutSafe(selfKickTimer);
    selfKickTimer = T.setTimeout(() => {
      selfKickTimer = null;
    }, opt.selfKickWindowMs);
  }

  function becomeKicked(msg) {
    kicked = true;
    wanted = false;
    reconnectTimer = clearTimeoutSafe(reconnectTimer);
    const err = sockError('kicked', '账号已在其他设备登录');
    failPending(err);
    failQueue(err);
    settleWaiters(err);
    setStatus('closed');
    logger.warn('[socket] 被新连接顶替，不再自动重连');
    bus.emit('kicked', msg);
  }

  function scheduleReconnect() {
    if (!wanted || current || reconnectTimer !== null) return;
    const delay = Math.min(opt.backoffBaseMs * Math.pow(2, Math.min(attempts, 20)), opt.backoffMaxMs);
    attempts += 1;
    logger.info(`[socket] ${delay}ms 后重连`);
    reconnectTimer = T.setTimeout(() => {
      reconnectTimer = null;
      if (wanted && !current) openConnection();
    }, delay);
  }

  function reconnectNow(why) {
    if (!wanted) return;
    if (current) {
      if (current.opened) sendPing(); // 已连接：探一下活，死连接 10 秒内会被发现
      return;
    }
    reconnectTimer = clearTimeoutSafe(reconnectTimer);
    logger.info(`[socket] ${why}，立即重连`);
    openConnection();
  }

  function installHooks() {
    if (hooksInstalled) return;
    hooksInstalled = true;
    try {
      const w = getWx();
      if (typeof w.onAppShow === 'function') w.onAppShow(() => reconnectNow('回到前台'));
      if (typeof w.onNetworkStatusChange === 'function') {
        w.onNetworkStatusChange((res) => {
          if (res && res.isConnected) reconnectNow('网络恢复');
        });
      }
    } catch (err) {
      logger.warn('[socket] 注册前后台监听失败', err);
    }
  }

  // 连续打开前失败：可能是令牌过期。用 REST 校验一次（401 时 api 会清令牌并重新登录）
  async function verifyToken() {
    preOpenFailures = 0;
    if (api && typeof api.request === 'function') {
      try {
        await api.request({ method: 'GET', path: '/api/me' });
      } catch (err) {
        logger.warn('[socket] 校验登录状态失败', err);
      }
    } else if (lastToken) {
      auth.invalidate(lastToken);
    }
  }

  // ---------- 心跳 ----------

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = T.setInterval(sendPing, opt.heartbeatMs);
  }

  function stopHeartbeat() {
    if (heartbeatTimer !== null) {
      T.clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    pongTimer = clearTimeoutSafe(pongTimer);
  }

  function sendPing() {
    const att = current;
    if (!att || !att.opened || pongTimer !== null) return;
    const err = rawSend({ t: 'ping' }, (e) => logger.warn('[socket] ping 发送失败', e));
    if (err) logger.warn('[socket] ping 发送失败', err);
    // 发送失败也照样计时：收不到 pong 就重连
    pongTimer = T.setTimeout(() => {
      pongTimer = null;
      if (att !== current) return;
      logger.warn('[socket] 心跳超时，重新连接');
      handleDisconnect(att, { reason: 'pong_timeout' });
    }, opt.pongTimeoutMs);
  }

  return {
    connect,
    close,
    request,
    on: (t, fn) => bus.on(t, fn),
    off: (t, fn) => bus.off(t, fn),
    once: (t, fn) => bus.once(t, fn),
    getStatus: () => status,
    isReady: () => ready,
    getReadyData: () => readyData,
    isKicked: () => kicked,
  };
}

// 默认单例：运行时才读取全局 wx
const socket = createSocket({
  wx: () => wx,
  config: appConfig,
  auth: defaultAuth,
  api: defaultApi,
});

module.exports = socket;
module.exports.socket = socket;
module.exports.createSocket = createSocket;
module.exports.KICKED_CLOSE_CODE = KICKED_CLOSE_CODE;
