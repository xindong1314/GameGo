'use strict';
const crypto = require('node:crypto');
const { GameSession, normalizeRow } = require('./session');
const { GameError } = require('./errors');
const { playerInfo, aiPlayerInfo, rankedStatsView, randomGameId } = require('./players');
const { board: B, coords: C } = require('./engine-ref');

// 对局管理器：持有进行中的对局（GameSession），负责
// - 定时器：读秒超时、首手超时、掉线弃局、数子自动确认、人机闲置作废（每局一个"最近到期"定时器）；
// - 持久化：每一手后 games.saveProgress，终局 games.finish + stats.applyRanked（同一事务）；
// - 推送：通过 hub 发给已订阅（game.sync 过）该局的玩家连接；
// - AI：轮到 AI 时调用 ai.chooseMove，死子判断调用 ai.judgeDead，带超时与过期结果保护；
// - 启动时从 listUnfinished() 恢复对局。
//
// hub 接口：{ send(userId, msg), sendGame(userId, gameId, msg), isOnline(userId) }

const { opponent } = B;
const PASS = C.PASS;
const MAX_TIMER_MS = 2 ** 31 - 1;
const ENDED_KEEP_MS = 10 * 60 * 1000; // 终局后在内存里保留一会儿，方便断线重连的客户端 game.sync
// 终局写库失败后的重试间隔（最后一个间隔一直重复，直到写成功）
const PERSIST_RETRY_MS = [1000, 5000, 15000, 60000];
// 死子判断的尝试次数（第一次失败或超时后重试一次，仍失败才改为手动数子）
const JUDGE_ATTEMPTS = 2;
const DAY_MS = 86400000;

class GameManager {
  constructor({ repos, ai, settings, logger, now = Date.now, timers, hub, randomInt = crypto.randomInt }) {
    if (!repos || !repos.games || !repos.users || !repos.stats) throw new TypeError('GameManager: 需要 repos');
    if (!settings) throw new TypeError('GameManager: 需要 settings');
    if (!timers || typeof timers.setTimeout !== 'function') throw new TypeError('GameManager: 需要 timers');
    if (!hub || typeof hub.sendGame !== 'function') throw new TypeError('GameManager: 需要 hub');
    this.repos = repos;
    this.ai = ai;
    this.settings = settings;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.hub = hub;
    this.randomInt = randomInt;
    this.sessions = new Map(); // 进行中的对局 id → GameSession
    this.userGames = new Map(); // userId → Set<gameId>（进行中）
    this.endedCache = new Map(); // 刚结束的对局 id → { session, entry }
    this.deadlineTimers = new Map(); // gameId → 定时器条目
    this.aiFailures = new Map(); // gameId → { token, count }
    this.aiInflight = new Map(); // userId → 在途的 AI 落子请求数（含已作废但 AI 还在算的）
    this.aiInflightTotal = 0;
    this.aiWaiting = new Map(); // gameId → token：等 AI 名额的对局（按先来后到）
    this.unsavedEnds = new Map(); // gameId → { session, counted, entry }：终局写库失败、等待重试
    this.judgeJobs = new Map(); // gameId → { running, queued }：死子判断任务（每局最多一个在途，见 _requestJudge）
    this.pending = new Set(); // 所有未触发的定时器条目（关闭时统一清理）
    this.closed = false;
  }

  // ---------- 查询 ----------

  activeGamesOf(userId) {
    const ids = this.userGames.get(userId);
    if (!ids) return [];
    const out = [];
    for (const id of ids) {
      const s = this.sessions.get(id);
      if (s && !s.ended) out.push({ id: s.id, mode: s.mode });
    }
    return out;
  }

  // 进行中的真人对局（排位/好友），没有返回 null
  humanGameOf(userId) {
    const ids = this.userGames.get(userId);
    if (!ids) return null;
    for (const id of ids) {
      const s = this.sessions.get(id);
      if (s && !s.ended && !s.isAiGame) return s;
    }
    return null;
  }

  aiGamesOf(userId) {
    const ids = this.userGames.get(userId);
    if (!ids) return [];
    return [...ids].map((id) => this.sessions.get(id)).filter((s) => s && !s.ended && s.isAiGame);
  }

  getSession(gameId) {
    return this.sessions.get(gameId) || null;
  }

  // 刚结束、还在内存里的对局（包括终局结果还没写进数据库的）
  _endedSession(gameId) {
    const unsaved = this.unsavedEnds.get(gameId);
    if (unsaved) return unsaved.session;
    const cached = this.endedCache.get(gameId);
    return cached ? cached.session : null;
  }

  // ---------- 建局 ----------

