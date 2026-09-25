'use strict';

// 客户端单测共用：模拟的 wx 对象、可控的 SocketTask、假定时器、静默日志。
// 回调一律用 setImmediate 异步触发（与真机一致），测试里用 flush() / timers.tick() 推进。

function later(fn) {
  setImmediate(fn);
}

// 让出若干轮事件循环，跑完已排队的 Promise 续体与 setImmediate 回调
async function flush(rounds = 12) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

// ---------- 假定时器 ----------

class FakeTimers {
  constructor(now = 0) {
    this.now = now;
    this.seq = 0;
    this.timers = new Map();
    this.setTimeout = (fn, ms) => this._add(fn, ms, false);
    this.setInterval = (fn, ms) => this._add(fn, ms, true);
    this.clearTimeout = (id) => {
      this.timers.delete(id);
    };
    this.clearInterval = (id) => {
      this.timers.delete(id);
    };
  }

  _add(fn, ms, repeat) {
    if (typeof fn !== 'function') throw new TypeError('定时器回调必须是函数');
    const delay = Math.max(repeat ? 1 : 0, Number(ms) || 0);
    const id = ++this.seq;
    this.timers.set(id, { id, fn, at: this.now + delay, ms: delay, repeat });
    return id;
  }

  _next(end) {
    let best = null;
    for (const t of this.timers.values()) {
      if (t.at > end) continue;
      if (!best || t.at < best.at || (t.at === best.at && t.id < best.id)) best = t;
    }
    return best;
  }

  // 推进 ms 毫秒：按时间顺序逐个触发到期的定时器，每次触发前后都让异步续体跑完
  async tick(ms) {
    const end = this.now + ms;
    for (;;) {
      await flush();
      const t = this._next(end);
      if (!t) break;
      this.now = t.at;
      if (t.repeat) t.at += t.ms;
      else this.timers.delete(t.id);
      t.fn();
    }
    this.now = end;
    await flush();
  }

  count() {
    return this.timers.size;
  }
}

// ---------- SocketTask ----------

class FakeSocketTask {
  constructor(options, mock) {
    this.options = options;
    this.url = options.url;
    this.mock = mock;
    this.readyState = 0; // 0 连接中 1 已打开 3 已关闭
    this.sent = [];
    this.closeCalls = [];
    this.listeners = { open: [], message: [], close: [], error: [] };
  }

  onOpen(fn) {
    this.listeners.open.push(fn);
  }

  onMessage(fn) {
    this.listeners.message.push(fn);
  }

  onClose(fn) {
    this.listeners.close.push(fn);
  }

  onError(fn) {
    this.listeners.error.push(fn);
  }

  send({ data, success, fail } = {}) {
    if (this.readyState !== 1) {
      if (fail) later(() => fail({ errMsg: 'sendSocketMessage:fail WebSocket is not connected' }));
      return;
    }
    if (this.mock.sendFails) {
      if (fail) later(() => fail({ errMsg: 'sendSocketMessage:fail mocked' }));
      return;
    }
    this.sent.push(JSON.parse(data));
    if (success) later(() => success({ errMsg: 'sendSocketMessage:ok' }));
  }

  close({ code = 1000, reason = '', success, fail } = {}) {
    this.closeCalls.push({ code, reason });
    if (this.readyState === 3) {
      if (fail) later(() => fail({ errMsg: 'closeSocket:fail already closed' }));
      return;
    }
    this.readyState = 3;
    // 真机上 close() 之后 onClose 会异步触发——正好用来检验"旧连接的迟到回调被忽略"
    later(() => this._emit('close', { code, reason }));
    if (success) later(() => success({ errMsg: 'closeSocket:ok' }));
  }

  _emit(type, arg) {
    for (const fn of this.listeners[type].slice()) fn(arg);
  }

  // ---- 以下由测试调用，模拟服务端 ----

  serverOpen() {
    this.readyState = 1;
    this._emit('open', { header: {} });
  }

  serverSend(msg) {
    this._emit('message', { data: typeof msg === 'string' ? msg : JSON.stringify(msg) });
  }

  serverClose(code = 1006, reason = '') {
    this.readyState = 3;
    this._emit('close', { code, reason });
  }

  serverError(errMsg = 'mock error') {
    this._emit('error', { errMsg });
  }

  sentOf(t) {
    return this.sent.filter((m) => m.t === t);
  }

  lastSent(t) {
    const list = t ? this.sentOf(t) : this.sent;
    return list[list.length - 1];
  }

  reply(req, data) {
    this.serverSend(data === undefined ? { t: 'res', rid: req.rid, ok: true } : { t: 'res', rid: req.rid, ok: true, data });
  }

  replyError(req, code, msg = '') {
    this.serverSend({ t: 'res', rid: req.rid, ok: false, err: { code, msg } });
  }

  isClosedByClient() {
    return this.closeCalls.length > 0;
  }
}

// ---------- wx ----------

