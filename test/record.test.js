'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BLACK, WHITE } = require('../miniprogram/utils/engine/board');
const { createGame, play, pass, undo } = require('../miniprogram/utils/engine/game');
const { PASS, idxToGtp, gtpToIdx, idxToSgf, sgfToIdx } = require('../miniprogram/utils/engine/coords');
const { movesOf, replay, resultText, resultLabel, toSgf } = require('../miniprogram/utils/engine/record');

test('GTP 坐标：跳过 I，行号自下而上', () => {
  assert.equal(idxToGtp(0, 19), 'A19');
  assert.equal(idxToGtp(18, 19), 'T19');
  assert.equal(idxToGtp(19 * 19 - 1, 19), 'T1');
  assert.equal(idxToGtp(8, 19), 'J19'); // x=8 是 J 不是 I
  assert.equal(idxToGtp(3 * 19 + 15, 19), 'Q16');
  assert.equal(idxToGtp(PASS, 9), 'pass');
  assert.equal(idxToGtp(80, 9), 'J1');
});

test('GTP 坐标往返一致，非法输入抛错', () => {
  for (const n of [9, 13, 19]) {
    for (let i = 0; i < n * n; i++) assert.equal(gtpToIdx(idxToGtp(i, n), n), i);
  }
  assert.equal(gtpToIdx('pass', 19), PASS);
  assert.equal(gtpToIdx('PASS', 19), PASS);
  assert.equal(gtpToIdx('q16', 19), 3 * 19 + 15);
  assert.throws(() => gtpToIdx('I5', 19));
  assert.throws(() => gtpToIdx('K5', 9)); // 9 路没有 K 列
  assert.throws(() => gtpToIdx('A10', 9));
  assert.throws(() => gtpToIdx('A0', 9));
  assert.throws(() => gtpToIdx('', 9));
  assert.throws(() => idxToGtp(81, 9));
  assert.throws(() => idxToGtp(0, 20));
});

test('SGF 坐标往返一致', () => {
  assert.equal(idxToSgf(0, 19), 'aa');
  assert.equal(idxToSgf(3 * 19 + 15, 19), 'pd');
  assert.equal(idxToSgf(PASS, 19), '');
  for (const n of [9, 13, 19]) {
    for (let i = 0; i < n * n; i++) assert.equal(sgfToIdx(idxToSgf(i, n), n), i);
  }
  assert.equal(sgfToIdx('', 9), PASS);
  assert.equal(sgfToIdx('tt', 19), PASS);
  assert.throws(() => sgfToIdx('jj', 9));
});

test('movesOf / replay 往返，pass 记为 -1', () => {
  const g = createGame({ size: 9 });
  play(g, 40);
  play(g, 41);
  pass(g);
  play(g, 50);
  const moves = movesOf(g);
  assert.deepEqual(moves, [40, 41, PASS, 50]);
  const r = replay(9, 7.5, moves);
  assert.deepEqual(Array.from(r.board.cells), Array.from(g.board.cells));
  assert.equal(r.toPlay, g.toPlay);
  assert.equal(r.autoScore, false);
});

test('replay：两次 pass 停在数子阶段；非法着手抛错并带位置', () => {
  const r = replay(9, 7.5, [40, PASS, PASS]);
  assert.equal(r.status, 'scoring');
  assert.throws(() => replay(9, 7.5, [40, 40]), (err) => err.moveIndex === 1 && err.reason === 'occupied');
  assert.throws(() => replay(9, 7.5, [40, PASS, PASS, 40]), (err) => err.moveIndex === 3 && err.reason === 'occupied');
});

test('replay：数子阶段之后的着手视为"继续对局"', () => {
  // 黑 40，白 pass，黑 pass → 数子；有人继续对局，轮到白（最先 pass 的一方）下 41
  const r = replay(9, 7.5, [40, PASS, PASS, 41]);
  assert.equal(r.status, 'playing');
  assert.equal(r.board.get(41), WHITE);
  assert.equal(r.consecutivePasses, 0);
  assert.equal(r.toPlay, BLACK);
  // 继续对局后只 pass 一次不会进入数子阶段，要再连续两次
  const r2 = replay(9, 7.5, [40, PASS, PASS, 41, PASS]);
  assert.equal(r2.status, 'playing');
  const r3 = replay(9, 7.5, [40, PASS, PASS, 41, PASS, PASS]);
  assert.equal(r3.status, 'scoring');
  // 继续对局后也可以直接 pass：[.., pass, pass, pass, pass] 是 数子→继续→再两次 pass
  const r4 = replay(9, 7.5, [40, PASS, PASS, PASS, PASS]);
  assert.equal(r4.status, 'scoring');
});

test('继续对局后悔棋：精确恢复连续 pass 计数，下一次 pass 不会直接进入数子', () => {
  const g = replay(9, 7.5, [40, PASS, PASS, 41]); // 白 41 之后轮到黑
  assert.equal(undo(g), true); // 撤回白 41
  assert.equal(g.status, 'playing');
  assert.equal(g.consecutivePasses, 0); // 继续对局时已清零，而不是按末尾两个 pass 算成 2
  assert.equal(g.toPlay, WHITE);
  pass(g);
  assert.equal(g.status, 'playing');
  // 撤回数子阶段的第二次 pass：回到 1
  const s = replay(9, 7.5, [40, PASS, PASS]);
  undo(s);
  assert.equal(s.status, 'playing');
  assert.equal(s.consecutivePasses, 1);
});

test('replay 正确处理提子', () => {
  // 黑围住角上白子并提掉：B a2(9), W a1(0), B b1(1) 提
  const r = replay(9, 7.5, [9, 0, 1]);
  assert.equal(r.board.get(0), 0);
  assert.equal(r.captures[BLACK], 1);
});

test('resultText / resultLabel', () => {
  assert.equal(resultText({ winner: BLACK, reason: 'resign' }), 'B+R');
  assert.equal(resultText({ winner: WHITE, reason: 'timeout' }), 'W+T');
  assert.equal(resultText({ winner: WHITE, reason: 'score', black: 180, white: 188.5 }), 'W+8.5');
  assert.equal(resultText({ winner: BLACK, reason: 'score', black: 44, white: 37 }), 'B+7');
  assert.equal(resultText({ winner: 0, reason: 'score', black: 40, white: 40 }), '0');
  assert.equal(resultText({ winner: 0, reason: 'abort' }), 'Void');
  assert.equal(resultText(null), '');
  assert.equal(resultLabel({ winner: BLACK, reason: 'resign' }), '黑中盘胜（对方认输）');
  assert.equal(resultLabel({ winner: WHITE, reason: 'timeout' }), '白胜（对方超时）');
  assert.equal(resultLabel({ winner: WHITE, reason: 'score', black: 180, white: 188.5 }), '白胜 8.5 目');
  assert.equal(resultLabel({ winner: 0, reason: 'abort' }), '对局作废');
});

test('toSgf', () => {
  const sgf = toSgf({
    size: 9,
    komi: 7.5,
    moves: [40, PASS, 0],
    blackName: '小明',
    whiteName: 'a]b',
    result: { winner: BLACK, reason: 'resign' },
    date: '2026-09-25',
  });
  assert.equal(
    sgf,
    '(;FF[4]GM[1]CA[UTF-8]AP[GameGo]RU[Chinese]SZ[9]KM[7.5]PB[小明]PW[a\\]b]DT[2026-09-25]RE[B+R];B[ee];W[];B[aa])'
  );
});
