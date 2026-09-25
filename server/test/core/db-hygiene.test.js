'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { openDb, createRepos, migrate } = require('../../src/db');
const { MIGRATIONS } = require('../../src/db/migrations');
const { MAX_SESSIONS_PER_USER, SESSION_TTL_MS } = require('../../src/db/repos');
const { GameManager } = require('../../src/game/manager');
const { buildSettings } = require('../../src/game/settings');
const { DAY, T0, makeRepos, insertRanked } = require('./helpers');

// 数据库卫生（回归测试）：
// - SL-11 令牌表：按用户的索引、每用户最多保留若干令牌、定时清理过期令牌
// - SL-14 一条损坏的未结束对局不能让服务起不来：listUnfinished 标记为 broken，恢复时作废
// - SL-4 按用户列对局不再全表排序（执黑 / 执白两路各走索引）

const noop = () => {};
const SILENT = { debug: noop, info: noop, warn: noop, error: noop };

test('迁移 2：从旧库（版本 1）升级，补上令牌表的索引；清理与按用户删除都走索引', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db, MIGRATIONS.slice(0, 1));
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  migrate(db, MIGRATIONS.slice(0, 2));
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  const plan = (sql) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(' | ');
  assert.match(plan('DELETE FROM sessions WHERE user_id = 1 AND expires_at <= 5'), /USING INDEX sessions_user/);
  assert.match(plan('DELETE FROM sessions WHERE expires_at <= 5'), /INDEX sessions_expires/);
  db.close();
});

test('令牌：每个用户最多保留最新的若干个；purgeExpired 清掉所有过期令牌', () => {
  const { repos } = makeRepos();
  const u = repos.users.create({ openid: 'o1' }, T0);
  const v = repos.users.create({ openid: 'o2' }, T0);
  const tokens = [];
  for (let i = 0; i < MAX_SESSIONS_PER_USER + 3; i++) tokens.push(repos.sessions.create(u.id, T0 + i));
  assert.equal(repos.sessions.resolve(tokens[0], T0 + 100), null, '最旧的被挤掉');
  assert.equal(repos.sessions.resolve(tokens[2], T0 + 100), null);
  assert.equal(repos.sessions.resolve(tokens[3], T0 + 100), u.id);
  assert.equal(repos.sessions.resolve(tokens.at(-1), T0 + 100), u.id);
  const old = repos.sessions.create(v.id, T0);
  const fresh = repos.sessions.create(v.id, T0 + 20 * DAY);
  // u 剩下的 10 个与 v 的旧令牌都已过期；v 的新令牌还有效
  assert.equal(repos.sessions.purgeExpired(T0 + SESSION_TTL_MS + 20), MAX_SESSIONS_PER_USER + 1);
  assert.equal(repos.sessions.purgeExpired(T0 + SESSION_TTL_MS + 20), 0);
  assert.equal(repos.sessions.resolve(old, T0 + SESSION_TTL_MS + 21), null);
  assert.equal(repos.sessions.resolve(fresh, T0 + SESSION_TTL_MS + 21), v.id);
});

test('listUnfinished：JSON 损坏的行返回 { id, broken }，不抛错；查看与列表对损坏字段宽容', () => {
  const { db, repos } = makeRepos();
  const a = repos.users.create({ openid: 'a' }, T0);
  const b = repos.users.create({ openid: 'b' }, T0);
  const good = insertRanked(repos, a.id, b.id, T0, { moves: [40, 41] });
  const bad = insertRanked(repos, a.id, b.id, T0 + 1);
  db.prepare('UPDATE games SET moves = ? WHERE id = ?').run('[40,', bad);
  const rows = repos.games.listUnfinished();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].moves, [40, 41]);
  assert.equal(rows[1].id, bad);
  assert.equal(rows[1].broken, true);
  assert.match(rows[1].error, /moves/);
  assert.deepEqual(repos.games.findById(bad).moves, [], '查看时损坏的字段按空值');
  repos.games.finish(bad, { winner: 0, reason: 'abort' }, T0 + 2);
  assert.equal(repos.games.listByUser(a.id, {}).length, 1);
  void good;
});

