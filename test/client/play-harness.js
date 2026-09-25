'use strict';
// 对局页 / 复盘页胶水代码测试用的最小运行环境：假 wx、假 socket、假 Page 实例，
// 以及把页面里 require 的 utils/net/*、utils/clock 等模块替换成假实现（这些模块由其他模块负责）。
const Module = require('node:module');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../miniprogram');

function norm(p) {
  return path.normalize(p).replace(/\.js$/, '').toLowerCase();
}

// 加载页面脚本，返回传给 Page() 的定义。fakes: { 'utils/net/socket': exports, ... }（相对 miniprogram/，不带扩展名）
function loadPage(rel, fakes) {
  const map = new Map();
  for (const [name, exp] of Object.entries(fakes)) {
    const id = `fake:${name}`;
    map.set(norm(path.join(ROOT, name)), id);
    const m = new Module(id);
    m.filename = id;
    m.loaded = true;
    m.exports = exp;
    require.cache[id] = m;
  }
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && parent.filename && request.startsWith('.')) {
      const key = norm(path.resolve(path.dirname(parent.filename), request));
      if (map.has(key)) return map.get(key);
    }
    return origResolve.call(this, request, parent, ...rest);
  };
  let def = null;
  global.Page = (d) => {
    def = d;
  };
  const file = path.join(ROOT, rel);
  try {
    delete require.cache[require.resolve(file)];
    require(file);
  } finally {
    Module._resolveFilename = origResolve;
    delete global.Page;
    for (const id of map.values()) delete require.cache[id];
  }
  if (!def) throw new Error(`${rel} 没有调用 Page()`);
  return def;
}

// 模拟 setData：数据经过 JSON 序列化（与真实的逻辑层 → 视图层传输一致，可发现 TypedArray 等不可传输的值）
function createPage(def) {
  const page = { data: JSON.parse(JSON.stringify(def.data || {})), setDataCalls: [] };
  for (const [k, v] of Object.entries(def)) {
    if (k !== 'data') page[k] = v;
  }
  page.setData = function (patch, cb) {
    const copy = JSON.parse(JSON.stringify(patch));
    this.setDataCalls.push(copy);
    Object.assign(this.data, copy);
    if (cb) cb();
  };
  return page;
}

function createWx(options = {}) {
  const calls = [];
  const rec = (name) => (arg) => {
    calls.push([name, arg]);
    return undefined;
  };
  const wx = {
    calls,
    named: (name) => calls.filter((c) => c[0] === name).map((c) => c[1]),
    setKeepScreenOn: rec('setKeepScreenOn'),
    vibrateShort: rec('vibrateShort'),
    navigateTo: rec('navigateTo'),
    redirectTo: rec('redirectTo'),
    reLaunch: rec('reLaunch'),
    navigateBack: rec('navigateBack'),
    showLoading: rec('showLoading'),
    hideLoading: rec('hideLoading'),
    showToast: rec('showToast'),
    setNavigationBarTitle: rec('setNavigationBarTitle'),
    pageScrollTo: rec('pageScrollTo'),
    setClipboardData(arg) {
      calls.push(['setClipboardData', arg]);
      if (arg && arg.success) arg.success();
    },
    showModal(arg) {
      calls.push(['showModal', arg]);
      if (arg && arg.success) arg.success({ confirm: options.modalConfirm !== false, cancel: options.modalConfirm === false });
    },
  };
  return wx;
}

// 假 socket 单例：记录订阅与请求，由测试决定请求何时、如何返回
function createSocket() {
  const handlers = new Map();
  const requests = [];
  return {
    requests,
    connects: 0,
    connect() {
      this.connects += 1;
      return Promise.resolve();
    },
    on(t, fn) {
      if (!handlers.has(t)) handlers.set(t, new Set());
      handlers.get(t).add(fn);
    },
    off(t, fn) {
      if (handlers.has(t)) handlers.get(t).delete(fn);
    },
    emit(t, data) {
      for (const fn of Array.from(handlers.get(t) || [])) fn(data);
    },
    count(t) {
      return handlers.has(t) ? handlers.get(t).size : 0;
    },
    total() {
      let n = 0;
      for (const s of handlers.values()) n += s.size;
      return n;
    },
    request(t, params, opts) {
      return new Promise((resolve, reject) => {
        requests.push({ t, params, opts, resolve, reject, done: false });
      });
    },
    // 取出最近一个指定类型且未处理的请求
    take(t) {
      for (let i = requests.length - 1; i >= 0; i--) {
        const r = requests[i];
        if (r.t === t && !r.done) {
          r.done = true;
          return r;
        }
      }
      return null;
    },
    pending(t) {
      return requests.filter((r) => r.t === t && !r.done).length;
    },
  };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function settle(times = 5) {
  for (let i = 0; i < times; i++) await flush();
}

module.exports = { loadPage, createPage, createWx, createSocket, settle };
