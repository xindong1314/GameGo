'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDb, createRepos, migrate } = require('../../src/db');
const { MIGRATIONS } = require('../../src/db/migrations');
const { SESSION_TTL_MS } = require('../../src/db/repos');
const { DAY, T0, makeRepos, tmpDir, rmDir, insertRanked, gameId } = require('./helpers');

// ---------- openDb / 迁移 ----------

test('openDb(:memory:)：执行迁移、开启外键', () => {
  const db = openDb(':memory:');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.ok(Number(db.prepare('PRAGMA busy_timeout').get().timeout) >= 1000);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.deepEqual(tables, ['games', 'sessions', 'user_stats', 'users']);
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.deepEqual(indexes, [
    'games_ai_black',
    'games_ai_white',
    'games_black',
    'games_status',
    'games_white',
    'sessions_expires',
    'sessions_user',
  ]);
  const cols = db.prepare('PRAGMA table_info(games)').all().map((c) => c.name);
  assert.deepEqual(cols, [
    'id', 'mode', 'size', 'komi', 'black_id', 'white_id', 'ai_level', 'time_control', 'status', 'moves', 'clocks',
    'dead', 'winner', 'reason', 'score_black', 'score_white', 'result_text', 'counted', 'created_at', 'updated_at',
    'ended_at', 'state', 'cause',
  ]);
  db.close();
});

test('openDb(文件)：WAL 模式，重新打开不会重复迁移，数据保留', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'g.db');
  const db = openDb(file);
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  const repos = createRepos(db);
  repos.users.create({ openid: 'o1' }, T0);
  db.close();
  const db2 = openDb(file);
  assert.equal(db2.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
  assert.equal(createRepos(db2).users.findByOpenid('o1').id, 1);
  db2.close();
  rmDir(dir);
});

