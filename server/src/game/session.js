'use strict';
const { board: B, game: G, score: S, coords: C, record: R } = require('./engine-ref');
const { GameClock, normalizeTimeControl } = require('./clock');
const { GameError } = require('./errors');

// 一局棋的权威状态（设计文档第 6 节）。纯内存、无 IO：时间由调用方传入，
// 出错时抛 GameError，成功时返回描述变化的对象，由 GameManager 负责持久化、推送、定时器与 AI。

const { BLACK, WHITE, opponent } = B;
const PASS = C.PASS;
const MODES = ['ranked', 'friend', 'ai'];

const ILLEGAL_MSG = {
  occupied: '这里已经有棋子了',
  ko: '打劫，不能立即提回',
  suicide: '禁止自杀',
};

// 同一时刻到期时的处理顺序
const DUE_ORDER = ['first_move', 'timeout', 'abandon', 'scoring', 'idle'];

function isUserId(v) {
  return Number.isSafeInteger(v) && v > 0;
}

function numOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 从着手序列重建局面。两次 pass 之后还有着手，说明双方曾"继续对局"，先 resume 再下。
// （record.replay 遇到这种序列会报错，所以这里自己实现）
function replayMoves(size, komi, moves) {
  if (!Array.isArray(moves)) throw new Error('着手序列必须是数组');
  const total = size * size;
  const state = G.createGame({ size, komi, autoScore: false });
  moves.forEach((mv, i) => {
    if (!Number.isInteger(mv) || mv < PASS || mv >= total) {
      const err = new Error(`第 ${i + 1} 手坐标非法：${mv}`);
      err.moveIndex = i;
      throw err;
    }
    if (state.status === 'scoring') G.resume(state);
    const r = mv === PASS ? G.pass(state) : G.play(state, mv);
    if (!r.ok) {
      const err = new Error(`第 ${i + 1} 手非法：${r.reason}`);
      err.moveIndex = i;
      err.reason = r.reason;
      throw err;
    }
  });
  return state;
}

function parseMaybeJson(v, field) {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch (err) {
    throw new Error(`对局记录的 ${field} 不是合法 JSON：${err.message}`);
  }
}

