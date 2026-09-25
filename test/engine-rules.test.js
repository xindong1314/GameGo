'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Board, EMPTY, BLACK, WHITE } = require('../miniprogram/utils/engine/board');
const { tryPlay, canPlay } = require('../miniprogram/utils/engine/rules');
const { fromDiagram, toDiagram } = require('./helpers');

const sorted = (arr) => arr.slice().sort((a, b) => a - b);

test('普通落子：成功、无提子、无劫', () => {
  const b = new Board(9);
  const r = tryPlay(b, BLACK, null, 40);
  assert.equal(r.ok, true);
  assert.deepEqual(r.captured, []);
  assert.equal(r.koAfter, null);
  assert.equal(b.get(40), BLACK);
});

test('提单子（中腹）', () => {
  const b = fromDiagram(`
    . X .
    X O X
    . . .
  `);
  const r = tryPlay(b, BLACK, null, b.toIdx(1, 2));
  assert.equal(r.ok, true);
  assert.deepEqual(r.captured, [4]);
  assert.equal(r.koAfter, null); // 提子后落下的子有 3 口气，不是劫
  assert.equal(toDiagram(b), '. X .\nX . X\n. X .');
});

test('提角上的单子', () => {
  const b = fromDiagram(`
    O X .
    . . .
    . . .
  `);
  const r = tryPlay(b, BLACK, null, 3);
  assert.equal(r.ok, true);
  assert.deepEqual(r.captured, [0]);
  assert.equal(b.get(0), EMPTY);
});

test('提多子（一整块）', () => {
  const b = fromDiagram(`
    . X X .
    X O O X
    . X . .
    . . . .
  `);
  const r = tryPlay(b, BLACK, null, b.toIdx(2, 2));
  assert.equal(r.ok, true);
  assert.deepEqual(sorted(r.captured), [5, 6]);
  assert.equal(r.koAfter, null);
  assert.equal(b.get(5), EMPTY);
  assert.equal(b.get(6), EMPTY);
});

test('一手同时提掉多块', () => {
  const b = fromDiagram(`
    . O X . .
    O X . . .
    X . . . .
    . . . . .
    . . . . .
  `);
  const r = tryPlay(b, BLACK, null, 0);
  assert.equal(r.ok, true);
  assert.deepEqual(sorted(r.captured), [1, 5]);
  assert.equal(r.koAfter, null);
  assert.equal(b.get(1), EMPTY);
  assert.equal(b.get(5), EMPTY);
  assert.equal(b.get(0), BLACK);
});

test('同一块与落点多处相邻时只提一次', () => {
  const b = fromDiagram(`
    . X X X .
    X O O O X
    X O . O X
    X O O O X
    . X X X .
  `);
  const r = tryPlay(b, BLACK, null, b.toIdx(2, 2));
  assert.equal(r.ok, true);
  assert.equal(r.captured.length, 8);
  assert.equal(new Set(r.captured).size, 8);
  assert.equal(b.group(b.toIdx(2, 2)).liberties.length, 4);
});

test('只提没气的对方块，有气的相邻对方块不动', () => {
  const b = fromDiagram(`
    . X O .
    X O . .
    . X . .
    . . . .
  `);
  // 黑下 (2,1)：(1,1) 白子没气被提；(2,0) 白子还有 (3,0) 一口气
  const r = tryPlay(b, BLACK, null, b.toIdx(2, 1));
  assert.equal(r.ok, true);
  assert.deepEqual(r.captured, [5]);
  assert.equal(b.get(b.toIdx(2, 0)), WHITE);
});

test('禁止自杀：单子', () => {
  const b = fromDiagram(`
    . X .
    X . X
    . X .
  `);
  const before = toDiagram(b);
  assert.deepEqual(tryPlay(b, WHITE, null, 4), { ok: false, reason: 'suicide' });
  assert.equal(toDiagram(b), before);
});

test('禁止自杀：角上单子', () => {
  const b = fromDiagram(`
    . X .
    X . .
    . . .
  `);
  assert.deepEqual(tryPlay(b, WHITE, null, 0), { ok: false, reason: 'suicide' });
  assert.equal(b.get(0), EMPTY);
});

