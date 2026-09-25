'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BLACK, WHITE, EMPTY } = require('../miniprogram/utils/engine/board');
const { score, scoreArea, toggleDead } = require('../miniprogram/utils/engine/score');
const { fromDiagram } = require('./helpers');

const WITH_DEAD = `
  . . X O . . . . .
  . . X O . . X . .
  . X X O O . . . .
  X X O O . . . . .
  X O O . . . . . .
  X O . . . . . . .
  X O . . . . . . .
  X O . . . . . . .
  X O . . . . . . .
`;

test('无死子时 scoreArea 与 score 结果一致', () => {
  const b = fromDiagram(WITH_DEAD);
  const a = scoreArea(b, 7.5, []);
  const s = score(b, 7.5);
  for (const k of ['black', 'white', 'winner', 'blackStones', 'whiteStones', 'blackArea', 'whiteArea']) {
    assert.equal(a[k], s[k], k);
  }
  assert.deepEqual(a.dead, []);
});

test('白地里的黑死子：去掉后该点连同周围计入白地', () => {
  const b = fromDiagram(WITH_DEAD);
  const deadIdx = b.toIdx(6, 1);
  const before = scoreArea(b, 7.5, []);
  // 不认定死子时，黑子"污染"了白地，那片空区两边都接触 → 无主
  assert.equal(before.whiteArea, 0);
  const after = scoreArea(b, 7.5, [deadIdx]);
  assert.deepEqual(after.dead, [deadIdx]);
  assert.equal(after.blackStones, 11);
  assert.equal(after.whiteStones, 12);
  assert.equal(after.blackArea, 5);
  assert.equal(after.whiteArea, 53); // 原 52 个空点 + 死子所在点
  assert.equal(after.white, 12 + 53 + 7.5);
  assert.equal(after.winner, WHITE);
  assert.equal(after.owner[deadIdx], WHITE);
});

test('owner：活子为自身颜色，地为所属方，公气为 0', () => {
  const b = fromDiagram(`
    . X . . .
    X X . . .
    . . . . .
    . . . O O
    . . . O .
  `);
  const r = scoreArea(b, 0, []);
  assert.equal(r.owner[b.toIdx(0, 0)], BLACK); // 黑子围住的角
  assert.equal(r.owner[b.toIdx(1, 0)], BLACK); // 黑子本身
  assert.equal(r.owner[b.toIdx(2, 2)], EMPTY); // 中间的大片空区两边都挨着
  assert.equal(r.owner[b.toIdx(3, 3)], WHITE); // 白子本身
  assert.equal(r.owner[b.toIdx(4, 4)], WHITE); // 白子围住的角
  assert.equal(r.owner.length, 25);
});

test('dead 中的空点、越界值、重复值被忽略', () => {
  const b = fromDiagram(`
    . X .
    . . .
    . . O
  `);
  const r = scoreArea(b, 0, [0, 0, -1, 99, 1.5, b.toIdx(1, 0), b.toIdx(1, 0)]);
  assert.deepEqual(r.dead, [b.toIdx(1, 0)]);
  assert.equal(r.blackStones, 0);
  assert.equal(r.whiteStones, 1);
  assert.equal(r.whiteArea, 8);
});

test('toggleDead 切换整块死活，空点无效果', () => {
  const b = fromDiagram(`
    X X . O .
    . . . O .
    . . . . .
    . . . . .
    . . . . .
  `);
  let dead = toggleDead(b, [], b.toIdx(0, 0));
  assert.deepEqual(dead, [b.toIdx(0, 0), b.toIdx(1, 0)]);
  dead = toggleDead(b, dead, b.toIdx(3, 1));
  assert.deepEqual(dead, [b.toIdx(0, 0), b.toIdx(1, 0), b.toIdx(3, 0), b.toIdx(3, 1)]);
  dead = toggleDead(b, dead, b.toIdx(1, 0));
  assert.deepEqual(dead, [b.toIdx(3, 0), b.toIdx(3, 1)]);
  assert.deepEqual(toggleDead(b, dead, b.toIdx(2, 2)), dead);
});

test('toggleDead：一块中只有部分被标死时，点击后整块标死', () => {
  const b = fromDiagram(`
    X X X
    . . .
    . . .
  `);
  const dead = toggleDead(b, [b.toIdx(0, 0)], b.toIdx(2, 0));
  assert.deepEqual(dead, [0, 1, 2]);
});
