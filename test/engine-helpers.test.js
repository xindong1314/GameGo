'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Board } = require('../miniprogram/utils/engine/board');
const { fromDiagram, toDiagram, BLACK, WHITE, EMPTY } = require('./helpers');

test('helpers 转出颜色常量', () => {
  assert.equal(EMPTY, 0);
  assert.equal(BLACK, 1);
  assert.equal(WHITE, 2);
});

test('fromDiagram：X 黑 O 白 . 空，左上角是索引 0', () => {
  const b = fromDiagram(`
    X . O
    . . .
    . O X
  `);
  assert.ok(b instanceof Board);
  assert.equal(b.n, 3);
  assert.deepEqual(Array.from(b.cells), [1, 0, 2, 0, 0, 0, 0, 2, 1]);
});

test('fromDiagram：行内空白全部去掉，空行被忽略', () => {
  const a = fromDiagram('X.O\n...\n.OX');
  const b = fromDiagram('\n\n  X   .O \n\t. . .\n\n .  O X  \n\n');
  assert.deepEqual(Array.from(a.cells), Array.from(b.cells));
});

test('toDiagram：字符之间一个空格，行之间换行，没有多余空白', () => {
  const b = new Board(3);
  b.set(b.toIdx(1, 0), BLACK);
  b.set(b.toIdx(2, 2), WHITE);
  assert.equal(toDiagram(b), '. X .\n. . .\n. . O');
});

test('fromDiagram 与 toDiagram 往返一致', () => {
  const text = [
    'X O . . X',
    '. X O O .',
    'O . . X X',
    '. . O . .',
    'X X X O O',
  ].join('\n');
  assert.equal(toDiagram(fromDiagram(text)), text);

  const b = new Board(9);
  for (let i = 0; i < 81; i++) b.set(i, (i * 7) % 3);
  const again = fromDiagram(toDiagram(b));
  assert.deepEqual(Array.from(again.cells), Array.from(b.cells));
});

test('fromDiagram：行宽与行数不一致时报错', () => {
  assert.throws(() => fromDiagram('X .\n. . .'));
  assert.throws(() => fromDiagram('. . .\n. .\n. . .'));
  assert.throws(() => fromDiagram('. . . .\n. . . .\n. . . .'));
});

test('fromDiagram：无法识别的字符报错', () => {
  assert.throws(() => fromDiagram('x .\n. .'));
  assert.throws(() => fromDiagram('. #\n. .'));
  assert.throws(() => fromDiagram('0 .\n. .'));
});

test('fromDiagram：空字符画报错', () => {
  assert.throws(() => fromDiagram(''));
  assert.throws(() => fromDiagram('\n  \n\t\n'));
});
