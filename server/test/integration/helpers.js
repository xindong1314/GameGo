'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../../src/app');
const { defaultConfig } = require('../../src/config');
const { createFakeAi } = require('../helpers/fake-ai');
const { TestClient } = require('../helpers/ws-client');

// 集成测试装置：真实的 startServer（真实 SQLite 文件、真实 HTTP、真实 WebSocket），只有 AI 是假的。
// 每个装置一个临时数据目录；restart() 关闭服务后在同一个数据库文件上重新启动（默认沿用同一端口）。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 一张真实的 1×1 PNG（带完整 IHDR/IDAT/IEND）
const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a0b5fd6a0000000049454e44ae426082',
  'hex',
);

// 记录日志；IT_LOG=1 时同时打印，便于排查
function createTestLogger({ echo = process.env.IT_LOG === '1' } = {}) {
  const logs = { debug: [], info: [], warn: [], error: [] };
  const make = (lv) => (...args) => {
    logs[lv].push(args);
    if (echo) console.log(`[server ${lv}]`, ...args);
  };
  return { debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error'), logs };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gamego-it-'));
}

function rmDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows 上偶发文件占用：临时目录留给系统清理
  }
}

// 启动完整服务。config 为 defaultConfig 的覆盖项。
async function startStack({ config = {}, ai, dataDir } = {}) {
  const dir = dataDir || tmpDir();
  const cfg = defaultConfig({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    dbPath: path.join(dir, 'gamego.db'),
    devLogin: true,
    publicBaseUrl: 'http://127.0.0.1:1', // 只用于拼头像地址，测试里按路径访问
    ...config,
  });
  const fakeAi = ai || createFakeAi();
  const stack = {
    dataDir: dir,
    config: cfg,
    ai: fakeAi,
    logger: null,
    app: null,
    url: '',
    wsUrl: '',
    clients: [],
  };

  async function boot(port) {
    stack.logger = createTestLogger();
    stack.app = await startServer({ config: { ...cfg, port }, ai: fakeAi, logger: stack.logger });
    stack.url = stack.app.url;
    stack.wsUrl = `${stack.app.url.replace(/^http/, 'ws')}/ws`;
    stack.repos = stack.app.repos;
  }

  await boot(cfg.port);

  // 关闭后在同一数据库文件上重新启动。samePort=false 时换随机端口。
  stack.restart = async ({ samePort = true } = {}) => {
    const port = stack.app.port;
    await stack.app.close();
    await boot(samePort ? port : 0);
  };

  // 每个请求一条新连接（agent: false）：重启服务时不会拿到旧进程的 keep-alive 连接
  stack.http = async (method, p, { token, body, form, headers = {} } = {}) => {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    let payload = null;
    if (form) {
      // 用 WHATWG Response 把 FormData 编码成真实的 multipart/form-data
      const encoded = new Response(form);
      h['content-type'] = encoded.headers.get('content-type');
      payload = Buffer.from(await encoded.arrayBuffer());
    } else if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body));
      h['content-type'] = 'application/json';
    }
    if (payload) h['content-length'] = String(payload.length);
    const u = new URL(stack.url + p);
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: u.hostname, port: u.port, method, path: u.pathname + u.search, headers: h, agent: false },
        (r) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, buf: Buffer.concat(chunks) }));
          r.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end(payload || undefined);
    });
    let json = null;
    try {
      json = JSON.parse(res.buf.toString('utf8'));
    } catch {
      json = null;
    }
    return { status: res.status, headers: { get: (k) => res.headers[k.toLowerCase()] }, json, buf: res.buf };
  };

  // 期望 200 并返回 JSON
  stack.api = async (method, p, opts) => {
    const r = await stack.http(method, p, opts);
    assert.equal(r.status, 200, `${method} ${p} → ${r.status} ${r.buf.toString('utf8')}`);
    return r.json;
  };

  // dev-login + 设置昵称 → { token, user }
  stack.login = async (deviceId, nickname) => {
    const r = await stack.api('POST', '/api/auth/dev-login', { body: { deviceId } });
    assert.equal(typeof r.token, 'string');
    if (nickname) {
      const p = await stack.api('PUT', '/api/me/profile', { token: r.token, body: { nickname } });
      return { token: r.token, user: p.user, id: p.user.id };
    }
    return { token: r.token, user: r.user, id: r.user.id };
  };

  stack.connect = async (token) => {
    const c = await TestClient.connect(stack.wsUrl, { token });
    stack.clients.push(c);
    return c;
  };

  // 登录 + 连接 + hello
  stack.player = async (deviceId, nickname) => {
    const u = await stack.login(deviceId, nickname);
    const c = await stack.connect(u.token);
    const hello = await c.req('hello');
    return { ...u, c, hello, nickname };
  };

  // 断线重连（同一令牌）+ hello
  stack.reconnect = async (p) => {
    const c = await stack.connect(p.token);
    p.c = c;
    p.hello = await c.req('hello');
    return p;
  };

  stack.noErrors = () => {
    assert.deepEqual(
      stack.logger.logs.error.map((a) => a.map((x) => (x instanceof Error ? x.stack : String(x))).join(' ')),
      [],
      '服务端不应有 error 日志',
    );
  };

  stack.close = async () => {
    for (const c of stack.clients) c.terminate();
    if (stack.app) await stack.app.close();
    rmDir(dir);
  };

  return stack;
}

