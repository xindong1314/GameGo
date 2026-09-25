'use strict';
// 页面测试工具：在 Node 里加载小程序页面（模拟 Page / wx / getCurrentPages），
// 并用替身替换 utils/net/{socket,auth,api}（这些模块由其他模块实现，页面只依赖设计文档里的接口）。

const path = require('node:path');
const Module = require('node:module');

const MINI_ROOT = path.join(__dirname, '..', '..', 'miniprogram');

// ---------- require 拦截 ----------

let mocks = {};
let installed = false;
const originalLoad = Module._load;

function installInterceptor() {
  if (installed) return;
  installed = true;
  Module._load = function (request, parent, isMain) {
    for (const key of Object.keys(mocks)) {
      if (request === key || request.endsWith('/' + key) || request.endsWith('/' + key + '.js')) {
        return mocks[key];
      }
    }
    return originalLoad.call(this, request, parent, isMain);
  };
}

function setMocks(next) {
  installInterceptor();
  mocks = {};
  Object.keys(next).forEach((k) => {
    if (next[k]) mocks[k] = next[k];
  });
}

// ---------- 小工具 ----------

async function flush(rounds = 12) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------- 替身 ----------

function createFakeSocket() {
  const listeners = {};
  const responders = {};
  const s = {
    calls: [],
    connectCalls: 0,
    closeCalls: 0,
    connect() {
      s.connectCalls += 1;
      return Promise.resolve();
    },
    close() {
      s.closeCalls += 1;
    },
    // 未设置应答的请求返回 undefined
    request(t, params, opts) {
      s.calls.push({ t, params, opts });
      const r = responders[t];
      if (!r) return Promise.resolve(undefined);
      return new Promise((resolve, reject) => {
        let out;
        try {
          out = r(params);
        } catch (e) {
          reject(e);
          return;
        }
        Promise.resolve(out).then(resolve, reject);
      });
    },
    respond(t, fn) {
      responders[t] = fn;
    },
    on(t, fn) {
      (listeners[t] = listeners[t] || []).push(fn);
    },
    off(t, fn) {
      listeners[t] = (listeners[t] || []).filter((f) => f !== fn);
    },
    emit(t, data) {
      (listeners[t] || []).slice().forEach((f) => f(data));
    },
    listenerCount(t) {
      return (listeners[t] || []).length;
    },
    totalListeners() {
      return Object.keys(listeners).reduce((n, k) => n + listeners[k].length, 0);
    },
    sent(t) {
      return s.calls.filter((c) => c.t === t);
    },
  };
  return s;
}

function createFakeAuth(opts = {}) {
  const a = {
    user: opts.user === undefined ? { id: 1, nickname: '小明', avatarUrl: '' } : opts.user,
    loginError: opts.loginError || null,
    loginCalls: 0,
    clearCalls: 0,
    setUserCalls: [],
    ensureLogin() {
      a.loginCalls += 1;
      return a.loginError ? Promise.reject(a.loginError) : Promise.resolve(a.user);
    },
    getUser() {
      return a.user;
    },
    setUser(u) {
      a.user = u;
      a.setUserCalls.push(u);
    },
    needProfile() {
      return !(a.user && a.user.nickname);
    },
    clear() {
      a.clearCalls += 1;
    },
  };
  return a;
}

// 路由键为 'GET /api/me'（不含查询串）；处理函数收到 request 的参数，返回数据或抛出 { code, msg }
function createFakeApi() {
  const routes = {};
  const api = {
    calls: [],
    uploads: [],
    uploadImpl: () => Promise.reject({ code: 'no_upload', msg: 'not stubbed' }),
    route(key, fn) {
      routes[key] = fn;
    },
    request(opts) {
      api.calls.push(opts);
      const key = String(opts.method || 'GET').toUpperCase() + ' ' + String(opts.path).split('?')[0];
      const fn = routes[key];
      if (!fn) return Promise.reject({ code: 'not_found', msg: 'no route ' + key });
      return new Promise((resolve, reject) => {
        let out;
        try {
          out = fn(opts);
        } catch (e) {
          reject(e);
          return;
        }
        Promise.resolve(out).then(resolve, reject);
      });
    },
    uploadAvatar(p) {
      api.uploads.push(p);
      return api.uploadImpl(p);
    },
    callsTo(key) {
      return api.calls.filter((c) => String(c.method || 'GET').toUpperCase() + ' ' + String(c.path).split('?')[0] === key);
    },
  };
  return api;
}