function parseLenient(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

// 仓储返回的 GameRow 统一成驼峰（兼容下划线写法与未解析的 JSON 字符串）
function normalizeRow(row) {
  if (!row || typeof row !== 'object') throw new TypeError('对局记录为空');
  const f = (camel, snake) => (row[camel] !== undefined ? row[camel] : row[snake]);
  return {
    id: row.id,
    mode: row.mode,
    size: Number(row.size),
    komi: Number(row.komi),
    blackId: numOrNull(f('blackId', 'black_id')),
    whiteId: numOrNull(f('whiteId', 'white_id')),
    aiLevel: f('aiLevel', 'ai_level') ?? null,
    timeControl: parseMaybeJson(f('timeControl', 'time_control'), 'time_control') ?? null,
    status: row.status,
    moves: parseMaybeJson(row.moves, 'moves') ?? [],
    clocks: parseMaybeJson(row.clocks, 'clocks') ?? null,
    dead: parseMaybeJson(row.dead, 'dead') ?? null,
    winner: numOrNull(row.winner),
    reason: row.reason ?? null,
    scoreBlack: numOrNull(f('scoreBlack', 'score_black')),
    scoreWhite: numOrNull(f('scoreWhite', 'score_white')),
    counted: Boolean(Number(f('counted', 'counted') || 0)),
    // 附加状态坏了不影响恢复（只是少了继续对局次数/保护），所以解析失败按 null
    state: parseLenient(row.state),
    cause: typeof row.cause === 'string' && row.cause ? row.cause : null,
    createdAt: numOrNull(f('createdAt', 'created_at')),
    updatedAt: numOrNull(f('updatedAt', 'updated_at')),
    endedAt: numOrNull(f('endedAt', 'ended_at')),
  };
}

const SETTING_KEYS = ['firstMoveTimeoutMs', 'abandonMs', 'scoringTimeoutMs', 'aiIdleTimeoutMs', 'minMovesRanked'];

// 可选设置（settings 里没给时用这些默认值，见 game/settings.js）
const OPTIONAL_DEFAULTS = Object.freeze({
  resumeLimit: 1, // 真人对局每方每局最多"继续对局"几次
  scoringGraceMs: 60000, // 有人点选死子后，对方至少还有这么久可以回应（自动确认时限顺延）
  arrivalGraceMs: 300000, // 开局时不在线 / 重启恢复后还没回来的玩家，最多等这么久，超时作废
});

function optSetting(settings, key) {
  const v = settings[key];
  return Number.isSafeInteger(v) && v >= 0 ? v : OPTIONAL_DEFAULTS[key];
}

function deadKey(list) {
  return list.join(',');
}

function sameList(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function isIdxList(v) {
  return Array.isArray(v) && v.every((i) => Number.isSafeInteger(i) && i >= 0);
}

function isCount(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

// 数子阶段的状态 ↔ 可 JSON 化的对象（继续对局保护要随对局进度保存，重启后还能撤销继续对局，见 persistState）
function serializeScoring(sc) {
  return {
    source: sc.source,
    version: sc.version,
    dead: sc.dead.slice(),
    proposal: sc.proposal.slice(),
    accepted: { 1: sc.accepted[BLACK], 2: sc.accepted[WHITE] },
    endorsed: { 1: [...sc.endorsed[BLACK]], 2: [...sc.endorsed[WHITE]] },
    agreed: sc.agreed ? sc.agreed.dead.slice() : null,
    marks: [...sc.marks],
    stance: { 1: sc.stance[BLACK], 2: sc.stance[WHITE] },
  };
}

// 解析失败返回 null（坏数据只让保护失效，不影响恢复对局）。owner/点数由调用方按局面重算
function deserializeScoring(o) {
  if (!o || typeof o !== 'object') return null;
  if (!isIdxList(o.dead) || !isIdxList(o.proposal) || !Number.isSafeInteger(o.version)) return null;
  const keys = (v) => (Array.isArray(v) ? v.filter((k) => typeof k === 'string') : []);
  const endorsed = o.endorsed && typeof o.endorsed === 'object' ? o.endorsed : {};
  const accepted = o.accepted && typeof o.accepted === 'object' ? o.accepted : {};
  const stance = o.stance && typeof o.stance === 'object' ? o.stance : {};
  const marks = new Map();
  if (Array.isArray(o.marks)) {
    for (const m of o.marks) {
      if (Array.isArray(m) && Number.isSafeInteger(m[0]) && m[0] >= 0 && (m[1] === BLACK || m[1] === WHITE)) marks.set(m[0], m[1]);
    }
  }
  return {
    pending: false,
    source: o.source === 'manual' ? 'manual' : 'katago',
    version: o.version,
    dead: o.dead.slice(),
    owner: [],
    black: 0,
    white: 0,
    winner: 0,
    accepted: { 1: accepted[BLACK] === true, 2: accepted[WHITE] === true },
    deadlineAt: null,
    judgeSeq: 0,
    proposal: o.proposal.slice(),
    readyAt: null,
    endorsed: { 1: new Set(keys(endorsed[BLACK])), 2: new Set(keys(endorsed[WHITE])) },
    agreed: isIdxList(o.agreed) ? { key: deadKey(o.agreed), dead: o.agreed.slice() } : null,
    marks,
    stance: {
      1: typeof stance[BLACK] === 'string' ? stance[BLACK] : null,
      2: typeof stance[WHITE] === 'string' ? stance[WHITE] : null,
    },
  };
}

// "继续对局"在 stance 里的记号：不同意当时的数子结果（不会与任何死子集合的键相同）
const STANCE_RESUME = 'resume';

class GameSession {
  // settings: { firstMoveTimeoutMs, abandonMs, scoringTimeoutMs, aiIdleTimeoutMs, minMovesRanked }
  constructor({
    id,
    mode,
    size,
    komi,
    blackId = null,
    whiteId = null,
    aiLevel = null,
    timeControl = null,
    settings,
    now,
    createdAt,
  }) {
    if (typeof id !== 'string' || !id) throw new TypeError('GameSession: id 必须是非空字符串');
    if (!MODES.includes(mode)) throw new TypeError(`GameSession: 未知模式 ${mode}`);
    if (!Number.isInteger(size) || size < 2 || size > 19) throw new TypeError(`GameSession: 路数不合法 ${size}`);
    if (typeof komi !== 'number' || !Number.isFinite(komi)) throw new TypeError('GameSession: komi 必须是数字');
    if (!Number.isFinite(now)) throw new TypeError('GameSession: now 必须是时间戳');
    if (!settings || SETTING_KEYS.some((k) => !Number.isFinite(settings[k]))) {
      throw new TypeError(`GameSession: settings 需要 ${SETTING_KEYS.join('/')}`);
    }
    this.id = id;
    this.mode = mode;
    this.size = size;
    this.komi = komi;
    this.settings = settings;
    this.players = { 1: blackId, 2: whiteId };
    this.aiColor = 0;
    this.aiLevel = null;
    if (mode === 'ai') {
      if ((blackId === null) === (whiteId === null)) throw new TypeError('GameSession: 人机对局必须恰好一方为 AI');
      const human = blackId === null ? whiteId : blackId;
      if (!isUserId(human)) throw new TypeError('GameSession: 玩家 id 不合法');
      if (typeof aiLevel !== 'string' || !aiLevel) throw new TypeError('GameSession: 人机对局需要 aiLevel');
      this.aiColor = blackId === null ? BLACK : WHITE;
      this.aiLevel = aiLevel;
    } else if (!isUserId(blackId) || !isUserId(whiteId) || blackId === whiteId) {
      throw new TypeError('GameSession: 真人对局需要两个不同的玩家 id');
    }
    // 人机对局不计时
    this.timeControl = mode !== 'ai' && timeControl ? normalizeTimeControl(timeControl) : null;
    this.clock = this.timeControl ? new GameClock(this.timeControl) : null;

    this.state = G.createGame({ size, komi, autoScore: false });
    this.moves = [];
    this.createdAt = Number.isFinite(createdAt) ? createdAt : now;
    this.startedAt = now; // 首手计时的起点（重启恢复时为恢复时刻）
    this.turnStartedAt = now;
    this.lastActivityAt = now;
    this.online = { 1: this.aiColor === BLACK, 2: this.aiColor === WHITE };
    this.offlineSince = { 1: this.aiColor === BLACK ? null : now, 2: this.aiColor === WHITE ? null : now };
    this.scoring = null;
    this.judgeSeq = 0;
    this.result = null;
    this.counted = false;
    // 终局的细分原因（Result.cause，见设计文档 5.4），如 'first_move' 'arrival' 'abandon' 'score_dispute' 'resume_undone'
    this.endCause = null;
    // 排位赛、不是作废、却没有计入时的原因：'short'（手数不足）| 'pair_limit'（同一对手 24 小时内计入的局数已满）
    this.uncounted = null;
    // 终局结果写库失败、正在重试（Result.pending）
    this.savePending = false;
    this.endedAt = null;
    this.aiThinking = false;
    // 局面/阶段每变化一次 +1，用来识别过期的 AI 结果
    this.version = 0;
    // 真人对局每方已用的"继续对局"次数（随对局进度保存，重启不清零）
    this.resumesUsed = { 1: 0, 2: 0 };
    // 继续对局时对方已同意当时的数子建议：{ color, movesLen, scoring }。
    // 该方在走下一手之前就掉线弃局/超时，则撤销这次继续对局、按当时的建议终局（见 _undoResume）。也随对局进度保存。
    this.resumeGuard = null;
    // 最近一次 KataGo 死子判断：{ key: 局面, dead }。局面没变时再次数子直接复用，不再请求 AI。
    this.judgeCache = null;
    // 还没到场的玩家：{ waiting: { 1, 2 }, since }（见 expectArrival）
    this.arrival = null;
    if (this.clock) this.clock.start(BLACK, now);
  }

  get status() {
    return this.state.status;
  }

  get toPlay() {
    return this.state.toPlay;
  }

  get isAiGame() {
    return this.mode === 'ai';
  }

  get humanColor() {
    return this.aiColor ? opponent(this.aiColor) : 0;
  }

  get ended() {
    return this.state.status === 'ended';
  }

  colorOf(userId) {
    if (userId === null || userId === undefined) return 0;
    if (this.players[BLACK] === userId) return BLACK;
    if (this.players[WHITE] === userId) return WHITE;
    return 0;
  }

  userIds() {
    return [this.players[BLACK], this.players[WHITE]].filter((id) => id !== null && id !== undefined);
  }

  // 人机对局：最后一手是玩家的 pass（"继续对局"后连续 pass 计数清零，不算）
  humanJustPassed() {
    const h = this.state.history;
    const last = h[h.length - 1];
    return Boolean(last) && last.idx === null && last.color === this.humanColor && this.state.consecutivePasses >= 1;
  }

  touch(now) {
    this.lastActivityAt = now;
  }

  // 返回在线状态是否有变化
  setOnline(color, online, now) {
    if (color !== BLACK && color !== WHITE) return false;
    if (color === this.aiColor) return false;
    const val = Boolean(online);
    if (this.online[color] === val) return false;
    this.online[color] = val;
    this.offlineSince[color] = val ? null : now;
    if (val) this._arrive(color, now);
    return true;
  }

  // ---------- 到场 ----------
  // 开局时不在线的玩家（好友房房主切到了后台）与服务端重启后恢复的对局里的玩家，在"到场"（上线）之前：
  // 不走他的钟、首手计时不开始、轮到他时也不按掉线弃局判负；超过 arrivalGraceMs 仍未到场则对局作废。
  // 这样停机或开局时不在场都不会变成计入排行的超时负。建局/恢复时由管理器在设置好在线状态后调用。
  expectArrival(now) {
    if (this.isAiGame || this.ended) return;
    const waiting = { 1: !this.online[BLACK], 2: !this.online[WHITE] };
    if (!waiting[BLACK] && !waiting[WHITE]) {
      this.arrival = null;
      return;
    }
    this.arrival = { waiting, since: now };
    if (this.clock && this.clock.running && waiting[this.clock.running]) this.clock.stop(now);
  }

  awaitingArrival(color) {
    return Boolean(this.arrival && this.arrival.waiting[color]);
  }

  _arrive(color, now) {
    const a = this.arrival;
    if (!a || !a.waiting[color]) return;
    a.waiting[color] = false;
    if (!a.waiting[BLACK] && !a.waiting[WHITE]) this.arrival = null;
    if (this.state.status !== 'playing' || this.state.toPlay !== color) return;
    if (this.moves.length === 0) this.startedAt = now; // 首手计时从黑方到场算起
    this.turnStartedAt = now;
    if (this.clock && !this.clock.running) this.clock.start(color, now);
  }

  // 轮到 color：开始计时（还没到场的一方先不走钟）
  _runClockFor(color, now) {
    if (!this.clock) return;
    if (this.awaitingArrival(color)) this.clock.stop(now);
    else this.clock.start(color, now);
  }

  // ---------- 对局中 ----------

  _requirePlaying() {
    const st = this.state.status;
    if (st === 'playing') return;
    throw new GameError('wrong_phase', st === 'scoring' ? '正在数子，不能落子' : '对局已结束');
  }

  _checkTurn(color, n, now) {
    const expected = this.moves.length + 1;
    if (n !== expected) throw new GameError('stale', `局面已变化，当前应为第 ${expected} 手`, { expected });
    if (color !== this.state.toPlay) throw new GameError('not_your_turn', '还没轮到你');
    if (this.clock && this.clock.running === color && this.clock.isTimedOut(now)) {
      throw new GameError('wrong_phase', '已超时');
    }
  }

  _nextTurn(now) {
    this._runClockFor(this.state.toPlay, now); // start/stop 都会先结算刚落子的一方
    this.turnStartedAt = now;
    this.version += 1;
  }

  // color 走了一手：继续对局的保护到此为止（他已经回到对局里了）
  _moved(color) {
    if (this.resumeGuard && this.resumeGuard.color === color) this.resumeGuard = null;
  }

  // color 落子于 idx，n 为这一手的序号。返回 { n, idx, color, captured, scoring: false }
  play(color, n, idx, now) {
    this._requirePlaying();
    this._checkTurn(color, n, now);
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.size * this.size) {
      throw new GameError('bad_request', '坐标超出棋盘');
    }
    const r = G.play(this.state, idx);
    if (!r.ok) throw new GameError('illegal', ILLEGAL_MSG[r.reason] || `非法着手：${r.reason}`, { reason: r.reason });
    const last = this.state.history[this.state.history.length - 1];
    this.moves.push(idx);
    this._moved(color);
    this._nextTurn(now);
    return { n: this.moves.length, idx, color, captured: last.captured.slice(), scoring: false };
  }

  // 返回 { n, idx: -1, color, captured: [], scoring }，scoring 为真表示双方连续 pass 进入数子阶段
  pass(color, n, now) {
    this._requirePlaying();
    this._checkTurn(color, n, now);
    const r = G.pass(this.state);
    if (!r.ok) throw new GameError('wrong_phase', '当前不能停一手');
    this.moves.push(PASS);
    this._moved(color);
    const scoring = this.state.status === 'scoring';
    if (scoring) this._enterScoring(now);
    else this._nextTurn(now);
    return { n: this.moves.length, idx: PASS, color, captured: [], scoring };
  }

  // ---------- 数子阶段 ----------

  _enterScoring(now) {
    if (this.clock) this.clock.stop(now);
    this.judgeSeq += 1;
    this.resumeGuard = null;
    const s = S.scoreArea(this.state.board, this.komi, []);
    this.scoring = {
      pending: true,
      source: 'katago',
      version: 0,
      dead: [],
      owner: s.owner,
      black: s.black,
      white: s.white,
      winner: s.winner,
      accepted: { 1: false, 2: false },
      deadlineAt: null,
      judgeSeq: this.judgeSeq,
      // 以下在建议到达后设置（applyJudge）
      proposal: [], // 最初的建议（KataGo 判断；manual 时为空）
      readyAt: null,
      // 各方认可过的死子集合的键：确认过的，或者点选之后"与原建议的差别全是自己改的"集合
      // （点在对方的修改之上、或改到一半的中间状态都不算认可，见 toggleDead）
      endorsed: { 1: new Set(), 2: new Set() },
      agreed: null, // 最近一个双方都认可过的死子集合
      marks: new Map(), // 与原建议不同的棋子 → 最后改动它的一方
      // 手动数子（manual）时各方最近一次表态：点选/确认后的死子集合的键，继续对局为 STANCE_RESUME；没表过态为 null
      stance: { 1: null, 2: null },
    };
    this.version += 1;
  }

  get judgeToken() {
    return this.scoring && this.scoring.pending ? this.scoring.judgeSeq : null;
  }

  // 当前局面的键（数子阶段复用死子判断用）
  boardKey() {
    return this.state.board.cells.join('');
  }

  // 局面与上次 KataGo 判断时相同 → 上次的死子；否则 null
  cachedJudge() {
    const c = this.judgeCache;
    return c && c.key === this.boardKey() ? c.dead.slice() : null;
  }

  // 死子建议到达（dead 为数组）或判定失败（dead 为 null → manual、无死子）。
  // 结果已过期（局面变了/不在等待中）时返回 false，不做任何修改。
  applyJudge(seq, dead, now) {
    const sc = this.scoring;
    if (this.state.status !== 'scoring' || !sc || !sc.pending || sc.judgeSeq !== seq) return false;
    const list = Array.isArray(dead) ? dead.filter((i) => Number.isInteger(i)) : [];
    const s = S.scoreArea(this.state.board, this.komi, list);
    sc.pending = false;
    sc.source = Array.isArray(dead) ? 'katago' : 'manual';
    sc.version = 1;
    this._setDead(s);
    sc.proposal = s.dead.slice();
    sc.readyAt = now;
    sc.endorsed = { 1: new Set(), 2: new Set() };
    sc.agreed = null;
    sc.marks = new Map();
    sc.stance = { 1: null, 2: null };
    sc.accepted = { 1: false, 2: false };
    // 人机对局：AI 一方自动确认，也没有自动确认时限
    if (this.aiColor) sc.accepted[this.aiColor] = true;
    sc.deadlineAt = this.aiColor ? null : now + this.settings.scoringTimeoutMs;
    if (sc.source === 'katago') this.judgeCache = { key: this.boardKey(), dead: s.dead.slice() };
    this.version += 1;
    return true;
  }

  _setDead(s) {
    const sc = this.scoring;
    sc.dead = s.dead;
    sc.owner = s.owner;
    sc.black = s.black;
    sc.white = s.white;
    sc.winner = s.winner;
  }

  _requireScoringReady() {
    if (this.state.status !== 'scoring' || !this.scoring) {
      throw new GameError('wrong_phase', this.state.status === 'ended' ? '对局已结束' : '当前不在数子阶段');
    }
    if (this.scoring.pending) throw new GameError('wrong_phase', '正在判断死子，请稍候');
  }

  // color 认可当前的死子集合（确认，或者点选出来的集合与原建议的差别全是他自己改的）
  _endorse(color) {
    const sc = this.scoring;
    const key = deadKey(sc.dead);
    sc.endorsed[color].add(key);
    if (sc.endorsed[opponent(color)].has(key)) sc.agreed = { key, dead: sc.dead.slice() };
  }

  // 切换 idx 所在整块的死活。返回 { changed }（点在空点上不变）。
  // version（可选）：客户端点选时看到的版本，不是当前版本 → stale（点选不会落在自己没看到的修改之上）。
  // 真人对局：自动确认时限顺延，保证对方至少还有 scoringGraceMs 可以回应（总时长不超过 2 × scoringTimeoutMs）。
  // 人机对局：只有死子判断失败（manual）时才允许点选，AI 一方保持已确认。
  toggleDead(color, idx, now, version) {
    this._requireScoringReady();
    const sc = this.scoring;
    if (this.isAiGame && sc.source !== 'manual') throw new GameError('bad_request', '人机对局由 AI 判断死子，不能修改');
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.size * this.size) {
      throw new GameError('bad_request', '坐标超出棋盘');
    }
    if (version !== undefined && version !== null && version !== sc.version) {
      throw new GameError('stale', '死子已被修改，请看清最新结果再点选', { version: sc.version });
    }
    const next = S.toggleDead(this.state.board, sc.dead, idx);
    if (sameList(next, sc.dead)) return { changed: false };
    // 记下与原建议不同的棋子是谁改的
    const before = new Set(sc.dead);
    const after = new Set(next);
    const proposal = new Set(sc.proposal);
    for (const i of [...before, ...after]) {
      if (before.has(i) === after.has(i)) continue;
      if (after.has(i) === proposal.has(i)) sc.marks.delete(i);
      else sc.marks.set(i, color);
    }
    this._setDead(S.scoreArea(this.state.board, this.komi, next));
    sc.version += 1;
    sc.accepted = { 1: false, 2: false };
    if (this.aiColor) sc.accepted[this.aiColor] = true;
    // 点选出来的集合只有在"与原建议的差别全是自己改的"时才算认可：
    // 点在对方的修改之上、或者一处处改回来时的中间状态，都不能被对方一确认就变成"双方认可"（FS-2）
    if ([...sc.marks.values()].every((c) => c === color)) this._endorse(color);
    sc.stance[color] = deadKey(sc.dead);
    if (sc.deadlineAt !== null) {
      const grace = Math.min(optSetting(this.settings, 'scoringGraceMs'), this.settings.scoringTimeoutMs);
      const cap = sc.readyAt + 2 * this.settings.scoringTimeoutMs;
      sc.deadlineAt = Math.max(sc.deadlineAt, Math.min(now + grace, cap));
    }
    this.version += 1;
    return { changed: true };
  }

  // 确认当前版本的数子结果。返回 { done }：双方都确认了
  accept(color, version, now) {
    this._requireScoringReady();
    const sc = this.scoring;
    if (version !== sc.version) {
      throw new GameError('stale', '死子已被修改，请确认最新结果', { version: sc.version });
    }
    sc.accepted[color] = true;
    this._endorse(color);
    sc.stance[color] = deadKey(sc.dead);
    return { done: sc.accepted[BLACK] && sc.accepted[WHITE] };
  }

  // 还能"继续对局"几次；人机对局不限（null）
  resumesLeft(color) {
    if (this.isAiGame) return null;
    return Math.max(0, optSetting(this.settings, 'resumeLimit') - this.resumesUsed[color]);
  }

  // 不同意数子结果，回到对局：轮到最先 pass 的一方，重新计时。返回 { toPlay }
  // 真人对局：每方每局最多 resumeLimit 次；对手不在线时不能继续（交给自动确认按规则计分）。
  resume(color, now) {
    if (this.state.status !== 'scoring') {
      throw new GameError('wrong_phase', this.state.status === 'ended' ? '对局已结束' : '当前不在数子阶段');
    }
    const opp = opponent(color);
    if (!this.isAiGame) {
      if (this.resumesLeft(color) <= 0) {
        throw new GameError('wrong_phase', '你已经用过"继续对局"了，请确认数子结果或等待自动计分');
      }
      if (!this.online[opp]) throw new GameError('wrong_phase', '对手不在线，不能继续对局，请等待自动计分');
    }
    const sc = this.scoring;
    const r = G.resume(this.state);
    if (!r.ok) throw new GameError('wrong_phase', '当前不在数子阶段');
    if (!this.isAiGame) {
      this.resumesUsed[color] += 1;
      if (sc && !sc.pending && sc.accepted[opp]) {
        // 继续对局 = 不同意当时的结果（手动数子撤销继续对局时，这算一次异议，见 deadlineOutcome）
        sc.stance[color] = STANCE_RESUME;
        this.resumeGuard = { color: opp, movesLen: this.moves.length, scoring: sc };
      } else {
        this.resumeGuard = null;
      }
    }
    this.scoring = null;
    this.judgeSeq += 1; // 让还在路上的死子判断结果作废
    this._runClockFor(this.state.toPlay, now);
    this.turnStartedAt = now;
    this.version += 1;
    return { toPlay: this.state.toPlay };
  }

  // 按当前死子计分终局（双方都确认了当前版本）。cause：Result.cause
  finishByScore(now, cause = 'agreed') {
    this._requireScoringReady();
    const s = S.scoreArea(this.state.board, this.komi, this.scoring.dead);
    return this._end({ winner: s.winner, reason: 'score', black: s.black, white: s.white }, now, cause);
  }

  // 自动确认时限到了、双方还没对当前版本达成一致时怎么终局。返回 { dead } 或 { void: cause }（作废）。
  // KataGo 给出的建议（中立）：当前版本就是原建议，或双方都认可过当前版本 → 当前版本；
  //   否则最近一个双方都认可过的版本；再没有就用原建议。单方面的点选（最后一刻、趁对方不在）不决定结果。
  // 手动数子（manual，没有中立的建议，"无死子"只对一方有利）：双方都认可过的版本照用；否则
  //   有人还没到场（重启后没回来）→ 作废（'arrival'）；谁都没有对"无死子"表示异议 → 无死子；
  //   有异议（点选过、确认过别的集合，或继续对局后被撤销）→ 作废（'score_dispute'），不计入排行。
  //   这样不合作（掉线、不回应、确认后离开）的一方拿不到错误的胜局（FS-1）。
  deadlineOutcome() {
    const sc = this.scoring;
    const cur = deadKey(sc.dead);
    const both = (key) => sc.endorsed[BLACK].has(key) && sc.endorsed[WHITE].has(key);
    const pk = deadKey(sc.proposal);
    if (sc.source !== 'manual') {
      if (cur === pk || both(cur)) return { dead: sc.dead.slice() };
      if (sc.agreed) return { dead: sc.agreed.dead.slice() };
      return { dead: sc.proposal.slice() };
    }
    if (both(cur)) return { dead: sc.dead.slice() };
    if (sc.agreed) return { dead: sc.agreed.dead.slice() };
    if (!this.isAiGame && (this.awaitingArrival(BLACK) || this.awaitingArrival(WHITE))) return { void: 'arrival' };
    if ([BLACK, WHITE].every((c) => sc.stance[c] === null || sc.stance[c] === pk)) return { dead: sc.proposal.slice() };
    return { void: 'score_dispute' };
  }

  // 自动确认时限到：按 deadlineOutcome() 计分终局（死子集合有变化时 version +1）或作废
  finishAtDeadline(now, cause = 'deadline') {
    this._requireScoringReady();
    const sc = this.scoring;
    const out = this.deadlineOutcome();
    if (out.void) return this._end({ winner: 0, reason: 'abort', black: null, white: null }, now, out.void);
    if (!sameList(out.dead, sc.dead)) {
      this._setDead(S.scoreArea(this.state.board, this.komi, out.dead));
      sc.version += 1;
    }
    return this.finishByScore(now, cause);
  }

  // 继续对局后，此前已同意数子结果的一方还没走下一手就掉线弃局/超时：撤销这次继续对局
  // （之后的着手作废），回到当时的数子阶段并按自动确认的规则终局。
  _undoResume(now) {
    const g = this.resumeGuard;
    this.resumeGuard = null;
    const moves = this.moves.slice(0, g.movesLen);
    this.state = replayMoves(this.size, this.komi, moves);
    this.moves = moves;
    this.scoring = g.scoring;
    // 按撤销后的局面重算（从数据库恢复的保护只存了死子集合）
    this._setDead(S.scoreArea(this.state.board, this.komi, this.scoring.dead));
    this.resumeUndone = true;
    return this.finishAtDeadline(now, 'resume_undone');
  }

  // ---------- 终局 ----------

  resign(color, now) {
    const st = this.state.status;
    if (st !== 'playing' && st !== 'scoring') throw new GameError('wrong_phase', '对局已结束');
    return this._end({ winner: opponent(color), reason: 'resign', black: null, white: null }, now);
  }

  // cause：作废的原因（Result.cause），如 'replaced'（新开了人机对局）、'ai_error'
  abort(now, cause = null) {
    if (this.ended) throw new GameError('wrong_phase', '对局已结束');
    return this._end({ winner: 0, reason: 'abort', black: null, white: null }, now, cause);
  }

  // cause：'clock'（读秒用完）| 'abandon'（轮到时掉线太久）
  timeoutLoss(loser, now, cause = 'clock') {
    if (this.ended) throw new GameError('wrong_phase', '对局已结束');
    return this._end({ winner: opponent(loser), reason: 'timeout', black: null, white: null }, now, cause);
  }

  _end(result, now, cause = null) {
    if (this.clock) this.clock.stop(now);
    if (this.scoring && this.scoring.pending) this.scoring = null;
    if (this.scoring) this.scoring.deadlineAt = null;
    const r = G.finish(this.state, result);
    if (!r.ok) throw new GameError('wrong_phase', '对局已结束');
    this.result = {
      winner: this.state.result.winner,
      reason: this.state.result.reason,
      black: this.state.result.black,
      white: this.state.result.white,
    };
    this.endedAt = now;
    this.endCause = cause;
    this.counted = this._computeCounted();
    this.uncounted = this.mode === 'ranked' && result.reason !== 'abort' && !this.counted ? 'short' : null;
    this.aiThinking = false;
    this.version += 1;
    return this.result;
  }

  // 落子数（不含 pass）
  stoneMoves() {
    let n = 0;
    for (const mv of this.moves) if (mv !== PASS) n += 1;
    return n;
  }

  // 计入排行的条件（设计文档 6.6）。作废的不计；另外：
  // - 认输 / 超时：双方都至少下过一手（总手数 ≥ 2）就计入——不能靠开局几手就认输、超时来躲开强手保住连胜；
  //   还没下过一手就认输/超时（相当于拒绝这盘棋）不计；
  // - 数子：落子数（不含 pass）≥ minMovesRanked——开局就双方 pass、确认，刷不了胜局。
  // 同一对手 24 小时内计入的局数上限由管理器检查（需要查库，见 GameManager._end）。
  _computeCounted() {
    const r = this.result;
    if (this.mode !== 'ranked' || !r || r.reason === 'abort') return false;
    if (r.reason === 'score') return this.stoneMoves() >= this.settings.minMovesRanked;
    return this.moves.length >= 2;
  }

  // ---------- 人机悔棋 ----------

  canUndo() {
    if (!this.isAiGame || this.ended) return false;
    return this.hasHumanMove();
  }

  // 人机对局里玩家下过（或 pass 过）至少一手
  hasHumanMove() {
    const human = this.humanColor;
    return Boolean(human) && this.state.history.some((h) => h.color === human);
  }

  // 撤回玩家最近一手及其后的 AI 应手（数子阶段 = 撤回 pass 回到对局）。返回 { moves }
  undo(color, now) {
    if (!this.isAiGame) throw new GameError('bad_request', '只有人机对局可以悔棋');
    if (this.ended) throw new GameError('wrong_phase', '对局已结束');
    if (!this.canUndo()) throw new GameError('nothing_to_undo', '没有可以悔的棋');
    const human = this.humanColor;
    for (;;) {
      const last = this.state.history[this.state.history.length - 1];
      G.undo(this.state);
      this.moves.pop();
      if (last.color === human) break;
    }
    this.scoring = null;
    this.judgeSeq += 1;
    this.aiThinking = false;
    this.turnStartedAt = now;
    this.version += 1;
    return { moves: this.moves.slice() };
  }

  // ---------- 定时事件 ----------

  // 当前所有待到期事件 [{ kind, at }]
  deadlines() {
    const out = [];
    const st = this.state.status;
    if (st === 'ended') return out;
    const human = !this.isAiGame;
    const set = this.settings;
    if (st === 'playing') {
      if (human && this.moves.length === 0 && !this.awaitingArrival(BLACK)) {
        out.push({ kind: 'first_move', at: this.startedAt + set.firstMoveTimeoutMs });
      }
      if (this.clock && this.clock.running) out.push({ kind: 'timeout', at: this.clock.timeoutAt() });
      const toPlay = this.state.toPlay;
      if (human && !this.online[toPlay]) {
        // 继续对局保护下的一方（已同意数子结果）不回来：结果是撤销继续对局、按当时的数子结果终局，
        // 不是判他负，所以不必等他的基本时间用完，也不必等满到场宽限，abandonMs 后就处理（FS-11）
        const guarded = Boolean(this.resumeGuard && this.resumeGuard.color === toPlay);
        if (this.awaitingArrival(toPlay)) {
          // 还没到场：等 arrivalGraceMs，到时作废
          const since = Math.max(this.arrival.since, this.turnStartedAt);
          out.push({ kind: 'abandon', at: since + (guarded ? set.abandonMs : optSetting(set, 'arrivalGraceMs')) });
        } else {
          // 掉线：至少等 abandonMs；基本时间还没用完就等到用完为止（掉线期间照常走钟，但不给读秒）
          const since = Math.max(this.offlineSince[toPlay] ?? this.turnStartedAt, this.turnStartedAt);
          let at = since + set.abandonMs;
          if (!guarded && this.clock && this.clock.running === toPlay) at = Math.max(at, this.clock.mainOutAt());
          out.push({ kind: 'abandon', at });
        }
      }
    } else if (st === 'scoring') {
      const sc = this.scoring;
      if (human && sc && !sc.pending && sc.deadlineAt !== null) out.push({ kind: 'scoring', at: sc.deadlineAt });
    }
    if (!human) out.push({ kind: 'idle', at: this.lastActivityAt + set.aiIdleTimeoutMs });
    return out;
  }

  nextDeadline() {
    let min = null;
    for (const d of this.deadlines()) if (min === null || d.at < min) min = d.at;
    return min;
  }

  // 已到期的事件（没有返回 null）。还没下第一手就超时/弃局的一律按作废处理。
  dueAction(now) {
    const due = this.deadlines().filter((d) => d.at <= now);
    if (!due.length) return null;
    due.sort((a, b) => a.at - b.at || DUE_ORDER.indexOf(a.kind) - DUE_ORDER.indexOf(b.kind));
    const kind = due[0].kind;
    if ((kind === 'timeout' || kind === 'abandon') && this.moves.length === 0) return 'first_move';
    return kind;
  }

  // 执行到期事件，返回终局结果
  applyDue(kind, now) {
    switch (kind) {
      case 'first_move':
        // 还没下第一手：黑方没到场（开局时不在线、重启后没回来）超过宽限 → 'arrival'，否则 'first_move'
        return this.abort(now, this.awaitingArrival(this.state.toPlay) ? 'arrival' : 'first_move');
      case 'idle':
        return this.abort(now, 'idle');
      case 'timeout': {
        const loser = this.clock.running;
        // 继续对局保护下的一方（已同意数子结果）在走下一手之前读秒用完：不论是否在线，都撤销继续对局，
        // 给他当时同意的结果——他掉线也能得到这个结果，在线却没注意到反而判负就不公平了（FS-3）
        if (this.resumeGuard && this.resumeGuard.color === loser) return this._undoResume(now);
        return this.timeoutLoss(loser, now, 'clock');
      }
      case 'abandon': {
        // 轮到的一方掉线太久：判其超时负；他还没到场过（开局时不在 / 重启恢复后没回来）、
        // 或他还一手没下（总手数 < 2，相当于没开始）则作废
        const loser = this.state.toPlay;
        if (this.resumeGuard && this.resumeGuard.color === loser) return this._undoResume(now);
        if (this.awaitingArrival(loser)) return this.abort(now, 'arrival');
        if (this.moves.length < 2) return this.abort(now, 'abandon');
        return this.timeoutLoss(loser, now, 'abandon');
      }
      case 'scoring':
        return this.finishAtDeadline(now, 'deadline');
      default:
        throw new Error(`未知的到期事件 ${kind}`);
    }
  }

  // ---------- 视图 ----------

  clocksView(now) {
    return this.clock ? this.clock.snapshot(now) : null;
  }

  scoringView(now) {
    const sc = this.scoring;
    if (!sc) return null;
    return {
      pending: sc.pending,
      source: sc.source,
      version: sc.version,
      dead: sc.dead.slice(),
      owner: sc.owner.slice(),
      black: sc.black,
      white: sc.white,
      winner: sc.winner,
      accepted: { 1: sc.accepted[BLACK], 2: sc.accepted[WHITE] },
      deadline: sc.deadlineAt === null || this.ended ? null : Math.max(0, sc.deadlineAt - now),
      resumesLeft: this.isAiGame ? null : { 1: this.resumesLeft(BLACK), 2: this.resumesLeft(WHITE) },
      atDeadline: this._atDeadlineView(),
    };
  }

  // 时限到时会怎么终局（设计文档 5.4 Scoring.atDeadline），让客户端能提示"到时将按 … 计分"。
  // 没有自动确认时限（人机、正在判断、已终局）为 null
  _atDeadlineView() {
    const sc = this.scoring;
    if (!sc || sc.pending || sc.deadlineAt === null || this.ended || this.state.status !== 'scoring') return null;
    const out = this.deadlineOutcome();
    if (out.void) return { void: true, cause: out.void };
    const s = S.scoreArea(this.state.board, this.komi, out.dead);
    return { void: false, dead: s.dead, black: s.black, white: s.white, winner: s.winner, same: sameList(s.dead, sc.dead) };
  }

  resultView() {
    const r = this.result;
    if (!r) return null;
    return {
      winner: r.winner,
      reason: r.reason,
      black: r.black,
      white: r.white,
      text: R.resultText(r),
      label: R.resultLabel(r),
      counted: this.counted,
      cause: this.endCause,
      uncounted: this.counted ? null : this.uncounted,
      pending: this.savePending,
    };
  }

  // players: { 1: PlayerInfo, 2: PlayerInfo }（由管理器查用户表生成）
  snapshot(viewerColor, now, players) {
    return {
      id: this.id,
      mode: this.mode,
      size: this.size,
      komi: this.komi,
      players,
      myColor: viewerColor,
      moves: this.moves.slice(),
      status: this.state.status,
      toPlay: this.state.toPlay,
      timeControl: this.timeControl ? { ...this.timeControl } : null,
      clocks: this.clocksView(now),
      scoring: this.scoringView(now),
      result: this.resultView(),
      presence: { 1: this.online[BLACK], 2: this.online[WHITE] },
      aiThinking: this.aiThinking,
      canUndo: this.canUndo(),
    };
  }

  // ---------- 持久化 ----------

  // games.insert 的参数（字段同表）
  insertRow(now) {
    return {
      id: this.id,
      mode: this.mode,
      size: this.size,
      komi: this.komi,
      black_id: this.players[BLACK],
      white_id: this.players[WHITE],
      ai_level: this.aiLevel,
      time_control: this.timeControl ? { ...this.timeControl } : null,
      status: this.state.status,
      moves: this.moves.slice(),
      clocks: this.clock ? this.clock.toJSON() : null,
      dead: null,
      winner: null,
      reason: null,
      score_black: null,
      score_white: null,
      result_text: null,
      counted: 0,
      created_at: this.createdAt,
      updated_at: now,
      ended_at: null,
    };
  }

  // games.saveProgress 的参数
  progress() {
    return {
      status: this.state.status,
      moves: this.moves.slice(),
      clocks: this.clock ? this.clock.toJSON() : null,
      state: this.persistState(),
    };
  }

  // 重启后还要保留的会话状态（games.state 列）：已用的"继续对局"次数与继续对局保护（FS-6 / FS-7）。人机对局为 null
  persistState() {
    if (this.isAiGame) return null;
    const g = this.resumeGuard;
    return {
      resumesUsed: { 1: this.resumesUsed[BLACK], 2: this.resumesUsed[WHITE] },
      guard: g ? { color: g.color, movesLen: g.movesLen, scoring: serializeScoring(g.scoring) } : null,
    };
  }

  // 从 games.state 恢复（坏数据忽略：最多是少了保护，不影响恢复对局）
  _restoreState(st) {
    if (this.isAiGame || !st || typeof st !== 'object') return;
    const used = st.resumesUsed;
    if (used && typeof used === 'object') {
      for (const c of [BLACK, WHITE]) if (isCount(used[c])) this.resumesUsed[c] = used[c];
    }
    const g = st.guard;
    if (!g || typeof g !== 'object' || this.state.status !== 'playing') return;
    if (g.color !== BLACK && g.color !== WHITE) return;
    const len = g.movesLen;
    // 保护点必须是这局棋里某次"双方 pass"之后
    if (!Number.isSafeInteger(len) || len < 2 || len > this.moves.length) return;
    if (this.moves[len - 1] !== PASS || this.moves[len - 2] !== PASS) return;
    const scoring = deserializeScoring(g.scoring);
    if (scoring) this.resumeGuard = { color: g.color, movesLen: len, scoring };
  }

  // games.finish 的参数
  finishFields() {
    const r = this.result;
    return {
      status: 'ended',
      moves: this.moves.slice(),
      dead: r && r.reason === 'score' && this.scoring ? this.scoring.dead.slice() : null,
      winner: r.winner,
      reason: r.reason,
      scoreBlack: r.black,
      scoreWhite: r.white,
      resultText: R.resultText(r),
      counted: this.counted,
      cause: this.endCause,
    };
  }

  // 从数据库记录恢复（重启后恢复未结束的对局，或为已结束的对局生成快照）
  static fromRow(raw, { settings, now }) {
    const row = normalizeRow(raw);
    const session = new GameSession({
      id: row.id,
      mode: row.mode,
      size: row.size,
      komi: row.komi,
      blackId: row.blackId,
      whiteId: row.whiteId,
      aiLevel: row.aiLevel,
      timeControl: row.mode === 'ai' ? null : row.timeControl,
      settings,
      now,
      createdAt: row.createdAt,
    });
    session.state = replayMoves(row.size, row.komi, row.moves);
    session.moves = row.moves.slice();
    if (session.timeControl) session.clock = new GameClock(session.timeControl, row.clocks);

    if (row.status === 'ended') {
      const result = {
        winner: row.winner === 1 || row.winner === 2 ? row.winner : 0,
        reason: row.reason || 'abort',
        black: row.scoreBlack,
        white: row.scoreWhite,
      };
      if (result.reason === 'score') {
        const s = S.scoreArea(session.state.board, session.komi, Array.isArray(row.dead) ? row.dead : []);
        session.scoring = {
          pending: false,
          source: 'manual',
          version: 1,
          dead: s.dead,
          owner: s.owner,
          black: s.black,
          white: s.white,
          winner: s.winner,
          accepted: { 1: true, 2: true },
          deadlineAt: null,
          judgeSeq: 0,
        };
      }
      G.finish(session.state, result);
      session.result = { ...result };
      session.counted = row.counted;
      session.endCause = row.cause;
      // 排位赛没计入的原因：按规则本该计入却没计入的，只能是同一对手的局数上限
      if (session.mode === 'ranked' && result.reason !== 'abort' && !row.counted) {
        session.uncounted = session._computeCounted() ? 'pair_limit' : 'short';
      }
      session.endedAt = row.endedAt ?? row.updatedAt ?? now;
      return session;
    }

    // 未结束：两次 pass 之后如果库里是 playing，说明已"继续对局"
    if (session.state.status === 'scoring' && row.status !== 'scoring') G.resume(session.state);
    session._restoreState(row.state);
    session.lastActivityAt = Number.isFinite(row.updatedAt) ? Math.min(row.updatedAt, now) : now;
    session.startedAt = now;
    session.turnStartedAt = now;
    if (session.state.status === 'playing') {
      if (session.clock) session.clock.start(session.state.toPlay, now); // 停机时间不计入
    } else {
      session._enterScoring(now); // 数子阶段重新请求死子建议
    }
    return session;
  }
}

module.exports = { GameSession, replayMoves, normalizeRow, ILLEGAL_MSG };
