'use strict';
const engine = require('../engine');

// AI 模块内部共用：参数校验、按着手序列重建局面、坐标换算、视角换算。
// 规则一律以本项目引擎为准（KataGo 对传入的 moves 很宽容，合法性只能由我们保证）。

const { BLACK, WHITE, EMPTY } = engine.board;
const { PASS, idxToGtp, gtpToIdx } = engine.coords;
const { canPlay } = engine.rules;

const SIZES = Object.freeze([9, 13, 19]);
const MAX_MOVES = 2000; // 远超任何正常对局；只是防止异常请求
const MAX_ABS_KOMI = 150;

// 带错误码的错误：bad_request（参数不对）、ai_unavailable、katago_error、timeout
class AiError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

function badRequest(msg) {
  return new AiError('bad_request', msg);
}

function unavailable(msg = 'AI 暂不可用') {
  return new AiError('ai_unavailable', msg);
}

function checkSize(size) {
  if (!SIZES.includes(size)) throw badRequest(`不支持的路数：${String(size)}（只支持 9/13/19）`);
  return size;
}

// KataGo 只接受整数或半整数贴目
function checkKomi(komi) {
  if (typeof komi !== 'number' || !Number.isFinite(komi) || Math.abs(komi) > MAX_ABS_KOMI || !Number.isInteger(komi * 2)) {
    throw badRequest(`贴目不合法：${String(komi)}`);
  }
  return komi;
}

function checkMovesShape(moves, size) {
  if (!Array.isArray(moves)) throw badRequest('moves 必须是数组');
  if (moves.length > MAX_MOVES) throw badRequest(`着手过多（${moves.length}）`);
  const total = size * size;
  moves.forEach((mv, i) => {
    if (!Number.isInteger(mv) || mv < PASS || mv >= total) throw badRequest(`第 ${i + 1} 手不是合法的坐标：${String(mv)}`);
  });
  return moves;
}

// 按着手序列重建局面。与服务端对局一致：两次 pass 进入数子阶段后若还有着手（继续对局），先 resume。
// 返回引擎的对局状态（board、ko、toPlay、status）；非法着手抛 bad_request。
function replayMoves(size, komi, moves) {
  const g = engine.game;
  const state = g.createGame({ size, komi, autoScore: false });
  moves.forEach((mv, i) => {
    if (state.status === 'scoring') g.resume(state);
    const r = mv === PASS ? g.pass(state) : g.play(state, mv);
    if (!r.ok) throw badRequest(`第 ${i + 1} 手非法：${r.reason}`);
  });
  return state;
}

// 黑先、轮流：已下 k 手时轮到的一方
function colorToMove(moveCount) {
  return moveCount % 2 === 0 ? BLACK : WHITE;
}

// 校验 { size, komi, moves }，返回 { size, komi, moves, state }
function parseBoardRequest(req) {
  if (!req || typeof req !== 'object') throw badRequest('请求必须是对象');
  const size = checkSize(req.size);
  const komi = checkKomi(req.komi);
  const moves = checkMovesShape(req.moves, size).slice();
  const state = replayMoves(size, komi, moves);
  return { size, komi, moves, state };
}

// 校验 chooseMove 的参数；levelIds 为允许的难度 id 集合（Set）
function parseMoveRequest(req, levelIds) {
  const p = parseBoardRequest(req);
  if (typeof req.level !== 'string' || !levelIds.has(req.level)) throw badRequest(`未知的难度：${String(req.level)}`);
  if (req.color !== BLACK && req.color !== WHITE) throw badRequest(`color 必须是 1（黑）或 2（白）：${String(req.color)}`);
  const toMove = colorToMove(p.moves.length);
  if (req.color !== toMove) throw badRequest(`现在轮到${toMove === BLACK ? '黑' : '白'}方，不是 AI（color=${req.color}）`);
  return { ...p, color: req.color, level: req.level, humanJustPassed: req.humanJustPassed === true };
}