test('禁止自杀：多子（与己方块连成一块后整块没气）', () => {
  const b = fromDiagram(`
    . X X X .
    X O . O X
    . X X X .
    . . . . .
    . . . . .
  `);
  const before = toDiagram(b);
  assert.deepEqual(tryPlay(b, WHITE, null, b.toIdx(2, 1)), { ok: false, reason: 'suicide' });
  assert.equal(toDiagram(b), before);
});

test('填自己最后一口气也是自杀', () => {
  const b = fromDiagram(`
    O O X .
    . X X .
    X . . .
    . . . .
  `);
  // 白 (0,1)：与 (0,0)(1,0) 连成一块，四周全是黑子
  assert.deepEqual(tryPlay(b, WHITE, null, 4), { ok: false, reason: 'suicide' });
  assert.equal(b.get(4), EMPTY);
  assert.equal(b.get(0), WHITE);
});

test('落下后本身没气但能提子，不算自杀', () => {
  const b = fromDiagram(`
    . X O .
    X O . O
    . X O .
    . . . .
  `);
  const r = tryPlay(b, BLACK, null, 6);
  assert.equal(r.ok, true);
  assert.deepEqual(r.captured, [5]);
  assert.equal(b.get(5), EMPTY);
  assert.equal(b.get(6), BLACK);
});

test('打劫：提一子形成劫，对方不能立即回提；劫点解除后可以', () => {
  const b = fromDiagram(`
    . X O .
    X O . O
    . X O .
    . . . .
  `);
  const r = tryPlay(b, BLACK, null, 6);
  assert.equal(r.koAfter, 5);
  // 白立即回提：劫
  assert.deepEqual(tryPlay(b, WHITE, r.koAfter, 5), { ok: false, reason: 'ko' });
  assert.equal(b.get(5), EMPTY);
  assert.deepEqual(canPlay(b, WHITE, r.koAfter, 5), { ok: false, reason: 'ko' });
  // 劫点解除（中间隔了别的着手，劫点为 null）后，白可以提回
  const back = tryPlay(b, WHITE, null, 5);
  assert.equal(back.ok, true);
  assert.deepEqual(back.captured, [6]);
  assert.equal(back.koAfter, 6);
  assert.equal(b.get(6), EMPTY);
});

test('劫点只禁止那一个点', () => {
  const b = fromDiagram(`
    . X O .
    X O . O
    . X O .
    . . . .
  `);
  const r = tryPlay(b, BLACK, null, 6);
  assert.equal(tryPlay(b, WHITE, r.koAfter, 15).ok, true);
});

test('提两子不成劫：落下的子只剩一口气，对方也可以立即提回', () => {
  const b = fromDiagram(`
    X O O . O
    . X X O O
    . . . . .
    . . . . .
    . . . . .
  `);
  const r = tryPlay(b, BLACK, null, 3);
  assert.equal(r.ok, true);
  assert.deepEqual(sorted(r.captured), [1, 2]);
  assert.equal(r.koAfter, null);
  assert.deepEqual(b.group(3).liberties, [2]);
  // 白在 (2,0) 提回黑一子：不受劫的限制，提后白子有两口气，也不是劫
  const back = tryPlay(b, WHITE, r.koAfter, 2);
  assert.equal(back.ok, true);
  assert.deepEqual(back.captured, [3]);
  assert.equal(back.koAfter, null);
});

test('提一子但落下的子与己方连成一块：不是劫', () => {
  const b = fromDiagram(`
    . X O . .
    X O . O .
    . X X . .
    . . . . .
    . . . . .
  `);
  // 黑 (2,1) 提掉白 (1,1)，同时与下方 (2,2)(1,2) 连成三子一块
  const r = tryPlay(b, BLACK, null, b.toIdx(2, 1));
  assert.equal(r.ok, true);
  assert.deepEqual(r.captured, [b.toIdx(1, 1)]);
  assert.equal(r.koAfter, null);
});