function createFakeWx() {
  const w = {
    calls: [],
    storage: {},
    failNext: {}, // { redirectTo: true } → 下一次该导航调用失败
    modalResponse: { confirm: true, cancel: false },
    privacy: { needAuthorization: false, privacyContractName: '《隐私保护指引》' },
    log(name, arg) {
      w.calls.push({ name, arg });
    },
    nav(name, o) {
      w.log(name, o);
      const opt = o || {};
      if (w.failNext[name]) {
        delete w.failNext[name];
        if (opt.fail) opt.fail({ errMsg: name + ':fail' });
      } else if (opt.success) {
        opt.success({ errMsg: name + ':ok' });
      }
      if (opt.complete) opt.complete();
    },
    navigateTo(o) { w.nav('navigateTo', o); },
    redirectTo(o) { w.nav('redirectTo', o); },
    reLaunch(o) { w.nav('reLaunch', o); },
    navigateBack(o) { w.nav('navigateBack', o); },
    showToast(o) { w.log('showToast', o); },
    showLoading(o) { w.log('showLoading', o); },
    hideLoading(o) { w.log('hideLoading', o); },
    setKeepScreenOn(o) { w.log('setKeepScreenOn', o); },
    showModal(o) {
      w.log('showModal', o);
      setImmediate(() => {
        if (o && o.success) o.success(Object.assign({}, w.modalResponse));
      });
    },
    setClipboardData(o) { w.nav('setClipboardData', o); },
    stopPullDownRefresh() { w.log('stopPullDownRefresh'); },
    getStorageSync(k) {
      return Object.prototype.hasOwnProperty.call(w.storage, k) ? w.storage[k] : '';
    },
    setStorageSync(k, v) {
      w.storage[k] = v;
    },
    getPrivacySetting(o) {
      w.log('getPrivacySetting', o);
      if (o && o.success) o.success(Object.assign({}, w.privacy));
    },
    openPrivacyContract(o) { w.nav('openPrivacyContract', o); },
    // 查询
    all(name) {
      return w.calls.filter((c) => c.name === name);
    },
    last(name) {
      const list = w.all(name);
      return list.length ? list[list.length - 1].arg : undefined;
    },
    count(name) {
      return w.all(name).length;
    },
    toasts() {
      return w.all('showToast').map((c) => c.arg.title);
    },
  };
  return w;
}

// ---------- 页面实例 ----------

function setPath(obj, key, value) {
  const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] === undefined || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function instantiate(def, route) {
  const page = { route };
  Object.keys(def).forEach((k) => {
    if (k !== 'data') page[k] = def[k];
  });
  page.data = structuredClone(def.data || {});
  page.setDataCalls = 0;
  page.setData = function (patch, cb) {
    page.setDataCalls += 1;
    Object.keys(patch).forEach((k) => setPath(page.data, k, structuredClone(patch[k])));
    if (cb) cb();
  };
  return page;
}

// rel 如 'match/match'；env = { wx, socket, auth, api, stackDepth }
function loadPageDef(rel, env) {
  setMocks({ 'net/socket': env.socket, 'net/auth': env.auth, 'net/api': env.api });
  global.wx = env.wx;
  const depth = env.stackDepth === undefined ? 2 : env.stackDepth;
  global.getCurrentPages = () => Array.from({ length: depth }, () => ({}));
  let def = null;
  global.Page = (d) => {
    def = d;
  };
  const file = require.resolve(path.join(MINI_ROOT, 'pages', rel));
  delete require.cache[file];
  require(file);
  if (!def) throw new Error('页面没有调用 Page(): ' + rel);
  return def;
}

// 页面栈：stackDepth - 1 个占位页面 + 这个页面（在栈顶）。env.stack 可在测试里修改（例如模拟别的页面被打开到上面）
function loadPage(rel, env) {
  const page = instantiate(loadPageDef(rel, env), 'pages/' + rel);
  const depth = env.stackDepth === undefined ? 2 : env.stackDepth;
  env.stack = Array.from({ length: Math.max(0, depth - 1) }, () => ({})).concat([page]);
  global.getCurrentPages = () => env.stack.slice();
  return page;
}

// 一套完整的测试环境
function createEnv(opts = {}) {
  return {
    wx: createFakeWx(),
    socket: createFakeSocket(),
    auth: createFakeAuth(opts),
    api: createFakeApi(),
    stackDepth: opts.stackDepth,
  };
}

module.exports = {
  MINI_ROOT,
  flush,
  deferred,
  createFakeSocket,
  createFakeAuth,
  createFakeApi,
  createFakeWx,
  createEnv,
  loadPage,
  loadPageDef,
  setMocks,
};
