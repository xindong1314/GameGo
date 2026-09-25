'use strict';
// 端到端装置：启动真实服务端（startServer + SQLite 文件 + 假 AI），
// 并创建"模拟客户端"：真实的小程序模块（utils/net/*、pages/*）+ 由真实网络实现的 wx。
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createRuntime } = require('./mp-runtime');
const { createWx } = require('./wx-adapter');

const SERVER = path.resolve(__dirname, '../../server');

// 运行条件：Node ≥ 22.13（node:sqlite 免 flag）且已安装服务端依赖（ws）
function prerequisites() {
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 13)) return `需要 Node ≥ 22.13（当前 ${process.versions.node}）`;
  if (!fs.existsSync(path.join(SERVER, 'node_modules', 'ws'))) return '需要先在 server/ 下 npm install';
  return '';
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function silentLogger(echo) {
  const logs = { debug: [], info: [], warn: [], error: [] };
  const make = (lv) => (...args) => {
    logs[lv].push(args);
    if (echo) console.log(`[server ${lv}]`, ...args);
  };
  return { debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error'), logs };
}

async function startE2EServer({ config = {}, ai } = {}) {
  const { startServer } = require(path.join(SERVER, 'src/app'));
  const { defaultConfig } = require(path.join(SERVER, 'src/config'));
  const { createFakeAi } = require(path.join(SERVER, 'test/helpers/fake-ai'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gamego-e2e-'));
  const port = await freePort();
  const cfg = defaultConfig({
    port,
    host: '127.0.0.1',
    dataDir,
    dbPath: path.join(dataDir, 'gamego.db'),
    devLogin: true,
    publicBaseUrl: `http://127.0.0.1:${port}`,
    ...config,
  });
  const logger = silentLogger(process.env.E2E_LOG === '1');
  const fakeAi = ai || createFakeAi();
  const srv = {
    app: await startServer({ config: cfg, ai: fakeAi, logger }),
    ai: fakeAi,
    logger,
    config: cfg,
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    dataDir,
    errors: () => logger.logs.error.map((a) => a.map((x) => (x instanceof Error ? x.stack : String(x))).join(' ')),
    // 模拟服务进程重启：关闭后在同一端口、同一数据库文件上重新启动
    async restart({ downMs = 0 } = {}) {
      await srv.app.close();
      if (downMs) await new Promise((r) => setTimeout(r, downMs));
      srv.app = await startServer({ config: cfg, ai: fakeAi, logger });
    },
    async close() {
      await srv.app.close();
      try {
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // 临时目录留给系统清理
      }
    },
  };
  return srv;
}

// 一个模拟客户端：独立的模块实例（auth/api/socket 单例各一份）与独立的 wx
function createClient(srv, name, { login = 'code' } = {}) {
  const echo = process.env.E2E_LOG === '1';
  const { wx, control } = createWx({ name, login, logger: echo ? console.log : null });
  // 小程序代码里的 console：记录下来（E2E_LOG=1 时同时打印），测试结束时检查没有 console.error
  const logs = [];
  const rec = (level) => (...args) => {
    logs.push({ level, args });
    if (echo) console.log(`[${name} ${level}]`, ...args);
  };
  const quiet = { log: rec('log'), info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') };
  const rt = createRuntime({ wx, logger: quiet });
  // 指向测试服务器：config.js 导出的是普通对象，网络层每次调用时读取其中的地址（不改生产默认值）
  const cfg = rt.require('config');
  cfg.API_BASE = srv.url;
  cfg.WS_URL = srv.wsUrl;
  cfg.DEV_LOGIN = true;
  // 网络层的日志默认打到 console；测试时静音（E2E_LOG=1 时保留）
  const client = {
    name,
    wx,
    control,
    rt,
    logs,
    errors: () => logs.filter((l) => l.level === 'error').map((l) => l.args.map((a) => (a && a.stack) || JSON.stringify(a)).join(' ')),
    config: cfg,
    auth: rt.require('utils/net/auth'),
    api: rt.require('utils/net/api'),
    socket: rt.require('utils/net/socket'),
    clock: rt.require('utils/clock'),
    M: rt.require('pages/play/model'),
    pages: [],
    // 执行 app.js 的 onLaunch（静默登录、注册好友房开局通知）
    launch() {
      return rt.launchApp();
    },
    open(rel, query) {
      const p = rt.openPage(rel, query);
      this.pages.push(p);
      return p;
    },
    close(page) {
      const i = this.pages.indexOf(page);
      if (i >= 0) this.pages.splice(i, 1);
      rt.closePage(page);
    },
    shutdown() {
      for (const p of this.pages.slice()) this.close(p);
      this.socket.close();
      control.closeAll();
    },
  };
  return client;
}

// 轮询直到 fn() 为真
async function waitUntil(fn, { timeout = 5000, interval = 10, what = '条件' } = {}) {
  const start = Date.now();
  for (;;) {
    let v;
    try {
      v = fn();
    } catch (err) {
      v = false;
    }
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`等待${what}超时`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 登录并设置昵称（与资料页保存时的调用相同）
async function loginAs(client, nickname) {
  await client.auth.ensureLogin();
  const res = await client.api.request({ method: 'PUT', path: '/api/me/profile', data: { nickname } });
  client.auth.setUser(res.user);
  return res.user;
}

// 匹配页：等 match.found → redirectTo 对局页；返回对局页地址
async function quickMatch(client, size) {
  const since = client.control.calls.length;
  const page = client.open('pages/match/match', { size: String(size) });
  const nav = await client.control.waitFor('redirectTo', {
    since,
    filter: (a) => a && typeof a.url === 'string' && a.url.startsWith('/pages/play/play'),
    timeout: 8000,
  });
  client.close(page);
  return nav.url;
}

// 按地址打开对局页并等快照加载
async function openPlay(client, url) {
  const q = Object.fromEntries(new URL(`http://x${url}`).searchParams);
  const page = client.open('pages/play/play', q);
  await waitUntil(() => page.data.loaded && page.model, { what: `${client.name} 对局页加载` });
  return page;
}

// 轮到的一方在自己的对局页上落子（选点 → 确定）或停一手（idx = -1），等两个页面都收到这一手
async function move(pages, n, idx) {
  const me = pages[n % 2 === 1 ? 1 : 2];
  const opp = pages[n % 2 === 1 ? 2 : 1];
  await sleep(35); // 服务端限流：每连接每秒 ≤ 20 条
  if (idx === -1) me.onPass();
  else {
    me.onPick({ detail: { idx } });
    me.onConfirm();
  }
  await waitUntil(() => me.model.moves.length === n && opp.model.moves.length === n, { what: `第 ${n} 手同步` });
}

module.exports = {
  prerequisites,
  startE2EServer,
  createClient,
  waitUntil,
  sleep,
  freePort,
  loginAs,
  quickMatch,
  openPlay,
  move,
};
