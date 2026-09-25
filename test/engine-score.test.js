'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Board, EMPTY, BLACK, WHITE } = require('../miniprogram/utils/engine/board');
const { score, scoreArea, toggleDead } = require('../miniprogram/utils/engine/score');
const { createGame, pass } = require('../miniprogram/utils/engine/game');
const { fromDiagram, toDiagram } = require('./helpers');

const SCORE_KEYS = ['black', 'white', 'winner', 'blackStones', 'whiteStones', 'blackArea', 'whiteArea'];

// 9 路终局：黑占左边、白占右边，(3,4)(4,4) 是双方都挨着的公气。
// 黑子 17、白子 16；黑地 3+1+5+10 = 19，白地 12+15 = 27。
const FINAL_9 = `
  . . X O . . . . .
  . X . X O . . O .
  X X X X O . . . .
  . . . X O O O O O
  . . X . . O . . .
  X X X X X O . O .
  . . . . X O . . .
  . . . X O O . . .
  . . . X O . . . .
`;

test('空盘：没有地，贴目决定胜负', () => {
  const b = new Board(9);
  assert.deepEqual(score(b, 7.5), {
    black: 0,
    white: 7.5,
    winner: WHITE,
    blackStones: 0,
    whiteStones: 0,
    blackArea: 0,
    whiteArea: 0,
  });
  assert.equal(score(b, 0).winner, 0);
});

test('score 只返回七个计分字段，不改棋盘', () => {
  const b = fromDiagram(FINAL_9);
  const before = toDiagram(b);
  const s = score(b, 7.5);
  assert.deepEqual(Object.keys(s).sort(), SCORE_KEYS.slice().sort());
  assert.equal(toDiagram(b), before);
});

test('纯黑：盘上只有黑子，空点全是黑地', () => {
  const b = new Board(9);
  b.set(40, BLACK);
  const s = score(b, 7.5);
  assert.equal(s.blackStones, 1);
  assert.equal(s.blackArea, 80);
  assert.equal(s.black, 81);
  assert.equal(s.white, 7.5);
  assert.equal(s.winner, BLACK);
});

test('纯白：盘上只有白子，空点全是白地', () => {
  const b = fromDiagram(`
    O . .
    . . .
    . . O
  `);
  const s = score(b, 0);
  assert.equal(s.whiteStones, 2);
  assert.equal(s.whiteArea, 7);
  assert.equal(s.white, 9);
  assert.equal(s.black, 0);
  assert.equal(s.winner, WHITE);
});

test('无主区：同时挨着黑白的空区不归任何一方', () => {
  const b = fromDiagram(`
    X . O
    X . O
    X . O
  `);
  const s = score(b, 0);
  assert.equal(s.blackArea, 0);
  assert.equal(s.whiteArea, 0);
  assert.equal(s.black, 3);
  assert.equal(s.white, 3);
  assert.equal(s.winner, 0);
});

test('分隔开的空区各自判定归属', () => {
  const b = fromDiagram(`
    . . X . .
    . . X . .
    X X X . .
    . . . O O
    . . . O .
  `);
  const s = score(b, 0);
  assert.equal(s.blackStones, 5);
  assert.equal(s.whiteStones, 3);
  assert.equal(s.blackArea, 4); // 左上角被黑子围住的 4 个点
  assert.equal(s.whiteArea, 1); // 右下角被白子围住的 1 个点
  // 右上 6 个点、左下 6 个点都同时挨着黑白两方：无主
  assert.equal(s.black, 9);
  assert.equal(s.white, 4);
  assert.equal(s.winner, 1);
});

test('贴目：加在白方，可以反转胜负或成和', () => {
  const b = fromDiagram(`
    . . . . X O . . .
    . . . . X O . . .
    . . . . X O . . .
    . . . . X O . . .
    . . . . X O . . .
    . . . . X O . . .
    . . . . X O . . .
    . . . . X O . . .
    . . . . X O . . .
  `);
  const s = score(b, 7.5);
  assert.equal(s.black, 45);
  assert.equal(s.white, 43.5);
  assert.equal(s.winner, BLACK);
  assert.equal(score(b, 0).white, 36);
  assert.equal(score(b, 9.5).winner, WHITE);
  const draw = score(b, 9);
  assert.equal(draw.white, 45);
  assert.equal(draw.winner, 0);
});