  createHumanGame({ mode, size, blackId, whiteId }) {
    if (mode !== 'ranked' && mode !== 'friend') throw new TypeError(`createHumanGame: 模式不对 ${mode}`);
    const tc = this.settings.timeControls[size];
    if (!tc) throw new GameError('bad_request', `不支持 ${size} 路`);
    const now = this.now();
    const session = new GameSession({
      id: this._newGameId(),
      mode,
      size,
      komi: this.settings.komi,
      blackId,
      whiteId,
      timeControl: tc,
      settings: this.settings,
      now,
    });
    for (const c of [1, 2]) session.setOnline(c, this.hub.isOnline(session.players[c]), now);
    session.expectArrival(now); // 开局时不在线的一方（如切到后台的好友房房主）到场前不走钟、不判弃局
    this.repos.games.insert(session.insertRow(now));
    this._register(session);
    this._arm(session);
    this.logger.info(`对局 ${session.id} 开始：${mode} ${size} 路，黑 ${blackId} 白 ${whiteId}`);
    return session;
  }

  startAiGame(userId, { size, level, color }) {
    if (!this._aiAvailable()) throw new GameError('ai_unavailable', 'AI 暂时不可用');
    if (!this.settings.timeControls[size]) throw new GameError('bad_request', `不支持 ${size} 路`);
    if (!this._aiLevels().some((l) => l && l.id === level)) throw new GameError('bad_request', '没有这个难度');
    const now = this.now();
    // 同一玩家只保留一局人机对局：旧的作废；玩家还没下过子的直接删除，不留记录
    for (const old of this.aiGamesOf(userId)) {
      const played = old.hasHumanMove();
      old.abort(now, 'replaced');
      if (played) this._end(old, now);
      else this._discard(old);
    }
    const humanColor = color === 'black' ? 1 : color === 'white' ? 2 : this.randomInt(2) + 1;
    const session = new GameSession({
      id: this._newGameId(),
      mode: 'ai',
      size,
      komi: this.settings.komi,
      blackId: humanColor === 1 ? userId : null,
      whiteId: humanColor === 2 ? userId : null,
      aiLevel: level,
      timeControl: null,
      settings: this.settings,
      now,
    });
    session.setOnline(humanColor, this.hub.isOnline(userId), now);
    this.repos.games.insert(session.insertRow(now));
    this._register(session);
    this._arm(session);
    this.logger.info(`人机对局 ${session.id} 开始：${size} 路，玩家 ${userId} 执${humanColor === 1 ? '黑' : '白'}，难度 ${level}`);
    this._maybeAi(session);
    return session;
  }

  _newGameId() {
    for (let i = 0; i < 10; i++) {
      const id = randomGameId(this.randomInt);
      if (this.sessions.has(id) || this.endedCache.has(id)) continue;
      if (!this.repos.games.findById(id)) return id;
    }
    throw new Error('无法生成对局 id');
  }

  _register(session) {
    this.sessions.set(session.id, session);
    for (const uid of session.userIds()) {
      let set = this.userGames.get(uid);
      if (!set) {
        set = new Set();
        this.userGames.set(uid, set);
      }
      set.add(session.id);
    }
  }

  _unregister(session) {
    this._disarm(session.id);
    this.sessions.delete(session.id);
    this.aiFailures.delete(session.id);
    this.aiWaiting.delete(session.id);
    for (const uid of session.userIds()) {
      const set = this.userGames.get(uid);
      if (!set) continue;
      set.delete(session.id);
      if (!set.size) this.userGames.delete(uid);
    }
  }

  // ---------- 客户端请求 ----------

  // 完整快照（进行中、刚结束或库里已结束的对局都可以）
  sync(userId, gameId) {
    const now = this.now();
    const active = this.sessions.get(gameId);
    if (active) {
      const color = active.colorOf(userId);
      if (!color) throw new GameError('not_player', '你不是这局棋的对局者');
      this._runDue(active, now);
      return active.snapshot(color, now, this._playersOf(active));
    }
    const cached = this._endedSession(gameId);
    if (cached) {
      const color = cached.colorOf(userId);
      if (!color) throw new GameError('not_player', '你不是这局棋的对局者');
      return cached.snapshot(color, now, this._playersOf(cached));
    }
    const row = this.repos.games.findById(gameId);
    if (!row) throw new GameError('not_found', '对局不存在');
    const session = GameSession.fromRow(row, { settings: this.settings, now });
    const color = session.colorOf(userId);
    if (!color) throw new GameError('not_player', '你不是这局棋的对局者');
    return session.snapshot(color, now, this._playersOf(session));
  }

  move(userId, gameId, n, idx) {
    this._act(userId, gameId, (s, color, now) => {
      const info = s.play(color, n, idx, now);
      s.touch(now);
      this._afterPlay(s, info, now);
    });
  }

