'use strict';

// 棋盘数据结构。
// 交叉点按行展开成一维：idx = y * n + x，(0,0) 是左上角。
// cells 是 Int8Array，0 空、1 黑、2 白；外部代码会直接读写它，布局不能改。

const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

// 对方颜色；传入的不是黑白则返回 EMPTY
function opponent(color) {
  if (color === BLACK) return WHITE;
  if (color === WHITE) return BLACK;
  return EMPTY;
}

// 每种路数的相邻表只算一次：ADJACENCY.get(n)[idx] 为 idx 的上下左右（盘内）
const ADJACENCY = new Map();

function adjacencyOf(n) {
  let table = ADJACENCY.get(n);
  if (table) return table;
  table = new Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const list = [];
      if (y > 0) list.push(i - n);
      if (y < n - 1) list.push(i + n);
      if (x > 0) list.push(i - 1);
      if (x < n - 1) list.push(i + 1);
      table[i] = list;
    }
  }
  ADJACENCY.set(n, table);
  return table;
}

class Board {
  constructor(n) {
    if (!Number.isInteger(n) || n < 1) throw new RangeError(`棋盘路数必须是正整数：${n}`);
    this.n = n;
    this.cells = new Int8Array(n * n);
  }

  toIdx(x, y) {
    return y * this.n + x;
  }

  toXY(idx) {
    const x = idx % this.n;
    return { x, y: (idx - x) / this.n };
  }

  get(idx) {
    return this.cells[idx];
  }

  set(idx, color) {
    this.cells[idx] = color;
  }

  // 上下左右在盘内的相邻点。返回新数组，调用方可以随意修改
  neighbors(idx) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.cells.length) return [];
    return adjacencyOf(this.n)[idx].slice();
  }

  // idx 所在的同色连通块：{ color, stones, liberties }；idx 上没有棋子或不在盘内时为 null。
  // 用 stones 数组本身充当广度优先的队列，不递归。
  group(idx) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.cells.length) return null;
    const cells = this.cells;
    const color = cells[idx];
    if (color === EMPTY) return null;
    const adj = adjacencyOf(this.n);
    // 0 未访问；1 已收入本块；2 已记为气
    const seen = new Uint8Array(cells.length);
    const stones = [idx];
    const liberties = [];
    seen[idx] = 1;
    for (let head = 0; head < stones.length; head++) {
      const around = adj[stones[head]];
      for (let k = 0; k < around.length; k++) {
        const nb = around[k];
        if (seen[nb]) continue;
        const c = cells[nb];
        if (c === color) {
          seen[nb] = 1;
          stones.push(nb);
        } else if (c === EMPTY) {
          seen[nb] = 2;
          liberties.push(nb);
        }
      }
    }
    return { color, stones, liberties };
  }

  clone() {
    const copy = new Board(this.n);
    copy.cells.set(this.cells);
    return copy;
  }
}

module.exports = { Board, EMPTY, BLACK, WHITE, opponent };