test('migrate：数据库版本比程序新时拒绝启动；迁移失败整体回滚', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
  assert.throws(() => migrate(db), /比程序支持的/);
  db.close();

  const db2 = new DatabaseSync(':memory:');
  assert.throws(() => migrate(db2, ['CREATE TABLE a (x INTEGER);', 'CREATE TABLE b (y INTEGER); SELECT * FROM nope;']), /迁移 2 失败/);
  assert.equal(db2.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(db2.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'b'").get().n, 0);
  db2.close();
});

// ---------- users ----------

test('users：创建、查找、改资料、记录登录时间', () => {
  const { repos } = makeRepos();
  const u = repos.users.create({ openid: 'wx-openid-1' }, T0);
  assert.deepEqual(u, { id: 1, openid: 'wx-openid-1', nickname: '', avatar: '', createdAt: T0, lastLoginAt: T0 });
  assert.equal(typeof u.id, 'number');
  assert.deepEqual(repos.users.findById(1), u);
  assert.deepEqual(repos.users.findByOpenid('wx-openid-1'), u);
  assert.equal(repos.users.findById(99), null);
  assert.equal(repos.users.findByOpenid('nope'), null);
  assert.equal(repos.users.findById('1'), null);
  assert.equal(repos.users.findByOpenid(''), null);

  const v = repos.users.create({ openid: 'dev:abcdefgh', nickname: '棋手', avatar: 'a1.png' }, T0 + 1);
  assert.equal(v.id, 2);
  assert.equal(v.nickname, '棋手');

  const u2 = repos.users.updateProfile(1, { nickname: '小明' }, T0 + 5);
  assert.equal(u2.nickname, '小明');
  assert.equal(u2.avatar, '');
  const u3 = repos.users.updateProfile(1, { avatar: 'ff.jpg' }, T0 + 6);
  assert.equal(u3.nickname, '小明');
  assert.equal(u3.avatar, 'ff.jpg');
  assert.deepEqual(repos.users.updateProfile(1, {}, T0 + 7), u3);
  assert.equal(repos.users.updateProfile(42, { nickname: 'x' }, T0), null);

  assert.equal(repos.users.touchLogin(1, T0 + 100), true);
  assert.equal(repos.users.findById(1).lastLoginAt, T0 + 100);
  assert.equal(repos.users.touchLogin(42, T0), false);
});

test('users：openid 唯一，参数校验', () => {
  const { repos } = makeRepos();
  repos.users.create({ openid: 'dup' }, T0);
  assert.throws(() => repos.users.create({ openid: 'dup' }, T0), /UNIQUE/);
  assert.throws(() => repos.users.create({ openid: '' }, T0), TypeError);
  assert.throws(() => repos.users.create({}, T0), TypeError);
  assert.throws(() => repos.users.create({ openid: 'x', nickname: 5 }, T0), TypeError);
  assert.throws(() => repos.users.create({ openid: 'y' }, 'now'), TypeError);
  assert.throws(() => repos.users.updateProfile(1, { nickname: null }, T0), TypeError);
  assert.throws(() => repos.users.updateProfile(0, { nickname: 'a' }, T0), TypeError);
});

// ---------- sessions ----------

test('sessions：令牌格式、解析、撤销', () => {
  const { repos } = makeRepos();
  const u = repos.users.create({ openid: 'o' }, T0);
  const token = repos.sessions.create(u.id, T0);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.notEqual(repos.sessions.create(u.id, T0), token);
  assert.equal(repos.sessions.resolve(token, T0 + 1000), u.id);
  assert.equal(repos.sessions.resolve('x'.repeat(64), T0), null);
  assert.equal(repos.sessions.resolve(token.toUpperCase(), T0), null);
  assert.equal(repos.sessions.resolve('', T0), null);
  assert.equal(repos.sessions.resolve(null, T0), null);
  assert.equal(repos.sessions.resolve('0'.repeat(64), T0), null);
  assert.equal(repos.sessions.revoke(token), true);
  assert.equal(repos.sessions.revoke(token), false);
  assert.equal(repos.sessions.resolve(token, T0 + 1000), null);
  assert.throws(() => repos.sessions.create(999, T0), /FOREIGN KEY/);
  assert.throws(() => repos.sessions.create('1', T0), TypeError);
});

test('sessions：30 天过期，过期令牌被删除', (t) => {
  const { db, repos } = makeRepos();
  const u = repos.users.create({ openid: 'o' }, T0);
  const token = repos.sessions.create(u.id, T0);
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  assert.equal(row.expires_at, T0 + SESSION_TTL_MS);
  assert.equal(row.created_at, T0);
  // 过期前 1 毫秒仍有效（但会续期）；另建一个令牌测过期
  const t2 = repos.sessions.create(u.id, T0);
  assert.equal(repos.sessions.resolve(t2, T0 + 30 * DAY), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token = ?').get(t2).n, 0);
  assert.equal(repos.sessions.resolve(token, T0 + 30 * DAY - 1), u.id);
  t.diagnostic('ok');
});

test('sessions：剩余不足 15 天时滑动续期到 30 天', () => {
  const { db, repos } = makeRepos();
  const u = repos.users.create({ openid: 'o' }, T0);
  const token = repos.sessions.create(u.id, T0);
  const expires = () => db.prepare('SELECT expires_at FROM sessions WHERE token = ?').get(token).expires_at;

  // 第 10 天：剩 20 天，不续期
  assert.equal(repos.sessions.resolve(token, T0 + 10 * DAY), u.id);
  assert.equal(expires(), T0 + 30 * DAY);
  // 第 15 天整：剩 15 天，不续期（"不足 15 天"才续）
  assert.equal(repos.sessions.resolve(token, T0 + 15 * DAY), u.id);
  assert.equal(expires(), T0 + 30 * DAY);
  // 第 16 天：剩 14 天，续到第 46 天
  assert.equal(repos.sessions.resolve(token, T0 + 16 * DAY), u.id);
  assert.equal(expires(), T0 + 46 * DAY);
  // 原本第 30 天过期，续期后第 45 天仍有效
  assert.equal(repos.sessions.resolve(token, T0 + 45 * DAY), u.id);
  assert.equal(expires(), T0 + 75 * DAY);
  // 长时间不用则过期
  assert.equal(repos.sessions.resolve(token, T0 + 75 * DAY), null);
});

test('sessions.create 顺手清理该用户已过期的令牌', () => {
  const { db, repos } = makeRepos();
  const a = repos.users.create({ openid: 'a' }, T0);
  const b = repos.users.create({ openid: 'b' }, T0);
  repos.sessions.create(a.id, T0);
  repos.sessions.create(b.id, T0);
  repos.sessions.create(a.id, T0 + 31 * DAY);
  const rows = db.prepare('SELECT user_id, created_at FROM sessions ORDER BY user_id').all();
  assert.deepEqual(
    rows.map((r) => [r.user_id, r.created_at]),
    [
      [a.id, T0 + 31 * DAY],
      [b.id, T0],
    ],
  );
});

// ---------- transaction ----------

test('transaction：提交、回滚、嵌套 savepoint、拒绝异步函数', async () => {
  const { repos } = makeRepos();
  assert.equal(
    repos.transaction(() => {
      repos.users.create({ openid: 'a' }, T0);
      return 42;
    }),
    42,
  );
  assert.ok(repos.users.findByOpenid('a'));

  assert.throws(() =>
    repos.transaction(() => {
      repos.users.create({ openid: 'b' }, T0);
      throw new Error('boom');
    }),
  /boom/);
  assert.equal(repos.users.findByOpenid('b'), null);

  // 内层失败只回滚内层
  repos.transaction(() => {
    repos.users.create({ openid: 'c' }, T0);
    assert.throws(() =>
      repos.transaction(() => {
        repos.users.create({ openid: 'd' }, T0);
        throw new Error('inner');
      }),
    );
    repos.users.create({ openid: 'e' }, T0);
  });
  assert.ok(repos.users.findByOpenid('c'));
  assert.equal(repos.users.findByOpenid('d'), null);
  assert.ok(repos.users.findByOpenid('e'));

  // 外层失败回滚全部（包括已 RELEASE 的内层）
  assert.throws(() =>
    repos.transaction(() => {
      repos.transaction(() => repos.users.create({ openid: 'f' }, T0));
      throw new Error('outer');
    }),
  );
  assert.equal(repos.users.findByOpenid('f'), null);

  assert.throws(
    () =>
      repos.transaction(async () => {
        repos.users.create({ openid: 'g' }, T0);
      }),
    /同步函数/,
  );
  assert.equal(repos.users.findByOpenid('g'), null);
  assert.throws(() => repos.transaction(null), TypeError);

  // 事务状态已恢复，可以继续使用
  repos.transaction(() => repos.users.create({ openid: 'h' }, T0));
  assert.ok(repos.users.findByOpenid('h'));
});

// ---------- games ----------

function seedUsers(repos, n) {
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(repos.users.create({ openid: `u${i}`, nickname: `用户${i}` }, T0).id);
  return ids;
}

test('games.insert / findById：JSON 字段序列化与解析，驼峰与下划线均可', () => {
  const { repos } = makeRepos();
  const [a, b] = seedUsers(repos, 2);
  const tc = { mainMs: 180000, periods: 3, periodMs: 20000 };
  const row = repos.games.insert({
    id: 'abc123def456',
    mode: 'ranked',
    size: 9,
    komi: 7.5,
    blackId: a,
    whiteId: b,
    timeControl: tc,
    status: 'playing',
    moves: [40, -1, 30],
    clocks: { 1: { mainMs: 1000, periodsLeft: 3, periodMs: 20000 }, running: 2 },
    createdAt: T0,
  });
  assert.deepEqual(row, {
    id: 'abc123def456',
    mode: 'ranked',
    size: 9,
    komi: 7.5,
    blackId: a,
    whiteId: b,
    aiLevel: null,
    timeControl: tc,
    status: 'playing',
    moves: [40, -1, 30],
    clocks: { 1: { mainMs: 1000, periodsLeft: 3, periodMs: 20000 }, running: 2 },
    dead: null,
    winner: null,
    reason: null,
    scoreBlack: null,
    scoreWhite: null,
    resultText: null,
    counted: false,
    state: null,
    cause: null,
    createdAt: T0,
    updatedAt: T0,
    endedAt: null,
  });
  assert.deepEqual(repos.games.findById('abc123def456'), row);
  assert.equal(repos.games.findById('nope'), null);
  assert.equal(repos.games.findById('../x'), null);
  assert.equal(repos.games.findById(5), null);

  const ai = repos.games.insert({
    id: 'aigame000001',
    mode: 'ai',
    size: 13,
    komi: 7.5,
    black_id: null,
    white_id: a,
    ai_level: 'k5',
    time_control: null,
    status: 'playing',
    created_at: T0 + 5,
    updated_at: T0 + 6,
  });
  assert.equal(ai.blackId, null);
  assert.equal(ai.whiteId, a);
  assert.equal(ai.aiLevel, 'k5');
  assert.equal(ai.timeControl, null);
  assert.deepEqual(ai.moves, []);
  assert.equal(ai.createdAt, T0 + 5);
  assert.equal(ai.updatedAt, T0 + 6);
});

test('games.insert：参数校验', () => {
  const { repos } = makeRepos();
  const [a, b] = seedUsers(repos, 2);
  const ok = { id: 'x1', mode: 'friend', size: 19, komi: 7.5, blackId: a, whiteId: b, createdAt: T0 };
  const bad = [
    { id: '' },
    { id: 'a b' },
    { mode: 'blitz' },
    { size: 20 },
    { size: 9.5 },
    { komi: '7.5' },
    { blackId: null },
    { whiteId: a },
    { status: 'paused' },
    { moves: [1, 'x'] },
    { moves: [-2] },
    { winner: 3 },
    { reason: 'quit' },
    { timeControl: { mainMs: 1 } },
    { mode: 'ai', aiLevel: 'k5' }, // 两方都是人
    { mode: 'ai', blackId: null, aiLevel: '' },
    { blackId: -1 },
  ];
  for (const patch of bad) {
    assert.throws(() => repos.games.insert({ ...ok, ...patch }), TypeError, JSON.stringify(patch));
  }
  repos.games.insert(ok);
  assert.throws(() => repos.games.insert(ok), /UNIQUE|PRIMARY/);
});

test('games.saveProgress：只改给出的字段，不改已结束的对局', () => {
  const { repos } = makeRepos();
  const [a, b] = seedUsers(repos, 2);
  const id = insertRanked(repos, a, b, T0);
  assert.equal(repos.games.saveProgress(id, { moves: [1, 2], clocks: { running: 1 } }, T0 + 10), true);
  let g = repos.games.findById(id);
  assert.deepEqual(g.moves, [1, 2]);
  assert.deepEqual(g.clocks, { running: 1 });
  assert.equal(g.status, 'playing');
  assert.equal(g.updatedAt, T0 + 10);

  assert.equal(repos.games.saveProgress(id, { status: 'scoring', moves: [1, 2, -1, -1] }, T0 + 20), true);
  g = repos.games.findById(id);
  assert.equal(g.status, 'scoring');
  assert.deepEqual(g.clocks, { running: 1 });
  assert.equal(repos.games.saveProgress(id, { clocks: null }, T0 + 21), true);
  assert.equal(repos.games.findById(id).clocks, null);

  assert.throws(() => repos.games.saveProgress(id, { status: 'ended' }, T0), TypeError);
  assert.throws(() => repos.games.saveProgress(id, { moves: 'x' }, T0), TypeError);
  assert.equal(repos.games.saveProgress('missing', { moves: [] }, T0), false);

  repos.games.finish(id, { winner: 1, reason: 'resign' }, T0 + 30);
  assert.equal(repos.games.saveProgress(id, { status: 'playing', moves: [] }, T0 + 40), false);
  g = repos.games.findById(id);
  assert.equal(g.status, 'ended');
  assert.deepEqual(g.moves, [1, 2, -1, -1]);
});

test('games.finish：写入结果，自动生成 resultText，重复终局无效', () => {
  const { repos } = makeRepos();
  const [a, b] = seedUsers(repos, 2);
  const id = insertRanked(repos, a, b, T0);
  const ok = repos.games.finish(
    id,
    {
      status: 'ended',
      moves: [40, -1, -1],
      dead: [3, 1],
      winner: 2,
      reason: 'score',
      scoreBlack: 40,
      scoreWhite: 48.5,
      counted: true,
    },
    T0 + 100,
  );
  assert.equal(ok, true);
  const g = repos.games.findById(id);
  assert.equal(g.status, 'ended');
  assert.deepEqual(g.moves, [40, -1, -1]);
  assert.deepEqual(g.dead, [3, 1]);
  assert.equal(g.winner, 2);
  assert.equal(g.reason, 'score');
  assert.equal(g.scoreBlack, 40);
  assert.equal(g.scoreWhite, 48.5);
  assert.equal(g.resultText, 'W+8.5');
  assert.equal(g.endedAt, T0 + 100);
  assert.equal(g.updatedAt, T0 + 100);
  // counted 列只由 stats.applyRanked 置 1
  assert.equal(g.counted, false);

  assert.equal(repos.games.finish(id, { winner: 1, reason: 'resign' }, T0 + 200), false);
  assert.equal(repos.games.findById(id).winner, 2);

  const id2 = insertRanked(repos, a, b, T0);
  repos.games.finish(id2, { winner: 0, reason: 'abort', resultText: 'Void' }, T0 + 1);
  const g2 = repos.games.findById(id2);
  assert.equal(g2.resultText, 'Void');
  assert.deepEqual(g2.moves, []); // 未给 moves 时保留原值
  assert.equal(g2.dead, null);
  assert.equal(g2.scoreBlack, null);

  const id3 = insertRanked(repos, a, b, T0);
  for (const bad of [
    { winner: 4, reason: 'score' },
    { winner: 1, reason: 'nope' },
    { winner: 1, reason: 'score', status: 'playing' },
    { winner: 1, reason: 'score', scoreBlack: 'x' },
    { winner: 1, reason: 'score', dead: [-1] },
  ]) {
    assert.throws(() => repos.games.finish(id3, bad, T0), TypeError, JSON.stringify(bad));
  }
  assert.equal(repos.games.finish('missing', { winner: 1, reason: 'resign' }, T0), false);
});

test('games.listByUser：只含已结束、倒序、游标分页', () => {
  const { repos } = makeRepos();
  const [a, b, c] = seedUsers(repos, 3);
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const id = insertRanked(repos, i % 2 ? a : b, i % 2 ? b : a, T0 + i * 1000);
    repos.games.finish(id, { winner: 1, reason: 'resign' }, T0 + i * 1000 + 500);
    ids.push(id);
  }
  insertRanked(repos, a, b, T0 + 9000); // 进行中，不列出
  const other = insertRanked(repos, b, c, T0 + 8000);
  repos.games.finish(other, { winner: 1, reason: 'resign' }, T0 + 8500);

  const all = repos.games.listByUser(a);
  assert.deepEqual(
    all.map((g) => g.id),
    [...ids].reverse(),
  );
  const page1 = repos.games.listByUser(a, { limit: 2 });
  assert.deepEqual(
    page1.map((g) => g.id),
    [ids[4], ids[3]],
  );
  const page2 = repos.games.listByUser(a, { before: page1[1].createdAt, limit: 2 });
  assert.deepEqual(
    page2.map((g) => g.id),
    [ids[2], ids[1]],
  );
  const page3 = repos.games.listByUser(a, { before: page2[1].createdAt, limit: 2 });
  assert.deepEqual(
    page3.map((g) => g.id),
    [ids[0]],
  );
  assert.equal(repos.games.listByUser(c).length, 1);
  assert.equal(repos.games.listByUser(999).length, 0);
  assert.equal(repos.games.listByUser(a, { limit: 0 }).length, 1); // 截断到至少 1
  assert.throws(() => repos.games.listByUser('a'), TypeError);
  assert.throws(() => repos.games.listByUser(a, { before: 'x' }), TypeError);
});

test('games.listUnfinished 与 aiRecord', () => {
  const { repos } = makeRepos();
  const [a, b] = seedUsers(repos, 2);
  const p = insertRanked(repos, a, b, T0 + 2);
  const s = insertRanked(repos, a, b, T0 + 1, { status: 'scoring' });
  const e = insertRanked(repos, a, b, T0);
  repos.games.finish(e, { winner: 1, reason: 'resign' }, T0 + 3);
  assert.deepEqual(
    repos.games.listUnfinished().map((g) => g.id),
    [s, p],
  );

  const ai = (color, winner, reason) => {
    const id = gameId();
    repos.games.insert({
      id,
      mode: 'ai',
      size: 9,
      komi: 7.5,
      blackId: color === 1 ? a : null,
      whiteId: color === 2 ? a : null,
      aiLevel: 'k5',
      createdAt: T0,
    });
    if (winner !== undefined) repos.games.finish(id, { winner, reason }, T0 + 1);
    return id;
  };
  ai(1, 1, 'score'); // 胜
  ai(2, 2, 'resign'); // 胜
  ai(2, 1, 'score'); // 负
  ai(1, 0, 'abort'); // 作废，不计
  ai(1); // 进行中，不计
  assert.deepEqual(repos.games.aiRecord(a), { games: 3, wins: 2 });
  assert.deepEqual(repos.games.aiRecord(b), { games: 0, wins: 0 });
});
