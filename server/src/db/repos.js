'use strict';
const crypto = require('node:crypto');
const { resultText: engineResultText } = require('../../../miniprogram/utils/engine/record');
const { avatarUrl } = require('../util/public-user');

// 仓储层（设计文档 3.1）。所有方法同步执行（node:sqlite 是同步 API）。
// 对外的对象一律用驼峰字段、Number 类型的 id 与时间戳；JSON 列读出时已解析。

const DAY_MS = 86400000;
const SESSION_TTL_MS = 30 * DAY_MS; // 令牌有效期 30 天
const SESSION_RENEW_BELOW_MS = 15 * DAY_MS; // 剩余不足 15 天时续到 30 天
const MAX_SESSIONS_PER_USER = 10; // 每个用户最多保留的令牌数（多出来的最旧的作废）
const TOKEN_RE = /^[0-9a-f]{64}$/;
const GAME_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const GAME_MODES = new Set(['ranked', 'friend', 'ai']);
const GAME_STATUSES = new Set(['playing', 'scoring', 'ended']);
const END_REASONS = new Set(['score', 'resign', 'timeout', 'abort']);
// 终局细分原因（games.cause）：小写字母与下划线
const CAUSE_RE = /^[a-z_]{1,32}$/;
const LEADERBOARD_TYPES = Object.freeze(['streak', 'maxStreak', 'winrate']);

const MAX_LEADERBOARD_LIMIT = 200;
const MAX_LIST_LIMIT = 100;

// ---------- 小工具 ----------

function numOrNull(v) {
  return v === null || v === undefined ? null : Number(v);
}

function ts(now, fn) {
  if (now === undefined) return Date.now();
  if (typeof now !== 'number' || !Number.isFinite(now)) throw new TypeError(`${fn}: now 必须是毫秒时间戳`);
  return Math.floor(now);
}

function assertUserId(id, fn, name = 'userId') {
  if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError(`${fn}: ${name} 必须是正整数，收到 ${String(id)}`);
}

function assertString(v, fn, name, { max = 1024, allowEmpty = true } = {}) {
  if (typeof v !== 'string') throw new TypeError(`${fn}: ${name} 必须是字符串`);
  if (!allowEmpty && v.length === 0) throw new TypeError(`${fn}: ${name} 不能为空`);
  if (v.length > max) throw new TypeError(`${fn}: ${name} 过长`);
}

function assertMoves(moves, fn) {
  if (!Array.isArray(moves) || !moves.every((m) => Number.isInteger(m) && m >= -1)) {
    throw new TypeError(`${fn}: moves 必须是整数数组（pass 为 -1）`);
  }
}

function assertIdxArray(arr, fn, name) {
  if (!Array.isArray(arr) || !arr.every((m) => Number.isInteger(m) && m >= 0)) {
    throw new TypeError(`${fn}: ${name} 必须是非负整数数组`);
  }
}

function jsonOrNull(v) {
  return v === null || v === undefined ? null : JSON.stringify(v);
}

// 同时接受驼峰与下划线写法（row 字段"同表"），驼峰优先
function pick(obj, camel, snake) {
  if (obj[camel] !== undefined) return obj[camel];
  return snake ? obj[snake] : undefined;
}

function clampLimit(limit, def, max) {
  if (limit === undefined || limit === null) return def;
  const n = Math.floor(Number(limit));
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, 1), max);
}

// ---------- 行映射 ----------

function toUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    openid: row.openid,
    nickname: row.nickname,
    avatar: row.avatar,
    createdAt: Number(row.created_at),
    lastLoginAt: Number(row.last_login_at),
  };
}

// lenient：损坏的 JSON 返回 fallback（查看棋谱、列表等只读场景，一条坏记录不能让整个接口失败）
function parseJson(text, field, id, fallback, lenient) {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text);
  } catch (err) {
    if (lenient) return fallback;
    throw new Error(`games.${field} 的 JSON 已损坏（对局 ${id}）：${err.message}`);
  }
}

