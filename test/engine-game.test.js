'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Board, EMPTY, BLACK, WHITE } = require('../miniprogram/utils/engine/board');
const { createGame, play, pass, undo, resign, resume, finish } = require('../miniprogram/utils/engine/game');
const { score } = require('../miniprogram/utils/engine/score');
const { fromDiagram, toDiagram } = require('./helpers');

// 4 路打劫形：黑下 6 提白 5，形成劫
const KO_SHAPE = `
  . X O .
  X O . O
  . X O .
  . . . .
`;

// 以给定局面开局（轮到 toPlay）
function gameFrom(diagram, toPlay = BLACK, opts = {}) {
  const b = fromDiagram(diagram);
  const g = createGame(Object.assign({ size: b.n }, opts));
  g.board.cells.set(b.cells);
  g.toPlay = toPlay;
  return g;
}

test('createGame：默认值与字段', () => {
  const g = createGame();
  assert.ok(g.board instanceof Board);
  assert.equal(g.board.n, 19);
  assert.deepEqual(Object.assign({}, g, { board: null }), {
    board: null,
    size: 19,
    komi: 7.5,
    autoScore: true,
    toPlay: BLACK,
    ko: null,
    history: [],
    captures: { 1: 0, 2: 0 },
    consecutivePasses: 0,
    status: 'playing',
    result: null,
  });
});

test('createGame：自定义路数、贴目、autoScore', () => {
  const g = createGame({ size: 9, komi: 6.5, autoScore: false });
  assert.equal(g.size, 9);
  assert.equal(g.board.n, 9);
  assert.equal(g.komi, 6.5);
  assert.equal(g.autoScore, false);
  assert.equal(createGame({ size: 13 }).komi, 7.5);
});

test('每局独立：不共享棋盘、历史与提子计数', () => {
  const a = createGame({ size: 9 });
  const b = createGame({ size: 9 });
  play(a, 40);
  assert.equal(b.board.get(40), EMPTY);
  assert.equal(b.history.length, 0);
  assert.notEqual(a.captures, b.captures);
});

test('轮流落子：黑先，成功时恰好返回 { ok: true }', () => {
  const g = createGame({ size: 9 });
  assert.deepEqual(play(g, 40), { ok: true });
  assert.equal(g.board.get(40), BLACK);
  assert.equal(g.toPlay, WHITE);
  assert.deepEqual(play(g, 41), { ok: true });
  assert.equal(g.board.get(41), WHITE);
  assert.equal(g.toPlay, BLACK);
});

test('history 项：字段与顺序固定', () => {
  const g = createGame({ size: 9 });
  play(g, 40);
  pass(g);
  assert.deepEqual(g.history, [
    { color: BLACK, idx: 40, captured: [], koBefore: null, koAfter: null, passesBefore: 0 },
    { color: WHITE, idx: null, captured: [], koBefore: null, koAfter: null, passesBefore: 0 },
  ]);
  assert.deepEqual(Object.keys(g.history[0]), ['color', 'idx', 'captured', 'koBefore', 'koAfter', 'passesBefore']);
  assert.deepEqual(Object.keys(g.history[1]), ['color', 'idx', 'captured', 'koBefore', 'koAfter', 'passesBefore']);
});

test('非法落子原样返回原因，状态不变', () => {
  const g = createGame({ size: 9 });
  play(g, 40);
  assert.deepEqual(play(g, 40), { ok: false, reason: 'occupied' });
  assert.deepEqual(play(g, -1), { ok: false, reason: 'invalid' });
  assert.deepEqual(play(g, 81), { ok: false, reason: 'invalid' });
  assert.equal(g.toPlay, WHITE);
  assert.equal(g.history.length, 1);
});

test('提子计入 captures，captured 记在 history 里', () => {
  const g = gameFrom(`
    . X .
    X O X
    . . .
  `);
  play(g, 7); // 黑 (1,2) 提白 (1,1)
  assert.equal(g.captures[BLACK], 1);
  assert.equal(g.captures[WHITE], 0);
  assert.deepEqual(g.history[0].captured, [4]);
  assert.equal(g.board.get(4), EMPTY);
});