// 两人快速匹配 → 双方 game.sync。返回 { gameId, 1: 黑方, 2: 白方, snap }
async function matchPair(a, b, size = 9) {
  assert.deepEqual(await a.c.req('match.join', { size }), { size });
  assert.deepEqual(await b.c.req('match.join', { size }), { size });
  const fa = await a.c.waitFor('match.found');
  const fb = await b.c.waitFor('match.found');
  assert.equal(fa.gameId, fb.gameId);
  return syncPair(a, b, fa.gameId);
}

async function syncPair(a, b, gameId) {
  const ga = (await a.c.req('game.sync', { gameId })).game;
  const gb = (await b.c.req('game.sync', { gameId })).game;
  assert.equal(ga.myColor + gb.myColor, 3);
  const byColor = ga.myColor === 1 ? { 1: a, 2: b, snap: ga } : { 1: b, 2: a, snap: gb };
  return { gameId, ...byColor, snaps: { [ga.myColor]: ga, [gb.myColor]: gb } };
}

// 轮流落子（-1 为 pass），双方都要收到 game.move 推送；返回各手的推送（黑方视角）。
// 每手之间稍等：服务端限流每连接每秒 20 条。
async function playMoves(g, moves, startN = 1, { pace = 40 } = {}) {
  let n = startN;
  const pushes = [];
  for (const idx of moves) {
    if (pace) await sleep(pace);
    const color = n % 2 === 1 ? 1 : 2;
    const p = g[color];
    if (idx === -1) await p.c.req('game.pass', { gameId: g.gameId, n });
    else await p.c.req('game.move', { gameId: g.gameId, n, idx });
    for (const c of [1, 2]) {
      const m = await g[c].c.waitFor('game.move', { filter: (x) => x.gameId === g.gameId && x.n === n });
      assert.equal(m.idx, idx, `第 ${n} 手`);
      assert.equal(m.color, color, `第 ${n} 手颜色`);
      if (c === 1) pushes.push(m);
    }
    n += 1;
  }
  return pushes;
}

// 9 路剧本：黑墙 x=4，白墙 x=5；白 10 被黑提掉（第 27 手 captured=[10]）；
// 白 20 留在黑地里（死子）。按 dead=[20] 计：黑 45，白 36+7.5=43.5 → B+1.5；不算死子则白胜。
const SCRIPT_CAPTURE = [
  4, 5, 13, 14, 22, 23, 31, 32, 40, 41, 49, 50, 58, 59, 67, 68, 76, 77, // 1-18 两道墙
  72, 10, 1, 20, 9, 7, 11, 16, 19, // 19-27：第 27 手黑 19 提白 10
];
const CAPTURE_N = 27;
const CAPTURED_IDX = 10;
const DEAD_WHITE = 20;

module.exports = {
  sleep,
  PNG_1X1,
  createTestLogger,
  startStack,
  matchPair,
  syncPair,
  playMoves,
  SCRIPT_CAPTURE,
  CAPTURE_N,
  CAPTURED_IDX,
  DEAD_WHITE,
};
