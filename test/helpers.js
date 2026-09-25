'use strict';

// 测试工具：用字符画描述棋盘。X 黑、O 白、. 空，第一行是棋盘最上面一行。
//   fromDiagram(`
//     . X .
//     X O X
//     . . .
//   `)
// 行内空白随意，空行忽略；行数就是路数。
const { Board, EMPTY, BLACK, WHITE } = require('../miniprogram/utils/engine/board');

// 下标即颜色值：SYMBOLS[EMPTY] === '.'、SYMBOLS[BLACK] === 'X'、SYMBOLS[WHITE] === 'O'
const SYMBOLS = ['.', 'X', 'O'];

// 拆出有效的行：去掉每行里的全部空白，丢掉空行
function meaningfulRows(text) {
  const rows = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const row = raw.replace(/\s/g, '');
    if (row !== '') rows.push(row);
  }
  return rows;
}

function fromDiagram(text) {
  const rows = meaningfulRows(text);
  const n = rows.length;
  if (n === 0) throw new Error('fromDiagram：字符画里没有任何棋盘行');
  const bad = rows.findIndex((row) => row.length !== n);
  if (bad !== -1) {
    throw new Error(`fromDiagram：共 ${n} 行，但第 ${bad + 1} 行有 ${rows[bad].length} 个点（应为方形棋盘）`);
  }
  // 按行拼接后的第 k 个字符恰好对应索引 k（idx = y * n + x）
  const flat = rows.join('');
  const board = new Board(n);
  for (let k = 0; k < flat.length; k++) {
    const color = SYMBOLS.indexOf(flat[k]);
    if (color === -1) throw new Error(`fromDiagram：不认识的字符 "${flat[k]}"（位置 ${k}），只能用 X / O / .`);
    board.set(k, color);
  }
  return board;
}

function toDiagram(board) {
  const symbols = Array.from(board.cells, (c) => SYMBOLS[c]);
  const lines = [];
  for (let start = 0; start < symbols.length; start += board.n) {
    lines.push(symbols.slice(start, start + board.n).join(' '));
  }
  return lines.join('\n');
}

module.exports = { fromDiagram, toDiagram, BLACK, WHITE, EMPTY };
