'use strict';
const crypto = require('node:crypto');

// 内存版仓储（设计文档 3.1 的子集），供 server-game 的测试使用。
// 行为尽量与 SQLite 版一致：GameRow 用驼峰字段、JSON 字段为 JS 值；insert 同时接受下划线与驼峰；
// finish/saveProgress 不会修改已结束的对局；stats.applyRanked 以 gameId 防重（同一局只计一次）；
// transaction 失败时整体回滚。
//
// 测试辅助：repos.calls 记录每次调用 [name, ...args]；repos.failOn(name, err) 让下一次该调用抛错。

const DAY_MS = 86400000;

function clone(v) {
  return v === undefined ? undefined : structuredClone(v);
}

function pick(obj, camel, snake) {
  if (obj[camel] !== undefined) return obj[camel];
  return obj[snake];
}

function emptyStats() {
  return { games: 0, wins: 0, losses: 0, draws: 0, curStreak: 0, maxStreak: 0, curStreakAt: null, maxStreakAt: null, updatedAt: null };
}

function createMemoryRepos() {
  const db = {
    users: new Map(),
    nextUserId: 1,
    sessions: new Map(),
    games: new Map(),
    stats: new Map(),
  };
  const calls = [];
  const failures = new Map();
  let depth = 0;

  function track(name, args) {
    calls.push([name, ...clone(args)]);
    const err = failures.get(name);
    if (err) {
      failures.delete(name);
      throw err;
    }
  }

  const users = {
    findById(id) {
      track('users.findById', [id]);
      return clone(db.users.get(id) || null);
    },
    findByOpenid(openid) {
      for (const u of db.users.values()) if (u.openid === openid) return clone(u);
      return null;
    },
    create({ openid, nickname = '', avatar = '' } = {}, now = Date.now()) {
      const id = db.nextUserId++;
      const user = { id, openid, nickname, avatar, createdAt: now, lastLoginAt: now };
      db.users.set(id, user);
      return clone(user);
    },
    updateProfile(id, fields = {}, now) {
      const u = db.users.get(id);
      if (!u) return null;
      if (fields.nickname !== undefined) u.nickname = fields.nickname;
      if (fields.avatar !== undefined) u.avatar = fields.avatar;
      return clone(u);
    },
    touchLogin(id, now) {
      const u = db.users.get(id);
      if (u) u.lastLoginAt = now;
      return !!u;
    },
  };

  const sessions = {
    create(userId, now = Date.now()) {
      const token = crypto.randomBytes(32).toString('hex');
      db.sessions.set(token, { userId, createdAt: now, expiresAt: now + 30 * DAY_MS });
      return token;
    },
    resolve(token, now = Date.now()) {
      track('sessions.resolve', [token, now]);
      const s = db.sessions.get(token);
      if (!s) return null;
      if (s.expiresAt <= now) {
        db.sessions.delete(token);
        return null;
      }
      if (s.expiresAt - now < 15 * DAY_MS) s.expiresAt = now + 30 * DAY_MS;
      return s.userId;
    },
    revoke(token) {
      return db.sessions.delete(token);
    },
  };

  const games = {
    insert(row) {
      track('games.insert', [row]);
      if (!row || typeof row.id !== 'string') throw new TypeError('games.insert: id');
      if (db.games.has(row.id)) throw new Error(`games.insert: 主键冲突 ${row.id}`);
      const g = {
        id: row.id,
        mode: row.mode,
        size: row.size,
        komi: row.komi,
        blackId: pick(row, 'blackId', 'black_id') ?? null,
        whiteId: pick(row, 'whiteId', 'white_id') ?? null,
        aiLevel: pick(row, 'aiLevel', 'ai_level') ?? null,
        timeControl: clone(pick(row, 'timeControl', 'time_control') ?? null),
        status: row.status || 'playing',
        moves: clone(row.moves || []),
        clocks: clone(row.clocks ?? null),
        dead: clone(row.dead ?? null),
        winner: row.winner ?? null,
        reason: row.reason ?? null,
        scoreBlack: pick(row, 'scoreBlack', 'score_black') ?? null,
        scoreWhite: pick(row, 'scoreWhite', 'score_white') ?? null,
        resultText: pick(row, 'resultText', 'result_text') ?? null,
        counted: Boolean(row.counted),
        createdAt: pick(row, 'createdAt', 'created_at'),
        updatedAt: pick(row, 'updatedAt', 'updated_at') ?? pick(row, 'createdAt', 'created_at'),
        endedAt: pick(row, 'endedAt', 'ended_at') ?? null,
        state: clone(row.state ?? null),
        cause: row.cause ?? null,
      };
      if (!Array.isArray(g.moves) || !g.moves.every((m) => Number.isInteger(m) && m >= -1)) {
        throw new TypeError('games.insert: moves');
      }
      db.games.set(g.id, g);
      return clone(g);
    },
    saveProgress(id, { status, moves, clocks, state } = {}, now) {
      track('games.saveProgress', [id, { status, moves, clocks, state }, now]);
      const g = db.games.get(id);
      if (!g || g.status === 'ended') return false;
      if (status !== undefined) {
        if (status !== 'playing' && status !== 'scoring') throw new TypeError('games.saveProgress: status');
        g.status = status;
      }
      if (moves !== undefined) g.moves = clone(moves);
      if (clocks !== undefined) g.clocks = clone(clocks);
      if (state !== undefined) g.state = clone(state);
      g.updatedAt = now;
      return true;
    },
    finish(id, fields = {}, now) {
      track('games.finish', [id, fields, now]);
      const g = db.games.get(id);
      if (!g || g.status === 'ended') return false;
      if (![0, 1, 2].includes(fields.winner)) throw new TypeError('games.finish: winner');
      if (!['score', 'resign', 'timeout', 'abort'].includes(fields.reason)) throw new TypeError('games.finish: reason');
      g.status = 'ended';
      g.winner = fields.winner;
      g.reason = fields.reason;
      g.scoreBlack = fields.scoreBlack ?? null;
      g.scoreWhite = fields.scoreWhite ?? null;
      g.resultText = fields.resultText ?? null;
      g.cause = fields.cause ?? null;
      g.state = null;
      if (fields.moves !== undefined) g.moves = clone(fields.moves);
      if (fields.dead !== undefined) g.dead = clone(fields.dead);
      g.endedAt = now;
      g.updatedAt = now;
      return true;
    },
    findById(id) {
      track('games.findById', [id]);
      return clone(db.games.get(id) || null);
    },
    listByUser(userId, { before = Infinity, limit = 20 } = {}) {
      return [...db.games.values()]
        .filter((g) => g.status === 'ended' && (g.blackId === userId || g.whiteId === userId) && g.createdAt < before)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit)
        .map(clone);
    },
    listUnfinished() {
      track('games.listUnfinished', []);
      return [...db.games.values()].filter((g) => g.status !== 'ended').map(clone);
    },
    // 最近两人之间已计入排行的排位赛局数（不分黑白）
    countCountedBetween(a, b, since) {
      track('games.countCountedBetween', [a, b, since]);
      let n = 0;
      for (const g of db.games.values()) {
        const pair = (g.blackId === a && g.whiteId === b) || (g.blackId === b && g.whiteId === a);
        if (pair && g.mode === 'ranked' && g.counted && g.createdAt >= since) n += 1;
      }
      return n;
    },
    // 删除未结束的对局（玩家还没下过子就被顶替的人机对局）
    discard(id) {
      track('games.discard', [id]);
      const g = db.games.get(id);
      if (!g || g.status === 'ended') return false;
      db.games.delete(id);
      return true;
    },
  };

  function statsOf(userId) {
    return db.stats.get(userId) || emptyStats();
  }

  const stats = {
    get(userId) {
      track('stats.get', [userId]);
      const s = statsOf(userId);
      return { ...clone(s), winrate: s.games > 0 ? s.wins / s.games : 0 };
    },
    // 与 SQLite 版一致：{ gameId, winnerId, loserId, draw, userIds }；gameId 用于防重
    applyRanked({ gameId, winnerId, loserId, draw = false, userIds } = {}, now) {
      track('stats.applyRanked', [{ gameId, winnerId, loserId, draw, userIds }, now]);
      return transaction(() => {
        if (gameId !== undefined) {
          const g = db.games.get(gameId);
          if (!g) throw new Error(`stats.applyRanked: 对局 ${gameId} 不存在`);
          if (g.mode !== 'ranked') throw new Error(`stats.applyRanked: 对局 ${gameId} 不是排位赛`);
          if (g.counted) return false;
          g.counted = true;
        }
        if (draw) {
          for (const uid of userIds) {
            const s = { ...statsOf(uid) };
            s.games += 1;
            s.draws += 1;
            s.updatedAt = now;
            db.stats.set(uid, s);
          }
          return true;
        }
        const w = { ...statsOf(winnerId) };
        w.games += 1;
        w.wins += 1;
        w.curStreak += 1;
        w.curStreakAt = now;
        if (w.curStreak > w.maxStreak) {
          w.maxStreak = w.curStreak;
          w.maxStreakAt = now;
        }
        w.updatedAt = now;
        db.stats.set(winnerId, w);
        const l = { ...statsOf(loserId) };
        l.games += 1;
        l.losses += 1;
        l.curStreak = 0;
        l.curStreakAt = null;
        l.updatedAt = now;
        db.stats.set(loserId, l);
        return true;
      });
    },
  };

  function transaction(fn) {
    const outer = depth === 0;
    const snapshot = outer ? structuredClone(db) : null;
    depth += 1;
    try {
      return fn();
    } catch (err) {
      if (outer) Object.assign(db, snapshot);
      throw err;
    } finally {
      depth -= 1;
    }
  }

  return {
    users,
    sessions,
    games,
    stats,
    transaction(fn) {
      track('transaction', []);
      return transaction(fn);
    },
    calls,
    failOn(name, err = new Error(`模拟 ${name} 失败`)) {
      failures.set(name, err);
    },
    callsOf(name) {
      return calls.filter((c) => c[0] === name);
    },
    _db: db,
  };
}

module.exports = { createMemoryRepos };
