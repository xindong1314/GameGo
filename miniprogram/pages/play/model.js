'use strict';
const { BLACK, WHITE, EMPTY, opponent } = require('../../utils/engine/board');
const { play, pass, resume, finish } = require('../../utils/engine/game');
const { canPlay } = require('../../utils/engine/rules');
const { resultText, resultLabel } = require('../../utils/engine/record');
const { PASS, colorOfMove, isValidMove, replayMoves, cloneState, lastPlacedIdx } = require('./moves');
const { ILLEGAL_TEXT, illegalMoveText } = require('../../utils/format');

// 联网 / 人机对局页的全部状态转换（纯函数，不调用 wx，便于单测）。
// 页面只做胶水：收到快照 → fromSnapshot；收到推送 → applyEvent；用户操作 → start*/pick/tapPoint
// 得到要发的请求；请求结果 → requestDone / requestFailed；渲染 → viewData + diffData。
// 模型对象视为不可变：每次转换返回新对象（引擎状态先 cloneState 再修改）。

const MODES = ['ranked', 'friend', 'ai'];
const STATUSES = ['playing', 'scoring', 'ended'];
const REASONS = ['score', 'resign', 'timeout', 'abort'];
const MODE_LABEL = { ranked: '排位赛', friend: '好友对局', ai: '人机对局' };
const COLOR_NAME = { [BLACK]: '黑', [WHITE]: '白' };
const COLOR_KEY = { [BLACK]: 'black', [WHITE]: 'white' };

// 引擎 canPlay 的原因 → 文案（与本地对局页共用 utils/format 里的同一份）
const REASON_TEXT = ILLEGAL_TEXT;

// 服务端错误码（见设计文档 5.2）与网络层错误
const ERROR_TEXT = {
  illegal: '这里不能落子',
  not_your_turn: '还没轮到你',
  stale: '局面已更新，已重新同步',
  wrong_phase: '当前阶段不能这样操作',
  not_player: '你不是这局的棋手',
  not_found: '对局不存在或已结束',
  nothing_to_undo: '没有可以悔的棋',
  rate_limited: '操作太频繁，请稍后再试',
  offline: '网络未连接，请稍后再试',
  timeout: '请求超时，请重试',
  bad_request: '请求无效',
  internal: '服务器出错了，请稍后再试',
  ai_unavailable: 'AI 暂时不可用',
  in_game: '你还有一局正在进行',
  unauthorized: '登录已失效，请重新进入',
  kicked: '账号已在其他设备登录',
  closed: '连接已关闭',
};

// 这些错误说明本地局面与服务端不一致，需要重新同步
const RESYNC_CODES = ['stale', 'wrong_phase', 'not_your_turn', 'illegal', 'timeout'];

const RESYNC = Object.freeze({ resync: true });

function isColor(c) {
  return c === BLACK || c === WHITE;
}

function finiteOr(x, fallback) {
  return typeof x === 'number' && Number.isFinite(x) ? x : fallback;
}

function formatNumber(x) {
  return Number.isInteger(x) ? String(x) : String(Number(x.toFixed(1)));
}