test('打劫：劫点记在状态与历史里，对方不能立即提回', () => {
  const g = gameFrom(KO_SHAPE);
  play(g, 6);
  assert.equal(g.ko, 5);
  assert.deepEqual(g.history[0], { color: BLACK, idx: 6, captured: [5], koBefore: null, koAfter: 5, passesBefore: 0 });
  assert.deepEqual(play(g, 5), { ok: false, reason: 'ko' });
  assert.equal(g.toPlay, WHITE);
});

test('打劫：别处落子后劫点解除，可以提回', () => {
  const g = gameFrom(KO_SHAPE);
  play(g, 6); // 黑提劫
  play(g, 15); // 白找劫材
  assert.equal(g.ko, null);
  assert.equal(g.history[1].koBefore, 5);
  play(g, 12); // 黑应
  assert.deepEqual(play(g, 5), { ok: true }); // 白提回
  assert.equal(g.ko, 6);
  assert.equal(g.captures[WHITE], 1);
});

test('pass：换手、计数、解除劫点', () => {
  const g = gameFrom(KO_SHAPE);
  play(g, 6);
  assert.deepEqual(pass(g), { ok: true });
  assert.equal(g.toPlay, BLACK);
  assert.equal(g.ko, null);
  assert.equal(g.consecutivePasses, 1);
  assert.deepEqual(g.history[1], { color: WHITE, idx: null, captured: [], koBefore: 5, koAfter: null, passesBefore: 0 });
  // 黑随后落子，计数清零
  play(g, 15);
  assert.equal(g.consecutivePasses, 0);
  assert.equal(g.history[2].passesBefore, 1);
});

test('autoScore 为真：双方连续 pass 按 Tromp-Taylor 计分终局', () => {
  const g = createGame({ size: 5, komi: 0.5 });
  play(g, 12);
  pass(g);
  assert.equal(g.status, 'playing');
  pass(g);
  assert.equal(g.status, 'ended');
  assert.equal(g.consecutivePasses, 2);
  const s = score(g.board, 0.5);
  assert.deepEqual(g.result, { winner: BLACK, black: s.black, white: s.white, reason: 'score' });
  assert.equal(g.result.black, 25);
  assert.equal(g.result.white, 0.5);
});

test('autoScore 为真：空盘两次 pass，贴目让白胜', () => {
  const g = createGame({ size: 9 });
  pass(g);
  pass(g);
  assert.deepEqual(g.result, { winner: WHITE, black: 0, white: 7.5, reason: 'score' });
});

test('autoScore 为假：进入数子阶段，结果为 null', () => {
  const g = createGame({ size: 9, autoScore: false });
  pass(g);
  pass(g);
  assert.equal(g.status, 'scoring');
  assert.equal(g.result, null);
  assert.equal(g.toPlay, BLACK);
});

test('非对局中不能落子与 pass：scoring 与 ended 两种原因', () => {
  const s = createGame({ size: 9, autoScore: false });
  pass(s);
  pass(s);
  assert.deepEqual(play(s, 40), { ok: false, reason: 'scoring' });
  assert.deepEqual(pass(s), { ok: false, reason: 'scoring' });
  assert.equal(s.history.length, 2);

  const e = createGame({ size: 9 });
  pass(e);
  pass(e);
  assert.deepEqual(play(e, 40), { ok: false, reason: 'ended' });
  assert.deepEqual(pass(e), { ok: false, reason: 'ended' });
  assert.equal(e.history.length, 2);
  assert.equal(e.board.get(40), EMPTY);
});

test('resume：只在数子阶段有效，轮到谁不变', () => {
  const g = createGame({ size: 9, autoScore: false });
  assert.deepEqual(resume(g), { ok: false, reason: 'not-scoring' });
  play(g, 40);
  pass(g); // 白
  pass(g); // 黑
  assert.equal(g.toPlay, WHITE);
  assert.deepEqual(resume(g), { ok: true });
  assert.equal(g.status, 'playing');
  assert.equal(g.consecutivePasses, 0);
  assert.equal(g.toPlay, WHITE);
  assert.deepEqual(play(g, 41), { ok: true });

  const e = createGame({ size: 9 });
  pass(e);
  pass(e);
  assert.deepEqual(resume(e), { ok: false, reason: 'not-scoring' });
  assert.equal(e.status, 'ended');
});