  pass(userId, gameId, n) {
    this._act(userId, gameId, (s, color, now) => {
      const info = s.pass(color, n, now);
      s.touch(now);
      this._afterPlay(s, info, now);
    });
  }

  resign(userId, gameId) {
    this._act(userId, gameId, (s, color, now) => {
      s.touch(now);
      s.resign(color, now);
      this._end(s, now);
    });
  }

  undo(userId, gameId) {
    this._act(userId, gameId, (s, color, now) => {
      const wasThinking = s.aiThinking;
      const r = s.undo(color, now);
      s.touch(now);
      this._save(s, now);
      this._push(s, { t: 'game.undo', gameId: s.id, moves: r.moves });
      if (wasThinking) this._push(s, { t: 'game.ai', gameId: s.id, thinking: false });
      this._arm(s);
    });
  }

  // version 可选：客户端点选时看到的数子版本，不一致 → stale
  toggleDead(userId, gameId, idx, version) {
    this._act(userId, gameId, (s, color, now) => {
      const r = s.toggleDead(color, idx, now, version);
      if (r.changed) {
        this._pushScoring(s, now);
        this._arm(s); // 自动确认时限可能顺延了
      }
    });
  }

  acceptScore(userId, gameId, version) {
    this._act(userId, gameId, (s, color, now) => {
      s.touch(now);
      const r = s.accept(color, version, now);
      this._pushScoring(s, now);
      if (r.done) {
        s.finishByScore(now);
        this._end(s, now);
      }
    });
  }

  resumeScore(userId, gameId) {
    this._act(userId, gameId, (s, color, now) => {
      s.touch(now);
      const r = s.resume(color, now);
      this._save(s, now);
      this._push(s, { t: 'game.resumed', gameId: s.id, toPlay: r.toPlay, clocks: s.clocksView(now) });
      this._maybeAi(s);
      this._arm(s);
    });
  }

  // 找到进行中的对局并确认身份；先处理已到期的事件（超时等），再执行动作
  _act(userId, gameId, fn) {
    const session = this.sessions.get(gameId);
    if (!session) this._throwInactive(userId, gameId);
    const color = session.colorOf(userId);
    if (!color) throw new GameError('not_player', '你不是这局棋的对局者');
    const now = this.now();
    if (this._runDue(session, now)) throw new GameError('wrong_phase', '对局已结束');
    fn(session, color, now);
  }

  // 对局不在内存里：区分"不存在""不是你的对局""已结束"
  _throwInactive(userId, gameId) {
    const cached = this._endedSession(gameId);
    if (cached) {
      if (!cached.colorOf(userId)) throw new GameError('not_player', '你不是这局棋的对局者');
      throw new GameError('wrong_phase', '对局已结束');
    }
    const raw = this.repos.games.findById(gameId);
    if (!raw) throw new GameError('not_found', '对局不存在');
    const row = normalizeRow(raw);
    if (row.blackId !== userId && row.whiteId !== userId) throw new GameError('not_player', '你不是这局棋的对局者');
    throw new GameError('wrong_phase', '对局已结束');
  }

  // ---------- 在线状态 ----------

  userOnline(userId) {
    this._setPresence(userId, true);
  }

  userOffline(userId) {
    this._setPresence(userId, false);
  }

  _setPresence(userId, online) {
    const ids = this.userGames.get(userId);
    if (!ids) return;
    const now = this.now();
    for (const id of [...ids]) {
      const s = this.sessions.get(id);
      if (!s) continue;
      const color = s.colorOf(userId);
      if (!s.setOnline(color, online, now)) continue;
      const opp = s.players[opponent(color)];
      if (opp !== null && opp !== undefined) {
        // 附上读秒：到场的一方上线时才开始走他的钟（见 GameSession._arrive），对手据此更新显示（FS-9）
        const msg = { t: 'game.presence', gameId: s.id, color, online };
        if (s.clock) msg.clocks = s.clocksView(now);
        this.hub.sendGame(opp, s.id, msg);
      }
      this._arm(s);
    }
  }

  // ---------- 内部：落子之后 ----------

  _afterPlay(session, info, now, extra) {
    this._save(session, now);
    this._push(session, {
      t: 'game.move',
      gameId: session.id,
      n: info.n,
      idx: info.idx,
      color: info.color,
      captured: info.captured,
      clocks: session.clocksView(now),
    });
    if (extra) for (const m of extra) this._push(session, m);
    if (info.scoring) this._beginScoring(session, now);
    else this._maybeAi(session);
    this._arm(session);
  }

