'use strict';
// 在 Node 里加载真实的小程序代码：每个模拟客户端一份独立的模块缓存，
// 并把该客户端自己的 wx / Page / getApp / getCurrentPages 作为"全局变量"注入（小程序里它们就是全局的）。
// 这样两个客户端可以在同一个进程里同时运行，各自的 auth/api/socket 单例互不影响。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MP_ROOT = path.resolve(__dirname, '../../miniprogram');
const INJECTED = ['wx', 'Page', 'App', 'Component', 'getApp', 'getCurrentPages', 'console'];

// logger：注入给小程序代码的 console（默认真实 console）
function createRuntime({ wx, root = MP_ROOT, app = {}, logger = console } = {}) {
  if (!wx) throw new TypeError('createRuntime 需要 wx');
  const cache = new Map();
  const pageStack = [];
  let lastPageDef = null;
  let appDef = null;

  const globals = {
    wx,
    Page: (def) => {
      lastPageDef = def;
    },
    App: (def) => {
      appDef = def;
    },
    Component: () => {},
    getApp: () => app,
    getCurrentPages: () => pageStack.slice(),
    console: logger,
  };

  function resolveFile(from, spec) {
    let base;
    if (spec.startsWith('/')) base = path.join(root, spec);
    else base = path.resolve(path.dirname(from), spec);
    for (const f of [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')]) {
      if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
    }
    throw new Error(`[mp-runtime] 找不到模块 ${spec}（来自 ${from}）`);
  }

  function load(file) {
    const hit = cache.get(file);
    if (hit) return hit.exports;
    const module = { exports: {}, filename: file, loaded: false };
    cache.set(file, module);
    if (file.endsWith('.json')) {
      module.exports = JSON.parse(fs.readFileSync(file, 'utf8'));
      module.loaded = true;
      return module.exports;
    }
    const src = fs.readFileSync(file, 'utf8');
    const fn = vm.runInThisContext(
      `(function (exports, require, module, __filename, __dirname, ${INJECTED.join(', ')}) {${src}\n})`,
      { filename: file },
    );
    const req = (spec) => {
      if (spec.startsWith('.') || spec.startsWith('/')) return load(resolveFile(file, spec));
      throw new Error(`[mp-runtime] 小程序代码不应 require 非相对路径模块：${spec}（${file}）`);
    };
    try {
      fn.call(module.exports, module.exports, req, module, file, path.dirname(file), ...INJECTED.map((k) => globals[k]));
    } catch (err) {
      cache.delete(file);
      throw err;
    }
    module.loaded = true;
    return module.exports;
  }

  // rel 相对 miniprogram/，如 'utils/net/socket'
  function requireMp(rel) {
    return load(resolveFile(path.join(root, 'app.js'), `./${rel}`));
  }

  // 模拟 setData：数据经 JSON 序列化（与逻辑层 → 视图层的传输一致）
  function createPageInstance(def, route) {
    const page = { route, data: JSON.parse(JSON.stringify(def.data || {})), setDataCount: 0 };
    for (const [k, v] of Object.entries(def)) if (k !== 'data') page[k] = v;
    page.setData = function setData(patch, cb) {
      const copy = JSON.parse(JSON.stringify(patch));
      this.setDataCount += 1;
      for (const [k, v] of Object.entries(copy)) {
        if (k.includes('.') || k.includes('[')) throw new Error(`[mp-runtime] 测试环境不支持路径形式的 setData：${k}`);
        this.data[k] = v;
      }
      if (typeof cb === 'function') cb();
    };
    return page;
  }

  // 加载页面脚本并执行 onLoad(query) / onShow()。返回页面实例。
  function openPage(rel, query = {}) {
    lastPageDef = null;
    const file = resolveFile(path.join(root, 'app.js'), `./${rel}`);
    cache.delete(file); // 每次打开都重新执行页面脚本，得到新的定义
    load(file);
    if (!lastPageDef) throw new Error(`[mp-runtime] ${rel} 没有调用 Page()`);
    const page = createPageInstance(lastPageDef, rel);
    page.options = { ...query };
    pageStack.push(page);
    if (typeof page.onLoad === 'function') page.onLoad({ ...query });
    if (typeof page.onShow === 'function') page.onShow();
    return page;
  }

  // 卸载页面（redirectTo / navigateBack 时小程序会调用 onUnload）
  function closePage(page) {
    const i = pageStack.indexOf(page);
    if (i >= 0) pageStack.splice(i, 1);
    if (typeof page.onUnload === 'function') page.onUnload();
  }

  // 加载 app.js 并执行 onLaunch（this 为 App 定义对象，与小程序里 getApp() 拿到的实例相当）
  function launchApp() {
    requireMp('app');
    if (!appDef) throw new Error('[mp-runtime] app.js 没有调用 App()');
    if (typeof appDef.onLaunch === 'function') appDef.onLaunch.call(appDef, {});
    return appDef;
  }

  return { require: requireMp, openPage, closePage, launchApp, pages: pageStack, globals };
}

module.exports = { createRuntime, MP_ROOT };