test('完整 9 路终局', () => {
  const b = fromDiagram(FINAL_9);
  const s = score(b, 7.5);
  assert.deepEqual(s, {
    black: 36,
    white: 50.5,
    winner: WHITE,
    blackStones: 17,
    whiteStones: 16,
    blackArea: 19,
    whiteArea: 27,
  });
  // 子 + 地 + 公气 = 81
  assert.equal(s.blackStones + s.whiteStones + s.blackArea + s.whiteArea + 2, 81);
});

test('完整 9 路终局：对局中双方连续 pass 自动计出同样的结果', () => {
  const g = createGame({ size: 9, komi: 7.5 });
  g.board.cells.set(fromDiagram(FINAL_9).cells);
  pass(g);
  pass(g);
  assert.deepEqual(g.result, { winner: WHITE, black: 36, white: 50.5, reason: 'score' });
});

test('满盘没有空点：只数子', () => {
  const b = fromDiagram(`
    X O X
    O X O
    X O X
  `);
  const s = score(b, 0.5);
  assert.equal(s.blackStones, 5);
  assert.equal(s.whiteStones, 4);
  assert.equal(s.blackArea, 0);
  assert.equal(s.whiteArea, 0);
  assert.equal(s.black, 5);
  assert.equal(s.white, 4.5);
  assert.equal(s.winner, BLACK);
});

test('19 路：整盘一块空区也能计分（不递归）', () => {
  const b = new Board(19);
  b.set(0, WHITE);
  const s = score(b, 0);
  assert.equal(s.whiteArea, 360);
  assert.equal(s.white, 361);
});

test('scoreArea：没有死子时与 score 一致，并给出 owner 与 dead', () => {
  const b = fromDiagram(FINAL_9);
  const s = score(b, 7.5);
  for (const dead of [[], null, undefined]) {
    const a = scoreArea(b, 7.5, dead);
    for (const k of SCORE_KEYS) assert.equal(a[k], s[k], k);
    assert.deepEqual(a.dead, []);
    assert.ok(Array.isArray(a.owner));
    assert.equal(a.owner.length, 81);
  }
  const a = scoreArea(b, 7.5, []);
  assert.equal(a.owner[b.toIdx(2, 0)], BLACK); // 黑子
  assert.equal(a.owner[b.toIdx(3, 0)], WHITE); // 白子
  assert.equal(a.owner[b.toIdx(0, 0)], BLACK); // 黑地
  assert.equal(a.owner[b.toIdx(8, 8)], WHITE); // 白地
  assert.equal(a.owner[b.toIdx(3, 4)], EMPTY); // 公气
  assert.equal(a.owner[b.toIdx(4, 4)], EMPTY);
});

test('scoreArea：黑地里的白死子按提掉计算', () => {
  const b = fromDiagram(FINAL_9);
  const inv = b.toIdx(0, 7);
  b.set(inv, WHITE); // 白打入黑地
  // 不认定死子：那片空区也挨着白子，成了无主
  const alive = scoreArea(b, 7.5, []);
  assert.equal(alive.whiteStones, 17);
  assert.equal(alive.blackArea, 9);
  assert.equal(alive.owner[inv], WHITE);
  assert.equal(alive.owner[b.toIdx(0, 6)], EMPTY);

  const r = scoreArea(b, 7.5, [inv]);
  assert.deepEqual(r.dead, [inv]);
  assert.equal(r.whiteStones, 16); // 死子不计
  assert.equal(r.blackArea, 19); // 死子所在点也是黑地
  assert.equal(r.black, 36);
  assert.equal(r.white, 50.5);
  assert.equal(r.owner[inv], BLACK);
  assert.equal(r.owner[b.toIdx(0, 6)], BLACK);
  // 棋盘本身不变
  assert.equal(b.get(inv), WHITE);
});