test('重启恢复（真实 SQLite）：损坏的对局作废并记日志，其余对局照常恢复，服务不会起不来（SL-14）', () => {
  const { db, repos } = makeRepos();
  const a = repos.users.create({ openid: 'a' }, T0);
  const b = repos.users.create({ openid: 'b' }, T0);
  const good = insertRanked(repos, a.id, b.id, T0, { moves: [40, 41], clocks: null });
  const bad = insertRanked(repos, a.id, b.id, T0 + 1);
  db.prepare('UPDATE games SET clocks = ? WHERE id = ?').run('{oops', bad);
  const errors = [];
  const manager = new GameManager({
    repos,
    ai: null,
    settings: buildSettings({}),
    logger: { ...SILENT, error: (...args) => errors.push(args) },
    now: () => T0 + 1000,
    timers: { setTimeout: () => 0, clearTimeout: noop },
    hub: { send: noop, sendGame: noop, isOnline: () => false },
  });
  assert.equal(manager.restore(), 1);
  assert.ok(manager.getSession(good));
  assert.equal(repos.games.findById(bad).status, 'ended');
  assert.equal(repos.games.findById(bad).reason, 'abort');
  assert.equal(errors.length, 1);
  manager.shutdown();
});

test('按用户列对局：执黑执白两路合并、倒序、游标分页正确，查询不再对该用户全部对局排序（SL-4）', () => {
  const { db, repos } = makeRepos();
  const a = repos.users.create({ openid: 'a' }, T0);
  const b = repos.users.create({ openid: 'b' }, T0);
  const ids = [];
  for (let i = 0; i < 30; i++) {
    const [black, white] = i % 3 === 0 ? [b.id, a.id] : [a.id, b.id];
    const id = insertRanked(repos, black, white, T0 + i * 10);
    repos.games.finish(id, { winner: 1, reason: 'resign' }, T0 + i * 10 + 5);
    ids.push(id);
  }
  const page1 = repos.games.listByUser(a.id, { limit: 12 });
  assert.deepEqual(page1.map((g) => g.id), ids.slice(18).reverse());
  const page2 = repos.games.listByUser(a.id, { before: page1.at(-1).createdAt, limit: 12 });
  assert.deepEqual(page2.map((g) => g.id), ids.slice(6, 18).reverse());
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN SELECT * FROM (SELECT * FROM (SELECT * FROM games WHERE black_id = 1 AND created_at < 9 AND status = 'ended' ORDER BY created_at DESC, id DESC LIMIT 5) UNION ALL SELECT * FROM (SELECT * FROM games WHERE white_id = 1 AND created_at < 9 AND status = 'ended' ORDER BY created_at DESC, id DESC LIMIT 5)) ORDER BY created_at DESC, id DESC LIMIT 5`)
    .all()
    .map((r) => r.detail)
    .join(' | ');
  assert.match(plan, /USING INDEX games_black/);
  assert.match(plan, /USING INDEX games_white/);
  assert.doesNotMatch(plan, /MULTI-INDEX OR/);
  // 人机战绩同样走索引，结果不变
  const ai = repos.games.insert({ id: 'aigame000001', mode: 'ai', size: 9, komi: 7.5, whiteId: a.id, aiLevel: 'k5', status: 'playing', moves: [], createdAt: T0 });
  repos.games.finish(ai.id, { winner: 2, reason: 'score', scoreBlack: 1, scoreWhite: 20 }, T0 + 1);
  assert.deepEqual(repos.games.aiRecord(a.id), { games: 1, wins: 1 });
  const aiPlan = db
    .prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) AS games, COALESCE(SUM(won), 0) AS wins FROM (
        SELECT CASE WHEN winner = 1 THEN 1 ELSE 0 END AS won FROM games
        WHERE black_id = 1 AND mode = 'ai' AND status = 'ended' AND reason != 'abort'
        UNION ALL
        SELECT CASE WHEN winner = 2 THEN 1 ELSE 0 END AS won FROM games
        WHERE white_id = 1 AND mode = 'ai' AND status = 'ended' AND reason != 'abort')`)
    .all()
    .map((r) => r.detail)
    .join(' | ');
  assert.match(aiPlan, /INDEX games_ai_black/);
  assert.match(aiPlan, /INDEX games_ai_white/);
  assert.deepEqual(repos.games.aiRecord(b.id), { games: 0, wins: 0 });
  // 删除未结束的对局（被顶替的空局）；已结束的不删
  const empty = repos.games.insert({ id: 'aigame000002', mode: 'ai', size: 9, komi: 7.5, blackId: a.id, aiLevel: 'k5', status: 'playing', moves: [], createdAt: T0 });
  assert.equal(repos.games.discard(empty.id), true);
  assert.equal(repos.games.findById(empty.id), null);
  assert.equal(repos.games.discard(ai.id), false);
  assert.ok(repos.games.findById(ai.id));
});