  _save(session, now) {
    try {
      this.repos.games.saveProgress(session.id, session.progress(), now);
    } catch (err) {
      this.logger.error(`对局 ${session.id} 保存进度失败`, err);
    }
  }

  _push(session, msg) {
    for (const uid of session.userIds()) this.hub.sendGame(uid, session.id, msg);
  }

  _pushScoring(session, now) {
    this._push(session, { t: 'game.scoring', gameId: session.id, scoring: session.scoringView(now) });
  }

  // ---------- 数子阶段 ----------

  // 已进入 scoring（pending）：推送后请求死子建议；失败或 AI 不可用时为 manual、无死子
  _beginScoring(session, now) {
    this._pushScoring(session, now);
    const seq = session.judgeToken;
    const gameId = session.id;
    // 局面和上次 KataGo 判断时一样（继续对局后没落子又双方 pass、人机数子阶段悔棋后再 pass）：直接复用
    const cached = session.cachedJudge();
    if (cached) {
      this._onJudge(gameId, seq, cached);
      return;
    }
    if (!this._aiAvailable()) {
      this._onJudge(gameId, seq, null);
      return;
    }
    this._requestJudge(session);
  }

  // 死子判断任务：每局同时最多一个在途的请求（FS-8）——
  // - 同一局面已经在判断：等它的结果（人机数子阶段悔棋后又 pass 回到同一局面，不会再请求一次）；
  // - 另一个局面在判断：排在它后面（只保留最新的局面），不会同时占用 KataGo；
  // - 结果不论是否已过期都按请求时的局面记进 judgeCache，同一局面再次数子直接复用；
  // - 失败或超时重试一次，仍失败才改为手动数子（FS-1）。
  _requestJudge(session) {
    const gameId = session.id;
    const req = { key: session.boardKey(), size: session.size, komi: session.komi, moves: session.moves.slice() };
    const job = this.judgeJobs.get(gameId);
    if (job) {
      job.queued = job.running.key === req.key ? null : req;
      return;
    }
    const fresh = { running: req, queued: null };
    this.judgeJobs.set(gameId, fresh);
    this._runJudge(gameId, fresh);
  }

  _runJudge(gameId, job) {
    const req = job.running;
    this._judgeWithRetry(gameId, req).then((dead) =>
      this._safe(() => {
        if (this.closed) return;
        this._judgeArrived(gameId, req.key, dead);
        const next = job.queued;
        job.queued = null;
        const s = this.sessions.get(gameId);
        if (next && s && this._judgeWanted(s, next.key)) {
          const cached = s.cachedJudge();
          if (!cached) {
            job.running = next;
            this._runJudge(gameId, job);
            return;
          }
          this._onJudge(gameId, s.judgeToken, cached);
        }
        if (this.judgeJobs.get(gameId) === job) this.judgeJobs.delete(gameId);
      }),
    );
  }

  // 该局还在等这个局面的死子判断
  _judgeWanted(session, key) {
    return Boolean(session) && !session.ended && session.judgeToken !== null && session.boardKey() === key;
  }

  // 返回 Promise<dead[] | null>（null：两次都失败），不会 reject
  async _judgeWithRetry(gameId, req) {
    const payload = { size: req.size, komi: req.komi, moves: req.moves };
    for (let attempt = 1; ; attempt++) {
      let raw;
      try {
        raw = Promise.resolve(this.ai.judgeDead(payload));
      } catch (err) {
        raw = Promise.reject(err);
      }
      let settled = false;
      // 超时之后才到的结果：照样记进缓存，局面还在等它就直接用上
      raw.then(
        (res) => {
          if (settled && !this.closed && res && Array.isArray(res.dead)) this._safe(() => this._judgeArrived(gameId, req.key, res.dead));
        },
        () => {},
      );
      try {
        const res = await this._withTimeout(() => raw, this.settings.judgeTimeoutMs, 'judgeDead');
        if (res && Array.isArray(res.dead)) return res.dead;
        this.logger.warn(`对局 ${gameId} 死子判断返回格式不对（第 ${attempt} 次）`);
      } catch (err) {
        this.logger.warn(`对局 ${gameId} 死子判断失败（第 ${attempt} 次）：${err && err.message}`);
      } finally {
        settled = true;
      }
      if (attempt >= JUDGE_ATTEMPTS || this.closed || !this._aiAvailable() || !this._judgeWanted(this.sessions.get(gameId), req.key)) {
        if (attempt >= JUDGE_ATTEMPTS) this.logger.warn(`对局 ${gameId} 死子判断重试后仍失败，改为手动数子`);
        return null;
      }
    }
  }

