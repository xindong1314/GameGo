'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Board, EMPTY, BLACK, WHITE, opponent } = require('../miniprogram/utils/engine/board');
const { fromDiagram } = require('./helpers');

const sorted = (arr) => arr.slice().sort((a, b) => a - b);

test('颜色常量与 opponent', () => {
  assert.equal(EMPTY, 0);
  assert.equal(BLACK, 1);
  assert.equal(WHITE, 2);
  assert.equal(opponent(BLACK), WHITE);
  assert.equal(opponent(WHITE), BLACK);
});

test('新棋盘：路数、Int8Array、全空', () => {
  for (const n of [9, 13, 19]) {
    const b = new Board(n);
    assert.equal(b.n, n);
    assert.ok(b.cells instanceof Int8Array);
    assert.equal(b.cells.length, n * n);
    assert.ok(b.cells.every((c) => c === EMPTY));
  }
});

test('非法路数抛错', () => {
  assert.throws(() => new Board(0));
  assert.throws(() => new Board(-3));
  assert.throws(() => new Board(2.5));
  assert.throws(() => new Board('9'));
});

test('toIdx / toXY：按行展开，左上角为 0', () => {
  const b = new Board(9);
  assert.equal(b.toIdx(0, 0), 0);
  assert.equal(b.toIdx(8, 0), 8);
  assert.equal(b.toIdx(0, 1), 9);
  assert.equal(b.toIdx(4, 4), 40);
  assert.equal(b.toIdx(8, 8), 80);
  assert.deepEqual(b.toXY(0), { x: 0, y: 0 });
  assert.deepEqual(b.toXY(40), { x: 4, y: 4 });
  assert.deepEqual(b.toXY(17), { x: 8, y: 1 });
  for (let i = 0; i < 81; i++) {
    const { x, y } = b.toXY(i);
    assert.equal(b.toIdx(x, y), i);
  }
});

test('get / set 读写 cells', () => {
  const b = new Board(5);
  b.set(7, BLACK);
  b.set(8, WHITE);
  assert.equal(b.get(7), BLACK);
  assert.equal(b.get(8), WHITE);
  assert.equal(b.cells[7], BLACK);
  b.set(7, EMPTY);
  assert.equal(b.get(7), EMPTY);
  // 外部代码会直接 cells.set(...)
  b.cells.set([1, 2, 1]);
  assert.equal(b.get(0), BLACK);
  assert.equal(b.get(1), WHITE);
});

test('neighbors：角 2 个、边 3 个、中间 4 个', () => {
  const b = new Board(9);
  assert.deepEqual(sorted(b.neighbors(0)), [1, 9]);
  assert.deepEqual(sorted(b.neighbors(8)), [7, 17]);
  assert.deepEqual(sorted(b.neighbors(72)), [63, 73]);
  assert.deepEqual(sorted(b.neighbors(80)), [71, 79]);
  assert.deepEqual(sorted(b.neighbors(4)), [3, 5, 13]);
  assert.deepEqual(sorted(b.neighbors(36)), [27, 37, 45]);
  assert.deepEqual(sorted(b.neighbors(44)), [35, 43, 53]);
  assert.deepEqual(sorted(b.neighbors(76)), [67, 75, 77]);
  assert.deepEqual(sorted(b.neighbors(40)), [31, 39, 41, 49]);
});

test('neighbors：不跨行（行尾与下一行行首不相邻）', () => {
  const b = new Board(5);
  assert.ok(!b.neighbors(4).includes(5));
  assert.ok(!b.neighbors(5).includes(4));
});

test('neighbors：每个点的相邻关系对称，且总数正确', () => {
  for (const n of [1, 2, 9, 19]) {
    const b = new Board(n);
    let count = 0;
    for (let i = 0; i < n * n; i++) {
      for (const j of b.neighbors(i)) {
        assert.ok(b.neighbors(j).includes(i));
        count += 1;
      }
    }
    assert.equal(count, 4 * n * (n - 1)); // 每条边算两次
  }
});

test('neighbors 返回的数组可以随意修改，不影响下一次调用', () => {
  const b = new Board(9);
  const a = b.neighbors(40);
  a.length = 0;
  assert.equal(b.neighbors(40).length, 4);
});

test('group：空点返回 null', () => {
  const b = new Board(9);
  assert.equal(b.group(40), null);
});

test('group：单子的气', () => {
  const b = new Board(9);
  b.set(40, BLACK);
  assert.deepEqual(b.group(40).stones, [40]);
  assert.deepEqual(sorted(b.group(40).liberties), [31, 39, 41, 49]);
  assert.equal(b.group(40).color, BLACK);

  b.set(0, WHITE);
  assert.deepEqual(sorted(b.group(0).liberties), [1, 9]);
  b.set(1, BLACK);
  assert.deepEqual(b.group(0).liberties, [9]);
});

test('group：连通块的全部棋子与去重后的气', () => {
  const b = fromDiagram(`
    . . . . .
    . X X . .
    . X O . .
    . . . . .
    . . . . .
  `);
  const g = b.group(b.toIdx(1, 1));
  assert.equal(g.color, BLACK);
  assert.deepEqual(sorted(g.stones), [6, 7, 11]);
  // (1,0)(2,0)(0,1)(3,1)(0,2)(1,3)；(2,2) 是白子，不算气
  assert.deepEqual(sorted(g.liberties), [1, 2, 5, 8, 10, 16]);
  // 从块内任意一子出发结果相同
  assert.deepEqual(sorted(b.group(b.toIdx(1, 2)).stones), [6, 7, 11]);

  const w = b.group(b.toIdx(2, 2));
  assert.equal(w.color, WHITE);
  assert.deepEqual(w.stones, [12]);
  assert.deepEqual(sorted(w.liberties), [13, 17]);
});

test('group：斜向不算相连；环形块的内部空点只算一次气', () => {
  const b = fromDiagram(`
    X . . . .
    . X X X .
    . X . X .
    . X X X .
    . . . . .
  `);
  assert.deepEqual(b.group(0).stones, [0]);
  const ring = b.group(b.toIdx(1, 1));
  assert.equal(ring.stones.length, 8);
  const libs = sorted(ring.liberties);
  assert.equal(new Set(libs).size, libs.length);
  assert.ok(libs.includes(b.toIdx(2, 2)));
  assert.equal(libs.length, 13); // 外圈 12 + 中心 1
});

test('group：没有气的块', () => {
  const b = fromDiagram(`
    O X .
    X . .
    . . .
  `);
  assert.deepEqual(b.group(0).liberties, []);
});

test('group：19 路整盘同色大块（不递归，不爆栈）', () => {
  const b = new Board(19);
  b.cells.fill(BLACK);
  b.set(180, EMPTY);
  const g = b.group(0);
  assert.equal(g.stones.length, 360);
  assert.deepEqual(g.liberties, [180]);
});

test('clone：深拷贝，互不影响', () => {
  const b = new Board(9);
  b.set(10, BLACK);
  const c = b.clone();
  assert.ok(c instanceof Board);
  assert.equal(c.n, 9);
  assert.notEqual(c.cells, b.cells);
  assert.deepEqual(Array.from(c.cells), Array.from(b.cells));
  c.set(20, WHITE);
  b.set(30, BLACK);
  assert.equal(b.get(20), EMPTY);
  assert.equal(c.get(30), EMPTY);
  assert.equal(c.get(10), BLACK);
});
