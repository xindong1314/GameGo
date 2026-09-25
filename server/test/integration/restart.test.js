'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeAi } = require('../helpers/fake-ai');
const {
  startStack,
  matchPair,
  syncPair,
  playMoves,
  sleep,
  SCRIPT_CAPTURE,
  CAPTURE_N,
  DEAD_WHITE,
} = require('./helpers');

// 集成：服务进程重启（close + 在同一数据库文件上 startServer）后恢复对局。

test('重启恢复排位赛：对局中重启 → 重连 → game.sync → 继续；数子阶段再重启 → 重新请求死子建议 → 终局，统计只计一次', async (t) => {
  const ai = createFakeAi({ dead: [DEAD_WHITE] });
  const s = await startStack({ ai });
  t.after(() => s.close());
  const a = await s.player('device-rs-a1', 'Ria');
  const b = await s.player('device-rs-b1', 'Rib');
  const g = await matchPair(a, b, 9);
  const first = SCRIPT_CAPTURE.slice(0, 12);
  const pushes = await playMoves(g, first);
  const saved = pushes[pushes.length - 1].clocks;

  // ---------- 对局中重启 ----------
  await s.restart();
  const closeA = await a.c.closed;
  assert.equal(closeA.code, 1001, '关机以 1001 关闭连接');
  await s.reconnect(a);
  await s.reconnect(b);
  assert.deepEqual(a.hello.activeGames, [{ id: g.gameId, mode: 'ranked' }]);
  assert.deepEqual(b.hello.activeGames, [{ id: g.gameId, mode: 'ranked' }]);
  assert.deepEqual((await s.api('GET', '/api/me', { token: a.token })).activeGameIds, [g.gameId]);
  const g2 = await syncPair(a, b, g.gameId);
  assert.equal(g2[1], g[1], '执子颜色不变');
  const snap = g2.snap;
  assert.equal(snap.status, 'playing');
  assert.deepEqual(snap.moves, first);
  assert.equal(snap.toPlay, 1);
  assert.equal(snap.clocks.running, 1);
  // 读秒按保存值继续（停机时间不计入）：白方存量不变，黑方从保存值开始走
  assert.deepEqual(snap.clocks[2], saved[2]);
  assert.ok(snap.clocks[1].mainMs <= saved[1].mainMs && snap.clocks[1].mainMs > saved[1].mainMs - 2000);
  assert.deepEqual(snap.presence, { 1: true, 2: true });
  // 旧的 n 不能再用
  await assert.rejects(g[1].c.req('game.move', { gameId: g.gameId, n: 12, idx: 60 }), (e) => e.code === 'stale');

  await playMoves(g2, SCRIPT_CAPTURE.slice(12), 13);
  await playMoves(g2, [-1, -1], CAPTURE_N + 1);
  const prop = await g[1].c.waitFor('game.scoring', { filter: (m) => !m.scoring.pending });
  assert.deepEqual(prop.scoring.dead, [DEAD_WHITE]);
  assert.equal(ai.calls.judgeDead.length, 1);
  await sleep(40);
  await g[1].c.req('game.score.accept', { gameId: g.gameId, version: 1 });

  // ---------- 数子阶段重启：确认清零，重新请求死子建议 ----------
  await s.restart();
  await s.reconnect(a);
  await s.reconnect(b);
  const g3 = await syncPair(a, b, g.gameId);
  assert.equal(g3.snap.status, 'scoring');
  assert.equal(g3.snap.clocks.running, null);
  assert.equal(ai.calls.judgeDead.length, 2, '重启后重新请求死子建议');
  const sc = g3.snap.scoring.pending
    ? (await g3[1].c.waitFor('game.scoring', { filter: (m) => !m.scoring.pending })).scoring
    : g3.snap.scoring;
  assert.equal(sc.version, 1);
  assert.deepEqual(sc.dead, [DEAD_WHITE]);
  assert.deepEqual(sc.accepted, { 1: false, 2: false });
  await sleep(40);
  await g3[1].c.req('game.score.accept', { gameId: g.gameId, version: 1 });
  await g3[2].c.req('game.score.accept', { gameId: g.gameId, version: 1 });
  const end = await g3[1].c.waitFor('game.end');
  assert.equal(end.result.text, 'B+1.5');
  assert.equal(end.result.counted, true);
  assert.equal(end.stats[1].wins, 1);
  await g3[2].c.waitFor('game.end');
  const rec = await s.api('GET', `/api/games/${g.gameId}`, { token: a.token });
  assert.deepEqual(rec.moves, [...SCRIPT_CAPTURE, -1, -1]);
  assert.deepEqual(rec.dead, [DEAD_WHITE]);

  // 再重启：已结束的对局不再恢复，统计不变
  const before = [s.repos.stats.get(g[1].id), s.repos.stats.get(g[2].id)];
  await s.restart();
  assert.deepEqual([s.repos.stats.get(g[1].id), s.repos.stats.get(g[2].id)], before);
  assert.deepEqual(s.repos.games.listUnfinished(), []);
  s.noErrors();
});

