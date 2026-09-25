'use strict';
const { Board, BLACK, WHITE, opponent } = require('../../utils/engine/board');
const { scoreArea } = require('../../utils/engine/score');
const { resultLabel, toSgf } = require('../../utils/engine/record');
const { idxToGtp } = require('../../utils/engine/coords');
const { PASS, colorOfMove, replayMoves } = require('../play/moves');

// 复盘页的纯逻辑：由 GET /api/games/:id 返回的 GameRecord 预先算好每一手之后的局面，
// 拖动进度条时直接取用，不再重放。

const MODES = ['ranked', 'friend', 'ai'];
const MODE_LABEL = { ranked: '排位赛', friend: '好友对局', ai: '人机对局' };
const MY_RESULT = {
  win: { text: '胜', tone: 'win' },
  loss: { text: '负', tone: 'loss' },
  draw: { text: '和', tone: 'draw' },
  void: { text: '作废', tone: 'void' },
};

function finiteOr(x, fallback) {
  return typeof x === 'number' && Number.isFinite(x) ? x : fallback;
}

function formatNumber(x) {
  return Number.isInteger(x) ? String(x) : String(Number(x.toFixed(1)));
}

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

// 毫秒时间戳 → 'YYYY-MM-DD HH:mm'（本地时区）；无效返回 ''
function formatDate(ts, withTime = true) {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return '';
  const d = new Date(ts);
  const day = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return withTime ? `${day} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` : day;
}

function badRecord(msg) {
  const err = new Error(`棋谱数据异常：${msg}`);
  err.code = 'bad_record';
  return err;
}

function normalizePlayer(p, color) {
  const o = p && typeof p === 'object' ? p : {};
  const isAi = o.ai === true;
  let nickname = typeof o.nickname === 'string' && o.nickname.trim() ? o.nickname : '';
  if (!nickname && isAi && typeof o.levelName === 'string') nickname = `AI · ${o.levelName}`;
  if (!nickname) nickname = isAi ? 'AI' : `${color === BLACK ? '黑' : '白'}方`;
  return { isAi, nickname, avatarUrl: typeof o.avatarUrl === 'string' ? o.avatarUrl : '' };
}

// players 缺失时用 GameSummary 的 opponent 字段补齐
function playersOf(record, myColor) {
  if (record.players && typeof record.players === 'object') {
    return { [BLACK]: normalizePlayer(record.players[BLACK], BLACK), [WHITE]: normalizePlayer(record.players[WHITE], WHITE) };
  }
  const opp = record.opponent && typeof record.opponent === 'object' ? record.opponent : {};
  return {
    [myColor]: normalizePlayer({ nickname: '我' }, myColor),
    [opponent(myColor)]: normalizePlayer(opp, opponent(myColor)),
  };
}

function myResultOf(record, myColor, winner, reason) {
  if (MY_RESULT[record.myResult]) return record.myResult;
  if (winner === null) return '';
  if (reason === 'abort') return 'void';
  if (winner === 0) return 'draw';
  return winner === myColor ? 'win' : 'loss';
}

// GameRecord → 复盘模型。数据不合法时抛出 Error（code: 'bad_record'）；
// 着手序列中途非法时不抛错：只保留之前的局面，并在 error 中说明。
function fromRecord(record) {
  if (!record || typeof record !== 'object') throw badRecord('棋谱为空');
  const size = record.size;
  if (!Number.isInteger(size) || size < 2 || size > 19) throw badRecord(`路数无效 ${size}`);
  if (!Array.isArray(record.moves)) throw badRecord('缺少着手序列');
  const komi = finiteOr(record.komi, 7.5);
  const myColor = record.myColor === WHITE ? WHITE : BLACK;
  const winner = [0, BLACK, WHITE].includes(record.winner) ? record.winner : null;
  const reason = ['score', 'resign', 'timeout', 'abort'].includes(record.reason) ? record.reason : null;
  const moves = record.moves.slice();

  // frames[k]：第 k 手之后的局面（frames[0] 为空棋盘）
  const frames = [{ cells: new Int8Array(size * size), captures: { [BLACK]: 0, [WHITE]: 0 }, lastIdx: -1 }];
  let error = '';
  try {
    replayMoves(size, komi, moves, {
      onMove: (state, i) => {
        const mv = moves[i];
        frames.push({
          cells: Int8Array.from(state.board.cells),
          captures: { [BLACK]: state.captures[BLACK], [WHITE]: state.captures[WHITE] },
          lastIdx: mv === PASS ? frames[i].lastIdx : mv,
        });
      },
    });
  } catch (err) {
    const at = Number.isInteger(err.moveIndex) ? err.moveIndex : frames.length - 1;
    error = `棋谱第 ${at + 1} 手数据异常，只能显示到第 ${at} 手`;
  }
  const total = frames.length - 1;

  const scoreBlack = finiteOr(record.scoreBlack, null);
  const scoreWhite = finiteOr(record.scoreWhite, null);
  // 数子终局：最后一个局面上标出死子与地盘
  let finalMarks = null;
  if (reason === 'score' && !error && Array.isArray(record.dead)) {
    const board = new Board(size);
    board.cells.set(frames[total].cells);
    const s = scoreArea(board, komi, record.dead);
    finalMarks = { dead: s.dead, owner: s.owner };
  }

  return {
    id: typeof record.id === 'string' ? record.id : '',
    mode: MODES.includes(record.mode) ? record.mode : null,
    size,
    komi,
    moves,
    total,
    frames,
    players: playersOf(record, myColor),
    myColor,
    winner,
    reason,
    scoreBlack,
    scoreWhite,
    myResult: myResultOf(record, myColor, winner, reason),
    createdAt: finiteOr(record.createdAt, null),
    endedAt: finiteOr(record.endedAt, null),
    finalMarks,
    error,
  };
}