test('finish：对局中、数子阶段都可以；缺省的 black/white 为 null；传入的字段覆盖默认', () => {
  const g = createGame({ size: 9 });
  assert.deepEqual(finish(g, { winner: WHITE, reason: 'timeout' }), { ok: true });
  assert.equal(g.status, 'ended');
  assert.deepEqual(g.result, { winner: WHITE, reason: 'timeout', black: null, white: null });
  assert.deepEqual(finish(g, { winner: BLACK, reason: 'timeout' }), { ok: false, reason: 'ended' });
  assert.equal(g.result.winner, WHITE);

  const s = createGame({ size: 9, autoScore: false });
  pass(s);
  pass(s);
  assert.deepEqual(finish(s, { winner: BLACK, reason: 'score', black: 45, white: 43.5 }), { ok: true });
  assert.deepEqual(s.result, { winner: BLACK, reason: 'score', black: 45, white: 43.5 });

  const a = createGame({ size: 9 });
  finish(a, { winner: 0, reason: 'abort' });
  assert.deepEqual(a.result, { winner: 0, reason: 'abort', black: null, white: null });
});

test('finish 复制传入的结果对象', () => {
  const g = createGame({ size: 9 });
  const input = { winner: BLACK, reason: 'timeout' };
  finish(g, input);
  assert.notEqual(g.result, input);
  assert.deepEqual(input, { winner: BLACK, reason: 'timeout' });
});

test('resign：默认当前行棋方认输', () => {
  const g = createGame({ size: 9 });
  assert.deepEqual(resign(g), { ok: true });
  assert.equal(g.status, 'ended');
  assert.deepEqual(g.result, { winner: WHITE, black: null, white: null, reason: 'resign' });

  const w = createGame({ size: 9 });
  play(w, 40);
  resign(w);
  assert.equal(w.result.winner, BLACK);
});

test('resign：指定认输方；不是黑白时按当前行棋方', () => {
  const g = createGame({ size: 9 });
  resign(g, WHITE); // 轮到黑，但白认输
  assert.equal(g.result.winner, BLACK);

  const x = createGame({ size: 9 });
  resign(x, 7);
  assert.equal(x.result.winner, WHITE);
});

test('resign：数子阶段可以，终局后不行', () => {
  const s = createGame({ size: 9, autoScore: false });
  pass(s);
  pass(s);
  assert.deepEqual(resign(s, BLACK), { ok: true });
  assert.equal(s.result.winner, WHITE);
  assert.deepEqual(resign(s, WHITE), { ok: false, reason: 'ended' });
  assert.equal(s.result.winner, WHITE);

  const e = createGame({ size: 9 });
  pass(e);
  pass(e);
  const before = e.result;
  assert.deepEqual(resign(e), { ok: false, reason: 'ended' });
  assert.equal(e.result, before);
});

test('undo：没有可撤回的返回 false', () => {
  const g = createGame({ size: 9 });
  assert.equal(undo(g), false);
  assert.equal(g.status, 'playing');
});

test('undo：撤回落子，轮回该方', () => {
  const g = createGame({ size: 9 });
  play(g, 40);
  play(g, 41);
  assert.equal(undo(g), true);
  assert.equal(g.board.get(41), EMPTY);
  assert.equal(g.toPlay, WHITE);
  assert.equal(g.history.length, 1);
  assert.equal(undo(g), true);
  assert.equal(g.board.get(40), EMPTY);
  assert.equal(g.toPlay, BLACK);
  assert.equal(undo(g), false);
});

test('undo：放回被提的子并扣回提子数', () => {
  const g = gameFrom(`
    . X X .
    X O O X
    . X . .
    . . . .
  `);
  const before = toDiagram(g.board);
  play(g, 10); // 黑 (2,2) 提两子
  assert.equal(g.captures[BLACK], 2);
  assert.equal(undo(g), true);
  assert.equal(toDiagram(g.board), before);
  assert.equal(g.captures[BLACK], 0);
  assert.equal(g.toPlay, BLACK);
});

test('undo：恢复劫点', () => {
  const g = gameFrom(KO_SHAPE);
  play(g, 6); // 黑提劫，ko = 5
  play(g, 15); // 白别处，ko = null
  assert.equal(g.ko, null);
  undo(g);
  assert.equal(g.ko, 5);
  assert.deepEqual(play(g, 5), { ok: false, reason: 'ko' });
  undo(g); // 撤回提劫
  assert.equal(g.ko, null);
  assert.equal(g.board.get(5), WHITE);
  assert.equal(g.board.get(6), EMPTY);
  assert.equal(g.captures[BLACK], 0);
});

