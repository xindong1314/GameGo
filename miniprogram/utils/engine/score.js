'use strict';

// 数子法计分（区域计分）。
// score：Tromp-Taylor，棋盘上的子全算活子；
// scoreArea：先把 dead 里的子当作已提掉，再按同样的办法计分，并给出每个点的归属。
const { EMPTY, BLACK, WHITE } = require('./board');

function isPoint(board, i) {
  return Number.isInteger(i) && i >= 0 && i < board.n * board.n;
}

function asList(dead) {
  if (dead == null) return [];
  return Array.isArray(dead) ? dead : Array.from(dead);
}

// 整数、去重、升序
function uniqueSorted(values) {
  const out = Array.from(new Set(values.filter((v) => Number.isInteger(v))));
  return out.sort((a, b) => a - b);
}

// 生效的死子：盘内、有子，去重升序
function effectiveDead(board, dead) {
  return uniqueSorted(asList(dead).filter((i) => isPoint(board, i) && board.get(i) !== EMPTY));
}

// 计分核心。removed[i] 为 1 表示该点的子按死子处理（当作空点）。
function tally(board, komi, removed) {
  const total = board.n * board.n;
  const cells = board.cells;
  // 实际参与计分的颜色：死子处视为空点
  const colorAt = (i) => (removed && removed[i] ? EMPTY : cells[i]);

  const owner = new Array(total).fill(EMPTY);
  const visited = new Uint8Array(total);
  let blackStones = 0;
  let whiteStones = 0;
  let blackArea = 0;
  let whiteArea = 0;

  for (let start = 0; start < total; start++) {
    const c = colorAt(start);
    if (c === BLACK || c === WHITE) {
      owner[start] = c;
      if (c === BLACK) blackStones += 1;
      else whiteStones += 1;
      continue;
    }
    if (visited[start]) continue;

    // 从 start 出发找出整片空区，并记下它接触到的颜色
    const region = [start];
    visited[start] = 1;
    let seesBlack = false;
    let seesWhite = false;
    for (let head = 0; head < region.length; head++) {
      const around = board.neighbors(region[head]);
      for (let k = 0; k < around.length; k++) {
        const nb = around[k];
        const d = colorAt(nb);
        if (d === BLACK) seesBlack = true;
        else if (d === WHITE) seesWhite = true;
        else if (!visited[nb]) {
          visited[nb] = 1;
          region.push(nb);
        }
      }
    }

    let who = EMPTY;
    if (seesBlack && !seesWhite) who = BLACK;
    else if (seesWhite && !seesBlack) who = WHITE;
    if (who === EMPTY) continue; // 无主（双方都挨着，或谁都不挨着）
    for (let k = 0; k < region.length; k++) owner[region[k]] = who;
    if (who === BLACK) blackArea += region.length;
    else whiteArea += region.length;
  }

  const black = blackStones + blackArea;
  const white = whiteStones + whiteArea + komi;
  let winner = EMPTY;
  if (black > white) winner = BLACK;
  else if (white > black) winner = WHITE;
  return { black, white, winner, blackStones, whiteStones, blackArea, whiteArea, owner };
}

function score(board, komi = 0) {
  const t = tally(board, komi, null);
  return {
    black: t.black,
    white: t.white,
    winner: t.winner,
    blackStones: t.blackStones,
    whiteStones: t.whiteStones,
    blackArea: t.blackArea,
    whiteArea: t.whiteArea,
  };
}

function scoreArea(board, komi = 0, dead = []) {
  const list = effectiveDead(board, dead);
  const removed = new Uint8Array(board.n * board.n);
  for (let k = 0; k < list.length; k++) removed[list[k]] = 1;
  const t = tally(board, komi, removed);
  t.dead = list;
  return t;
}

// 切换 idx 所在整块的死活，返回新的死子数组（不改动传入的数组）。
// 整块都已标死 → 全部取消；否则（没标或只标了一部分）→ 整块标死。
function toggleDead(board, dead, idx) {
  const base = uniqueSorted(asList(dead));
  const g = board.group(idx); // 空点、越界或非整数时为 null
  if (!g) return base;
  const set = new Set(base);
  const allDead = g.stones.every((s) => set.has(s));
  for (const s of g.stones) {
    if (allDead) set.delete(s);
    else set.add(s);
  }
  return Array.from(set).sort((a, b) => a - b);
}

module.exports = { score, scoreArea, toggleDead };