// 毫秒 → m:ss（向上取整到秒）
function formatCountdown(ms) {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function formatPercent(rate) {
  return `${Math.round(rate * 1000) / 10}%`;
}

function timeControlText(tc) {
  if (!tc) return '';
  const main = tc.mainMs % 60000 === 0 ? `${tc.mainMs / 60000} 分` : `${Math.round(tc.mainMs / 1000)} 秒`;
  if (!tc.periods) return main;
  return `${main} + ${tc.periods}×${Math.round(tc.periodMs / 1000)} 秒`;
}

// ---------- 数据校验与规范化 ----------

function normalizePlayer(p, color) {
  const o = p && typeof p === 'object' ? p : {};
  const isAi = o.ai === true;
  const nickname = typeof o.nickname === 'string' && o.nickname.trim() ? o.nickname : isAi ? 'AI' : `${COLOR_NAME[color]}方`;
  return {
    isAi,
    userId: isAi ? null : o.userId === undefined ? null : o.userId,
    level: isAi && o.level !== undefined ? o.level : null,
    nickname,
    avatarUrl: typeof o.avatarUrl === 'string' ? o.avatarUrl : '',
  };
}

function normalizeTimeControl(tc) {
  if (!tc || typeof tc !== 'object') return null;
  const mainMs = finiteOr(tc.mainMs, NaN);
  const periods = finiteOr(tc.periods, NaN);
  const periodMs = finiteOr(tc.periodMs, NaN);
  if (!(mainMs >= 0) || !(periods >= 0) || !(periodMs >= 0)) return null;
  return { mainMs, periods, periodMs };
}

function normalizeClocks(clocks) {
  if (!clocks || typeof clocks !== 'object') return null;
  const side = (s) => {
    if (!s || typeof s !== 'object') return null;
    const mainMs = finiteOr(s.mainMs, NaN);
    const periodsLeft = finiteOr(s.periodsLeft, NaN);
    const periodMs = finiteOr(s.periodMs, NaN);
    if (Number.isNaN(mainMs) || Number.isNaN(periodsLeft) || Number.isNaN(periodMs)) return null;
    return { mainMs, periodsLeft, periodMs };
  };
  const b = side(clocks[BLACK]);
  const w = side(clocks[WHITE]);
  if (!b || !w) return null;
  return { [BLACK]: b, [WHITE]: w, running: isColor(clocks.running) ? clocks.running : null };
}

// 双方还能"继续对局"几次（真人对局）；人机对局或数据缺失时为 null（不限，由服务端把关）
function normalizeResumesLeft(r) {
  if (!r || typeof r !== 'object') return null;
  const b = finiteOr(r[BLACK], NaN);
  const w = finiteOr(r[WHITE], NaN);
  if (!(b >= 0) || !(w >= 0)) return null;
  return { [BLACK]: b, [WHITE]: w };
}

function normalizeScoring(s, size) {
  if (!s || typeof s !== 'object') return null;
  const total = size * size;
  const accepted = s.accepted && typeof s.accepted === 'object' ? s.accepted : {};
  return {
    pending: s.pending === true,
    source: s.source === 'manual' ? 'manual' : 'katago',
    version: Number.isInteger(s.version) ? s.version : 0,
    dead: Array.isArray(s.dead) ? s.dead.filter((i) => Number.isInteger(i) && i >= 0 && i < total) : [],
    owner: Array.isArray(s.owner) && s.owner.length === total ? s.owner.slice() : null,
    black: finiteOr(s.black, null),
    white: finiteOr(s.white, null),
    winner: [0, BLACK, WHITE].includes(s.winner) ? s.winner : null,
    accepted: { [BLACK]: accepted[BLACK] === true, [WHITE]: accepted[WHITE] === true },
    deadline: typeof s.deadline === 'number' && Number.isFinite(s.deadline) ? Math.max(0, s.deadline) : null,
    resumesLeft: normalizeResumesLeft(s.resumesLeft),
  };
}

function normalizeResult(r) {
  if (!r || typeof r !== 'object') return null;
  if (![0, BLACK, WHITE].includes(r.winner) || !REASONS.includes(r.reason)) return null;
  const out = {
    winner: r.winner,
    reason: r.reason,
    black: finiteOr(r.black, null),
    white: finiteOr(r.white, null),
    counted: r.counted === true,
    // 可选的细分信息（服务端较新版本才有）：作废/终局的原因、排位赛没计入的原因、结果是否还在保存
    cause: typeof r.cause === 'string' && r.cause ? r.cause : null,
    uncounted: typeof r.uncounted === 'string' && r.uncounted ? r.uncounted : null,
    pending: r.pending === true,
  };
  out.text = typeof r.text === 'string' && r.text ? r.text : resultText(out);
  out.label = typeof r.label === 'string' && r.label ? r.label : resultLabel(out);
  return out;
}

function normalizeStats(stats) {
  if (!stats || typeof stats !== 'object') return null;
  const out = {};
  let any = false;
  for (const c of [BLACK, WHITE]) {
    const s = stats[c];
    if (!s || typeof s !== 'object') continue;
    const games = finiteOr(s.games, 0);
    const wins = finiteOr(s.wins, 0);
    out[c] = {
      games,
      wins,
      losses: finiteOr(s.losses, 0),
      draws: finiteOr(s.draws, 0),
      winrate: finiteOr(s.winrate, games > 0 ? wins / games : 0),
      curStreak: finiteOr(s.curStreak, 0),
      maxStreak: finiteOr(s.maxStreak, 0),
    };
    any = true;
  }
  return any ? out : null;
}

function badSnapshot(msg) {
  const err = new Error(`对局数据异常：${msg}`);
  err.code = 'bad_snapshot';
  return err;
}

// ---------- 状态查询 ----------

// 已提交落子/停一手、正在等服务端推送这一手
function awaitingMove(model) {
  return model.expectN > 0 && model.moves.length < model.expectN;
}

function isMyTurn(model) {
  return model.status === 'playing' && model.toPlay === model.myColor && !awaitingMove(model);
}

// 人机对局且玩家已下过至少一手（悔棋撤回到上一次轮到玩家的局面）
function computeCanUndo(model) {
  if (model.mode !== 'ai' || model.status === 'ended') return false;
  return model.moves.length >= (model.myColor === BLACK ? 1 : 2);
}

// 数子阶段能否点选死子（设计文档 6.4、8.3）：真人对局可以；人机对局只有死子判断失败（source 'manual'）时可以
function canMarkDead(model) {
  const sc = model.scoring;
  if (model.status !== 'scoring' || !sc || sc.pending) return false;
  return model.mode !== 'ai' || sc.source === 'manual';
}

// 真人对局里"继续对局"不可用的原因（与服务端 6.3 第 5 步一致：每方每局 1 次、对手不在线时不能继续）；
// 可用时返回 ''。人机对局不限次数。
function resumeBlockedText(model) {
  if (model.mode === 'ai' || model.status !== 'scoring') return '';
  const me = model.myColor;
  const sc = model.scoring;
  if (sc && sc.resumesLeft && sc.resumesLeft[me] <= 0) return '你已用过"继续对局"，请确认数子结果或等待自动计分';
  if (model.presence[opponent(me)] === false) return '对手不在线，不能继续对局，时限到后自动计分';
  return '';
}

// 当前不能发起新请求的原因；可以时返回 ''
function blockedReason(model) {
  if (model.connection !== 'open') return '网络未连接，请稍候';
  if (model.pending) return '上一个操作还在处理中';
  return '';
}

// ---------- 构造 ----------

function withState(model, state, extra, boardChanged) {
  const next = Object.assign({}, model, extra || {});
  next.state = state;
  next.toPlay = state.toPlay;
  if (boardChanged !== false) {
    next.cells = Array.from(state.board.cells);
    next.lastIdx = lastPlacedIdx(state);
  }
  next.canUndo = computeCanUndo(next);
  return next;
}

// 本地"已同意"标记（acceptSent）只用来填补 accept 的 res 与随后 game.scoring 推送之间的空档。
// 服务端的 accepted 才是权威状态：同一 version 的推送/快照说我没有同意，说明确认已被清零
// （服务端重启后重新请求死子建议、继续对局后再次数子，version 都会重新从 1 开始），不能沿用本地标记。
function keepAcceptSent(acceptSent, scoring, myColor) {
  if (acceptSent === null || !scoring || acceptSent !== scoring.version) return null;
  return scoring.accepted[myColor] ? acceptSent : null;
}

function resumedByMe(model) {
  return model.pending === 'resume' || model.resumeSent === true;
}

// 同一局重新同步时保留页面侧的交互状态
function carryOver(next, prev) {
  next.connection = prev.connection;
  // 上次同步失败的提示在同步成功后不再保留
  next.hint = prev.syncFailed ? '' : prev.hint;
  if (prev.pending) {
    next.pending = prev.pending;
    next.pendingVersion = prev.pendingVersion;
    if ((prev.pending === 'move' || prev.pending === 'pass') && next.moves.length < prev.expectN) {
      next.expectN = prev.expectN;
    }
  }
  next.acceptSent = keepAcceptSent(prev.acceptSent, next.scoring, next.myColor);
  // 数子阶段断线期间对方选了"继续对局"：同步回来时说明一下
  if (prev.status === 'scoring' && next.status === 'playing' && next.moves.length === prev.moves.length) {
    next.resumedByOpp = next.mode !== 'ai' && !resumedByMe(prev);
  } else if (next.status === 'playing' && next.moves.length === prev.moves.length) {
    next.resumedByOpp = prev.resumedByOpp;
  }
  if (next.status === 'scoring' && prev.status === 'scoring') next.resumeSent = prev.resumeSent;
  const pv = prev.preview;
  if (pv && next.status === 'playing' && prev.moves.length === next.moves.length && isMyTurn(next)) {
    const r = canPlay(next.state.board, next.myColor, next.state.ko, pv.idx);
    next.preview = { idx: pv.idx, ok: r.ok, color: next.myColor };
  }
  if (next.status === 'ended' && prev.stats) next.stats = prev.stats;
  return next;
}

// 由 game.sync 返回的快照建立模型。prev 为同一页面的旧模型（重新同步时传入，保留交互状态）。
// 数据不合法时抛出 Error（code: 'bad_snapshot'）。
function fromSnapshot(snapshot, receivedAt, prev) {
  const s = snapshot;
  if (!s || typeof s !== 'object') throw badSnapshot('快照为空');
  if (typeof s.id !== 'string' || !s.id) throw badSnapshot('缺少对局编号');
  if (!MODES.includes(s.mode)) throw badSnapshot(`未知对局类型 ${s.mode}`);
  if (!Number.isInteger(s.size) || s.size < 2 || s.size > 19) throw badSnapshot(`路数无效 ${s.size}`);
  if (!isColor(s.myColor)) throw badSnapshot('缺少执子颜色');
  if (!Array.isArray(s.moves)) throw badSnapshot('缺少着手序列');
  if (!STATUSES.includes(s.status)) throw badSnapshot(`未知状态 ${s.status}`);
  const komi = finiteOr(s.komi, 7.5);

  let state;
  try {
    state = replayMoves(s.size, komi, s.moves);
  } catch (err) {
    throw badSnapshot(err.message);
  }
  // 着手序列不记录"继续对局"：服务端在对局中而序列以两次 pass 结尾，说明刚继续过
  if (s.status === 'playing' && state.status === 'scoring') resume(state);

  let result = null;
  if (s.status === 'ended') {
    result = normalizeResult(s.result);
    if (!result) throw badSnapshot('终局缺少结果');
    finish(state, result);
  }

  const players = { [BLACK]: normalizePlayer(s.players && s.players[BLACK], BLACK), [WHITE]: normalizePlayer(s.players && s.players[WHITE], WHITE) };
  const presence = s.presence && typeof s.presence === 'object' ? s.presence : {};
  const running = s.status === 'playing';
  const model = {
    id: s.id,
    mode: s.mode,
    size: s.size,
    komi,
    players,
    myColor: s.myColor,
    timeControl: normalizeTimeControl(s.timeControl),
    moves: s.moves.slice(),
    state,
    cells: Array.from(state.board.cells),
    lastIdx: lastPlacedIdx(state),
    status: s.status,
    toPlay: isColor(s.toPlay) ? s.toPlay : state.toPlay,
    clocks: normalizeClocks(s.clocks),
    clocksAt: receivedAt,
    // 非对局中时钟不走：冻结在收到快照的时刻
    clocksFrozenAt: running ? null : receivedAt,
    scoring: running ? null : normalizeScoring(s.scoring, s.size),
    scoringAt: receivedAt,
    result,
    stats: null,
    presence: {
      [BLACK]: players[BLACK].isAi || presence[BLACK] !== false,
      [WHITE]: players[WHITE].isAi || presence[WHITE] !== false,
    },
    aiThinking: s.aiThinking === true,
    canUndo: s.mode === 'ai' && s.status !== 'ended' && s.canUndo === true,
    // 以下为页面交互状态
    connection: 'open', // 'open' | 'connecting' | 'closed' | 'kicked'
    pending: null, // 正在进行的请求：move/pass/resign/undo/toggle/accept/resume/again
    pendingVersion: 0, // 正在确认的数子版本
    expectN: 0, // 已提交、等待推送的着手序号
    acceptSent: null, // 已成功确认的数子版本（等推送更新 accepted 之前防止重复确认）
    resumeSent: false, // 我的"继续对局"请求已成功（用来区分 game.resumed 是谁发起的）
    resumedByOpp: false, // 对手不同意数子结果、选了继续对局（下一手之前在状态栏说明）
    preview: null, // { idx, ok, color }
    hint: '',
    syncFailed: false, // hint 是否来自同步失败
  };
  if (prev && prev.id === model.id) carryOver(model, prev);
  return model;
}

// ---------- 服务端推送 ----------

function onMovePush(model, ev, receivedAt) {
  const n = ev.n;
  const idx = ev.idx;
  if (!Number.isInteger(n) || n < 1 || !isValidMove(idx, model.size)) return RESYNC;
  const len = model.moves.length;
  // 同步前后交错收到的重复推送：本地已有这一手
  if (n <= len && model.moves[n - 1] === idx) return model;
  if (n !== len + 1) return RESYNC;
  if (isColor(ev.color) && ev.color !== colorOfMove(n)) return RESYNC;
  if (model.status !== 'playing' || model.state.status !== 'playing') return RESYNC;

  const state = cloneState(model.state);
  const r = idx === PASS ? pass(state) : play(state, idx);
  if (!r.ok) return RESYNC;
  const last = state.history[state.history.length - 1];
  if (Array.isArray(ev.captured) && ev.captured.length !== last.captured.length) return RESYNC;

  const mover = colorOfMove(n);
  const clocks = ev.clocks !== undefined ? normalizeClocks(ev.clocks) : model.clocks;
  const status = state.status; // 两次 pass 后为 'scoring'，等 game.scoring 推送
  return withState(model, state, {
    moves: model.moves.concat([idx]),
    status,
    clocks,
    clocksAt: receivedAt,
    clocksFrozenAt: status === 'playing' ? null : receivedAt,
    scoring: null,
    preview: null,
    expectN: model.expectN && len + 1 >= model.expectN ? 0 : model.expectN,
    aiThinking: model.players[mover].isAi ? false : model.aiThinking,
    hint: '',
    resumedByOpp: false,
  });
}

function onUndoPush(model, ev) {
  if (model.mode !== 'ai' || model.status === 'ended') return RESYNC;
  if (!Array.isArray(ev.moves)) return RESYNC;
  let state;
  try {
    state = replayMoves(model.size, model.komi, ev.moves);
  } catch (err) {
    return RESYNC;
  }
  // 悔棋总是回到对局（数子阶段悔棋 = 撤回 pass）
  if (state.status === 'scoring') resume(state);
  return withState(model, state, {
    moves: ev.moves.slice(),
    status: 'playing',
    scoring: null,
    result: null,
    preview: null,
    expectN: 0,
    acceptSent: null,
    resumedByOpp: false,
    aiThinking: state.toPlay === model.myColor ? false : model.aiThinking,
    hint: '',
  });
}

function onAiPush(model, ev) {
  if (model.mode !== 'ai' || typeof ev.thinking !== 'boolean') return model;
  const thinking = model.status === 'ended' ? false : ev.thinking;
  if (thinking === model.aiThinking) return model;
  return Object.assign({}, model, { aiThinking: thinking });
}

function onScoringPush(model, ev, receivedAt) {
  if (model.status === 'ended') return model;
  const scoring = normalizeScoring(ev.scoring, model.size);
  if (!scoring) return RESYNC;
  // 本地局面必须已经是两次 pass 之后（或快照已处于数子阶段）
  if (model.status !== 'scoring' && model.state.status !== 'scoring') return RESYNC;
  return Object.assign({}, model, {
    status: 'scoring',
    scoring,
    scoringAt: receivedAt,
    preview: null,
    clocksFrozenAt: model.clocksFrozenAt !== null ? model.clocksFrozenAt : receivedAt,
    acceptSent: keepAcceptSent(model.acceptSent, scoring, model.myColor),
    resumeSent: false,
    resumedByOpp: false,
  });
}

function onResumedPush(model, ev, receivedAt) {
  if (model.status === 'playing' || model.status === 'ended') return model; // 同步后收到的旧推送
  const state = cloneState(model.state);
  if (state.status === 'scoring') resume(state);
  if (isColor(ev.toPlay) && ev.toPlay !== state.toPlay) return RESYNC;
  const clocks = ev.clocks !== undefined ? normalizeClocks(ev.clocks) : model.clocks;
  return withState(
    model,
    state,
    {
      status: 'playing',
      scoring: null,
      clocks,
      clocksAt: receivedAt,
      clocksFrozenAt: null,
      acceptSent: null,
      resumeSent: false,
      // 不是我发起的：对手对数子结果有异议（人机对局只有玩家自己能继续对局）
      resumedByOpp: model.mode !== 'ai' && !resumedByMe(model),
      preview: null,
      hint: '',
    },
    false
  );
}

function onEndPush(model, ev, receivedAt) {
  const stats = normalizeStats(ev.stats);
  if (model.status === 'ended') {
    // 重复推送：只补上统计
    return stats && !model.stats ? Object.assign({}, model, { stats }) : model;
  }
  const result = normalizeResult(ev.result);
  if (!result) return RESYNC;
  const state = cloneState(model.state);
  finish(state, result);
  return withState(
    model,
    state,
    {
      status: 'ended',
      result,
      stats,
      aiThinking: false,
      preview: null,
      expectN: 0,
      acceptSent: null,
      resumedByOpp: false,
      clocksFrozenAt: model.clocksFrozenAt !== null ? model.clocksFrozenAt : receivedAt,
    },
    false
  );
}

function onPresencePush(model, ev) {
  if (!isColor(ev.color) || typeof ev.online !== 'boolean') return model;
  if (model.players[ev.color].isAi) return model;
  if (model.presence[ev.color] === ev.online) return model;
  return Object.assign({}, model, { presence: Object.assign({}, model.presence, { [ev.color]: ev.online }) });
}

// 应用一条服务端推送（event 含 t 与推送数据）。
// 返回新模型；与本局无关或无变化时返回原模型；本地与服务端不一致时返回 { resync: true }。
function applyEvent(model, event, receivedAt) {
  if (!model || !event || typeof event !== 'object' || event.gameId !== model.id) return model;
  switch (event.t) {
    case 'game.move':
      return onMovePush(model, event, receivedAt);
    case 'game.undo':
      return onUndoPush(model, event);
    case 'game.ai':
      return onAiPush(model, event);
    case 'game.scoring':
      return onScoringPush(model, event, receivedAt);
    case 'game.resumed':
      return onResumedPush(model, event, receivedAt);
    case 'game.end':
      return onEndPush(model, event, receivedAt);
    case 'game.presence':
      return onPresencePush(model, event);
    default:
      return model;
  }
}

// ---------- 页面状态 ----------

// status: 'open' | 'connecting' | 'closed' | 'kicked'（被顶号后保持 kicked，直到用户手动重连）
function setConnection(model, status) {
  if (!['open', 'connecting', 'closed', 'kicked'].includes(status)) return model;
  let next = status;
  if (model.connection === 'kicked' && status === 'closed') next = 'kicked';
  if (model.connection === next) return model;
  return Object.assign({}, model, { connection: next });
}

function withHint(model, hint) {
  if (model.hint === hint && !model.syncFailed) return model;
  return Object.assign({}, model, { hint, syncFailed: false });
}

// 重新同步失败：保留当前局面，给出提示（下次同步成功时清除）
function syncFailed(model, err) {
  return Object.assign({}, model, { hint: `同步失败：${errorText(err)}`, syncFailed: true });
}

// ---------- 用户操作 ----------
// start* 返回 { model, req }：req 为 { t, params } 表示要发的请求，为 null 表示不发（model 可能带提示）。

function deny(model, hint) {
  return { model: hint ? withHint(model, hint) : model, req: null };
}

function request(model, kind, t, params, extra) {
  const next = Object.assign({}, model, { pending: kind, hint: '', syncFailed: false }, extra || {});
  return { model: next, req: { t, params: Object.assign({ gameId: model.id }, params) } };
}

// 触摸选点（棋盘 pick 事件）→ 预览子；只在轮到自己、没有进行中的请求时响应
function pick(model, idx) {
  if (!isMyTurn(model) || model.pending || model.connection !== 'open') return model;
  if (!Number.isInteger(idx) || idx < 0 || idx >= model.size * model.size) return model;
  const r = canPlay(model.state.board, model.myColor, model.state.ko, idx);
  const hint = r.ok ? '' : illegalMoveText(r.reason);
  const pv = model.preview;
  if (pv && pv.idx === idx && pv.ok === r.ok && model.hint === hint) return model;
  return Object.assign({}, model, { preview: { idx, ok: r.ok, color: model.myColor }, hint, syncFailed: false });
}

function startMove(model) {
  if (model.status !== 'playing') return deny(model, '');
  if (!isMyTurn(model)) return deny(model, '还没轮到你');
  const blocked = blockedReason(model);
  if (blocked) return deny(model, blocked);
  const pv = model.preview;
  if (!pv) return deny(model, '请先在棋盘上选点');
  const r = canPlay(model.state.board, model.myColor, model.state.ko, pv.idx);
  if (!r.ok) {
    return {
      model: Object.assign({}, model, { preview: Object.assign({}, pv, { ok: false }), hint: illegalMoveText(r.reason) }),
      req: null,
    };
  }
  const n = model.moves.length + 1;
  return request(model, 'move', 'game.move', { n, idx: pv.idx }, { expectN: n });
}

function startPass(model) {
  if (model.status !== 'playing') return deny(model, '');
  if (!isMyTurn(model)) return deny(model, '还没轮到你');
  const blocked = blockedReason(model);
  if (blocked) return deny(model, blocked);
  const n = model.moves.length + 1;
  return request(model, 'pass', 'game.pass', { n }, { expectN: n, preview: null });
}

function startResign(model) {
  if (model.status !== 'playing' && model.status !== 'scoring') return deny(model, '');
  const blocked = blockedReason(model);
  if (blocked) return deny(model, blocked);
  return request(model, 'resign', 'game.resign', {});
}

function startUndo(model) {
  if (model.mode !== 'ai' || (model.status !== 'playing' && model.status !== 'scoring')) return deny(model, '');
  if (!model.canUndo) return deny(model, ERROR_TEXT.nothing_to_undo);
  const blocked = blockedReason(model);
  if (blocked) return deny(model, blocked);
  return request(model, 'undo', 'game.undo', {}, { preview: null });
}

// 数子阶段点选（棋盘 tap 事件）：切换该块死活。真人对局；人机对局仅当死子判断失败（manual）时
function tapPoint(model, idx) {
  if (!canMarkDead(model)) return deny(model, '');
  if (!Number.isInteger(idx) || idx < 0 || idx >= model.size * model.size) return deny(model, '');
  const blocked = blockedReason(model);
  if (blocked) return deny(model, blocked);
  if (model.state.board.get(idx) === EMPTY) return deny(model, '点击棋子可切换死活');
  return request(model, 'toggle', 'game.score.toggle', { idx });
}

function startAccept(model) {
  if (model.status !== 'scoring') return deny(model, '');
  const sc = model.scoring;
  if (!sc || sc.pending) return deny(model, '正在判断死子，请稍候');
  if (sc.accepted[model.myColor] || (model.acceptSent !== null && model.acceptSent === sc.version)) return deny(model, '');
  const blocked = blockedReason(model);
  if (blocked) return deny(model, blocked);
  return request(model, 'accept', 'game.score.accept', { version: sc.version }, { pendingVersion: sc.version });
}

function startResume(model) {
  if (model.status !== 'scoring') return deny(model, '');
  const why = resumeBlockedText(model);
  if (why) return deny(model, why);
  const blocked = blockedReason(model);
  if (blocked) return deny(model, blocked);
  return request(model, 'resume', 'game.score.resume', {});
}

// 终局后"再来一局"：返回 { model, action }，action 为
//   { type: 'navigate', method: 'redirectTo'|'reLaunch', url }  或  { type: 'request', t: 'ai.start', params }
// aiColor 为进入本局时的人机执子选择（'black'|'white'|'random'），缺省按本局执子颜色。
function startAgain(model, { aiColor } = {}) {
  if (model.status !== 'ended') return { model, action: null };
  if (model.mode === 'ranked') {
    return { model, action: { type: 'navigate', method: 'redirectTo', url: `/pages/match/match?size=${model.size}` } };
  }
  if (model.mode === 'ai') {
    const ai = model.players[opponent(model.myColor)];
    if (ai.level === null || ai.level === '') {
      return { model, action: { type: 'navigate', method: 'redirectTo', url: '/pages/ai/ai' } };
    }
    if (model.pending) return { model, action: null };
    if (model.connection !== 'open') return { model: withHint(model, blockedReason(model)), action: null };
    const color = ['black', 'white', 'random'].includes(aiColor) ? aiColor : COLOR_KEY[model.myColor];
    return {
      model: Object.assign({}, model, { pending: 'again', hint: '' }),
      action: { type: 'request', t: 'ai.start', params: { size: model.size, level: ai.level, color } },
    };
  }
  return { model, action: { type: 'navigate', method: 'reLaunch', url: '/pages/index/index' } };
}

// ---------- 请求结果 ----------

function requestDone(model, kind) {
  if (model.pending !== kind) return model;
  const next = Object.assign({}, model, { pending: null, pendingVersion: 0 });
  if (kind === 'accept') next.acceptSent = model.pendingVersion;
  // 服务端先回 res 再推 game.resumed：记住是我发起的
  if (kind === 'resume' && next.status === 'scoring') next.resumeSent = true;
  return next;
}

// 终局后补统计：排位赛计入排行、但模型里没有统计（结果是经 game.sync 快照得到的，快照不带统计，
// 只有 game.end 推送带）。页面这时用 GET /api/me 取我的最新统计补上。
function needsStats(model) {
  return !!model && model.mode === 'ranked' && model.status === 'ended' && !!model.result && model.result.counted && !model.stats;
}

// stats：GET /api/me 的 RankedStats（我的）
function withMyStats(model, stats) {
  if (!needsStats(model)) return model;
  const normalized = normalizeStats({ [model.myColor]: stats });
  if (!normalized) return model;
  return Object.assign({}, model, { stats: normalized });
}

const HAS_CHINESE = /[\u4e00-\u9fa5]/;

function errorText(err, kind) {
  const code = err && typeof err.code === 'string' ? err.code : '';
  let msg = '';
  if (err && typeof err.msg === 'string') msg = err.msg;
  else if (err && typeof err.message === 'string') msg = err.message;
  if (code === 'illegal') {
    // 服务端在 err.reason 里给出引擎的原因（occupied / ko / suicide）
    const reason = err && typeof err.reason === 'string' ? err.reason : '';
    if (Object.prototype.hasOwnProperty.call(REASON_TEXT, reason)) return REASON_TEXT[reason];
    for (const r of Object.keys(REASON_TEXT)) {
      if (msg.indexOf(r) >= 0) return REASON_TEXT[r];
    }
    return HAS_CHINESE.test(msg) && msg.length <= 30 ? msg : ERROR_TEXT.illegal;
  }
  if (code === 'stale' && kind === 'accept') return '数子结果已变化，请重新确认';
  // 参数错误时服务端的中文说明（如"没有这个难度"）比"请求无效"更有用
  if (code === 'bad_request' && HAS_CHINESE.test(msg) && msg.length <= 30) return msg;
  // 阶段不对时服务端说明了具体原因（如"你已经用过"继续对局"了…""对手不在线，不能继续对局…""对局已结束"）
  if ((code === 'wrong_phase' || code === 'not_found') && HAS_CHINESE.test(msg) && msg.length <= 40) return msg;
  if (ERROR_TEXT[code]) return ERROR_TEXT[code];
  return msg || '操作失败，请重试';
}

// 返回 { model, resync }
function requestFailed(model, kind, err) {
  const code = err && typeof err.code === 'string' ? err.code : '';
  const next = Object.assign({}, model, { hint: errorText(err, kind), syncFailed: false });
  if (model.pending === kind) {
    next.pending = null;
    next.pendingVersion = 0;
  }
  if (kind === 'move' || kind === 'pass') next.expectN = 0;
  if (kind === 'move' && ['illegal', 'stale', 'not_your_turn', 'wrong_phase'].includes(code)) next.preview = null;
  return { model: next, resync: RESYNC_CODES.includes(code) };
}

// ---------- 视图 ----------

function clockView(model, color, now, displayClock) {
  const clocks = model.clocks;
  if (!clocks || typeof displayClock !== 'function') return null;
  let elapsed = 0;
  if (clocks.running === color) {
    const until = model.clocksFrozenAt !== null ? model.clocksFrozenAt : now;
    elapsed = Math.max(0, until - model.clocksAt);
  }
  // 第三个参数给出完整读秒周期：正在走的一方快照里的 periodMs 可能只是当前周期的剩余
  const d = displayClock(clocks[color], elapsed, model.timeControl || undefined) || {};
  const timeout = d.timeout === true;
  return {
    text: timeout ? '超时' : d.text === undefined || d.text === null ? '' : String(d.text),
    sub: timeout || !d.sub ? '' : String(d.sub),
    urgent: timeout || d.urgent === true,
    timeout,
  };
}

function panelView(model, color, now, displayClock) {
  const p = model.players[color];
  const isMe = color === model.myColor;
  return {
    color,
    colorName: COLOR_NAME[color],
    nickname: p.nickname,
    avatarUrl: p.avatarUrl,
    isAi: p.isAi,
    isMe,
    captures: model.state.captures[color],
    online: isMe ? model.connection === 'open' : p.isAi || model.presence[color] !== false,
    active: model.status === 'playing' && model.toPlay === color,
    thinking: p.isAi && model.aiThinking && model.status === 'playing',
    clock: clockView(model, color, now, displayClock),
  };
}

function marksView(model) {
  const sc = model.scoring;
  if (!sc || sc.pending) return null;
  const show = model.status === 'scoring' || (model.status === 'ended' && model.result && model.result.reason === 'score');
  if (!show) return null;
  return { dead: sc.dead, owner: sc.owner || [] };
}

function playingStatusText(model, myTurn) {
  const len = model.moves.length;
  const last = len > 0 ? model.moves[len - 1] : null;
  if (model.pending === 'move' || model.pending === 'pass' || awaitingMove(model)) return '提交中…';
  if (model.pending === 'undo') return '悔棋中…';
  if (model.pending === 'resign') return '认输中…';
  if (myTurn && model.preview && model.preview.ok) return '点「确定」落子，或拖动重新选点';
  if (model.resumedByOpp) {
    return myTurn ? '对手对数子结果有异议，继续对局：轮到你落子' : '对手对数子结果有异议，继续对局：等待对手落子…';
  }
  if (myTurn) {
    if (last === PASS) return '对手停了一手，轮到你（你也停一手将进入数子）';
    if (len === 0 && model.mode !== 'ai') return '轮到你落子（60 秒内未落第一手，对局作废）';
    return '轮到你落子：触摸棋盘选点';
  }
  if (model.mode === 'ai') return model.aiThinking ? 'AI 思考中…' : '等待 AI 落子…';
  const opp = opponent(model.myColor);
  if (model.presence[opp] === false) return '对手已离线，等待其重连…';
  if (last === PASS) return '你停了一手，等待对手…';
  return '等待对手落子…';
}

function statusText(model, myTurn) {
  if (model.status === 'playing') return playingStatusText(model, myTurn);
  if (model.status === 'scoring') {
    if (model.pending === 'resume') return '正在恢复对局…';
    const sc = model.scoring;
    if (!sc || sc.pending) return '正在判断死子…';
    return model.mode === 'ai' ? '请确认数子结果' : '双方确认数子结果';
  }
  return ''; // 终局信息在终局面板里
}

function bannerText(model) {
  if (model.connection === 'kicked') return '账号已在其他设备登录，点此重新连接';
  if (model.connection !== 'open') return '连接中断，正在重连…';
  return '';
}

function scoringView(model, now) {
  const sc = model.scoring;
  const me = model.myColor;
  const opp = opponent(me);
  const oppIsAi = model.players[opp].isAi;
  const base = {
    pending: true,
    blackText: '-',
    whiteText: '-',
    leadText: '',
    meAccepted: false,
    oppAccepted: false,
    meAcceptText: '未同意',
    oppAcceptText: '未同意',
    deadlineText: '',
    acceptText: '同意',
    komiText: '',
    tip: '正在判断死子，请稍候…',
    notes: scoringNotes(model),
  };
  if (!sc || sc.pending) return base;
  const meAccepted = sc.accepted[me] || (model.acceptSent !== null && model.acceptSent === sc.version);
  const oppAccepted = sc.accepted[opp] || oppIsAi;
  let winner = sc.winner;
  if (winner === null && sc.black !== null && sc.white !== null) {
    winner = sc.black > sc.white ? BLACK : sc.black < sc.white ? WHITE : 0;
  }
  let leadText = '';
  if (winner === 0) leadText = '按当前结果：双方点数相同';
  else if (winner !== null) leadText = `按当前结果：${resultLabel({ winner, reason: 'score', black: sc.black, white: sc.white })}`;

  let tip;
  if (model.mode === 'ai') {
    // 死子判断失败（AI_FALLBACK、KataGo 超时等）：玩家自己标记死子（6.4）
    tip = sc.source === 'manual' ? '未能自动判断死子，请点击死棋标记，再点"同意"终局' : '确认后按此结果终局；有异议可"继续对局"';
  } else if (sc.source === 'manual') tip = '未能自动判断死子，请点击死棋标记；双方同意后计分';
  else tip = '点击棋子可切换死活；双方同意后计分';
  if (meAccepted && !oppAccepted) tip = '你已同意，等待对手确认…';
  else if (oppAccepted && !meAccepted && !oppIsAi) tip = `对手已同意。${tip}`;

  let deadlineText = '';
  if (sc.deadline !== null) {
    const remain = sc.deadline - Math.max(0, now - model.scoringAt);
    deadlineText = `${formatCountdown(remain)} 后自动计分`;
  }
  return {
    pending: false,
    blackText: sc.black === null ? '-' : `${formatNumber(sc.black)} 点`,
    whiteText: sc.white === null ? '-' : `${formatNumber(sc.white)} 点`,
    leadText,
    meAccepted,
    oppAccepted,
    meAcceptText: meAccepted ? '已同意' : '未同意',
    oppAcceptText: oppAccepted ? '已同意' : '未同意',
    deadlineText,
    acceptText: meAccepted ? '已同意' : '同意',
    komiText: komiText(model),
    tip,
    notes: base.notes,
  };
}

// 数子面板下方的说明（真人对局）："继续对局"为什么不可用；时限到时怎么计分（6.3 第 6 步）
function scoringNotes(model) {
  const notes = [];
  const why = resumeBlockedText(model);
  if (why) notes.push(why);
  const sc = model.scoring;
  if (model.mode !== 'ai' && sc && !sc.pending && sc.deadline !== null) notes.push('时限到仍未达成一致时，单方面的修改不会生效');
  return notes;
}

// 数子法：白方点数里含贴目
function komiText(model) {
  return model.komi ? `白方点数已含贴目 ${formatNumber(model.komi)}` : '';
}

// 对局作废的原因（服务端只给 reason 'abort'，按对局情况推断）
// 服务端给出的作废原因（Result.cause）
const ABORT_CAUSE_TEXT = {
  score_dispute: '数子有争议，时限内未达成一致',
  arrival: '有一方长时间没有回到对局',
  replaced: '开了新的人机对局',
  ai_error: 'AI 连续出错',
  idle: '长时间没有落子',
};

function abortCauseText(model) {
  const cause = model.result && model.result.cause;
  if (cause && ABORT_CAUSE_TEXT[cause]) return ABORT_CAUSE_TEXT[cause];
  if (model.mode === 'ai') return '可能开了新的人机对局、长时间未下，或 AI 连续出错';
  const me = model.myColor;
  if (model.moves.length === 0) {
    return me === BLACK ? '你没有在 60 秒内落下第一手' : '对手没有在 60 秒内落下第一手';
  }
  // 轮到的一方掉线太久、手数又不足
  return model.toPlay === me ? '你离线太久，且手数太少' : '对手离线太久，且手数太少';
}

function rankLines(model) {
  const r = model.result;
  if (model.mode === 'friend') return ['好友对局不计入排行榜'];
  if (model.mode === 'ai') return ['人机对局不计入排行榜'];
  if (r.reason === 'abort') return ['对局作废，不计入排行榜'];
  if (!r.counted) {
    if (r.pending) return ['结果正在保存，稍后计入排行榜'];
    if (r.uncounted === 'pair_limit') return ['与同一对手 24 小时内计入排行的局数已满，本局不计入'];
    return ['手数不足，本局不计入排行榜'];
  }
  const st = model.stats && model.stats[model.myColor];
  if (!st) return ['本局已计入排行榜'];
  let first;
  if (r.winner === model.myColor) {
    first = `当前连胜 ${st.curStreak} 局`;
    if (st.curStreak >= 2 && st.curStreak === st.maxStreak) first += '（个人最高）';
  } else if (r.winner === 0) {
    first = `和棋，连胜保持 ${st.curStreak} 局`;
  } else {
    first = '连胜中断';
  }
  return [first, `最高连胜 ${st.maxStreak} 局 · 排位 ${st.games} 局 · 胜率 ${formatPercent(st.winrate)}`];
}

function endView(model) {
  const r = model.result;
  let title;
  let tone;
  if (r.reason === 'abort') {
    title = '对局作废';
    tone = 'void';
  } else if (r.winner === 0) {
    title = '和棋';
    tone = 'draw';
  } else if (r.winner === model.myColor) {
    title = '你赢了';
    tone = 'win';
  } else {
    title = '你输了';
    tone = 'loss';
  }
  const scoreText =
    r.reason === 'score' && r.black !== null && r.white !== null ? `黑 ${formatNumber(r.black)} 点 · 白 ${formatNumber(r.white)} 点` : '';
  return {
    title,
    tone,
    label: r.reason === 'abort' ? abortCauseText(model) : r.label,
    scoreText,
    komiText: scoreText ? komiText(model) : '',
    lines: rankLines(model),
    // 好友对局的"再来一局"就是返回首页，与"返回首页"重复，不单独显示
    showAgain: model.mode !== 'friend',
  };
}

// 生成页面 setData 用的完整数据对象。deps.displayClock 为 utils/clock.js 的 displayClock（由页面注入）。
function viewData(model, now, deps) {
  const displayClock = deps && deps.displayClock;
  const me = model.myColor;
  const phase = model.status;
  const myTurn = isMyTurn(model);
  const idle = model.connection === 'open' && !model.pending;
  const sc = model.scoring;
  const playing = phase === 'playing';
  const scoringPhase = phase === 'scoring';
  const active = playing || scoringPhase;
  const pv = model.preview;

  let boardDisabled = true;
  if (playing) boardDisabled = !(myTurn && idle);
  else if (scoringPhase) boardDisabled = !(canMarkDead(model) && idle);

  const tcText = timeControlText(model.timeControl);
  return {
    loaded: true,
    size: model.size,
    cells: model.cells,
    lastIdx: model.lastIdx,
    preview: playing && pv ? { idx: pv.idx, ok: pv.ok, color: pv.color } : null,
    marks: marksView(model),
    boardDisabled,
    infoText: `${MODE_LABEL[model.mode]} · ${model.size} 路 · 贴 ${formatNumber(model.komi)} 目${tcText ? ` · ${tcText}` : ''}`,
    moveText: model.moves.length ? `第 ${model.moves.length} 手` : '开局',
    top: panelView(model, opponent(me), now, displayClock),
    bottom: panelView(model, me, now, displayClock),
    phase,
    statusText: statusText(model, myTurn),
    hint: model.hint,
    banner: bannerText(model),
    btn: {
      confirm: playing && myTurn && idle && !!pv && pv.ok,
      pass: playing && myTurn && idle,
      resign: active && idle,
      showUndo: model.mode === 'ai',
      undo: model.mode === 'ai' && active && model.canUndo && idle,
      accept:
        scoringPhase &&
        !!sc &&
        !sc.pending &&
        !sc.accepted[me] &&
        !(model.acceptSent !== null && model.acceptSent === sc.version) &&
        idle,
      resume: scoringPhase && idle && !resumeBlockedText(model),
      again: phase === 'ended' && !model.pending,
    },
    scoring: scoringPhase ? scoringView(model, now) : null,
    end: phase === 'ended' && model.result ? endView(model) : null,
  };
}

module.exports = {
  MODE_LABEL,
  REASON_TEXT,
  ERROR_TEXT,
  fromSnapshot,
  applyEvent,
  setConnection,
  withHint,
  syncFailed,
  pick,
  tapPoint,
  startMove,
  startPass,
  startResign,
  startUndo,
  startAccept,
  startResume,
  startAgain,
  requestDone,
  requestFailed,
  needsStats,
  withMyStats,
  errorText,
  isMyTurn,
  awaitingMove,
  colorOfMove,
  viewData,
  // 供测试
  formatCountdown,
  timeControlText,
};
