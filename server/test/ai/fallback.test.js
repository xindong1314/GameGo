'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Board, BLACK, WHITE } = require('../../src/engine').board;
const { createFallbackAiService, chooseFallbackMove, isOwnEye, BASIC_LEVEL } = require('../../src/ai/fallback');
const { createAiService } = require('../../src/ai/service');
const { replayMoves, isLegal } = require('../../src/ai/common');
const { captureLogger, rejectsWith, mulberry32 } = require('./helpers');

function ai(opts = {}) {
  return createFallbackAiService({ config: { aiMinThinkMs: 0 }, logger: captureLogger(), rng: mulberry32(1), ...opts });
}

function board(size, stones) {
  const b = new Board(size);
  for (const [idx, c] of stones) b.set(idx, c);
  return b;
}

test('fallback: 接口与难度表', async () => {
  const s = ai();
  assert.equal(s.available(), true);
  assert.deepEqual(s.levels(), [{ id: 'basic', name: '内置练习 AI', desc: BASIC_LEVEL.desc }]);
  assert.match(BASIC_LEVEL.desc, /KataGo/);
  const err = await rejectsWith(s.judgeDead({ size: 9, komi: 7.5, moves: [-1, -1] }));
  assert.equal(err.code, 'ai_unavailable');
  await s.shutdown();
  assert.equal(s.available(), false);
  assert.equal((await rejectsWith(s.chooseMove({ size: 9, komi: 7.5, moves: [], color: 1, level: 'basic' }))).code, 'ai_unavailable');
});

test('fallback: 参数校验与真实服务一致；也接受 KataGo 难度 id', async () => {
  const s = ai();
  assert.equal((await rejectsWith(s.chooseMove({ size: 9, komi: 7.5, moves: [], color: 2, level: 'basic' }))).code, 'bad_request');
  assert.equal((await rejectsWith(s.chooseMove({ size: 9, komi: 7.5, moves: [], color: 1, level: 'zzz' }))).code, 'bad_request');
  assert.equal((await rejectsWith(s.chooseMove({ size: 8, komi: 7.5, moves: [], color: 1, level: 'basic' }))).code, 'bad_request');
  const r = await s.chooseMove({ size: 9, komi: 7.5, moves: [], color: 1, level: 'k8' });
  assert.equal(r.resign, false);
  assert.ok(r.move >= 0 && r.move < 81);
});

test('fallback: 能提子就提（提得多的优先）', async () => {
  // 黑 0 只剩一口气（白 1 已贴住），白走 9 提掉
  const s = ai();
  for (let seed = 1; seed <= 5; seed++) {
    const r = await createFallbackAiService({ config: { aiMinThinkMs: 0 }, rng: mulberry32(seed) }).chooseMove({
      size: 9,
      komi: 7.5,
      moves: [0, 1, 80],
      color: 2,
      level: 'basic',
    });
    assert.equal(r.move, 9);
  }
  // 两处可提：提 2 子的优先
  const b = board(9, [
    [0, BLACK], // 角上黑 1 子，气 9
    [1, WHITE],
    [30, BLACK], // 黑 30、31 两子，气只剩 32
    [31, BLACK],
    [21, WHITE],
    [22, WHITE],
    [29, WHITE],
    [39, WHITE],
    [40, WHITE],
  ]);
  assert.equal(chooseFallbackMove(b, WHITE, null, { rng: mulberry32(3) }), 32);
  assert.equal(chooseFallbackMove(b, WHITE, null, { rng: mulberry32(3), humanJustPassed: true }), 32, '对方 pass 后有子可提仍然提');
  assert.ok(s);
});

test('fallback: 不填自己的单点眼，不自己送吃', () => {
  // 白 1、9 围住角上 0：0 是白的眼
  const b = board(9, [
    [1, WHITE],
    [9, WHITE],
  ]);
  assert.equal(isOwnEye(b, 0, WHITE), true);
  assert.equal(isOwnEye(b, 0, BLACK), false);
  // 白 1 贴在角旁：黑下 0 后只剩 9 一口气，又没有提子 → 自己送吃，不下
  const b2 = board(9, [[1, WHITE]]);
  const rng = mulberry32(11);
  for (let i = 0; i < 300; i++) {
    assert.notEqual(chooseFallbackMove(b, WHITE, null, { rng }), 0);
    assert.notEqual(chooseFallbackMove(b2, BLACK, null, { rng }), 0);
  }
});

test('fallback: 没有合理的点 → pass；对方刚 pass 且无子可提 → pass', () => {
  // 整盘白子，只留几个单点眼：白不填眼，黑下进去是自杀 → 都 pass
  const size = 9;
  const eyes = new Set([0, 20, 44, 80]);
  const stones = [];
  for (let i = 0; i < size * size; i++) if (!eyes.has(i)) stones.push([i, WHITE]);
  const full = board(size, stones);
  assert.equal(chooseFallbackMove(full, WHITE, null, { rng: mulberry32(1) }), -1);
  assert.equal(chooseFallbackMove(full, BLACK, null, { rng: mulberry32(1) }), -1);
  // 空棋盘上对方刚 pass、无子可提
  assert.equal(chooseFallbackMove(new Board(9), BLACK, null, { humanJustPassed: true }), -1);
});

test('fallback: 两个内置 AI 对下一整盘，每手合法且能正常结束（不会陷入多劫循环）', async () => {
  for (const size of [9, 13]) {
    const s = createAiService({ config: { aiFallback: true, aiMinThinkMs: 0 }, rng: mulberry32(size) });
    assert.equal(s.kind, 'fallback');
    const moves = [];
    let passes = 0;
    while (passes < 2) {
      assert.ok(moves.length < size * size * 4, '对局应当能结束');
      const color = moves.length % 2 === 0 ? 1 : 2;
      const humanJustPassed = moves.length > 0 && moves[moves.length - 1] === -1;
      const r = await s.chooseMove({ size, komi: 7.5, moves, color, level: 'basic', humanJustPassed });
      assert.equal(r.resign, false);
      if (r.move !== -1) assert.ok(isLegal(replayMoves(size, 7.5, moves), color, r.move), `${size} 路第 ${moves.length + 1} 手`);
      passes = r.move === -1 ? passes + 1 : 0;
      moves.push(r.move);
    }
    assert.ok(moves.length > size * 2, `${size} 路下了 ${moves.length} 手`);
  }
});

test('fallback: 最短思考时间', async () => {
  const sleeps = [];
  const s = createFallbackAiService({ config: {}, now: () => 0, sleep: async (ms) => sleeps.push(ms) });
  await s.chooseMove({ size: 9, komi: 7.5, moves: [], color: 1, level: 'basic' });
  assert.deepEqual(sleeps, [600]);
});
