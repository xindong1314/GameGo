'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { T0, makeRepos, insertRanked, gameId } = require('./helpers');

function seed(repos, n) {
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(repos.users.create({ openid: `u${i}`, nickname: `用户${i}`, avatar: i % 2 ? `a${i}.png` : '' }, T0).id);
  return ids;
}

// 下一局排位赛：winner 胜 loser
function win(repos, winner, loser, now) {
  const id = insertRanked(repos, winner, loser, now);
  return { id, applied: repos.stats.applyRanked({ gameId: id, winnerId: winner, loserId: loser }, now) };
}

function draw(repos, a, b, now) {
  const id = insertRanked(repos, a, b, now);
  return repos.stats.applyRanked({ gameId: id, draw: true, userIds: [a, b] }, now);
}

// 直接写统计行，便于构造并列情形
function setStats(db, userId, s) {
  db.prepare(
    `INSERT OR REPLACE INTO user_stats (user_id, games, wins, losses, draws, cur_streak, max_streak, cur_streak_at, max_streak_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    userId,
    s.games ?? 0,
    s.wins ?? 0,
    s.losses ?? 0,
    s.draws ?? 0,
    s.cur ?? 0,
    s.max ?? 0,
    s.curAt ?? null,
    s.maxAt ?? null,
    T0,
  );
}

test('stats.get：没有记录时返回全 0', () => {
  const { repos } = makeRepos();
  const [a] = seed(repos, 1);
  assert.deepEqual(repos.stats.get(a), {
    games: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    winrate: 0,
    curStreak: 0,
    maxStreak: 0,
    curStreakAt: null,
    maxStreakAt: null,
  });
  assert.equal(repos.stats.get(12345).games, 0);
  assert.equal(repos.stats.get('x').games, 0);
});

test('applyRanked：胜者连胜 +1、负者清零，最高连胜与时间', () => {
  const { repos } = makeRepos();
  const [a, b, c] = seed(repos, 3);
  assert.equal(win(repos, a, b, T0 + 1).applied, true);
  assert.equal(win(repos, a, c, T0 + 2).applied, true);
  assert.deepEqual(repos.stats.get(a), {
    games: 2,
    wins: 2,
    losses: 0,
    draws: 0,
    winrate: 1,
    curStreak: 2,
    maxStreak: 2,
    curStreakAt: T0 + 2,
    maxStreakAt: T0 + 2,
  });
  assert.deepEqual(repos.stats.get(b), {
    games: 1,
    wins: 0,
    losses: 1,
    draws: 0,
    winrate: 0,
    curStreak: 0,
    maxStreak: 0,
    curStreakAt: null,
    maxStreakAt: null,
  });

  // a 输一局：当前连胜清零，最高连胜保留
  win(repos, b, a, T0 + 3);
  let s = repos.stats.get(a);
  assert.equal(s.curStreak, 0);
  assert.equal(s.curStreakAt, null);
  assert.equal(s.maxStreak, 2);
  assert.equal(s.maxStreakAt, T0 + 2);
  assert.equal(s.losses, 1);
  assert.equal(repos.stats.get(b).curStreak, 1);
  assert.equal(repos.stats.get(b).curStreakAt, T0 + 3);

  // a 再连胜 2 局：追平不更新最高连胜时间，超过才更新
  win(repos, a, c, T0 + 4);
  win(repos, a, c, T0 + 5);
  s = repos.stats.get(a);
  assert.equal(s.curStreak, 2);
  assert.equal(s.maxStreak, 2);
  assert.equal(s.maxStreakAt, T0 + 2);
  win(repos, a, c, T0 + 6);
  s = repos.stats.get(a);
  assert.equal(s.curStreak, 3);
  assert.equal(s.maxStreak, 3);
  assert.equal(s.maxStreakAt, T0 + 6);
  assert.equal(s.games, 6);
  assert.equal(s.wins, 5);
  assert.equal(s.winrate, 5 / 6);
});

test('applyRanked：和棋双方局数与和棋数 +1，连胜不变', () => {
  const { repos } = makeRepos();
  const [a, b] = seed(repos, 2);
  win(repos, a, b, T0 + 1);
  assert.equal(draw(repos, a, b, T0 + 2), true);
  const sa = repos.stats.get(a);
  const sb = repos.stats.get(b);
  assert.deepEqual([sa.games, sa.wins, sa.draws, sa.curStreak, sa.curStreakAt], [2, 1, 1, 1, T0 + 1]);
  assert.deepEqual([sb.games, sb.losses, sb.draws, sb.curStreak], [2, 1, 1, 0]);
  // 和棋也可只给 winnerId/loserId 表示双方
  const id = insertRanked(repos, a, b, T0 + 3);
  assert.equal(repos.stats.applyRanked({ gameId: id, draw: true, winnerId: b, loserId: a }, T0 + 3), true);
  assert.equal(repos.stats.get(a).draws, 2);
  assert.equal(repos.stats.get(b).draws, 2);
});

test('applyRanked：同一局只计一次（counted 防重），先 finish 后 applyRanked 也能计入', () => {
  const { repos } = makeRepos();
  const [a, b] = seed(repos, 2);
  const id = insertRanked(repos, a, b, T0);
  repos.games.finish(id, { winner: 1, reason: 'resign', counted: true }, T0 + 10);
  assert.equal(repos.games.findById(id).counted, false);
  assert.equal(repos.stats.applyRanked({ gameId: id, winnerId: a, loserId: b }, T0 + 10), true);
  assert.equal(repos.games.findById(id).counted, true);
  assert.equal(repos.stats.applyRanked({ gameId: id, winnerId: a, loserId: b }, T0 + 11), false);
  assert.equal(repos.stats.applyRanked({ gameId: id, draw: true, userIds: [a, b] }, T0 + 12), false);
  assert.equal(repos.stats.get(a).games, 1);
  assert.equal(repos.stats.get(a).curStreakAt, T0 + 10);
  assert.equal(repos.stats.get(b).games, 1);
});

test('applyRanked：可在外层事务中调用；外层回滚时统计与 counted 一起回滚', () => {
  const { repos } = makeRepos();
  const [a, b] = seed(repos, 2);
  const id = insertRanked(repos, a, b, T0);
  assert.throws(() =>
    repos.transaction(() => {
      repos.games.finish(id, { winner: 2, reason: 'timeout' }, T0);
      repos.stats.applyRanked({ gameId: id, winnerId: b, loserId: a }, T0);
      throw new Error('rollback');
    }),
  );
  assert.equal(repos.games.findById(id).status, 'playing');
  assert.equal(repos.games.findById(id).counted, false);
  assert.equal(repos.stats.get(b).games, 0);

  const r = repos.transaction(() => {
    repos.games.finish(id, { winner: 2, reason: 'timeout' }, T0);
    return repos.stats.applyRanked({ gameId: id, winnerId: b, loserId: a }, T0);
  });
  assert.equal(r, true);
  assert.equal(repos.stats.get(b).wins, 1);
});

test('applyRanked：统计写入失败时 counted 不会被置 1', () => {
  const { repos } = makeRepos();
  const [a] = seed(repos, 1);
  // games.black_id 没有外键，user_stats.user_id 有：不存在的用户会让统计写入失败
  const id = insertRanked(repos, a, 999, T0);
  assert.throws(() => repos.stats.applyRanked({ gameId: id, winnerId: 999, loserId: a }, T0), /FOREIGN KEY/);
  assert.equal(repos.games.findById(id).counted, false);
  assert.equal(repos.stats.get(a).games, 0);
});

test('applyRanked：参数与对局校验', () => {
  const { repos } = makeRepos();
  const [a, b, c] = seed(repos, 3);
  const id = insertRanked(repos, a, b, T0);
  assert.throws(() => repos.stats.applyRanked({ winnerId: a, loserId: b }, T0), /gameId/);
  assert.throws(() => repos.stats.applyRanked({ gameId: id, winnerId: a, loserId: a }, T0), TypeError);
  assert.throws(() => repos.stats.applyRanked({ gameId: id, winnerId: a }, T0), TypeError);
  assert.throws(() => repos.stats.applyRanked({ gameId: id, draw: true, userIds: [a] }, T0), TypeError);
  assert.throws(() => repos.stats.applyRanked({ gameId: id, winnerId: a, loserId: b }, 'now'), TypeError);
  assert.throws(() => repos.stats.applyRanked({ gameId: 'missing', winnerId: a, loserId: b }, T0), /不存在/);
  assert.throws(() => repos.stats.applyRanked({ gameId: id, winnerId: a, loserId: c }, T0), /不符/);
  const friend = gameId();
  repos.games.insert({ id: friend, mode: 'friend', size: 9, komi: 7.5, blackId: a, whiteId: b, createdAt: T0 });
  assert.throws(() => repos.stats.applyRanked({ gameId: friend, winnerId: a, loserId: b }, T0), /不是排位赛/);
  assert.equal(repos.games.findById(id).counted, false);
  assert.equal(repos.stats.get(a).games, 0);
});

// ---------- 排行榜 ----------

function checkRankOfMatchesList(repos, type, userIds, opts) {
  const list = repos.stats.leaderboard(type, 200, opts);
  for (const uid of userIds) {
    const r = repos.stats.rankOf(type, uid, opts);
    const item = list.find((it) => it.userId === uid);
    assert.equal(r.rank, item ? item.rank : null, `${type} user ${uid}`);
    if (item) assert.equal(r.value, item.value);
  }
}

test('leaderboard streak：cur_streak DESC, cur_streak_at ASC, user_id ASC', () => {
  const { db, repos } = makeRepos({ publicBaseUrl: 'https://go.example.com' });
  const u = seed(repos, 7);
  setStats(db, u[0], { games: 3, wins: 3, cur: 3, curAt: T0 + 50, max: 3, maxAt: T0 + 50 });
  setStats(db, u[1], { games: 5, wins: 5, cur: 5, curAt: T0 + 90, max: 5, maxAt: T0 + 90 });
  setStats(db, u[2], { games: 3, wins: 3, cur: 3, curAt: T0 + 10, max: 3, maxAt: T0 + 10 });
  setStats(db, u[3], { games: 3, wins: 3, cur: 3, curAt: T0 + 10, max: 4, maxAt: T0 + 1 });
  setStats(db, u[4], { games: 2, wins: 0, losses: 2, cur: 0, max: 1, maxAt: T0 });
  setStats(db, u[5], { games: 1, wins: 1, cur: 1, curAt: T0, max: 1, maxAt: T0 });
  // u[6] 没有统计记录

  const list = repos.stats.leaderboard('streak', 50);
  assert.deepEqual(
    list.map((it) => [it.rank, it.userId, it.value]),
    [
      [1, u[1], 5],
      [2, u[2], 3],
      [3, u[3], 3],
      [4, u[0], 3],
      [5, u[5], 1],
    ],
  );
  assert.deepEqual(list[0], {
    rank: 1,
    userId: u[1],
    nickname: '用户1',
    avatar: 'a1.png',
    avatarUrl: 'https://go.example.com/avatars/a1.png',
    value: 5,
    games: 5,
    wins: 5,
  });
  assert.equal(list[1].avatarUrl, '');
  assert.deepEqual(
    repos.stats.leaderboard('streak', 2).map((it) => it.userId),
    [u[1], u[2]],
  );
  checkRankOfMatchesList(repos, 'streak', u);
  assert.deepEqual(repos.stats.rankOf('streak', u[3]), { rank: 3, value: 3, games: 3, wins: 3, need: 0 });
  assert.deepEqual(repos.stats.rankOf('streak', u[4]), { rank: null, value: 0, games: 2, wins: 0, need: 0 });
  assert.deepEqual(repos.stats.rankOf('streak', u[6]), { rank: null, value: 0, games: 0, wins: 0, need: 0 });
});

test('leaderboard maxStreak：max_streak DESC, max_streak_at ASC, user_id ASC', () => {
  const { db, repos } = makeRepos();
  const u = seed(repos, 5);
  setStats(db, u[0], { games: 9, wins: 6, max: 4, maxAt: T0 + 30 });
  setStats(db, u[1], { games: 9, wins: 6, max: 4, maxAt: T0 + 20 });
  setStats(db, u[2], { games: 9, wins: 6, max: 6, maxAt: T0 + 99 });
  setStats(db, u[3], { games: 9, wins: 6, max: 4, maxAt: T0 + 20 });
  setStats(db, u[4], { games: 1, losses: 1 });
  assert.deepEqual(
    repos.stats.leaderboard('maxStreak', 50).map((it) => [it.rank, it.userId, it.value]),
    [
      [1, u[2], 6],
      [2, u[1], 4],
      [3, u[3], 4],
      [4, u[0], 4],
    ],
  );
  checkRankOfMatchesList(repos, 'maxStreak', u);
  assert.equal(repos.stats.rankOf('maxStreak', u[4]).rank, null);
});

test('leaderboard winrate：games >= MIN，胜率 DESC、局数 DESC、user_id ASC；need', () => {
  const { db, repos } = makeRepos();
  const u = seed(repos, 8);
  setStats(db, u[0], { games: 10, wins: 5 }); // 0.5
  setStats(db, u[1], { games: 20, wins: 10 }); // 0.5，局数多排前
  setStats(db, u[2], { games: 12, wins: 9 }); // 0.75
  setStats(db, u[3], { games: 9, wins: 9 }); // 局数不够
  setStats(db, u[4], { games: 30, wins: 10 }); // 1/3
  setStats(db, u[5], { games: 15, wins: 5 }); // 1/3，局数少排后
  setStats(db, u[6], { games: 30, wins: 10 }); // 1/3，与 u4 完全相同，按 user_id
  const list = repos.stats.leaderboard('winrate', 50);
  assert.deepEqual(
    list.map((it) => [it.rank, it.userId]),
    [
      [1, u[2]],
      [2, u[1]],
      [3, u[0]],
      [4, u[4]],
      [5, u[6]],
      [6, u[5]],
    ],
  );
  assert.equal(list[0].value, 0.75);
  assert.equal(list[3].value, 1 / 3);
  checkRankOfMatchesList(repos, 'winrate', u);
  assert.deepEqual(repos.stats.rankOf('winrate', u[3]), { rank: null, value: 1, games: 9, wins: 9, need: 1 });
  assert.deepEqual(repos.stats.rankOf('winrate', u[7]), { rank: null, value: 0, games: 0, wins: 0, need: 10 });
  assert.deepEqual(repos.stats.rankOf('winrate', u[2]), { rank: 1, value: 0.75, games: 12, wins: 9, need: 0 });

  // 逐次覆盖上榜局数
  const low = repos.stats.leaderboard('winrate', 50, { minGames: 5 });
  assert.equal(low[0].userId, u[3]);
  assert.equal(repos.stats.rankOf('winrate', u[3], { minGames: 5 }).rank, 1);
  checkRankOfMatchesList(repos, 'winrate', u, { minGames: 5 });
  assert.equal(repos.stats.rankOf('winrate', u[7], { minGames: 5 }).need, 5);
});

test('leaderboard：createRepos 的 minGamesWinrate 选项；参数校验', () => {
  const { db, repos } = makeRepos({ minGamesWinrate: 3 });
  const [a] = seed(repos, 1);
  setStats(db, a, { games: 3, wins: 1 });
  assert.equal(repos.stats.leaderboard('winrate').length, 1);
  assert.equal(repos.stats.rankOf('winrate', a).rank, 1);
  assert.throws(() => repos.stats.leaderboard('elo'), TypeError);
  assert.throws(() => repos.stats.rankOf('elo', a), TypeError);
  assert.throws(() => repos.stats.leaderboard('winrate', 10, { minGames: 0 }), TypeError);
  assert.throws(() => makeRepos({ minGamesWinrate: 0 }), TypeError);
});

test('排行榜与 applyRanked 联动：真实对局序列后 rankOf 与列表一致', () => {
  const { repos } = makeRepos({ minGamesWinrate: 2 });
  const u = seed(repos, 5);
  let t = T0;
  const seq = [
    [0, 1],
    [0, 2],
    [3, 4],
    [3, 0],
    [1, 2],
    [3, 1],
    [4, 2],
    [2, 0],
    [3, 2],
  ];
  for (const [w, l] of seq) win(repos, u[w], u[l], (t += 1000));
  draw(repos, u[1], u[4], (t += 1000));
  for (const type of ['streak', 'maxStreak', 'winrate']) checkRankOfMatchesList(repos, type, u);
  const top = repos.stats.leaderboard('streak', 1)[0];
  assert.equal(top.userId, u[3]);
  assert.equal(top.value, 4);
  assert.equal(repos.stats.get(u[3]).maxStreak, 4);
  const totalGames = u.reduce((n, id) => n + repos.stats.get(id).games, 0);
  assert.equal(totalGames, (seq.length + 1) * 2);
});
