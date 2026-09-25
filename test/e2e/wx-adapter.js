'use strict';
// 由真实网络实现的 wx 适配器（一个模拟客户端一份）：
//   wx.request      → fetch
//   wx.uploadFile   → fetch + FormData（真实 multipart）
//   wx.connectSocket → 'ws' 客户端包装成 SocketTask（onOpen/onMessage/onClose/onError/send/close）
//   wx.login        → 成功返回假 code（服务端未配置微信 → 503 wx_not_configured → 客户端改走 dev-login）或直接失败
//   存储            → 内存
//   界面类接口      → 记录调用（navigateTo/redirectTo/showToast/...），showModal 自动确认
// 排查用：E2E_LOG=1 打印服务端与小程序代码的日志，E2E_TRACE=1 打印每条 WebSocket 收发消息。
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const serverRequire = createRequire(path.resolve(__dirname, '../../server/package.json'));
const WebSocket = serverRequire('ws');

function createWx({ name = 'client', login = 'code', logger = null } = {}) {
  const storage = new Map();
  const calls = [];
  const appShow = [];
  const netChange = [];
  const sockets = new Set();
  let currentSocket = null;
  const waiters = [];

  function record(api, arg) {
    calls.push({ api, arg });
    for (const w of waiters.slice()) {
      if (w.api === api && (!w.filter || w.filter(arg))) {
        waiters.splice(waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(arg);
      }
    }
  }

  function done(opts, method, res) {
    if (opts && typeof opts[method] === 'function') opts[method](res);
    if (opts && typeof opts.complete === 'function') opts.complete(res);
  }

  function log(...args) {
    if (logger) logger(`[wx ${name}]`, ...args);
  }

  const base = {
    // ---------- 存储 ----------
    getStorageSync(key) {
      return storage.has(key) ? JSON.parse(storage.get(key)) : '';
    },
    setStorageSync(key, value) {
      storage.set(key, JSON.stringify(value));
    },
    removeStorageSync(key) {
      storage.delete(key);
    },

    // ---------- 登录 ----------
    login(opts) {
      record('login', opts);
      setTimeout(() => {
        if (login === 'code') done(opts, 'success', { code: `fakecode-${name}`, errMsg: 'login:ok' });
        else done(opts, 'fail', { errMsg: 'login:fail 模拟失败' });
      }, 1);
    },

    // ---------- HTTP ----------
    request(opts) {
      record('request', { url: opts.url, method: opts.method || 'GET', data: opts.data });
      const method = (opts.method || 'GET').toUpperCase();
      let url = opts.url;
      const headers = { ...(opts.header || {}) };
      let body;
      if (opts.data !== undefined && opts.data !== null) {
        if (method === 'GET') {
          const q = new URLSearchParams(opts.data).toString();
          if (q) url += (url.includes('?') ? '&' : '?') + q;
        } else {
          body = typeof opts.data === 'string' ? opts.data : JSON.stringify(opts.data);
        }
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeout || 60000);
      fetch(url, { method, headers, body, signal: ctrl.signal })
        .then(async (res) => {
          const text = await res.text();
          let data = text;
          if ((opts.dataType || 'json') === 'json') {
            try {
              data = JSON.parse(text);
            } catch {
              data = text;
            }
          }
          const header = {};
          res.headers.forEach((v, k) => {
            header[k] = v;
          });
          clearTimeout(timer);
          done(opts, 'success', { statusCode: res.status, data, header, errMsg: 'request:ok' });
        })
        .catch((err) => {
          clearTimeout(timer);
          const msg = ctrl.signal.aborted ? 'timeout' : String(err && err.message);
          done(opts, 'fail', { errMsg: `request:fail ${msg}` });
        });
      return { abort: () => ctrl.abort() };
    },

    uploadFile(opts) {
      record('uploadFile', { url: opts.url, filePath: opts.filePath, name: opts.name });
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeout || 60000);
      Promise.resolve()
        .then(async () => {
          const buf = fs.readFileSync(opts.filePath);
          const form = new FormData();
          for (const [k, v] of Object.entries(opts.formData || {})) form.append(k, String(v));
          form.append(opts.name, new Blob([buf]), path.basename(opts.filePath));
          const res = await fetch(opts.url, { method: 'POST', headers: { ...(opts.header || {}) }, body: form, signal: ctrl.signal });
          const text = await res.text();
          clearTimeout(timer);
          // wx.uploadFile 的 data 总是字符串
          done(opts, 'success', { statusCode: res.status, data: text, errMsg: 'uploadFile:ok' });
        })
        .catch((err) => {
          clearTimeout(timer);
          done(opts, 'fail', { errMsg: `uploadFile:fail ${err && err.message}` });
        });
      return { abort: () => ctrl.abort(), onProgressUpdate() {} };
    },

    // ---------- WebSocket ----------
    connectSocket(opts) {
      record('connectSocket', { url: opts.url, header: opts.header ? { ...opts.header } : null });
      const handlers = { open: [], message: [], close: [], error: [] };
      let closed = false;
      const ws = new WebSocket(opts.url, { headers: opts.header || {} });
      const task = {
        ws,
        onOpen: (fn) => handlers.open.push(fn),
        onMessage: (fn) => handlers.message.push(fn),
        onClose: (fn) => handlers.close.push(fn),
        onError: (fn) => handlers.error.push(fn),
        send(o) {
          if (ws.readyState !== WebSocket.OPEN) {
            done(o, 'fail', { errMsg: 'sendSocketMessage:fail WebSocket is not connected' });
            return;
          }
          if (process.env.E2E_TRACE === '1') console.log(`[${name} >>]`, o.data);
          ws.send(o.data, (err) => {
            if (err) done(o, 'fail', { errMsg: `sendSocketMessage:fail ${err.message}` });
            else done(o, 'success', { errMsg: 'sendSocketMessage:ok' });
          });
        },
        close(o = {}) {
          try {
            if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
            else ws.close(o.code || 1000, o.reason || '');
            done(o, 'success', { errMsg: 'closeSocket:ok' });
          } catch (err) {
            done(o, 'fail', { errMsg: `closeSocket:fail ${err.message}` });
          }
        },
      };
      const emit = (type, arg) => {
        for (const fn of handlers[type].slice()) fn(arg);
      };
      ws.on('open', () => emit('open', { header: {} }));
      ws.on('message', (data, isBinary) => {
        if (process.env.E2E_TRACE === '1') console.log(`[${name} <<]`, isBinary ? '<binary>' : data.toString('utf8').slice(0, 300));
        emit('message', { data: isBinary ? data : data.toString('utf8') });
      });
      ws.on('unexpected-response', (req, res) => {
        log('握手被拒绝', res.statusCode);
        emit('error', { errMsg: `Invalid HTTP status ${res.statusCode}` });
        ws.terminate();
      });
      ws.on('error', (err) => emit('error', { errMsg: String(err && err.message) }));
      ws.on('close', (code, reason) => {
        if (closed) return;
        closed = true;
        sockets.delete(task);
        if (currentSocket === task) currentSocket = null;
        emit('close', { code, reason: reason ? reason.toString() : '' });
      });
      sockets.add(task);
      currentSocket = task;
      setTimeout(() => done(opts, 'success', { errMsg: 'connectSocket:ok' }), 0);
      return task;
    },

    // ---------- 前后台 / 网络 ----------
    onAppShow: (fn) => appShow.push(fn),
    offAppShow: (fn) => appShow.splice(appShow.indexOf(fn) >>> 0, 1),
    onNetworkStatusChange: (fn) => netChange.push(fn),

    // ---------- 界面：记录调用 ----------
    showModal(opts) {
      record('showModal', opts);
      setTimeout(() => done(opts, 'success', { confirm: true, cancel: false }), 0);
    },
  };

  const wx = new Proxy(base, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key !== 'string' || key === 'then') return undefined;
      // 其余 wx 接口（navigateTo、showToast、setKeepScreenOn、vibrateShort…）只记录；有 success 回调就回调
      return (arg) => {
        record(key, arg);
        if (arg && typeof arg === 'object') setTimeout(() => done(arg, 'success', { errMsg: `${key}:ok` }), 0);
        return undefined;
      };
    },
  });

  const control = {
    name,
    calls,
    storage,
    named: (api) => calls.filter((c) => c.api === api).map((c) => c.arg),
    // 等待某个 wx 接口被调用（已调用过的也算：从 since 起查找）
    waitFor(api, { filter, timeout = 5000, since = 0 } = {}) {
      const hit = calls.slice(since).find((c) => c.api === api && (!filter || filter(c.arg)));
      if (hit) return Promise.resolve(hit.arg);
      return new Promise((resolve, reject) => {
        const w = { api, filter, resolve, timer: null };
        w.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          reject(new Error(`[wx ${name}] 等待 wx.${api} 超时`));
        }, timeout);
        waiters.push(w);
      });
    },
    // 模拟网络突然断开：底层连接直接断掉（客户端收到 onClose 1006）
    dropSocket() {
      const t = currentSocket;
      if (!t) return false;
      t.ws.terminate();
      return true;
    },
    get socket() {
      return currentSocket;
    },
    triggerAppShow() {
      for (const fn of appShow.slice()) fn({});
    },
    closeAll() {
      for (const t of sockets) t.ws.terminate();
    },
  };

  return { wx, control };
}

module.exports = { createWx };
