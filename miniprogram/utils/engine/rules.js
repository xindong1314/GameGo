'use strict';

// 单手棋的合法性判定与执行：提子、禁止自杀、劫（不许立即回提单个子）。
const { EMPTY, BLACK, WHITE, opponent } = require('./board');

function reject(reason) {
  return { ok: false, reason };
}

// 以 color 落在 idx 之后（子已放上），与 idx 相邻、已无气的对方棋块中的全部棋子。
// 先把要提的块全部找出来再统一拿掉：对方两块只要互不相连，提掉其中一块不会影响另一块的气。
function doomedStones(board, idx, color) {
  const foe = opponent(color);
  const inspected = new Set(); // 已检查过的对方棋子，避免同一块被查两遍
  const doomed = [];
  for (const p of board.neighbors(idx)) {
    if (inspected.has(p) || board.get(p) !== foe) continue;
    const blk = board.group(p);
    blk.stones.forEach((s) => inspected.add(s));
    if (blk.liberties.length === 0) doomed.push(...blk.stones);
  }
  return doomed;
}

// board 上由 color 落子于 idx；ko 为此刻不许落子的劫点（没有则为 null）。
// 合法：直接改动 board，返回 { ok: true, captured, koAfter }；不合法：board 原样不动。
function tryPlay(board, color, ko, idx) {
  const points = board.n * board.n;
  if (!Number.isInteger(idx) || idx < 0 || idx >= points) return reject('invalid');
  if (color !== BLACK && color !== WHITE) return reject('invalid');
  if (board.get(idx) !== EMPTY) return reject('occupied');
  if (idx === ko) return reject('ko');

  board.set(idx, color);
  const captured = doomedStones(board, idx, color);
  captured.forEach((s) => board.set(s, EMPTY));

  const mine = board.group(idx);
  if (captured.length === 0 && mine.liberties.length === 0) {
    board.set(idx, EMPTY); // 一个子也没提到、自己却没气：自杀，不论单子多子，收回这手
    return reject('suicide');
  }

  captured.sort((a, b) => a - b);
  // 只提掉一个子，而落下的子孤立无援、仅剩的一口气正是被提的那个点：
  // 对方若立即回提就会还原局面，所以把这个点记为下一手的劫点
  const makesKo = captured.length === 1 && mine.stones.length === 1 && mine.liberties.length === 1;
  return { ok: true, captured, koAfter: makesKo ? captured[0] : null };
}

// 只问能不能下：在副本上试一下，board 本身不受影响
function canPlay(board, color, ko, idx) {
  const { ok, reason } = tryPlay(board.clone(), color, ko, idx);
  return ok ? { ok: true, reason: null } : { ok: false, reason };
}

module.exports = { tryPlay, canPlay };