function ok(data, statusCode = 200) {
  return { statusCode, data };
}

function httpError(statusCode, code, msg = '') {
  return { statusCode, data: { error: { code, msg } } };
}

function createWxMock() {
  const mock = {
    storage: new Map(),
    storageThrows: false,
    loginCount: 0,
    // 返回 { code } 走 success；返回 { errMsg } 或抛错走 fail
    loginImpl: () => ({ code: `code${mock.loginCount}` }),
    requests: [],
    uploads: [],
    routes: new Map(),
    sockets: [],
    connectSocketFail: null, // 非空时 connectSocket 走 fail 回调（值为 errMsg）
    connectSocketThrows: false,
    sendFails: false,
    appShowHandlers: [],
    networkHandlers: [],
  };

  // key 形如 'POST /api/auth/login'；handler(ctx) 返回 { statusCode, data } 或 { fail: 'errMsg' }，可为 Promise
  mock.route = (key, handler) => {
    mock.routes.set(key, handler);
    return mock;
  };

  mock.requestsTo = (path) => mock.requests.filter((r) => new URL(r.url).pathname === path);

  async function dispatch(opts, method) {
    const u = new URL(opts.url);
    const handler = mock.routes.get(`${method} ${u.pathname}`);
    const ctx = {
      method,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      data: opts.data,
      header: opts.header || {},
      token: ((opts.header || {}).Authorization || '').replace(/^Bearer /, ''),
      opts,
    };
    if (!handler) return httpError(404, 'not_found', `no mock route for ${method} ${u.pathname}`);
    return handler(ctx);
  }

  function checkStorage() {
    if (mock.storageThrows) throw new Error('storage:fail mocked');
  }

  const wx = {
    getStorageSync(key) {
      checkStorage();
      return mock.storage.has(key) ? clone(mock.storage.get(key)) : '';
    },
    setStorageSync(key, value) {
      checkStorage();
      mock.storage.set(key, clone(value));
    },
    removeStorageSync(key) {
      checkStorage();
      mock.storage.delete(key);
    },

    login(opts = {}) {
      mock.loginCount += 1;
      later(async () => {
        let r;
        try {
          r = await mock.loginImpl();
        } catch (err) {
          r = { errMsg: `login:fail ${err.message}` };
        }
        if (r && r.errMsg) opts.fail && opts.fail(r);
        else opts.success && opts.success(Object.assign({ errMsg: 'login:ok' }, r));
      });
    },

    request(opts) {
      mock.requests.push(opts);
      later(async () => {
        let r;
        try {
          r = await dispatch(opts, String(opts.method || 'GET').toUpperCase());
        } catch (err) {
          r = { fail: err.message };
        }
        if (r.fail) opts.fail && opts.fail({ errMsg: `request:fail ${r.fail}` });
        else opts.success && opts.success({ statusCode: r.statusCode === undefined ? 200 : r.statusCode, data: r.data, header: {} });
      });
      return { abort() {} };
    },

    uploadFile(opts) {
      mock.uploads.push(opts);
      later(async () => {
        let r;
        try {
          r = await dispatch(opts, 'UPLOAD');
        } catch (err) {
          r = { fail: err.message };
        }
        if (r.fail) {
          opts.fail && opts.fail({ errMsg: `uploadFile:fail ${r.fail}` });
          return;
        }
        // 真机的 uploadFile 返回的 data 是字符串
        const data = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
        opts.success && opts.success({ statusCode: r.statusCode === undefined ? 200 : r.statusCode, data });
      });
      return { abort() {}, onProgressUpdate() {} };
    },

    connectSocket(opts) {
      if (mock.connectSocketThrows) throw new Error('connectSocket mocked throw');
      const task = new FakeSocketTask(opts, mock);
      mock.sockets.push(task);
      if (mock.connectSocketFail) {
        const errMsg = mock.connectSocketFail;
        later(() => opts.fail && opts.fail({ errMsg }));
      }
      return task;
    },

    onAppShow(fn) {
      mock.appShowHandlers.push(fn);
    },

    onNetworkStatusChange(fn) {
      mock.networkHandlers.push(fn);
    },
  };

  mock.wx = wx;
  mock.lastSocket = () => mock.sockets[mock.sockets.length - 1];
  mock.triggerAppShow = () => mock.appShowHandlers.forEach((fn) => fn({ scene: 1001 }));
  mock.triggerNetwork = (isConnected) => mock.networkHandlers.forEach((fn) => fn({ isConnected, networkType: 'wifi' }));
  return mock;
}

// 只记录不打印的日志对象，测试可断言某级别日志的条数
function createLogger() {
  const records = [];
  const make = (level) => (...args) => {
    records.push({ level, args });
  };
  return {
    records,
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    count(level) {
      return records.filter((r) => r.level === level).length;
    },
  };
}

module.exports = { createWxMock, FakeTimers, FakeSocketTask, createLogger, flush, ok, httpError };
