'use strict';
// 本地对弈的数子阶段（纯函数，便于单测）：双方连续停一手后进入数子，点棋子标记死棋，按中国规则数子法计分。
const { BLACK, EMPTY } = require('../../utils/engine/board');
const { scoreArea, toggleDead } = require('../../utils/engine/score');
const { resultLabel } = require('../../utils/engine/record');

function formatNumber(x) {
  return Number.isInteger(x) ? String(x) : String(Number(x.toFixed(1)));
}

// 当前死子标记下的计分 → 页面数据
function scoreView(board, komi, dead) {
  const s = scoreArea(board, komi, dead);
  const diff = Math.abs(s.black - s.white);
  return {
    marks: { dead: s.dead, owner: s.owner },
    dead: s.dead,
    blackText: `${formatNumber(s.black)} 点`,
    whiteText: `${formatNumber(s.white)} 点`,
    leadText: s.winner === 0 ? '双方点数相同' : `按当前标记：${s.winner === BLACK ? '黑' : '白'}胜 ${formatNumber(diff)} 目`,
    komiText: komi ? `白方点数已含贴目 ${formatNumber(komi)}` : '',
    result: { winner: s.winner, reason: 'score', black: s.black, white: s.white },
  };
}

// 点选：切换所在整块的死活；点在空点上返回 null
function toggle(board, dead, idx) {
  if (!Number.isInteger(idx) || idx < 0 || idx >= board.n * board.n) return null;
  if (board.get(idx) === EMPTY) return null;
  return toggleDead(board, dead, idx);
}

// 终局面板文字
function endView(result) {
  if (!result) return null;
  let title = '和棋';
  if (result.winner === 1) title = '黑胜';
  else if (result.winner === 2) title = '白胜';
  let detail = '';
  if (result.reason === 'score' && typeof result.black === 'number' && typeof result.white === 'number') {
    detail = `黑 ${formatNumber(result.black)} 点 : 白 ${formatNumber(result.white)} 点`;
  } else if (result.reason === 'resign') {
    detail = result.winner === 1 ? '白方认输' : '黑方认输';
  }
  return { title, label: resultLabel(result), detail };
}

module.exports = { scoreView, toggle, endView, formatNumber };