test('重启恢复人机对局：轮到玩家时重启；AI 思考中重启（重新请求 AI，旧结果作废）→ 继续到终局', async (t) => {
  const ai = createFakeAi({ dead: [] });
  const s = await startStack({ ai });
  t.after(() => s.close());
  const p = await s.player('device-rs-ai1', 'Solo');
  const { gameId } = await p.c.req('ai.start', { size: 9, level: 'd1', color: 'white' });
  // AI 执黑先下：推送只发给 game.sync 过的连接，所以第一手可能已经在快照里
  const s0 = (await p.c.req('game.sync', { gameId })).game;
  const m1 = s0.moves.length ? { idx: s0.moves[0], color: 1 } : await p.c.waitFor('game.move', { filter: (m) => m.n === 1 });
  assert.equal(m1.color, 1);
  if (!s0.moves.length) await p.c.waitFor('game.ai', { filter: (m) => !m.thinking });
  await sleep(30);
  await p.c.req('game.move', { gameId, n: 2, idx: 40 });
  const m3 = await p.c.waitFor('game.move', { filter: (m) => m.n === 3 });
  await p.c.waitFor('game.ai', { filter: (m) => !m.thinking });

  // ---------- 轮到玩家时重启 ----------
  await s.restart();
  await s.reconnect(p);
  assert.deepEqual(p.hello.activeGames, [{ id: gameId, mode: 'ai' }]);
  const snap = (await p.c.req('game.sync', { gameId })).game;
  assert.deepEqual(snap.moves, [m1.idx, 40, m3.idx]);
  assert.equal(snap.toPlay, 2);
  assert.equal(snap.aiThinking, false);
  assert.equal(snap.canUndo, true);
  assert.deepEqual(snap.players[1], { ai: true, level: 'd1', nickname: 'AI · 1段', avatarUrl: '' });

  // ---------- AI 思考中重启 ----------
  ai.set({ manual: true });
  await sleep(30);
  await p.c.req('game.move', { gameId, n: 4, idx: 30 });
  await p.c.waitFor('game.ai', { filter: (m) => m.thinking });
  assert.equal(ai.pendingMoves.length, 1);
  await s.restart();
  assert.equal(ai.pendingMoves.length, 2, '恢复时重新请求 AI 落子');
  assert.deepEqual(ai.pendingMoves[1].req.moves, [m1.idx, 40, m3.idx, 30]);
  assert.equal(ai.pendingMoves[1].req.color, 1);
  await s.reconnect(p);
  const snap2 = (await p.c.req('game.sync', { gameId })).game;
  assert.equal(snap2.aiThinking, true);
  ai.set({ manual: false });
  ai.resolveNextMove(); // 旧进程的请求：结果作废
  ai.resolveNextMove(); // 新进程的请求
  const m5 = await p.c.waitFor('game.move', { filter: (m) => m.n === 5 });
  assert.equal(m5.color, 1);
  await p.c.waitFor('game.ai', { filter: (m) => !m.thinking });
  await sleep(30);
  const snap3 = (await p.c.req('game.sync', { gameId })).game;
  assert.equal(snap3.moves.length, 5, '旧请求的结果没有被重复落下');

  // 玩家 pass → AI pass → 数子 → 确认
  await p.c.req('game.pass', { gameId, n: 6 });
  const prop = await p.c.waitFor('game.scoring', { filter: (m) => !m.scoring.pending });
  await sleep(30);
  await p.c.req('game.score.accept', { gameId, version: prop.scoring.version });
  const end = await p.c.waitFor('game.end');
  assert.equal(end.result.reason, 'score');
  assert.equal(end.result.counted, false);
  assert.deepEqual((await s.api('GET', '/api/me', { token: p.token })).ai.games, 1);
  s.noErrors();
});