test('失败原因：invalid（索引不是盘内整数）', () => {
  const b = new Board(9);
  for (const idx of [-1, 81, 100, 1.5, NaN, Infinity, '3', null, undefined, {}]) {
    assert.deepEqual(tryPlay(b, BLACK, null, idx), { ok: false, reason: 'invalid' }, String(idx));
    assert.deepEqual(canPlay(b, BLACK, null, idx), { ok: false, reason: 'invalid' }, String(idx));
  }
  assert.ok(b.cells.every((c) => c === EMPTY));
});

test('失败原因：invalid（颜色不是黑白）', () => {
  const b = new Board(9);
  assert.deepEqual(tryPlay(b, EMPTY, null, 40), { ok: false, reason: 'invalid' });
  assert.deepEqual(tryPlay(b, 3, null, 40), { ok: false, reason: 'invalid' });
  assert.equal(b.get(40), EMPTY);
});

test('失败原因：occupied，棋盘不变', () => {
  const b = new Board(9);
  tryPlay(b, BLACK, null, 40);
  const before = toDiagram(b);
  assert.deepEqual(tryPlay(b, WHITE, null, 40), { ok: false, reason: 'occupied' });
  assert.deepEqual(tryPlay(b, BLACK, null, 40), { ok: false, reason: 'occupied' });
  assert.equal(toDiagram(b), before);
  assert.equal(b.get(40), BLACK);
});

test('判定顺序：有子优先于劫', () => {
  const b = new Board(9);
  b.set(40, BLACK);
  assert.deepEqual(tryPlay(b, WHITE, 40, 40), { ok: false, reason: 'occupied' });
});

test('失败原因：ko，即使那一手本来能提子也不行，棋盘不变', () => {
  const b = fromDiagram(`
    . X O .
    X O . O
    . X O .
    . . . .
  `);
  const before = toDiagram(b);
  assert.deepEqual(tryPlay(b, BLACK, 6, 6), { ok: false, reason: 'ko' });
  assert.equal(toDiagram(b), before);
});

test('canPlay：只判断不落子，成功时 reason 为 null', () => {
  const b = fromDiagram(`
    . X O .
    X O . O
    . X O .
    . . . .
  `);
  const before = toDiagram(b);
  assert.deepEqual(canPlay(b, BLACK, null, 6), { ok: true, reason: null });
  assert.equal(toDiagram(b), before); // 能提子的着手也不动棋盘
  assert.deepEqual(canPlay(b, BLACK, null, 15), { ok: true, reason: null });
  assert.deepEqual(canPlay(b, WHITE, null, 1), { ok: false, reason: 'occupied' });
  assert.deepEqual(canPlay(b, BLACK, 6, 6), { ok: false, reason: 'ko' });
  assert.equal(toDiagram(b), before);
});

test('canPlay：自杀点', () => {
  const b = fromDiagram(`
    . X .
    X . X
    . X .
  `);
  assert.deepEqual(canPlay(b, WHITE, null, 4), { ok: false, reason: 'suicide' });
  assert.deepEqual(canPlay(b, BLACK, null, 4), { ok: true, reason: null });
  assert.equal(b.get(4), EMPTY);
});

// 可复现的伪随机数
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('19 路随机对局：每一步之后盘上没有无气的块，提子数与棋盘一致', () => {
  const rnd = lcg(20260925);
  const b = new Board(19);
  let color = BLACK;
  let ko = null;
  let stonesOnBoard = 0;
  let totalCaptured = 0;
  for (let step = 0; step < 600; step++) {
    const idx = Math.floor(rnd() * 361);
    const legal = canPlay(b, color, ko, idx);
    const r = tryPlay(b, color, ko, idx);
    assert.equal(r.ok, legal.ok);
    if (!r.ok) {
      assert.equal(r.reason, legal.reason);
      continue;
    }
    stonesOnBoard += 1 - r.captured.length;
    totalCaptured += r.captured.length;
    for (const i of r.captured) assert.equal(b.get(i), EMPTY);
    ko = r.koAfter;
    color = color === BLACK ? WHITE : BLACK;
    for (let i = 0; i < 361; i++) {
      if (b.get(i) !== EMPTY) assert.ok(b.group(i).liberties.length > 0);
    }
    assert.equal(b.cells.reduce((sum, c) => sum + (c === EMPTY ? 0 : 1), 0), stonesOnBoard);
  }
  assert.ok(totalCaptured > 0);
});