function toGame(row, { lenient = false } = {}) {
  if (!row) return null;
  const json = (field, fallback) => parseJson(row[field], field, row.id, fallback, lenient);
  return {
    id: row.id,
    mode: row.mode,
    size: Number(row.size),
    komi: Number(row.komi),
    blackId: numOrNull(row.black_id),
    whiteId: numOrNull(row.white_id),
    aiLevel: row.ai_level === undefined ? null : row.ai_level,
    timeControl: json('time_control', null),
    status: row.status,
    moves: json('moves', []),
    clocks: json('clocks', null),
    dead: json('dead', null),
    winner: numOrNull(row.winner),
    reason: row.reason === undefined ? null : row.reason,
    scoreBlack: numOrNull(row.score_black),
    scoreWhite: numOrNull(row.score_white),
    resultText: row.result_text === undefined ? null : row.result_text,
    counted: Number(row.counted) !== 0,
    // 附加状态坏了不影响读取与恢复（只是少了继续对局次数/保护），一律按 null
    state: parseJson(row.state, 'state', row.id, null, true),
    cause: row.cause === undefined || row.cause === null ? null : row.cause,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    endedAt: numOrNull(row.ended_at),
  };
}

function emptyStats() {
  return {
    games: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    winrate: 0,
    curStreak: 0,
    maxStreak: 0,
    curStreakAt: null,
    maxStreakAt: null,
  };
}

function toStats(row) {
  if (!row) return emptyStats();
  const games = Number(row.games);
  const wins = Number(row.wins);
  return {
    games,
    wins,
    losses: Number(row.losses),
    draws: Number(row.draws),
    winrate: games > 0 ? wins / games : 0,
    curStreak: Number(row.cur_streak),
    maxStreak: Number(row.max_streak),
    curStreakAt: numOrNull(row.cur_streak_at),
    maxStreakAt: numOrNull(row.max_streak_at),
  };
}

// ---------- 仓储 ----------