test('undo：撤回 pass 恢复劫点与连续 pass 计数', () => {
  const g = gameFrom(KO_SHAPE);
  play(g, 6);
  pass(g); // 白 pass，劫点解除
  assert.equal(g.ko, null);
  undo(g);
  assert.equal(g.ko, 5);
  assert.equal(g.consecutivePasses, 0);
  assert.equal(g.toPlay, WHITE);

  const h = createGame({ size: 9, autoScore: false });
  pass(h);
  pass(h);
  play(h, 40); // 不会成功：数子阶段
  undo(h);
  assert.equal(h.consecutivePasses, 1);
  undo(h);
  assert.equal(h.consecutivePasses, 0);
});

test('undo：自动计分终局后撤回，回到对局', () => {
  const g = createGame({ size: 9 });
  play(g, 40);
  pass(g);
  pass(g);
  assert.equal(g.status, 'ended');
  assert.equal(undo(g), true);
  assert.equal(g.status, 'playing');
  assert.equal(g.result, null);
  assert.equal(g.consecutivePasses, 1);
  assert.equal(g.toPlay, BLACK);
});

test('undo：数子阶段撤回第二次 pass', () => {
  const g = createGame({ size: 9, autoScore: false });
  pass(g);
  pass(g);
  undo(g);
  assert.equal(g.status, 'playing');
  assert.equal(g.consecutivePasses, 1);
  assert.equal(g.toPlay, WHITE);
});

test('undo：认输后只撤销认输本身，不动历史', () => {
  const g = createGame({ size: 9 });
  play(g, 40);
  play(g, 41);
  resign(g);
  assert.equal(undo(g), true);
  assert.equal(g.status, 'playing');
  assert.equal(g.result, null);
  assert.equal(g.history.length, 2);
  assert.equal(g.board.get(41), WHITE);
  assert.equal(g.toPlay, BLACK);
  // 再悔一次才撤回着手
  assert.equal(undo(g), true);
  assert.equal(g.history.length, 1);
  assert.equal(g.board.get(41), EMPTY);
});

test('undo：一手没下就认输，也能撤销认输', () => {
  const g = createGame({ size: 9 });
  resign(g);
  assert.equal(undo(g), true);
  assert.equal(g.status, 'playing');
  assert.equal(g.result, null);
  assert.equal(undo(g), false);
});

test('undo：外部裁定的终局（超时）撤回最后一手', () => {
  const g = createGame({ size: 9 });
  play(g, 40);
  finish(g, { winner: BLACK, reason: 'timeout' });
  assert.equal(undo(g), true);
  assert.equal(g.status, 'playing');
  assert.equal(g.result, null);
  assert.equal(g.history.length, 0);
  assert.equal(g.board.get(40), EMPTY);
});

test('undo：继续对局后撤回，按 passesBefore 精确恢复计数', () => {
  const g = createGame({ size: 9, autoScore: false });
  play(g, 40);
  pass(g);
  pass(g);
  resume(g);
  play(g, 41); // 白
  undo(g);
  assert.equal(g.consecutivePasses, 0);
  assert.equal(g.status, 'playing');
});

test('undo：历史项缺 passesBefore 时按末尾连续 pass 个数恢复', () => {
  const g = createGame({ size: 9 });
  play(g, 40);
  pass(g);
  pass(g); // 自动终局
  play(g, 41); // 被拒绝
  for (const h of g.history) delete h.passesBefore;
  undo(g); // 撤回第二个 pass：之前末尾有 1 个 pass
  assert.equal(g.consecutivePasses, 1);
  undo(g); // 撤回第一个 pass：之前末尾是落子
  assert.equal(g.consecutivePasses, 0);
});

test('undo 全部撤回后回到初始局面', () => {
  const g = gameFrom(KO_SHAPE);
  const start = toDiagram(g.board);
  play(g, 6);
  play(g, 15);
  play(g, 12);
  play(g, 5);
  pass(g);
  play(g, 3);
  while (undo(g));
  assert.equal(toDiagram(g.board), start);
  assert.deepEqual(g.captures, { 1: 0, 2: 0 });
  assert.equal(g.ko, null);
  assert.equal(g.toPlay, BLACK);
  assert.equal(g.consecutivePasses, 0);
  assert.equal(g.history.length, 0);
});
