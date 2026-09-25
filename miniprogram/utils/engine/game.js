'use strict';

// 一局棋的状态与操作。下面每个操作都直接改写传入的 state，不另造新对象。
// status 的三种取值：
//   'playing' 正常行棋；
//   'scoring' 仅在 autoScore 为 false 时出现：双方接连停一手后停在这里，由外部确认死子；
//   'ended'   已有结果（自动数子、认输，或调用方通过 finish 给出）。
const { Board, EMPTY, BLACK, WHITE, opponent } = require('./board');
const { tryPlay } = require('./rules');
const { score } = require('./score');

function createGame(options) {
  const { size = 19, komi = 7.5, autoScore = true } = options || {};
  return {
    board: new Board(size),
    size,
    komi,
    autoScore,
    toPlay: BLACK,
    ko: null,
    history: [],
    captures: { [BLACK]: 0, [WHITE]: 0 },
    consecutivePasses: 0,
    status: 'playing',
    result: null,
  };
}

// 落子、停一手只能在 playing 阶段进行；其余阶段返回拒绝结果，playing 时返回 null
function refuseUnlessPlaying(state) {
  switch (state.status) {
    case 'playing':
      return null;
    case 'scoring':
      return { ok: false, reason: 'scoring' };
    default:
      return { ok: false, reason: 'ended' };
  }
}

// 往 history 里追加一手（idx 为 null 表示停一手）。
// 必须在改动 state.ko / consecutivePasses 之前调用，koBefore、passesBefore 才是这手之前的值
function logMove(state, color, idx, captured, koAfter) {
  state.history.push({
    color,
    idx,
    captured,
    koBefore: state.ko,
    koAfter,
    passesBefore: state.consecutivePasses,
  });
}

function play(state, idx) {
  const refused = refuseUnlessPlaying(state);
  if (refused) return refused;
  const mover = state.toPlay;
  const outcome = tryPlay(state.board, mover, state.ko, idx);
  if (!outcome.ok) return { ok: false, reason: outcome.reason };

  logMove(state, mover, idx, outcome.captured, outcome.koAfter);
  state.captures[mover] += outcome.captured.length;
  state.ko = outcome.koAfter;
  state.toPlay = opponent(mover);
  state.consecutivePasses = 0;
  return { ok: true };
}

// 双方接连停一手之后：交给外部数子，或者直接按 Tromp-Taylor 计分结束
function closeAfterPasses(state) {
  if (state.autoScore === false) {
    state.status = 'scoring';
    return;
  }
  const { winner, black, white } = score(state.board, state.komi);
  state.status = 'ended';
  state.result = { winner, black, white, reason: 'score' };
}

function pass(state) {
  const refused = refuseUnlessPlaying(state);
  if (refused) return refused;
  const mover = state.toPlay;
  logMove(state, mover, null, [], null);
  state.ko = null; // 隔了一手，原先的劫点不再禁着
  state.toPlay = opponent(mover);
  state.consecutivePasses += 1;
  if (state.consecutivePasses >= 2) closeAfterPasses(state);
  return { ok: true };
}

// scoring → playing。停一手的计数清零，toPlay 保持原值
function resume(state) {
  if (state.status !== 'scoring') return { ok: false, reason: 'not-scoring' };
  state.status = 'playing';
  state.consecutivePasses = 0;
  return { ok: true };
}

// 直接结束对局，结果由调用方给出（例如 { winner, reason: 'timeout' }）；没给的 black / white 记为 null
function finish(state, result) {
  if (state.status === 'ended') return { ok: false, reason: 'ended' };
  state.status = 'ended';
  state.result = Object.assign({ black: null, white: null }, result);
  return { ok: true };
}

// 认输。color 是黑或白时由该方认输，否则由当前该下的一方认输
function resign(state, color) {
  if (state.status !== 'playing' && state.status !== 'scoring') return { ok: false, reason: 'ended' };
  const quitter = color === BLACK || color === WHITE ? color : state.toPlay;
  state.status = 'ended';
  state.result = { winner: opponent(quitter), black: null, white: null, reason: 'resign' };
  return { ok: true };
}

// ---------- 悔棋 ----------

function reopen(state) {
  state.status = 'playing';
  state.result = null;
}

// history 末尾有几手连续的停一手（兼容没有 passesBefore 字段的旧记录）
function trailingPasses(history) {
  let count = 0;
  let i = history.length - 1;
  while (i >= 0 && history[i].idx === null) {
    count += 1;
    i -= 1;
  }
  return count;
}

// 把一手落子从棋盘上拿掉，被它提走的对方棋子放回原处，提子数同步扣回
function takeBack(state, entry) {
  const board = state.board;
  board.set(entry.idx, EMPTY);
  const victim = opponent(entry.color);
  entry.captured.forEach((p) => board.set(p, victim));
  state.captures[entry.color] -= entry.captured.length;
}

// 认输后悔棋只取消认输本身，棋盘与记录都不动；否则撤回 history 的最后一手。
// 什么都撤不了时返回 false
function undo(state) {
  if (state.result && state.result.reason === 'resign') {
    reopen(state);
    return true;
  }
  if (state.history.length === 0) return false;
  const entry = state.history.pop();
  if (Number.isInteger(entry.idx)) takeBack(state, entry);
  state.ko = entry.koBefore === undefined ? null : entry.koBefore;
  state.toPlay = entry.color;
  state.consecutivePasses = Number.isInteger(entry.passesBefore) ? entry.passesBefore : trailingPasses(state.history);
  reopen(state);
  return true;
}

module.exports = { createGame, play, pass, undo, resign, resume, finish };