// options.publicBaseUrl：排行榜条目附带 avatarUrl 时使用
// options.minGamesWinrate：胜率榜上榜所需局数（默认 10）；leaderboard/rankOf 也可逐次传 { minGames } 覆盖
function createRepos(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('createRepos: 需要 node:sqlite 的 DatabaseSync');
  const publicBaseUrl = options.publicBaseUrl || '';
  const defaultMinGames = options.minGamesWinrate === undefined ? 10 : options.minGamesWinrate;
  if (!Number.isSafeInteger(defaultMinGames) || defaultMinGames < 1) {
    throw new TypeError('createRepos: minGamesWinrate 必须是正整数');
  }

  // ----- 事务：最外层 BEGIN IMMEDIATE，嵌套时用 SAVEPOINT -----
  let depth = 0;

  function transaction(fn) {
    if (typeof fn !== 'function') throw new TypeError('transaction: 需要函数');
    const outer = depth === 0;
    const sp = `sp_${depth}`;
    db.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    depth += 1;
    try {
      const result = fn();
      if (result && typeof result.then === 'function') {
        // 同步事务无法跨越 await：回滚并报错；吞掉该 Promise 之后的拒绝，避免 unhandledRejection
        result.then(null, () => {});
        throw new TypeError('transaction(fn)：fn 必须是同步函数（不能返回 Promise）');
      }
      db.exec(outer ? 'COMMIT' : `RELEASE ${sp}`);
      return result;
    } catch (err) {
      try {
        if (outer) db.exec('ROLLBACK');
        else {
          db.exec(`ROLLBACK TO ${sp}`);
          db.exec(`RELEASE ${sp}`);
        }
      } catch {
        // 事务可能已被 SQLite 自动回滚，这里忽略二次错误，抛出原始错误
      }
      throw err;
    } finally {
      depth -= 1;
    }
  }

  // ----- 预编译语句 -----
  const st = {
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userByOpenid: db.prepare('SELECT * FROM users WHERE openid = ?'),
    userInsert: db.prepare(
      'INSERT INTO users (openid, nickname, avatar, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)',
    ),
    userTouch: db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?'),

    sessionInsert: db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
    sessionGet: db.prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?'),
    sessionExtend: db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?'),
    sessionDelete: db.prepare('DELETE FROM sessions WHERE token = ?'),
    sessionPurgeUser: db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?'),
    // 只保留该用户最新的若干个令牌
    sessionTrimUser: db.prepare(`
      DELETE FROM sessions WHERE user_id = :uid AND token NOT IN (
        SELECT token FROM sessions WHERE user_id = :uid ORDER BY created_at DESC, expires_at DESC LIMIT :keep)`),
    sessionPurgeExpired: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),

    gameInsert: db.prepare(`
      INSERT INTO games (id, mode, size, komi, black_id, white_id, ai_level, time_control, status, moves,
        clocks, dead, winner, reason, score_black, score_white, result_text, counted, created_at, updated_at, ended_at,
        state, cause)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    gameById: db.prepare('SELECT * FROM games WHERE id = ?'),
    // 执黑、执白两路各自按索引 (black_id|white_id, created_at) 倒序取前 N 条再合并。
    // 不用 OR：OR 会读出该用户的全部对局再排序，对局多了很慢。
    gameListByUser: db.prepare(`
      SELECT * FROM (
        SELECT * FROM (
          SELECT * FROM games WHERE black_id = :uid AND created_at < :before AND status = 'ended'
          ORDER BY created_at DESC, id DESC LIMIT :n)
        UNION ALL
        SELECT * FROM (
          SELECT * FROM games WHERE white_id = :uid AND created_at < :before AND status = 'ended'
          ORDER BY created_at DESC, id DESC LIMIT :n))
      ORDER BY created_at DESC, id DESC
      LIMIT :n`),
    gameUnfinished: db.prepare("SELECT * FROM games WHERE status != 'ended' ORDER BY created_at ASC, id ASC"),
    gameMarkCounted: db.prepare('UPDATE games SET counted = 1 WHERE id = ? AND counted = 0'),
    // 某人执黑、另一人执白、最近开始的已计入排位赛局数（走 games_black 索引）
    gameCountedPair: db.prepare(`
      SELECT COUNT(*) AS n FROM games
      WHERE black_id = ? AND created_at >= ? AND white_id = ? AND mode = 'ranked' AND counted = 1`),
    gameDiscard: db.prepare("DELETE FROM games WHERE id = ? AND status != 'ended'"),
    gameAiRecord: db.prepare(`
      SELECT COUNT(*) AS games, COALESCE(SUM(won), 0) AS wins FROM (
        SELECT CASE WHEN winner = 1 THEN 1 ELSE 0 END AS won FROM games
        WHERE black_id = :uid AND mode = 'ai' AND status = 'ended' AND reason != 'abort'
        UNION ALL
        SELECT CASE WHEN winner = 2 THEN 1 ELSE 0 END AS won FROM games
        WHERE white_id = :uid AND mode = 'ai' AND status = 'ended' AND reason != 'abort')`),

    statsGet: db.prepare('SELECT * FROM user_stats WHERE user_id = ?'),
    statsUpsert: db.prepare(`
      INSERT INTO user_stats (user_id, games, wins, losses, draws, cur_streak, max_streak, cur_streak_at, max_streak_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        games = excluded.games, wins = excluded.wins, losses = excluded.losses, draws = excluded.draws,
        cur_streak = excluded.cur_streak, max_streak = excluded.max_streak,
        cur_streak_at = excluded.cur_streak_at, max_streak_at = excluded.max_streak_at,
        updated_at = excluded.updated_at`),
  };

  // 排行榜（设计文档 3.3）。名次不并列；rankOf = 严格排在我前面的人数 + 1，与列表顺序一致。
  // 时间戳为 NULL 的异常数据按 0 处理，保证列表与 rankOf 的比较一致。
  const board = {
    streak: {
      list: db.prepare(`
        SELECT s.user_id, s.games, s.wins, s.cur_streak AS value, u.nickname, u.avatar
        FROM user_stats s JOIN users u ON u.id = s.user_id
        WHERE s.cur_streak > 0
        ORDER BY s.cur_streak DESC, COALESCE(s.cur_streak_at, 0) ASC, s.user_id ASC
        LIMIT ?`),
      ahead: db.prepare(`
        SELECT COUNT(*) AS n FROM user_stats
        WHERE cur_streak > 0 AND (
          cur_streak > :v OR (cur_streak = :v AND (
            COALESCE(cur_streak_at, 0) < :at OR (COALESCE(cur_streak_at, 0) = :at AND user_id < :uid))))`),
    },
    maxStreak: {
      list: db.prepare(`
        SELECT s.user_id, s.games, s.wins, s.max_streak AS value, u.nickname, u.avatar
        FROM user_stats s JOIN users u ON u.id = s.user_id
        WHERE s.max_streak > 0
        ORDER BY s.max_streak DESC, COALESCE(s.max_streak_at, 0) ASC, s.user_id ASC
        LIMIT ?`),
      ahead: db.prepare(`
        SELECT COUNT(*) AS n FROM user_stats
        WHERE max_streak > 0 AND (
          max_streak > :v OR (max_streak = :v AND (
            COALESCE(max_streak_at, 0) < :at OR (COALESCE(max_streak_at, 0) = :at AND user_id < :uid))))`),
    },
    winrate: {
      list: db.prepare(`
        SELECT s.user_id, s.games, s.wins, s.wins * 1.0 / s.games AS value, u.nickname, u.avatar
        FROM user_stats s JOIN users u ON u.id = s.user_id
        WHERE s.games >= ?
        ORDER BY s.wins * 1.0 / s.games DESC, s.games DESC, s.user_id ASC
        LIMIT ?`),
      // 胜率比较用交叉相乘（整数精确），与列表中浮点排序的结果一致
      ahead: db.prepare(`
        SELECT COUNT(*) AS n FROM user_stats
        WHERE games >= :min AND (
          wins * :g > :w * games OR (wins * :g = :w * games AND (
            games > :g OR (games = :g AND user_id < :uid))))`),
    },
  };

  const dynamicStmts = new Map();
  function dyn(sql) {
    let s = dynamicStmts.get(sql);
    if (!s) {
      s = db.prepare(sql);
      dynamicStmts.set(sql, s);
    }
    return s;
  }

  // ----- users -----

  const users = {
    findById(id) {
      if (!Number.isSafeInteger(id) || id <= 0) return null;
      return toUser(st.userById.get(id));
    },

    findByOpenid(openid) {
      if (typeof openid !== 'string' || !openid) return null;
      return toUser(st.userByOpenid.get(openid));
    },

    create({ openid, nickname = '', avatar = '' } = {}, now) {
      assertString(openid, 'users.create', 'openid', { max: 128, allowEmpty: false });
      assertString(nickname, 'users.create', 'nickname', { max: 64 });
      assertString(avatar, 'users.create', 'avatar', { max: 128 });
      const t = ts(now, 'users.create');
      const r = st.userInsert.run(openid, nickname, avatar, t, t);
      return users.findById(Number(r.lastInsertRowid));
    },

    // 只更新给出的字段；用户不存在返回 null
    updateProfile(id, fields = {}, now) {
      assertUserId(id, 'users.updateProfile', 'id');
      ts(now, 'users.updateProfile'); // users 表没有 updated_at 列，这里只校验参数
      const sets = [];
      const args = [];
      if (fields.nickname !== undefined) {
        assertString(fields.nickname, 'users.updateProfile', 'nickname', { max: 64 });
        sets.push('nickname = ?');
        args.push(fields.nickname);
      }
      if (fields.avatar !== undefined) {
        assertString(fields.avatar, 'users.updateProfile', 'avatar', { max: 128 });
        sets.push('avatar = ?');
        args.push(fields.avatar);
      }
      if (sets.length) dyn(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
      return users.findById(id);
    },

    touchLogin(id, now) {
      assertUserId(id, 'users.touchLogin', 'id');
      return Number(st.userTouch.run(ts(now, 'users.touchLogin'), id).changes) > 0;
    },
  };

  // ----- sessions -----

  const sessions = {
    create(userId, now) {
      assertUserId(userId, 'sessions.create');
      const t = ts(now, 'sessions.create');
      const token = crypto.randomBytes(32).toString('hex');
      transaction(() => {
        st.sessionPurgeUser.run(userId, t); // 顺手清理该用户已过期的令牌
        st.sessionInsert.run(token, userId, t, t + SESSION_TTL_MS);
        st.sessionTrimUser.run({ uid: userId, keep: MAX_SESSIONS_PER_USER }); // 只保留最新的若干个
      });
      return token;
    },

    // 删除所有已过期的令牌（定时清理），返回删除条数
    purgeExpired(now) {
      return Number(st.sessionPurgeExpired.run(ts(now, 'sessions.purgeExpired')).changes);
    },

    // 有效返回 userId；无效、过期返回 null。剩余不足 15 天时续到 30 天。
    resolve(token, now) {
      if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
      const t = ts(now, 'sessions.resolve');
      const row = st.sessionGet.get(token);
      if (!row) return null;
      const expiresAt = Number(row.expires_at);
      if (expiresAt <= t) {
        st.sessionDelete.run(token);
        return null;
      }
      if (expiresAt - t < SESSION_RENEW_BELOW_MS) st.sessionExtend.run(t + SESSION_TTL_MS, token);
      return Number(row.user_id);
    },

    revoke(token) {
      if (typeof token !== 'string' || !token) return false;
      return Number(st.sessionDelete.run(token).changes) > 0;
    },
  };

  // ----- games -----

  function validateTimeControl(tc, fn) {
    if (tc === null || tc === undefined) return;
    if (
      typeof tc !== 'object' ||
      !Number.isFinite(tc.mainMs) ||
      !Number.isInteger(tc.periods) ||
      !Number.isFinite(tc.periodMs)
    ) {
      throw new TypeError(`${fn}: timeControl 应为 { mainMs, periods, periodMs } 或 null`);
    }
  }

  const games = {
    // row 字段同表，驼峰（blackId）或下划线（black_id）均可；moves/clocks/dead/timeControl 传 JS 值。
    // 返回插入后的 GameRow。
    insert(row) {
      const fn = 'games.insert';
      if (!row || typeof row !== 'object') throw new TypeError(`${fn}: 需要对象`);
      const id = row.id;
      if (typeof id !== 'string' || !GAME_ID_RE.test(id)) throw new TypeError(`${fn}: id 不合法`);
      const mode = row.mode;
      if (!GAME_MODES.has(mode)) throw new TypeError(`${fn}: mode 必须是 ranked/friend/ai`);
      const size = row.size;
      if (!Number.isInteger(size) || size < 2 || size > 19) throw new TypeError(`${fn}: size 不合法`);
      const komi = row.komi;
      if (typeof komi !== 'number' || !Number.isFinite(komi)) throw new TypeError(`${fn}: komi 不合法`);

      const blackId = numOrNull(pick(row, 'blackId', 'black_id'));
      const whiteId = numOrNull(pick(row, 'whiteId', 'white_id'));
      const aiLevel = pick(row, 'aiLevel', 'ai_level') ?? null;
      for (const [name, v] of [['blackId', blackId], ['whiteId', whiteId]]) {
        if (v !== null) assertUserId(v, fn, name);
      }
      if (mode === 'ai') {
        if ((blackId === null) === (whiteId === null)) throw new TypeError(`${fn}: 人机对局必须恰好一方为 AI（id 为 null）`);
        if (typeof aiLevel !== 'string' || !aiLevel) throw new TypeError(`${fn}: 人机对局需要 aiLevel`);
      } else {
        if (blackId === null || whiteId === null) throw new TypeError(`${fn}: 真人对局需要 blackId 与 whiteId`);
        if (blackId === whiteId) throw new TypeError(`${fn}: 黑白不能是同一人`);
      }

      const timeControl = pick(row, 'timeControl', 'time_control') ?? null;
      validateTimeControl(timeControl, fn);
      const status = row.status === undefined ? 'playing' : row.status;
      if (!GAME_STATUSES.has(status)) throw new TypeError(`${fn}: status 不合法`);
      const moves = row.moves === undefined ? [] : row.moves;
      assertMoves(moves, fn);
      const dead = row.dead ?? null;
      if (dead !== null) assertIdxArray(dead, fn, 'dead');
      const winner = numOrNull(row.winner);
      if (winner !== null && ![0, 1, 2].includes(winner)) throw new TypeError(`${fn}: winner 必须是 0/1/2`);
      const reason = row.reason ?? null;
      if (reason !== null && !END_REASONS.has(reason)) throw new TypeError(`${fn}: reason 不合法`);

      const createdAt = ts(pick(row, 'createdAt', 'created_at'), fn);
      const updatedAt = pick(row, 'updatedAt', 'updated_at') === undefined ? createdAt : ts(pick(row, 'updatedAt', 'updated_at'), fn);
      const endedAt = numOrNull(pick(row, 'endedAt', 'ended_at'));
      const counted = pick(row, 'counted') ? 1 : 0;
      const cause = row.cause ?? null;
      if (cause !== null && (typeof cause !== 'string' || !CAUSE_RE.test(cause))) throw new TypeError(`${fn}: cause 不合法`);

      st.gameInsert.run(
        id,
        mode,
        size,
        komi,
        blackId,
        whiteId,
        aiLevel,
        jsonOrNull(timeControl),
        status,
        JSON.stringify(moves),
        jsonOrNull(row.clocks),
        jsonOrNull(dead),
        winner,
        reason,
        numOrNull(pick(row, 'scoreBlack', 'score_black')),
        numOrNull(pick(row, 'scoreWhite', 'score_white')),
        pick(row, 'resultText', 'result_text') ?? null,
        counted,
        createdAt,
        updatedAt,
        endedAt,
        jsonOrNull(row.state),
        cause,
      );
      return games.findById(id);
    },

    // 进行中的对局每一手后保存。只更新给出的字段（undefined 表示不改，clocks/state 传 null 表示清空）。
    // state：会话附加状态（JSON，继续对局次数与保护，见设计文档 6.5）。已结束的对局不会被改回；返回是否更新了一行。
    saveProgress(id, { status, moves, clocks, state } = {}, now) {
      const fn = 'games.saveProgress';
      if (typeof id !== 'string') throw new TypeError(`${fn}: id 必须是字符串`);
      const sets = [];
      const args = [];
      if (status !== undefined) {
        if (status !== 'playing' && status !== 'scoring') {
          throw new TypeError(`${fn}: status 只能是 playing/scoring（终局请用 games.finish）`);
        }
        sets.push('status = ?');
        args.push(status);
      }
      if (moves !== undefined) {
        assertMoves(moves, fn);
        sets.push('moves = ?');
        args.push(JSON.stringify(moves));
      }
      if (clocks !== undefined) {
        sets.push('clocks = ?');
        args.push(jsonOrNull(clocks));
      }
      if (state !== undefined) {
        sets.push('state = ?');
        args.push(jsonOrNull(state));
      }
      sets.push('updated_at = ?');
      args.push(ts(now, fn));
      const sql = `UPDATE games SET ${sets.join(', ')} WHERE id = ? AND status != 'ended'`;
      return Number(dyn(sql).run(...args, id).changes) > 0;
    },

    // 终局。已结束的对局不会被再次修改（返回 false）。
    // 注意：counted 列只由 stats.applyRanked 的防重 UPDATE 置 1（设计文档 3.2），
    // 这里传入的 counted 仅作记录，不写入该列——否则先 finish 再 applyRanked 会被防重挡掉。
    // resultText 省略时按引擎的 resultText() 生成。
    finish(id, fields = {}, now) {
      const fn = 'games.finish';
      if (typeof id !== 'string') throw new TypeError(`${fn}: id 必须是字符串`);
      const { status = 'ended', moves, dead, winner, reason, scoreBlack = null, scoreWhite = null, cause = null } = fields;
      if (status !== 'ended') throw new TypeError(`${fn}: status 必须是 ended`);
      if (![0, 1, 2].includes(winner)) throw new TypeError(`${fn}: winner 必须是 0/1/2`);
      if (!END_REASONS.has(reason)) throw new TypeError(`${fn}: reason 必须是 score/resign/timeout/abort`);
      if (cause !== null && (typeof cause !== 'string' || !CAUSE_RE.test(cause))) throw new TypeError(`${fn}: cause 不合法`);
      for (const [name, v] of [['scoreBlack', scoreBlack], ['scoreWhite', scoreWhite]]) {
        if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) throw new TypeError(`${fn}: ${name} 必须是数字或 null`);
      }
      const text =
        fields.resultText !== undefined && fields.resultText !== null
          ? String(fields.resultText)
          : engineResultText({ winner, reason, black: scoreBlack, white: scoreWhite });
      const t = ts(now, fn);

      const sets = ["status = 'ended'", 'winner = ?', 'reason = ?', 'score_black = ?', 'score_white = ?', 'result_text = ?', 'cause = ?', 'state = NULL'];
      const args = [winner, reason, scoreBlack, scoreWhite, text, cause];
      if (moves !== undefined) {
        assertMoves(moves, fn);
        sets.push('moves = ?');
        args.push(JSON.stringify(moves));
      }
      if (dead !== undefined) {
        if (dead !== null) assertIdxArray(dead, fn, 'dead');
        sets.push('dead = ?');
        args.push(jsonOrNull(dead));
      }
      sets.push('ended_at = ?', 'updated_at = ?');
      args.push(t, t);
      const sql = `UPDATE games SET ${sets.join(', ')} WHERE id = ? AND status != 'ended'`;
      return Number(dyn(sql).run(...args, id).changes) > 0;
    },

    // 只读查看：JSON 损坏的字段按空值返回，不抛错
    findById(id) {
      if (typeof id !== 'string' || !GAME_ID_RE.test(id)) return null;
      return toGame(st.gameById.get(id), { lenient: true });
    },

    // 某用户参与的已结束对局，按 created_at 倒序；before 为游标（只返回 created_at < before 的）
    listByUser(userId, { before, limit } = {}) {
      assertUserId(userId, 'games.listByUser');
      const cursor = before === undefined || before === null ? Number.MAX_SAFE_INTEGER : Number(before);
      if (!Number.isFinite(cursor)) throw new TypeError('games.listByUser: before 必须是时间戳');
      const n = clampLimit(limit, 20, MAX_LIST_LIMIT + 1);
      return st.gameListByUser.all({ uid: userId, before: Math.floor(cursor), n }).map((r) => toGame(r, { lenient: true }));
    },

    // 未结束的对局（重启恢复用）。解析不了的行不抛错，返回 { id, broken: true, error }，由恢复逻辑作废：
    // 一条坏记录不能让服务起不来。
    listUnfinished() {
      return st.gameUnfinished.all().map((row) => {
        try {
          return toGame(row);
        } catch (err) {
          return { id: row.id, broken: true, error: err.message };
        }
      });
    },

    // 最近（created_at >= since）两人之间已计入排行的排位赛局数（不分黑白），同一对手每日计入上限用
    countCountedBetween(a, b, since) {
      assertUserId(a, 'games.countCountedBetween', 'a');
      assertUserId(b, 'games.countCountedBetween', 'b');
      const t = ts(since, 'games.countCountedBetween');
      return Number(st.gameCountedPair.get(a, t, b).n) + Number(st.gameCountedPair.get(b, t, a).n);
    },

    // 删除一局未结束的对局（玩家还没下过子就被新开局顶替的人机对局）。已结束的不删；返回是否删除
    discard(id) {
      if (typeof id !== 'string' || !GAME_ID_RE.test(id)) return false;
      return Number(st.gameDiscard.run(id).changes) > 0;
    },

    // 人机战绩（作废的对局不算）：{ games, wins }
    aiRecord(userId) {
      assertUserId(userId, 'games.aiRecord');
      const r = st.gameAiRecord.get({ uid: userId });
      return { games: Number(r.games), wins: Number(r.wins) };
    },
  };

  // ----- stats -----

  function saveStats(userId, s, now) {
    st.statsUpsert.run(
      userId,
      s.games,
      s.wins,
      s.losses,
      s.draws,
      s.curStreak,
      s.maxStreak,
      s.curStreakAt,
      s.maxStreakAt,
      now,
    );
  }

  function resolveMinGames(opts) {
    const m = opts && opts.minGames !== undefined ? opts.minGames : defaultMinGames;
    if (!Number.isSafeInteger(m) || m < 1) throw new TypeError('minGames 必须是正整数');
    return m;
  }

  const stats = {
    // 不存在时返回全 0；含 winrate（0~1）与 curStreakAt / maxStreakAt
    get(userId) {
      if (!Number.isSafeInteger(userId) || userId <= 0) return emptyStats();
      return toStats(st.statsGet.get(userId));
    },

    // 排位赛计入统计（设计文档 3.2）。gameId 必填：用于 counted 防重，同一局只计一次。
    // 胜负：{ gameId, winnerId, loserId }；和棋：{ gameId, draw: true, userIds: [a, b] }
    // （和棋也可以只给 winnerId/loserId 表示双方）。
    // 返回 true 表示本次已计入，false 表示此前已计入（未做任何修改）。
    applyRanked({ gameId, winnerId, loserId, draw = false, userIds } = {}, now) {
      const fn = 'stats.applyRanked';
      if (typeof gameId !== 'string' || !gameId) {
        throw new TypeError(`${fn}: 需要 gameId（用于 counted 防重，见设计文档 3.2）`);
      }
      const t = ts(now, fn);
      let players;
      if (draw) {
        players = Array.isArray(userIds) && userIds.length ? userIds.map(Number) : [winnerId, loserId];
      } else {
        players = [winnerId, loserId];
      }
      if (players.length !== 2) throw new TypeError(`${fn}: 需要恰好两名玩家`);
      players.forEach((id, i) => assertUserId(id, fn, draw ? `userIds[${i}]` : i === 0 ? 'winnerId' : 'loserId'));
      if (players[0] === players[1]) throw new TypeError(`${fn}: 双方不能是同一人`);

      return transaction(() => {
        const game = st.gameById.get(gameId);
        if (!game) throw new Error(`${fn}: 对局 ${gameId} 不存在`);
        if (game.mode !== 'ranked') throw new Error(`${fn}: 对局 ${gameId} 不是排位赛（${game.mode}）`);
        const ids = [Number(game.black_id), Number(game.white_id)];
        if (!players.every((p) => ids.includes(p))) {
          throw new Error(`${fn}: 玩家 ${players.join(',')} 与对局 ${gameId} 的双方 ${ids.join(',')} 不符`);
        }
        if (Number(st.gameMarkCounted.run(gameId).changes) === 0) return false; // 已计入过

        if (draw) {
          for (const uid of players) {
            const s = toStats(st.statsGet.get(uid));
            s.games += 1;
            s.draws += 1;
            saveStats(uid, s, t);
          }
          return true;
        }

        const w = toStats(st.statsGet.get(winnerId));
        w.games += 1;
        w.wins += 1;
        w.curStreak += 1;
        w.curStreakAt = t;
        if (w.curStreak > w.maxStreak) {
          w.maxStreak = w.curStreak;
          w.maxStreakAt = t;
        }
        saveStats(winnerId, w, t);

        const l = toStats(st.statsGet.get(loserId));
        l.games += 1;
        l.losses += 1;
        l.curStreak = 0;
        l.curStreakAt = null;
        saveStats(loserId, l, t);
        return true;
      });
    },

    // → [{ rank, userId, nickname, avatar, avatarUrl, value, games, wins }]
    // avatar 为文件名，avatarUrl 按 createRepos 的 publicBaseUrl 生成
    leaderboard(type, limit = 50, opts = {}) {
      const b = board[type];
      if (!b) throw new TypeError(`stats.leaderboard: type 必须是 ${LEADERBOARD_TYPES.join('/')}`);
      const n = clampLimit(limit, 50, MAX_LEADERBOARD_LIMIT);
      const rows = type === 'winrate' ? b.list.all(resolveMinGames(opts), n) : b.list.all(n);
      return rows.map((r, i) => ({
        rank: i + 1,
        userId: Number(r.user_id),
        nickname: r.nickname,
        avatar: r.avatar,
        avatarUrl: avatarUrl(r.avatar, publicBaseUrl),
        value: Number(r.value),
        games: Number(r.games),
        wins: Number(r.wins),
      }));
    },

    // → { rank|null, value, games, wins, need }；need 仅胜率榜有意义（还差几局上榜），其余为 0
    rankOf(type, userId, opts = {}) {
      const b = board[type];
      if (!b) throw new TypeError(`stats.rankOf: type 必须是 ${LEADERBOARD_TYPES.join('/')}`);
      const s = stats.get(userId);
      const base = { games: s.games, wins: s.wins };
      if (type === 'winrate') {
        const min = resolveMinGames(opts);
        if (s.games < min) return { rank: null, value: s.winrate, ...base, need: min - s.games };
        const ahead = Number(b.ahead.get({ min, g: s.games, w: s.wins, uid: userId }).n);
        return { rank: ahead + 1, value: s.winrate, ...base, need: 0 };
      }
      const value = type === 'streak' ? s.curStreak : s.maxStreak;
      if (value <= 0) return { rank: null, value: 0, ...base, need: 0 };
      const at = (type === 'streak' ? s.curStreakAt : s.maxStreakAt) || 0;
      const ahead = Number(b.ahead.get({ v: value, at, uid: userId }).n);
      return { rank: ahead + 1, value, ...base, need: 0 };
    },
  };

  return { users, sessions, games, stats, transaction };
}

module.exports = {
  createRepos,
  LEADERBOARD_TYPES,
  SESSION_TTL_MS,
  SESSION_RENEW_BELOW_MS,
  MAX_SESSIONS_PER_USER,
  TOKEN_RE,
};