// 着手序列 → KataGo 的 moves：[['B','Q16'],['W','pass'],...]（必须黑白交替，pass 也要写）
function toKataMoves(moves, size) {
  return moves.map((mv, i) => [i % 2 === 0 ? 'B' : 'W', idxToGtp(mv, size)]);
}

// KataGo 返回的坐标（'Q16' / 'pass'）→ idx / PASS；无法解析返回 null
function parseKataMove(str, size) {
  try {
    return gtpToIdx(str, size);
  } catch {
    return null;
  }
}

function isLegal(state, color, idx) {
  if (!Number.isInteger(idx) || idx < 0 || idx >= state.board.n * state.board.n) return false;
  return canPlay(state.board, color, state.ko, idx).ok;
}

// rootInfo（reportAnalysisWinratesAs = BLACK，黑方视角）→ AI 视角的 { winrate, scoreLead, visits }
function infoForColor(rootInfo, color) {
  if (!rootInfo || typeof rootInfo !== 'object') return undefined;
  const wr = Number(rootInfo.winrate);
  const lead = Number(rootInfo.scoreLead);
  if (!Number.isFinite(wr) || !Number.isFinite(lead)) return undefined;
  const black = color === BLACK;
  return {
    winrate: black ? wr : 1 - wr,
    scoreLead: black ? lead : 0 - lead, // 0 - x 不会产生 -0
    visits: Number.isFinite(Number(rootInfo.visits)) ? Number(rootInfo.visits) : 0,
  };
}

// 按"块"（同色连通块）取归属平均值：本方视角 <= -threshold 的整块判死（设计文档 7.3）
function deadFromOwnership(board, ownership, threshold = 0.5) {
  const total = board.n * board.n;
  const seen = new Uint8Array(total);
  const dead = [];
  for (let i = 0; i < total; i++) {
    const c = board.get(i);
    if (c === EMPTY || seen[i]) continue;
    const g = board.group(i);
    let sum = 0;
    for (const s of g.stones) {
      seen[s] = 1;
      sum += ownership[s];
    }
    const avg = sum / g.stones.length;
    const own = c === BLACK ? avg : -avg;
    if (own <= -threshold) dead.push(...g.stones);
  }
  return dead.sort((a, b) => a - b);
}

// 假设现在就终局：死子按归属判定（与 judgeDead 同一规则），按数子法计分，返回 color 一方视角的目差（已含贴目）
function areaMarginIfEnded(board, komi, ownership, color) {
  const dead = deadFromOwnership(board, ownership);
  const s = engine.score.scoreArea(board, komi, dead);
  return color === BLACK ? s.black - s.white : s.white - s.black;
}

function resolveMinThinkMs(config) {
  const v = config ? config.aiMinThinkMs : undefined;
  if (v === undefined || v === null) return 600;
  if (!Number.isFinite(v) || v < 0) throw new TypeError(`config.aiMinThinkMs 必须是非负数：${String(v)}`);
  return v;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 让 AI 至少"想" minMs 毫秒再落子，避免秒下
async function waitMinThink(startedAt, minMs, now, sleep) {
  const left = minMs - (now() - startedAt);
  if (left > 0) await sleep(left);
}

const noop = () => {};
const SILENT = Object.freeze({ debug: noop, info: noop, warn: noop, error: noop });

module.exports = {
  BLACK,
  WHITE,
  EMPTY,
  PASS,
  SIZES,
  MAX_MOVES,
  AiError,
  badRequest,
  unavailable,
  replayMoves,
  colorToMove,
  parseBoardRequest,
  parseMoveRequest,
  toKataMoves,
  parseKataMove,
  isLegal,
  infoForColor,
  deadFromOwnership,
  areaMarginIfEnded,
  resolveMinThinkMs,
  defaultSleep,
  waitMinThink,
  SILENT,
};