test('openDb：新库直接迁移到最新版本', () => {
  const db = openDb(':memory:');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
  createRepos(db);
  db.close();
});

test('迁移 3：旧库（版本 2）升级后加上 state / cause 列，原有数据保留；state 随进度保存、终局清空，cause 随终局保存', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db, MIGRATIONS.slice(0, 2));
  db.exec(`INSERT INTO users (id, openid, created_at, last_login_at) VALUES (1, 'o-a', ${T0}, ${T0}), (2, 'o-b', ${T0}, ${T0})`);
  db.prepare(
    "INSERT INTO games (id, mode, size, komi, black_id, white_id, status, moves, created_at, updated_at) VALUES ('oldgame00001', 'ranked', 9, 7.5, 1, 2, 'playing', '[40]', ?, ?)",
  ).run(T0, T0);
  migrate(db);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
  const repos = createRepos(db);
  const g = repos.games.findById('oldgame00001');
  assert.deepEqual(g.moves, [40]);
  assert.equal(g.state, null);
  assert.equal(g.cause, null);

  const state = { resumesUsed: { 1: 1, 2: 0 }, guard: null };
  assert.equal(repos.games.saveProgress('oldgame00001', { moves: [40, -1, -1, 41], state }, T0 + 1), true);
  assert.deepEqual(repos.games.findById('oldgame00001').state, state);
  assert.deepEqual(repos.games.listUnfinished()[0].state, state);
  // state 的 JSON 坏了：只把 state 当成空，不让整局变成 broken
  db.prepare("UPDATE games SET state = '{oops' WHERE id = 'oldgame00001'").run();
  const [row] = repos.games.listUnfinished();
  assert.equal(row.broken, undefined);
  assert.equal(row.state, null);

  assert.equal(repos.games.finish('oldgame00001', { winner: 0, reason: 'abort', cause: 'score_dispute' }, T0 + 2), true);
  const ended = repos.games.findById('oldgame00001');
  assert.equal(ended.cause, 'score_dispute');
  assert.equal(ended.state, null, '终局后不再需要附加状态');
  assert.throws(() => repos.games.finish('x', { winner: 0, reason: 'abort', cause: 'DROP TABLE' }, T0), TypeError);
  db.close();
});

test('games.countCountedBetween：两人之间最近计入排行的排位赛局数（不分黑白），走索引', () => {
  const { db, repos } = makeRepos();
  const a = repos.users.create({ openid: 'p-a' }, T0).id;
  const b = repos.users.create({ openid: 'p-b' }, T0).id;
  const c = repos.users.create({ openid: 'p-c' }, T0).id;
  const counted = (black, white, at) => {
    const id = insertRanked(repos, black, white, at);
    repos.games.finish(id, { winner: 1, reason: 'resign' }, at + 1);
    repos.stats.applyRanked({ gameId: id, winnerId: black, loserId: white }, at + 1);
    return id;
  };
  counted(a, b, T0);
  counted(b, a, T0 + 10);
  counted(a, c, T0 + 20);
  const uncounted = insertRanked(repos, a, b, T0 + 30);
  repos.games.finish(uncounted, { winner: 2, reason: 'resign' }, T0 + 31);
  counted(a, b, T0 - DAY); // 太早
  assert.equal(repos.games.countCountedBetween(a, b, T0), 2);
  assert.equal(repos.games.countCountedBetween(b, a, T0), 2);
  assert.equal(repos.games.countCountedBetween(a, c, T0), 1);
  assert.equal(repos.games.countCountedBetween(b, c, T0), 0);
  assert.equal(repos.games.countCountedBetween(a, b, T0 - DAY), 3);
  const plan = db
    .prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM games WHERE black_id = 1 AND created_at >= 5 AND white_id = 2 AND mode = 'ranked' AND counted = 1")
    .all()
    .map((r) => r.detail)
    .join(' | ');
  assert.match(plan, /INDEX games_(black|white)/, '按执黑或执白的索引查，不全表扫描');
});
