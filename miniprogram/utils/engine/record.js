'use strict';
const { BLACK, WHITE } = require('./board');
const { createGame, play, pass, resume } = require('./game');
const { PASS, idxToSgf } = require('./coords');

// 对局记录：着手序列 moves 为整数数组，落子为 idx，pass 为 -1。
// 联网协议、数据库、复盘都使用这种表示；黑先、轮流行棋，不记录颜色。

function movesOf(state) {
  return state.history.map((m) => (m.idx === null ? PASS : m.idx));
}

// 从着手序列重建对局状态。遇到非法着手抛出 Error（err.moveIndex 为出错位置）。
// 返回的状态 autoScore 默认为 false：两次 pass 之后停在 'scoring'。
// 着手序列不记录"继续对局"：数子阶段之后如果还有着手，说明当时有人选择了继续对局，
// 这里先 resume() 再落下这一手。
function replay(size, komi, moves, { autoScore = false } = {}) {
  const state = createGame({ size, komi, autoScore });
  (moves || []).forEach((mv, i) => {
    if (state.status === 'scoring') resume(state);
    const r = mv === PASS ? pass(state) : play(state, mv);
    if (!r.ok) {
      const err = new Error(`第 ${i + 1} 手非法：${r.reason}`);
      err.moveIndex = i;
      err.reason = r.reason;
      throw err;
    }
  });
  return state;
}

function formatNumber(x) {
  return Number.isInteger(x) ? String(x) : String(Number(x.toFixed(1)));
}

// 结果文本，采用 SGF RE 的写法：B+R / W+T / B+3.5 / 0（和棋）/ Void（作废）
function resultText(result) {
  if (!result) return '';
  if (result.reason === 'abort') return 'Void';
  if (result.winner === 0) return '0';
  const side = result.winner === BLACK ? 'B' : result.winner === WHITE ? 'W' : '?';
  if (result.reason === 'resign') return `${side}+R`;
  if (result.reason === 'timeout') return `${side}+T`;
  if (result.reason === 'score' && typeof result.black === 'number' && typeof result.white === 'number') {
    return `${side}+${formatNumber(Math.abs(result.black - result.white))}`;
  }
  return `${side}+`;
}

// 中文结果描述，供界面显示
function resultLabel(result) {
  if (!result) return '';
  if (result.reason === 'abort') return '对局作废';
  if (result.winner === 0) return '和棋';
  const side = result.winner === BLACK ? '黑' : '白';
  if (result.reason === 'resign') return `${side}中盘胜（对方认输）`;
  if (result.reason === 'timeout') return `${side}胜（对方超时）`;
  if (result.reason === 'score' && typeof result.black === 'number' && typeof result.white === 'number') {
    // 显示双方点数之差（多数围棋应用的"胜 X 目"写法）；换算成"子"需再除以 2
    return `${side}胜 ${formatNumber(Math.abs(result.black - result.white))} 目`;
  }
  return `${side}胜`;
}

function escapeSgf(text) {
  return String(text == null ? '' : text).replace(/\\/g, '\\\\').replace(/]/g, '\\]');
}

// 生成 SGF 棋谱文本
function toSgf({ size, komi, moves, blackName, whiteName, result, date }) {
  const head = [
    'FF[4]',
    'GM[1]',
    'CA[UTF-8]',
    'AP[GameGo]',
    'RU[Chinese]',
    `SZ[${size}]`,
    `KM[${formatNumber(komi)}]`,
  ];
  if (blackName) head.push(`PB[${escapeSgf(blackName)}]`);
  if (whiteName) head.push(`PW[${escapeSgf(whiteName)}]`);
  if (date) head.push(`DT[${escapeSgf(date)}]`);
  const re = resultText(result);
  if (re) head.push(`RE[${re}]`);
  const body = (moves || []).map((mv, i) => `;${i % 2 === 0 ? 'B' : 'W'}[${idxToSgf(mv, size)}]`);
  return `(;${head.join('')}${body.join('')})`;
}

module.exports = { PASS, movesOf, replay, resultText, resultLabel, toSgf };
