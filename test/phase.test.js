'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BLACK, WHITE } = require('../miniprogram/utils/engine/board');
const { createGame, play, pass, undo, resign, resume, finish } = require('../miniprogram/utils/engine/game');

test('autoScore 默认开启：两次 pass 直接终局（兼容本地对弈）', () => {
  const g = createGame({ size: 5 });
  assert.equal(g.autoScore, true);
  pass(g);
  pass(g);
  assert.equal(g.status, 'ended');
  assert.equal(g.result.reason, 'score');
});

test('autoScore=false：两次 pass 进入数子阶段，不产生结果', () => {
  const g = createGame({ size: 5, autoScore: false });
  play(g, 12);
  pass(g); // 白
  pass(g); // 黑
  assert.equal(g.status, 'scoring');
  assert.equal(g.result, null);
  assert.equal(g.toPlay, WHITE);
});

test('数子阶段拒绝落子与 pass，原因为 scoring', () => {
  const g = createGame({ size: 5, autoScore: false });
  pass(g);
  pass(g);
  assert.deepEqual(play(g, 0), { ok: false, reason: 'scoring' });
  assert.deepEqual(pass(g), { ok: false, reason: 'scoring' });
});

test('resume 回到对局，连续 pass 计数清零，轮到最先 pass 的一方', () => {
  const g = createGame({ size: 5, autoScore: false });
  pass(g); // 黑
  pass(g); // 白
  assert.deepEqual(resume(g), { ok: true });
  assert.equal(g.status, 'playing');
  assert.equal(g.consecutivePasses, 0);
  assert.equal(g.toPlay, BLACK);
  // 恢复后再一次 pass 不会立即终局
  pass(g);
  assert.equal(g.status, 'playing');
  assert.deepEqual(resume(g), { ok: false, reason: 'not-scoring' });
});

test('finish 由外部裁定终局，终局后不能再 finish', () => {
  const g = createGame({ size: 5, autoScore: false });
  pass(g);
  pass(g);
  assert.deepEqual(finish(g, { winner: WHITE, reason: 'score', black: 10, white: 22.5 }), { ok: true });
  assert.equal(g.status, 'ended');
  assert.deepEqual(g.result, { winner: WHITE, reason: 'score', black: 10, white: 22.5 });
  assert.deepEqual(finish(g, { winner: BLACK, reason: 'timeout' }), { ok: false, reason: 'ended' });

  const t = createGame({ size: 5, autoScore: false });
  finish(t, { winner: BLACK, reason: 'timeout' });
  assert.deepEqual(t.result, { winner: BLACK, reason: 'timeout', black: null, white: null });
});

test('数子阶段悔棋撤回最后一次 pass，回到对局', () => {
  const g = createGame({ size: 5, autoScore: false });
  play(g, 12);
  pass(g);
  pass(g);
  assert.equal(undo(g), true);
  assert.equal(g.status, 'playing');
  assert.equal(g.consecutivePasses, 1);
  assert.equal(g.toPlay, BLACK);
});

test('resign 可指定认输方；数子阶段也可认输', () => {
  const g = createGame({ size: 5, autoScore: false });
  play(g, 12); // 黑下完轮到白
  assert.deepEqual(resign(g, BLACK), { ok: true });
  assert.equal(g.result.winner, WHITE);

  const s = createGame({ size: 5, autoScore: false });
  pass(s);
  pass(s);
  assert.deepEqual(resign(s, WHITE), { ok: true });
  assert.equal(s.result.winner, BLACK);
  assert.equal(s.result.reason, 'resign');

  // 不传 color 时仍是当前行棋方认输（原本地对弈行为）
  const l = createGame({ size: 5 });
  resign(l);
  assert.equal(l.result.winner, WHITE);
});