  // 某局面的死子判断到了（dead 为 null 表示失败）：记进缓存；该局正在等这个局面的判断就用上
  _judgeArrived(gameId, key, dead) {
    const s = this.sessions.get(gameId);
    if (!s) return;
    if (Array.isArray(dead)) s.judgeCache = { key, dead: dead.filter((i) => Number.isInteger(i)) };
    if (this._judgeWanted(s, key)) this._onJudge(gameId, s.judgeToken, Array.isArray(dead) ? dead : null);
  }

  _onJudge(gameId, seq, dead) {
    if (this.closed) return;
    const s = this.sessions.get(gameId);
    if (!s) return;
    const now = this.now();
    if (!s.applyJudge(seq, dead, now)) {
      this.logger.debug(`对局 ${gameId} 丢弃过期的死子判断`);
      return;
    }
    this._pushScoring(s, now);
    this._arm(s);
  }

  // ---------- AI ----------

  _aiAvailable() {
    try {
      return Boolean(this.ai && this.ai.available());
    } catch (err) {
      this.logger.error('ai.available() 出错', err);
      return false;
    }
  }

  _aiLevels() {
    try {
      const levels = this.ai && this.ai.levels();
      return Array.isArray(levels) ? levels : [];
    } catch (err) {
      this.logger.error('ai.levels() 出错', err);
      return [];
    }
  }

  // 轮到 AI 且没在思考 → 请求落子（名额不够时排队，见 _dispatchAi）
  _maybeAi(session) {
    if (this.closed || !session.isAiGame || session.status !== 'playing') return;
    if (session.toPlay !== session.aiColor || session.aiThinking) return;
    session.aiThinking = true;
    this._push(session, { t: 'game.ai', gameId: session.id, thinking: true });
    this._dispatchAi(session, session.version);
  }

  _aiOwner(session) {
    return session.players[session.humanColor];
  }

  // AI 请求名额：每个玩家最多 aiMaxPerUser 个、全服最多 aiMaxInflight 个在途请求。
  // 被悔棋、认输、新开一局作废的请求 AI 还会算完，名额在它真正结束（或超时）时才释放，
  // 所以反复悔棋 / 反复开局不能让 KataGo 的队列无限增长。
  _aiSlotFree(userId) {
    return (this.aiInflight.get(userId) || 0) < this.settings.aiMaxPerUser && this.aiInflightTotal < this.settings.aiMaxInflight;
  }