// 把任意输入夹到 [0, total]；非数字按最后一手处理
function clampMove(model, k) {
  const n = Number(k);
  if (!Number.isFinite(n)) return model.total;
  return Math.min(model.total, Math.max(0, Math.round(n)));
}

function coordText(idx, size) {
  try {
    return idxToGtp(idx, size);
  } catch (err) {
    return `(${(idx % size) + 1},${Math.floor(idx / size) + 1})`;
  }
}

function resultLabelOf(model) {
  if (model.winner === null || model.reason === null) return '对局未结束';
  return resultLabel({ winner: model.winner, reason: model.reason, black: model.scoreBlack, white: model.scoreWhite });
}

// 页面顶部（不随手数变化）的数据
function headerView(model) {
  const pv = (color) => {
    const p = model.players[color];
    return { nickname: p.nickname, avatarUrl: p.avatarUrl, isAi: p.isAi, isMe: color === model.myColor };
  };
  const my = MY_RESULT[model.myResult];
  const mode = model.mode ? `${MODE_LABEL[model.mode]} · ` : '';
  return {
    size: model.size,
    infoText: `${mode}${model.size} 路 · 贴 ${formatNumber(model.komi)} 目 · 共 ${model.moves.length} 手`,
    dateText: formatDate(model.createdAt),
    black: pv(BLACK),
    white: pv(WHITE),
    resultLabel: resultLabelOf(model),
    myResultText: my ? my.text : '',
    myResultTone: my ? my.tone : '',
    error: model.error,
  };
}

// 第 k 手之后的局面（setData 用）
function viewAt(model, k) {
  const kk = clampMove(model, k);
  const f = model.frames[kk];
  const atEnd = kk === model.total;
  let moveText = '开局';
  if (kk > 0) {
    const mv = model.moves[kk - 1];
    const side = colorOfMove(kk) === BLACK ? '黑' : '白';
    moveText = `第 ${kk} 手 · ${side} ${mv === PASS ? '停一手' : coordText(mv, model.size)}`;
  }
  const showScore = atEnd && model.reason === 'score' && model.scoreBlack !== null && model.scoreWhite !== null;
  return {
    k: kk,
    total: model.total,
    cells: Array.from(f.cells),
    lastIdx: f.lastIdx,
    captures: { 1: f.captures[BLACK], 2: f.captures[WHITE] },
    moveText,
    marks: atEnd ? model.finalMarks : null,
    finalText: showScore ? `黑 ${formatNumber(model.scoreBlack)} 点 · 白 ${formatNumber(model.scoreWhite)} 点（白含贴目 ${formatNumber(model.komi)}）` : '',
    canPrev: kk > 0,
    canNext: kk < model.total,
  };
}

// 导出 SGF 棋谱文本
function sgfOf(model) {
  return toSgf({
    size: model.size,
    komi: model.komi,
    moves: model.moves.slice(0, model.total),
    blackName: model.players[BLACK].nickname,
    whiteName: model.players[WHITE].nickname,
    result: model.winner === null || model.reason === null ? null : { winner: model.winner, reason: model.reason, black: model.scoreBlack, white: model.scoreWhite },
    date: formatDate(model.createdAt, false),
  });
}

// 加载失败的中文提示（api.request 失败时 reject { code, msg, status }）
function loadErrorText(err) {
  const code = err && typeof err.code === 'string' ? err.code : '';
  const status = err && typeof err.status === 'number' ? err.status : 0;
  if (code === 'bad_record') return err.message;
  if (code === 'not_found' || status === 404) return '对局不存在';
  if (code === 'forbidden' || code === 'not_player' || status === 403) return '只能查看自己参与的对局';
  if (code === 'offline' || code === 'network') return '网络未连接，请稍后再试';
  if (code === 'unauthorized' || status === 401) return '登录已失效，请重新进入';
  const msg = err && (typeof err.msg === 'string' ? err.msg : typeof err.message === 'string' ? err.message : '');
  return msg || '棋谱加载失败，请重试';
}

module.exports = { MODE_LABEL, fromRecord, clampMove, viewAt, headerView, sgfOf, loadErrorText, formatDate };
