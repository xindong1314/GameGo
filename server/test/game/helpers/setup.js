'use strict';
const http = require('node:http');
const { createMemoryRepos } = require('../../helpers/memory-repos');
const { createFakeAi } = require('../../helpers/fake-ai');
const { TestClient } = require('../../helpers/ws-client');
const { createFakeClock } = require('./fake-clock');
const { buildSettings } = require('../../../src/game/settings');
const { GameManager } = require('../../../src/game/manager');
const { createRealtime } = require('../../../src/realtime');

// server-game 测试的公共装置：配置、日志、假 hub、管理器装置、端到端服务器。

function testConfig(overrides = {}) {
  return {
    port: 0,
    host: '127.0.0.1',
    publicBaseUrl: 'http://test.local/',
    dataDir: '',
    dbPath: ':memory:',
    avatarDir: '',
    wx: { appId: '', secret: '' },
    devLogin: true,
    katago: null,
    aiFallback: false,
    komi: 7.5,
    timeControls: {
      9: { mainMs: 180000, periods: 3, periodMs: 20000 },
      13: { mainMs: 360000, periods: 3, periodMs: 30000 },
      19: { mainMs: 600000, periods: 3, periodMs: 30000 },
    },
    minMovesRanked: 10,
    minGamesWinrate: 10,
    firstMoveTimeoutMs: 60000,
    abandonMs: 90000,
    scoringTimeoutMs: 180000,
    judgeTimeoutMs: 15000,
    aiIdleTimeoutMs: 86400000,
    roomTtlMs: 1800000,
    ...overrides,
  };
}

// 记录 warn/error 的日志，便于断言"没有意外错误"
function createTestLogger({ echo = false } = {}) {
  const logs = { debug: [], info: [], warn: [], error: [] };
  const make = (lv) => (...args) => {
    logs[lv].push(args);
    if (echo) console.log(`[${lv}]`, ...args);
  };
  return { debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error'), logs };
}

// 管理器单测用的假 hub：记录所有推送；online 集合决定 isOnline
function createFakeHub() {
  const hub = {
    online: new Set(),
    sent: [],
    isOnline: (uid) => hub.online.has(uid),
    send: (userId, msg) => hub.sent.push({ userId, gameId: null, msg }),
    sendGame: (userId, gameId, msg) => hub.sent.push({ userId, gameId, msg }),
    batch: (fn) => fn(),
    // 某用户收到的某类推送
    of(t, userId) {
      return hub.sent.filter((s) => s.msg.t === t && (userId === undefined || s.userId === userId)).map((s) => s.msg);
    },
    types(userId) {
      return hub.sent.filter((s) => userId === undefined || s.userId === userId).map((s) => s.msg.t);
    },
    clear() {
      hub.sent.length = 0;
    },
  };
  return hub;
}

// 管理器 + 假时间 + 内存仓储 + 假 AI + 两个在线玩家
function setupManager({ config, ai, repos, online = true, randomSeq } = {}) {
  const clock = createFakeClock();
  const r = repos || createMemoryRepos();
  const hub = createFakeHub();
  const fakeAi = ai || createFakeAi();
  const settings = buildSettings(testConfig(config));
  const logger = createTestLogger();
  const seq = randomSeq ? [...randomSeq] : null;
  const randomInt = (a, b) => {
    if (seq && seq.length) return seq.shift();
    const lo = b === undefined ? 0 : a;
    const hi = b === undefined ? a : b;
    return lo + Math.floor(Math.random() * (hi - lo));
  };
  const alice = r.users.create({ openid: 'dev:alice', nickname: 'Alice', avatar: 'a1.png' }, clock.now());
  const bob = r.users.create({ openid: 'dev:bob', nickname: 'Bob' }, clock.now());
  const carol = r.users.create({ openid: 'dev:carol', nickname: 'Carol' }, clock.now());
  if (online) {
    hub.online.add(alice.id);
    hub.online.add(bob.id);
  }
  const make = () =>
    new GameManager({ repos: r, ai: fakeAi, settings, logger, now: clock.now, timers: clock.timers, hub, randomInt });
  const manager = make();
  return { clock, repos: r, hub, ai: fakeAi, settings, logger, manager, alice, bob, carol, makeManager: make };
}

// 端到端：真实 http 服务器（端口 0）+ createRealtime + 内存仓储 + 假 AI + 真实 ws 客户端
async function startServer({ config, ai, repos, timers, now, logger, hubLimits } = {}) {
  const r = repos || createMemoryRepos();
  const fakeAi = ai || createFakeAi();
  const log = logger || createTestLogger();
  const httpServer = http.createServer((req, res) => {
    res.statusCode = 404;
    res.end('not found');
  });
  const opts = { httpServer, repos: r, ai: fakeAi, config: testConfig(config), logger: log };
  if (timers) opts.timers = timers;
  if (now) opts.now = now;
  if (hubLimits) opts.hubLimits = hubLimits;
  const realtime = createRealtime(opts);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();
  const wsUrl = `ws://127.0.0.1:${port}/ws`;
  const clients = [];
  let n = 0;

  function user(nickname) {
    n += 1;
    const u = r.users.create({ openid: `dev:${nickname || 'u'}${n}`, nickname: nickname || `U${n}` }, Date.now());
    const token = r.sessions.create(u.id, Date.now());
    return { user: u, id: u.id, token };
  }

  async function connect(token, opts2) {
    const c = await TestClient.connect(wsUrl, { token, ...opts2 });
    clients.push(c);
    return c;
  }

  // 新用户并连接、hello
  async function player(nickname) {
    const u = user(nickname);
    const c = await connect(u.token);
    await c.req('hello');
    return { ...u, c };
  }

  async function close() {
    for (const c of clients) c.terminate();
    await realtime.close();
    httpServer.closeAllConnections();
    await new Promise((resolve) => httpServer.close(resolve));
  }

  return { repos: r, ai: fakeAi, realtime, httpServer, wsUrl, port, user, connect, player, close, logger: log };
}

module.exports = { testConfig, createTestLogger, createFakeHub, setupManager, startServer };