test('scoreArea：双方都有死子', () => {
  const b = fromDiagram(`
    . X . O .
    . X O O .
    . X . O X
    . X . O .
    O X . O .
  `);
  const blackDead = b.toIdx(4, 2);
  const whiteDead = b.toIdx(0, 4);
  const r = scoreArea(b, 0, [whiteDead, blackDead]);
  assert.deepEqual(r.dead, [blackDead, whiteDead].sort((x, y) => x - y));
  assert.equal(r.blackStones, 5);
  assert.equal(r.whiteStones, 6);
  assert.equal(r.blackArea, 5); // 左边一列（含白死子处）
  assert.equal(r.whiteArea, 5); // 右边一列（含黑死子处）
  assert.equal(r.owner[whiteDead], BLACK);
  assert.equal(r.owner[blackDead], WHITE);
  assert.equal(r.owner[b.toIdx(2, 0)], EMPTY); // 中间的公气
  assert.equal(r.winner, WHITE);
});

test('scoreArea：一整块死子', () => {
  const b = fromDiagram(`
    . . . . .
    . O O . .
    . . . . .
    X X X X X
    . . . . .
  `);
  const dead = [b.toIdx(1, 1), b.toIdx(2, 1)];
  const r = scoreArea(b, 0, dead);
  assert.equal(r.whiteStones, 0);
  assert.equal(r.blackStones, 5);
  assert.equal(r.blackArea, 20);
  assert.equal(r.black, 25);
  assert.ok(r.owner.every((c) => c === BLACK));
});

test('scoreArea：dead 中的非整数、越界值、空点、重复值被忽略，结果升序', () => {
  const b = fromDiagram(`
    X . O
    . . .
    O . X
  `);
  const r = scoreArea(b, 0, [8, 8, 2, '6', 6.5, -1, 9, 4, NaN, 0]);
  assert.deepEqual(r.dead, [0, 2, 8]);
  assert.equal(r.blackStones, 0);
  assert.equal(r.whiteStones, 1);
  assert.equal(r.whiteArea, 8);
});

test('scoreArea：不修改传入的 dead 数组', () => {
  const b = fromDiagram(`
    X . O
    . . .
    O . X
  `);
  const dead = [8, 0, 8];
  scoreArea(b, 0, dead);
  assert.deepEqual(dead, [8, 0, 8]);
});

test('toggleDead：点一块标死，再点取消', () => {
  const b = fromDiagram(`
    . . . . .
    . O O . .
    . O . . .
    X X X X X
    . . . . .
  `);
  const d1 = toggleDead(b, [], b.toIdx(2, 1));
  assert.deepEqual(d1, [6, 7, 11]);
  const d2 = toggleDead(b, d1, b.toIdx(1, 2));
  assert.deepEqual(d2, []);
});

test('toggleDead：不修改传入数组，返回去重升序的新数组', () => {
  const b = fromDiagram(`
    X . O
    . . .
    . . .
  `);
  const dead = [2, 2];
  const next = toggleDead(b, dead, 0);
  assert.deepEqual(next, [0, 2]);
  assert.deepEqual(dead, [2, 2]);
  assert.notEqual(next, dead);
});

test('toggleDead：部分标死时整块标死；整块标死时整块取消', () => {
  const b = fromDiagram(`
    O O O
    . . .
    X . .
  `);
  assert.deepEqual(toggleDead(b, [1], 0), [0, 1, 2]);
  assert.deepEqual(toggleDead(b, [0, 1, 2, 6], 1), [6]);
});

test('toggleDead：空点或无效索引返回原集合的去重升序副本', () => {
  const b = fromDiagram(`
    X . O
    . . .
    . . .
  `);
  const dead = [2, 0, 2];
  for (const idx of [1, 4, -1, 9, 1.5, null, undefined, '0']) {
    const r = toggleDead(b, dead, idx);
    assert.deepEqual(r, [0, 2], String(idx));
    assert.notEqual(r, dead);
  }
  assert.deepEqual(toggleDead(b, null, 4), []);
  assert.deepEqual(toggleDead(b, undefined, 0), [0]);
});

test('toggleDead 与 scoreArea 配合：标死后计分', () => {
  const b = fromDiagram(FINAL_9);
  b.set(b.toIdx(1, 7), WHITE);
  b.set(b.toIdx(2, 7), WHITE);
  const dead = toggleDead(b, [], b.toIdx(1, 7));
  assert.deepEqual(dead, [b.toIdx(1, 7), b.toIdx(2, 7)]);
  const r = scoreArea(b, 7.5, dead);
  assert.equal(r.black, 36);
  assert.equal(r.white, 50.5);
});
