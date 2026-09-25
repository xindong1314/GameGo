'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('../../src/app');
const { defaultConfig } = require('../../src/config');
const { TestClient } = require('../helpers/ws-client');
const { createTestLogger, sleep } = require('./helpers');

// 集成：不注入 AI，startServer 按配置自己创建 AiService（延迟 require ./ai/service）。
// 只检查设计文档 7.1 的接口契约（AI 模块的具体策略由它自己的测试负责）：
//   - 未配置 KataGo、AI_FALLBACK=0 → 不可用：/api/ai/levels available=false，ai.start → ai_unavailable；
//   - AI_FALLBACK=1 → 内置弱 AI：能开局、落合法的子、玩家 pass 后能进入数子（judgeDead 失败 → 手动），关闭时由 startServer 负责 shutdown。

const HAS_AI = fs.existsSync(path.join(__dirname, '../../src/ai/service.js'));

async function boot(overrides) {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gamego-it-ai-'));
  const config = defaultConfig({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    dbPath: path.join(dir, 'gamego.db'),
    devLogin: true,
    katago: null,
    ...overrides,
  });
  const logger = createTestLogger();
  const app = await startServer({ config, logger });
  const base = app.url;
  async function json(method, p, { token, body } = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body) headers['content-type'] = 'application/json';
    const res = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  }
  const login = await json('POST', '/api/auth/dev-login', { body: { deviceId: 'device-real-ai' } });
  await json('PUT', '/api/me/profile', { token: login.json.token, body: { nickname: 'Solo' } });
  const c = await TestClient.connect(`${base.replace(/^http/, 'ws')}/ws`, { token: login.json.token });
  await c.req('hello');
  return {
    app,
    c,
    json,
    token: login.json.token,
    logger,
    async close() {
      c.terminate();
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

test('未配置 KataGo 且未开内置 AI：人机不可用', { skip: !HAS_AI && 'server/src/ai/service.js 尚未提供' }, async (t) => {
  const s = await boot({ aiFallback: false });
  t.after(() => s.close());
  const levels = await s.json('GET', '/api/ai/levels');
  assert.deepEqual(levels.json, { available: false, levels: [] });
  await assert.rejects(s.c.req('ai.start', { size: 9, level: 'k18', color: 'black' }), (e) => e.code === 'ai_unavailable');
  assert.deepEqual(s.logger.logs.error, []);
});

test('内置弱 AI（AI_FALLBACK=1）：开局、应手合法、玩家 pass 后进入数子并可确认', { skip: !HAS_AI && 'server/src/ai/service.js 尚未提供' }, async (t) => {
  const s = await boot({ aiFallback: true, aiMinThinkMs: 0 });
  t.after(() => s.close());
  const levels = await s.json('GET', '/api/ai/levels');
  assert.equal(levels.json.available, true);
  assert.ok(levels.json.levels.length >= 1);
  const level = levels.json.levels[0];
  assert.match(level.id, /^[A-Za-z0-9_.-]{1,32}$/);
  assert.equal(typeof level.name, 'string');

  const { gameId } = await s.c.req('ai.start', { size: 9, level: level.id, color: 'black' });
  const snap = (await s.c.req('game.sync', { gameId })).game;
  assert.equal(snap.players[2].ai, true);
  assert.equal(snap.players[2].level, level.id);
  // 玩家落几手，AI 每手都应合法地应对（落子或 pass）
  let n = 1;
  for (const idx of [40, 20, 60]) {
    const cur = (await s.c.req('game.sync', { gameId })).game;
    if (cur.status !== 'playing') break;
    n = cur.moves.length + 1;
    let pick = idx;
    while (cur.moves.includes(pick)) pick += 1;
    await sleep(30);
    await s.c.req('game.move', { gameId, n, idx: pick });
    const reply = await s.c.waitFor('game.move', { filter: (m) => m.n === n + 1, timeout: 5000 });
    assert.equal(reply.color, 2);
    assert.ok(reply.idx === -1 || (reply.idx >= 0 && reply.idx < 81));
  }
  // 玩家 pass：AI 要么 pass（进入数子），要么继续下；最多再 pass 几次直到进入数子
  for (let i = 0; i < 6; i++) {
    const cur = (await s.c.req('game.sync', { gameId })).game;
    if (cur.status === 'scoring') break;
    await sleep(30);
    await s.c.req('game.pass', { gameId, n: cur.moves.length + 1 });
    await s.c.waitFor('game.move', { filter: (m) => m.n === cur.moves.length + 2, timeout: 5000 }).catch(() => null);
  }
  const sc = await s.c.waitFor('game.scoring', { filter: (m) => !m.scoring.pending, timeout: 20000 });
  assert.equal(sc.scoring.accepted[2], true, 'AI 一方自动同意');
  await sleep(30);
  await s.c.req('game.score.accept', { gameId, version: sc.scoring.version });
  const end = await s.c.waitFor('game.end', { timeout: 5000 });
  assert.equal(end.result.reason, 'score');
  assert.deepEqual(s.logger.logs.error, []);
});
