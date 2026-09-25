'use strict';
const { createGame, play, pass, resume } = require('../../utils/engine/game');
const { BLACK, WHITE } = require('../../utils/engine/board');
const { PASS } = require('../../utils/engine/coords');

// 对局页与复盘页共用的着手序列工具（纯函数，不依赖 wx）。

// 第 n 手（从 1 数）的颜色：奇数为黑
function colorOfMove(n) {
  return n % 2 === 1 ? BLACK : WHITE;
}

function isValidMove(mv, size) {
  return mv === PASS || (Number.isInteger(mv) && mv >= 0 && mv < size * size);
}

// 从着手序列重建局面（autoScore=false）。
// 与 record.replay 的区别：连续两次 pass 后若还有着手，说明数子阶段有人选了"继续对局"，
// 此时先 resume 再继续（record.replay 会把这种序列判为非法）。
// 非法着手抛出 Error，err.moveIndex 为出错位置（从 0 数），err.reason 为原因。
// onMove(state, i) 在每一手之后调用（复盘页用来记录每一手的局面）。
function replayMoves(size, komi, moves, { onMove } = {}) {
  const state = createGame({ size, komi, autoScore: false });
  const list = moves || [];
  for (let i = 0; i < list.length; i++) {
    const mv = list[i];
    if (!isValidMove(mv, size)) {
      const err = new Error(`第 ${i + 1} 手非法：坐标无效`);
      err.moveIndex = i;
      err.reason = 'invalid';
      throw err;
    }
    if (state.status === 'scoring') resume(state);
    const r = mv === PASS ? pass(state) : play(state, mv);
    if (!r.ok) {
      const err = new Error(`第 ${i + 1} 手非法：${r.reason}`);
      err.moveIndex = i;
      err.reason = r.reason;
      throw err;
    }
    if (onMove) onMove(state, i);
  }
  return state;
}

// 引擎状态的浅拷贝：棋盘与会被原地修改的字段复制一份，历史记录项本身不会被引擎修改，可共享
function cloneState(state) {
  return Object.assign({}, state, {
    board: state.board.clone(),
    history: state.history.slice(),
    captures: { [BLACK]: state.captures[BLACK], [WHITE]: state.captures[WHITE] },
    result: state.result ? Object.assign({}, state.result) : null,
  });
}

// 最近一手落子（非 pass）的位置，没有则为 -1
function lastPlacedIdx(state) {
  for (let i = state.history.length - 1; i >= 0; i--) {
    if (state.history[i].idx !== null) return state.history[i].idx;
  }
  return -1;
}

module.exports = { PASS, colorOfMove, isValidMove, replayMoves, cloneState, lastPlacedIdx };