  _dispatchAi(session, token) {
    const userId = this._aiOwner(session);
    if (!this._aiSlotFree(userId)) {
      this.aiWaiting.delete(session.id); // 重新排到队尾
      this.aiWaiting.set(session.id, token);
      return;
    }
    const gameId = session.id;
    const req = {
      size: session.size,
      komi: session.komi,
      moves: session.moves.slice(),
      color: session.aiColor,
      level: session.aiLevel,
      humanJustPassed: session.humanJustPassed(),
    };
    this.aiInflight.set(userId, (this.aiInflight.get(userId) || 0) + 1);
    this.aiInflightTotal += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const n = (this.aiInflight.get(userId) || 1) - 1;
      if (n > 0) this.aiInflight.set(userId, n);
      else this.aiInflight.delete(userId);
      this.aiInflightTotal = Math.max(0, this.aiInflightTotal - 1);
      this._safe(() => this._drainAiWaiting());
    };
    let raw;
    try {
      raw = Promise.resolve(this.ai.chooseMove(req));
    } catch (err) {
      raw = Promise.reject(err);
    }
    // AI 真正结束时释放名额；AI 迟迟不结束（超过 aiMoveTimeoutMs）也释放，避免名额泄漏
    raw.then(release, release);
    this._withTimeout(() => raw, this.settings.aiMoveTimeoutMs, 'chooseMove').then(
      (res) => this._safe(() => this._onAiMove(gameId, token, res)),
      (err) =>
        this._safe(() => {
          release();
          this._onAiError(gameId, token, err);
        }),
    );
  }

  // 有名额空出来：按排队顺序派发仍然有效的请求
  _drainAiWaiting() {
    if (this.closed) return;
    for (const [gameId, token] of [...this.aiWaiting]) {
      const s = this.sessions.get(gameId);
      if (!s || s.ended || s.version !== token || !s.aiThinking) {
        this.aiWaiting.delete(gameId); // 已作废（悔棋、认输、对局结束）
        continue;
      }
      if (!this._aiSlotFree(this._aiOwner(s))) continue;
      this.aiWaiting.delete(gameId);
      this._dispatchAi(s, token);
    }
  }

  // 结果回来时局面已变（悔棋/认输/作废）则丢弃
  _isCurrentAiRequest(s, token) {
    return !this.closed && s && !s.ended && s.version === token && s.aiThinking;
  }

  _onAiMove(gameId, token, res) {
    const s = this.sessions.get(gameId);
    if (!this._isCurrentAiRequest(s, token)) {
      this.logger.debug(`对局 ${gameId} 丢弃过期的 AI 着手`);
      return;
    }
    if (!res || typeof res !== 'object') {
      this._onAiError(gameId, token, new Error('AI 返回格式不对'));
      return;
    }
    const now = this.now();
    if (this._runDue(s, now)) return;
    if (res.resign === true) {
      s.aiThinking = false;
      this.aiFailures.delete(gameId);
      this._push(s, { t: 'game.ai', gameId, thinking: false });
      s.resign(s.aiColor, now);
      this._end(s, now);
      return;
    }
    const move = res.move;
    let info;
    try {
      if (move === PASS) info = s.pass(s.aiColor, s.moves.length + 1, now);
      else if (Number.isInteger(move)) info = s.play(s.aiColor, s.moves.length + 1, move, now);
      else throw new Error(`AI 返回的着手不合法：${JSON.stringify(move)}`);
    } catch (err) {
      this._onAiError(gameId, token, err);
      return;
    }
    s.aiThinking = false;
    this.aiFailures.delete(gameId);
    this._afterPlay(s, info, now, [{ t: 'game.ai', gameId, thinking: false }]);
  }

  // AI 落子失败：按 aiRetryDelaysMs 重试，全部失败则对局作废
  _onAiError(gameId, token, err) {
    const s = this.sessions.get(gameId);
    if (!this._isCurrentAiRequest(s, token)) {
      this.logger.debug(`对局 ${gameId} 忽略过期的 AI 错误`);
      return;
    }
    s.aiThinking = false;
    const prev = this.aiFailures.get(gameId);
    const count = (prev && prev.token === token ? prev.count : 0) + 1;
    this.aiFailures.set(gameId, { token, count });
    this._push(s, { t: 'game.ai', gameId, thinking: false });
    const delays = this.settings.aiRetryDelaysMs;
    if (count > delays.length) {
      this.logger.error(`对局 ${gameId} AI 连续 ${count} 次落子失败，对局作废`, err);
      const now = this.now();
      s.abort(now, 'ai_error');
      this._end(s, now);
      return;
    }
    const delay = delays[count - 1];
    this.logger.warn(`对局 ${gameId} AI 落子失败（第 ${count} 次），${delay}ms 后重试：${err && err.message}`);
    this._later(() => {
      const cur = this.sessions.get(gameId);
      if (cur && cur.version === token) this._maybeAi(cur);
    }, delay);
  }

  // ---------- 终局 ----------

  // 会话已处于 ended：持久化、更新排位统计（同一事务）、推送 game.end、清理。
  // 写库失败时：推送里的 counted 为 false、pending 为 true、不附统计（还没真正计入），之后按 PERSIST_RETRY_MS
  // 重试直到写成功；成功后内存里的 counted 恢复，并再推送一次 game.end（pending 为 false，排位附统计）；关机时再试一次。
  _end(session, now) {
    const s = session;
    this._applyPairLimit(s, now);
    const intended = s.counted;
    const saved = this._persistEnd(s, intended, now);
    if (!saved) {
      s.counted = false;
      s.savePending = true;
      this._retryPersist(s, intended, 0);
    }
    this._unregister(s);
    this._keepEnded(s);
    const msg = this._pushEnd(s);
    const cause = s.endCause ? `，${s.endCause}` : '';
    this.logger.info(`对局 ${s.id} 结束：${msg.result.text}（${s.result.reason}${cause}${intended ? '，计入排行' : ''}）`);
  }

  // 推送 game.end（排位赛、结果已写进数据库时附双方最新统计）。返回推送的消息
  _pushEnd(s) {
    let stats = null;
    if (s.mode === 'ranked' && !s.savePending) {
      try {
        stats = {
          1: rankedStatsView(this.repos.stats.get(s.players[1])),
          2: rankedStatsView(this.repos.stats.get(s.players[2])),
        };
      } catch (err) {
        this.logger.error(`对局 ${s.id} 读取排位统计失败`, err);
      }
    }
    const msg = { t: 'game.end', gameId: s.id, result: s.resultView() };
    if (stats) msg.stats = stats;
    this._push(s, msg);
    return msg;
  }

  // 同一对手 24 小时内计入排行的局数有上限（rankedPairDailyMax，0 = 不限）：防止两个账号反复匹配互刷连胜（COMP-5）
  _applyPairLimit(s, now) {
    const max = this.settings.rankedPairDailyMax;
    if (!s.counted || s.mode !== 'ranked' || !max || typeof this.repos.games.countCountedBetween !== 'function') return;
    let n;
    try {
      n = this.repos.games.countCountedBetween(s.players[1], s.players[2], now - DAY_MS);
    } catch (err) {
      this.logger.error(`对局 ${s.id} 查询同一对手的计入局数失败，按计入处理`, err);
      return;
    }
    if (n >= max) {
      s.counted = false;
      s.uncounted = 'pair_limit';
      this.logger.info(`对局 ${s.id}：这两位玩家 24 小时内已计入 ${n} 局，本局不计入排行`);
    }
  }

  // 终局结果与排位统计写进同一个事务。成功返回 true
  _persistEnd(s, counted, now) {
    const fields = s.finishFields();
    try {
      this.repos.transaction(() => {
        this.repos.games.finish(s.id, fields, now);
        if (counted) {
          const r = s.result;
          const draw = r.winner === 0;
          this.repos.stats.applyRanked(
            {
              gameId: s.id,
              winnerId: draw ? null : s.players[r.winner],
              loserId: draw ? null : s.players[opponent(r.winner)],
              draw,
              userIds: [s.players[1], s.players[2]],
            },
            now,
          );
        }
      });
      return true;
    } catch (err) {
      this.logger.error(`对局 ${s.id} 终局保存失败，稍后重试`, err);
      return false;
    }
  }

  _retryPersist(s, counted, attempt) {
    const prev = this.unsavedEnds.get(s.id);
    if (prev) this._cancel(prev.entry);
    const delay = PERSIST_RETRY_MS[Math.min(attempt, PERSIST_RETRY_MS.length - 1)];
    const entry = this._later(() => {
      if (this._persistEnd(s, counted, s.endedAt ?? this.now())) {
        this.unsavedEnds.delete(s.id);
        s.counted = counted;
        s.savePending = false;
        this.logger.info(`对局 ${s.id} 的终局结果已补写入数据库${counted ? '（已计入排行）' : ''}`);
        // 再推送一次终局：pending 为 false、counted 为实际值，排位赛附最新统计（FS-10）
        this._pushEnd(s);
      } else {
        this._retryPersist(s, counted, attempt + 1);
      }
    }, delay);
    this.unsavedEnds.set(s.id, { session: s, counted, entry });
  }

  // 玩家还没下过子的人机对局被新开的对局顶替：直接删除记录，不进终局缓存（不留大量空对局）
  _discard(session) {
    const s = session;
    try {
      this.repos.games.discard(s.id);
    } catch (err) {
      this.logger.error(`删除对局 ${s.id} 失败，改为按作废保存`, err);
      this._end(s, s.endedAt ?? this.now());
      return;
    }
    this._unregister(s);
    this._push(s, { t: 'game.end', gameId: s.id, result: s.resultView() });
  }

  _keepEnded(session) {
    const prev = this.endedCache.get(session.id);
    if (prev) {
      this._cancel(prev.entry);
      this.endedCache.delete(session.id);
    }
    // 有上限：超出时丢掉最早结束的（之后的 game.sync 从数据库读）
    while (this.endedCache.size >= this.settings.endedCacheMax) {
      const [oldId, old] = this.endedCache.entries().next().value;
      this._cancel(old.entry);
      this.endedCache.delete(oldId);
    }
    const entry = this._later(() => this.endedCache.delete(session.id), ENDED_KEEP_MS);
    this.endedCache.set(session.id, { session, entry });
  }

  // ---------- 定时 ----------

  _arm(session) {
    this._disarm(session.id);
    if (this.closed || session.ended || !this.sessions.has(session.id)) return;
    const at = session.nextDeadline();
    if (at === null) return;
    const entry = this._later(() => {
      this.deadlineTimers.delete(session.id);
      this._onDeadline(session.id);
    }, at - this.now());
    this.deadlineTimers.set(session.id, entry);
  }

  _disarm(gameId) {
    const entry = this.deadlineTimers.get(gameId);
    if (entry) {
      this._cancel(entry);
      this.deadlineTimers.delete(gameId);
    }
  }

  _onDeadline(gameId) {
    const s = this.sessions.get(gameId);
    if (!s || this.closed) return;
    if (!this._runDue(s, this.now())) this._arm(s); // 定时器提前触发或延时被截断：按当前时间重新安排
  }

  // 有到期事件就执行并终局，返回是否已终局
  _runDue(session, now) {
    const kind = session.dueAction(now);
    if (!kind) return false;
    this.logger.info(`对局 ${session.id} 到期事件：${kind}`);
    session.applyDue(kind, now);
    if (session.resumeUndone) {
      this.logger.info(`对局 ${session.id} 已同意数子结果的一方在继续对局后没有走下一手（掉线或读秒用完），撤销继续对局`);
    }
    // 按数子终局：先推送最终采用的死子（自动确认可能回退到双方认可的版本），再推送 game.end
    if (session.result && session.result.reason === 'score') this._pushScoring(session, now);
    this._end(session, now);
    return true;
  }

  _later(fn, ms) {
    const delay = Math.min(Math.max(0, Math.floor(Number(ms)) || 0), MAX_TIMER_MS);
    const entry = { handle: null };
    entry.handle = this.timers.setTimeout(() => {
      this.pending.delete(entry);
      this._safe(fn);
    }, delay);
    this.pending.add(entry);
    return entry;
  }

  _cancel(entry) {
    if (!entry) return;
    this.timers.clearTimeout(entry.handle);
    this.pending.delete(entry);
  }

  _withTimeout(factory, ms, label) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const entry = this._later(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`${label} 超时（${ms}ms）`));
      }, ms);
      let p;
      try {
        p = Promise.resolve(factory());
      } catch (err) {
        p = Promise.reject(err);
      }
      p.then(
        (v) => {
          if (settled) return;
          settled = true;
          this._cancel(entry);
          resolve(v);
        },
        (e) => {
          if (settled) return;
          settled = true;
          this._cancel(entry);
          reject(e);
        },
      );
    });
  }

  _safe(fn) {
    try {
      fn();
    } catch (err) {
      this.logger.error('对局管理器内部错误', err);
    }
  }

  // ---------- 玩家信息 ----------

  _playersOf(session) {
    const out = {};
    for (const c of [1, 2]) {
      if (c === session.aiColor) {
        out[c] = aiPlayerInfo(session.aiLevel, this._aiLevels());
        continue;
      }
      const id = session.players[c];
      let user = null;
      try {
        user = this.repos.users.findById(id);
      } catch (err) {
        this.logger.error(`读取用户 ${id} 失败`, err);
      }
      out[c] = playerInfo(user, this.settings.publicBaseUrl, id);
    }
    return out;
  }

  // ---------- 启动恢复 ----------

  restore() {
    const rows = this.repos.games.listUnfinished();
    const now = this.now();
    let restored = 0;
    for (const row of rows) {
      let s;
      try {
        // 仓储读不出来的行（JSON 损坏等）以 { id, broken: true, error } 返回
        if (row && row.broken) throw new Error(row.error || '对局记录损坏');
        s = GameSession.fromRow(row, { settings: this.settings, now });
      } catch (err) {
        this.logger.error(`对局 ${row && row.id} 无法恢复，按作废处理`, err);
        this._voidBroken(row, now);
        continue;
      }
      if (s.ended || this.sessions.has(s.id)) continue;
      for (const c of [1, 2]) {
        const uid = s.players[c];
        if (uid !== null && uid !== undefined) s.setOnline(c, this.hub.isOnline(uid), now);
      }
      // 停机不是玩家的错：还没重新连上的玩家到场前不走钟、不判弃局，超过 arrivalGraceMs 未回来则作废
      s.expectArrival(now);
      this._register(s);
      restored += 1;
      if (s.status === 'scoring') this._beginScoring(s, now);
      else this._maybeAi(s);
      this._arm(s);
    }
    if (rows.length) this.logger.info(`恢复了 ${restored}/${rows.length} 局未结束的对局`);
    return restored;
  }

  // 记录损坏（无法重放）的对局直接作废，避免每次启动都失败
  _voidBroken(row, now) {
    const id = row && row.id;
    if (typeof id !== 'string') return;
    try {
      this.repos.games.finish(
        id,
        {
          status: 'ended',
          winner: 0,
          reason: 'abort',
          dead: null,
          scoreBlack: null,
          scoreWhite: null,
          resultText: 'Void',
          counted: false,
          cause: 'broken',
        },
        now,
      );
    } catch (err) {
      this.logger.error(`对局 ${id} 作废失败`, err);
    }
  }

  shutdown() {
    // 终局结果还没写进数据库的：关机前再试一次，否则重启后会被当成进行中的对局恢复
    for (const [id, u] of [...this.unsavedEnds]) {
      if (this._persistEnd(u.session, u.counted, u.session.endedAt ?? this.now())) this.unsavedEnds.delete(id);
      else this.logger.error(`对局 ${id} 的终局结果在关机前仍未能写入数据库`);
    }
    this.closed = true;
    for (const entry of this.pending) this.timers.clearTimeout(entry.handle);
    this.pending.clear();
    this.deadlineTimers.clear();
    this.endedCache.clear();
    this.unsavedEnds.clear();
    this.aiWaiting.clear();
    this.judgeJobs.clear();
  }
}

module.exports = { GameManager, ENDED_KEEP_MS };
