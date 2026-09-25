'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PASS, colorOfMove, isValidMove, replayMoves, cloneState, lastPlacedIdx } = require('../../miniprogram/pages/play/moves');
const { replay } = require('../../miniprogram/utils/engine/record');
const { play } = require('../../miniprogram/utils/engine/game');

test('colorOfMove：奇数手为黑', () => {
  assert.equal(colorOfMove(1), 1);
  assert.equal(colorOfMove(2), 2);
  assert.equal(colorOfMove(101), 1);
});

test('isValidMove', () => {
  assert.equal(isValidMove(PASS, 9), true);
  assert.equal(isValidMove(0, 9), true);
  assert.equal(isValidMove(80, 9), true);
  assert.equal(isValidMove(81, 9), false);
  assert.equal(isValidMove(-2, 9), false);
  assert.equal(isValidMove(1.5, 9), false);
  assert.equal(isValidMove('3', 9), false);
  assert.equal(isValidMove(null, 9), false);
});

test('replayMoves 与 record.replay 对普通序列结果一致', () => {
  const moves = [40, 41, 9, 0, 1, PASS, 50];
  const a = replayMoves(9, 7.5, moves);
  const b = replay(9, 7.5, moves);
  assert.deepEqual(Array.from(a.board.cells), Array.from(b.board.cells));
  assert.deepEqual(a.captures, b.captures);
  assert.equal(a.toPlay, b.toPlay);
  assert.equal(a.status, 'playing');
  assert.equal(replayMoves(9, 7.5, [40, PASS, PASS]).status, 'scoring');
  assert.equal(replayMoves(9, 7.5, []).status, 'playing');
  assert.equal(replayMoves(9, 7.5, undefined).history.length, 0);
});

test('replayMoves：两次 pass 之后还有着手 → 视为继续对局', () => {
  // 引擎的 record.replay 现在也按"继续对局"处理，两者结果一致
  const viaEngine = replay(9, 7.5, [40, PASS, PASS, 41]);
  const viaPage = replayMoves(9, 7.5, [40, PASS, PASS, 41]);
  assert.deepEqual(Array.from(viaEngine.board.cells), Array.from(viaPage.board.cells));
  assert.equal(viaEngine.status, viaPage.status);
  assert.equal(viaEngine.toPlay, viaPage.toPlay);
  assert.equal(viaEngine.consecutivePasses, viaPage.consecutivePasses);
  const s = replayMoves(9, 7.5, [40, PASS, PASS, 41, PASS, PASS]);
  assert.equal(s.board.get(40), 1);
  assert.equal(s.board.get(41), 2);
  assert.equal(s.status, 'scoring');
  // 继续后一方 pass 不会立即进入数子
  const t = replayMoves(9, 7.5, [PASS, PASS, PASS]);
  assert.equal(t.status, 'playing');
  assert.equal(t.toPlay, 2);
});

test('replayMoves：非法着手抛错并带位置', () => {
  assert.throws(() => replayMoves(9, 7.5, [40, 40]), (err) => err.moveIndex === 1 && err.reason === 'occupied');
  assert.throws(() => replayMoves(9, 7.5, [40, 81]), (err) => err.moveIndex === 1 && err.reason === 'invalid');
  assert.throws(() => replayMoves(9, 7.5, ['a']), (err) => err.moveIndex === 0 && err.reason === 'invalid');
});

test('replayMoves：onMove 每手回调一次', () => {
  const seen = [];
  replayMoves(9, 7.5, [40, PASS, 41], { onMove: (state, i) => seen.push([i, state.history.length]) });
  assert.deepEqual(seen, [[0, 1], [1, 2], [2, 3]]);
});

test('cloneState：修改副本不影响原局面', () => {
  const s = replayMoves(9, 7.5, [1, 0]);
  const c = cloneState(s);
  play(c, 9); // 黑提白 0
  assert.equal(c.board.get(0), 0);
  assert.equal(s.board.get(0), 2);
  assert.equal(c.captures[1], 1);
  assert.equal(s.captures[1], 0);
  assert.equal(s.history.length, 2);
  assert.equal(c.history.length, 3);
  assert.equal(s.toPlay, 1);
});

test('lastPlacedIdx 跳过 pass', () => {
  assert.equal(lastPlacedIdx(replayMoves(9, 7.5, [])), -1);
  assert.equal(lastPlacedIdx(replayMoves(9, 7.5, [PASS])), -1);
  assert.equal(lastPlacedIdx(replayMoves(9, 7.5, [40, PASS])), 40);
  assert.equal(lastPlacedIdx(replayMoves(9, 7.5, [40, 41])), 41);
});
