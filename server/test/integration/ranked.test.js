'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeAi } = require('../helpers/fake-ai');
const {
  PNG_1X1,
  startStack,
  matchPair,
  playMoves,
  sleep,
  SCRIPT_CAPTURE,
  CAPTURE_N,
  CAPTURED_IDX,
  DEAD_WHITE,
} = require('./helpers');

// 集成：真实 startServer + SQLite 文件 + HTTP + WebSocket，假 AI。
// 覆盖：登录/资料/头像 → 排位全流程（提子、pass、数子建议、点选、确认、统计）→ 排行榜与棋谱；
// 认输（计入）、手数不足（不计入）、统计只计一次（含重启后）。

test('REST：dev-login → 昵称 → 头像上传（真实 multipart）→ /api/me', async (t) => {
  const s = await startStack();
  t.after(() => s.close());

  assert.deepEqual(await s.api('GET', '/healthz'), { ok: true });
  // 未配置微信：/auth/login 回 503 wx_not_configured（客户端据此改走 dev-login）
  const wx = await s.http('POST', '/api/auth/login', { body: { code: 'abc' } });
  assert.equal(wx.status, 503);
  assert.equal(wx.json.error.code, 'wx_not_configured');

  const login = await s.api('POST', '/api/auth/dev-login', { body: { deviceId: 'devicealpha01' } });
  assert.match(login.token, /^[0-9a-f]{64}$/);
  assert.equal(login.needProfile, true);
  assert.deepEqual(Object.keys(login.user).sort(), ['avatarUrl', 'id', 'nickname']);
  const token = login.token;

  // 同一 deviceId 再登录是同一个用户
  const again = await s.api('POST', '/api/auth/dev-login', { body: { deviceId: 'devicealpha01' } });
  assert.equal(again.user.id, login.user.id);

  // 昵称：去首尾空白，emoji 按码点计数
  const prof = await s.api('PUT', '/api/me/profile', { token, body: { nickname: '  棋手😀  ' } });
  assert.equal(prof.user.nickname, '棋手😀');
  const bad = await s.http('PUT', '/api/me/profile', { token, body: { nickname: '' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'bad_request');

  // 头像：真实 multipart（fetch + FormData）
  const form = new FormData();
  form.append('file', new Blob([PNG_1X1], { type: 'image/png' }), 'tmp_avatar.png');
  const up = await s.api('POST', '/api/me/avatar', { token, form });
  assert.match(up.user.avatarUrl, /\/avatars\/[0-9a-f]{24}\.png$/);
  const avatarPath = new URL(up.user.avatarUrl).pathname;
  const img = await s.http('GET', avatarPath);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.ok(img.buf.equals(PNG_1X1));

  // 不是图片 → 400
  const form2 = new FormData();
  form2.append('file', new Blob([Buffer.from('hello world')], { type: 'image/png' }), 'x.png');
  const notImg = await s.http('POST', '/api/me/avatar', { token, form: form2 });
  assert.equal(notImg.status, 400);

  const me = await s.api('GET', '/api/me', { token });
  assert.deepEqual(me.user, { id: login.user.id, nickname: '棋手😀', avatarUrl: up.user.avatarUrl });
  assert.equal(me.needProfile, false);
  assert.deepEqual(me.stats, { games: 0, wins: 0, losses: 0, draws: 0, winrate: 0, curStreak: 0, maxStreak: 0 });
  assert.deepEqual(me.ai, { games: 0, wins: 0 });
  assert.deepEqual(me.activeGameIds, []);

  // 未登录 / 令牌错误 → 401
  assert.equal((await s.http('GET', '/api/me')).status, 401);
  assert.equal((await s.http('GET', '/api/me', { token: 'f'.repeat(64) })).status, 401);

  // AI 难度表来自注入的 AI
  const levels = await s.api('GET', '/api/ai/levels');
  assert.equal(levels.available, true);
  assert.ok(levels.levels.length > 0 && levels.levels.every((l) => l.id && l.name));

  // 重启后令牌与资料仍在（真实数据库文件）
  await s.restart();
  const me2 = await s.api('GET', '/api/me', { token });
  assert.equal(me2.user.nickname, '棋手😀');
  assert.equal(me2.user.avatarUrl, up.user.avatarUrl);
  s.noErrors();
});

test('排位全流程：提子 → 双方 pass → 数子建议 → 点选 → 确认 → 统计 → 排行榜与棋谱；认输计入；短局不计入；只计一次', async (t) => {
  // 死子建议故意给空：玩家点选白 20 为死子后黑胜（点选改变胜负）
  const ai = createFakeAi({ dead: [] });
  const s = await startStack({ ai, config: { minGamesWinrate: 2 } });
  t.after(() => s.close());

  const ann = await s.player('device-ann-01', 'Ann');
  const ben = await s.player('device-ben-01', 'Ben');
  assert.deepEqual(ann.hello, { activeGames: [], room: null, matching: null });

  // ---------- 第 1 局：完整数子 ----------
  const g = await matchPair(ann, ben, 9);
  const snap = g.snap;
  assert.equal(snap.mode, 'ranked');
  assert.equal(snap.size, 9);
  assert.equal(snap.komi, 7.5);
  assert.equal(snap.status, 'playing');
  assert.equal(snap.toPlay, 1);
  assert.deepEqual(snap.timeControl, { mainMs: 180000, periods: 3, periodMs: 20000 });
  assert.equal(snap.clocks.running, 1);
  assert.deepEqual(snap.presence, { 1: true, 2: true });
  assert.equal(snap.players[1].nickname, g[1].nickname);
  assert.equal(snap.players[2].userId, g[2].id);

  // 进行中的对局出现在 /api/me 与 hello 里
  assert.deepEqual((await s.api('GET', '/api/me', { token: ann.token })).activeGameIds, [g.gameId]);
  assert.deepEqual((await ann.c.req('hello')).activeGames, [{ id: g.gameId, mode: 'ranked' }]);
  // 已在对局中不能再匹配
  await assert.rejects(ann.c.req('match.join', { size: 9 }), (e) => e.code === 'in_game');

  // 越权与错误请求
  await assert.rejects(g[2].c.req('game.move', { gameId: g.gameId, n: 1, idx: 0 }), (e) => e.code === 'not_your_turn');
  await assert.rejects(g[1].c.req('game.move', { gameId: g.gameId, n: 2, idx: 0 }), (e) => e.code === 'stale' && e.err.expected === 1);

  const pushes = await playMoves(g, SCRIPT_CAPTURE);
  const cap = pushes[CAPTURE_N - 1];
  assert.deepEqual(cap.captured, [CAPTURED_IDX]);
  assert.equal(cap.clocks.running, 2);
  // 占着的点 → illegal（带 reason）
  await sleep(40);
  await assert.rejects(
    g[2].c.req('game.move', { gameId: g.gameId, n: CAPTURE_N + 1, idx: 4 }),
    (e) => e.code === 'illegal' && e.err.reason === 'occupied',
  );
  await playMoves(g, [-1, -1], CAPTURE_N + 1);

  // 数子阶段：先 pending，再是 AI 建议（version 1，无死子）
  const pend = await g[1].c.waitFor('game.scoring');
  assert.equal(pend.scoring.pending, true);
  const prop = await g[1].c.waitFor('game.scoring', { filter: (m) => !m.scoring.pending });
  assert.equal(prop.scoring.version, 1);
  assert.equal(prop.scoring.source, 'katago');
  assert.deepEqual(prop.scoring.dead, []);
  assert.equal(prop.scoring.owner.length, 81);
  assert.equal(prop.scoring.winner, 2, '白 20 算活时白胜');
  assert.ok(prop.scoring.deadline > 170000 && prop.scoring.deadline <= 180000);
  assert.equal(ai.calls.judgeDead.length, 1);
  assert.equal(ai.calls.judgeDead[0].moves.length, CAPTURE_N + 2);

  // 数子阶段 game.sync 快照
  const scSnap = (await g[2].c.req('game.sync', { gameId: g.gameId })).game;
  assert.equal(scSnap.status, 'scoring');
  assert.equal(scSnap.clocks.running, null);
  assert.equal(scSnap.scoring.version, 1);

  // 黑方确认 v1，然后白方点选白 20 为死子 → v2，双方确认清零
  await sleep(40);
  await g[1].c.req('game.score.accept', { gameId: g.gameId, version: 1 });
  const acc1 = await g[2].c.waitFor('game.scoring', { filter: (m) => m.scoring.accepted[1] });
  assert.equal(acc1.scoring.version, 1);
  await g[2].c.req('game.score.toggle', { gameId: g.gameId, idx: DEAD_WHITE });
  const v2 = await g[1].c.waitFor('game.scoring', { filter: (m) => m.scoring.version === 2 });
  assert.deepEqual(v2.scoring.dead, [DEAD_WHITE]);
  assert.deepEqual(v2.scoring.accepted, { 1: false, 2: false });
  assert.equal(v2.scoring.black, 45);
  assert.equal(v2.scoring.white, 43.5);
  assert.equal(v2.scoring.winner, 1);
  assert.equal(v2.scoring.owner[DEAD_WHITE], 1);
  // 过期版本 → stale（带当前版本）
  await assert.rejects(
    g[1].c.req('game.score.accept', { gameId: g.gameId, version: 1 }),
    (e) => e.code === 'stale' && e.err.version === 2,
  );
  await sleep(40);
  await g[1].c.req('game.score.accept', { gameId: g.gameId, version: 2 });
  await g[2].c.req('game.score.accept', { gameId: g.gameId, version: 2 });
  const end = await g[1].c.waitFor('game.end');
  const end2 = await g[2].c.waitFor('game.end');
  assert.deepEqual(end, end2);
  assert.deepEqual(end.result, {
    winner: 1,
    reason: 'score',
    black: 45,
    white: 43.5,
    text: 'B+1.5',
    label: '黑胜 1.5 目',
    counted: true,
    cause: 'agreed',
    uncounted: null,
    pending: false,
  });
  assert.deepEqual(end.stats[1], { games: 1, wins: 1, losses: 0, draws: 0, winrate: 1, curStreak: 1, maxStreak: 1 });
  assert.deepEqual(end.stats[2], { games: 1, wins: 0, losses: 1, draws: 0, winrate: 0, curStreak: 0, maxStreak: 0 });

  const winner = g[1];
  const loser = g[2];

  // 终局后 sync 仍可用
  const endSnap = (await loser.c.req('game.sync', { gameId: g.gameId })).game;
  assert.equal(endSnap.status, 'ended');
  assert.equal(endSnap.result.text, 'B+1.5');
  assert.deepEqual(endSnap.scoring.dead, [DEAD_WHITE]);
  await assert.rejects(loser.c.req('game.resign', { gameId: g.gameId }), (e) => e.code === 'wrong_phase');

  // 数据库：counted=1
  const row = s.repos.games.findById(g.gameId);
  assert.equal(row.status, 'ended');
  assert.equal(row.counted, true);
  assert.deepEqual(row.dead, [DEAD_WHITE]);
  assert.equal(row.resultText, 'B+1.5');

  // 棋谱
  const list = await s.api('GET', '/api/games', { token: winner.token });
  assert.equal(list.items.length, 1);
  assert.equal(list.next, null);
  const item = list.items[0];
  assert.equal(item.id, g.gameId);
  assert.equal(item.mode, 'ranked');
  assert.equal(item.myColor, 1);
  assert.equal(item.myResult, 'win');
  assert.equal(item.resultText, 'B+1.5');
  assert.equal(item.moveCount, CAPTURE_N + 2);
  assert.deepEqual(item.opponent, { id: loser.id, nickname: loser.nickname, avatarUrl: '' });
  const rec = await s.api('GET', `/api/games/${g.gameId}`, { token: loser.token });
  assert.equal(rec.myResult, 'loss');
  assert.equal(rec.myColor, 2);
  assert.deepEqual(rec.moves, [...SCRIPT_CAPTURE, -1, -1]);
  assert.deepEqual(rec.dead, [DEAD_WHITE]);
  assert.equal(rec.komi, 7.5);
  assert.equal(rec.scoreBlack, 45);
  assert.equal(rec.scoreWhite, 43.5);
  assert.deepEqual(rec.players[1], { userId: winner.id, nickname: winner.nickname, avatarUrl: '' });
  assert.deepEqual(rec.players[2], { userId: loser.id, nickname: loser.nickname, avatarUrl: '' });
  // 第三人看不到
  const carol = await s.login('device-carol-1', 'Carol');
  assert.equal((await s.http('GET', `/api/games/${g.gameId}`, { token: carol.token })).status, 404);

  // ---------- 第 2 局：认输（≥10 手，计入）→ 同一人连胜 2 ----------
  const g2 = await matchPair(ann, ben, 9);
  await playMoves(g2, [40, 41, 30, 31, 20, 21, 10, 11, 0, 1]);
  const w2 = g2[1].id === winner.id ? 1 : 2;
  await sleep(40);
  await g2[3 - w2].c.req('game.resign', { gameId: g2.gameId });
  const e2 = await g2[w2].c.waitFor('game.end');
  assert.equal(e2.result.reason, 'resign');
  assert.equal(e2.result.winner, w2);
  assert.equal(e2.result.counted, true);
  assert.equal(e2.stats[w2].curStreak, 2);
  assert.equal(e2.stats[w2].maxStreak, 2);
  assert.equal(e2.stats[w2].games, 2);
  assert.equal(e2.stats[3 - w2].losses, 2);
  await g2[3 - w2].c.waitFor('game.end');

  // ---------- 第 3 局：自己还一手没下就认输（相当于拒绝这盘棋）→ 不计入，统计不变（仍附 stats） ----------
  const g3 = await matchPair(ann, ben, 9);
  const w3 = g3[1].id === loser.id ? 1 : 2; // 这次让原来的输家赢
  if (3 - w3 === 2) await playMoves(g3, [40]); // 认输的是白：黑先下一手，白还没下
  await sleep(40);
  await g3[3 - w3].c.req('game.resign', { gameId: g3.gameId });
  const e3 = await g3[w3].c.waitFor('game.end');
  assert.equal(e3.result.reason, 'resign');
  assert.equal(e3.result.counted, false);
  assert.equal(e3.result.uncounted, 'short');
  assert.equal(e3.stats[w3].wins, 0, '不计入：赢家统计不变');
  assert.equal(e3.stats[3 - w3].curStreak, 2, '不计入：连胜不断');
  await g3[3 - w3].c.waitFor('game.end');
  assert.equal(s.repos.games.findById(g3.gameId).counted, false);

  // ---------- 排行榜 ----------
  const streak = await s.api('GET', '/api/leaderboard?type=streak', { token: winner.token });
  assert.equal(streak.type, 'streak');
  assert.equal(streak.minGames, 2);
  assert.deepEqual(streak.items, [
    { rank: 1, userId: winner.id, nickname: winner.nickname, avatarUrl: '', value: 2, games: 2, wins: 2 },
  ]);
  assert.deepEqual(streak.me, { rank: 1, value: 2, games: 2, wins: 2, need: 0 });
  const maxS = await s.api('GET', '/api/leaderboard?type=maxStreak', { token: loser.token });
  assert.equal(maxS.items.length, 1);
  assert.equal(maxS.items[0].value, 2);
  assert.deepEqual(maxS.me, { rank: null, value: 0, games: 2, wins: 0, need: 0 });
  const wr = await s.api('GET', '/api/leaderboard?type=winrate&limit=10', { token: loser.token });
  assert.deepEqual(
    wr.items.map((i) => [i.rank, i.userId, i.value, i.games, i.wins]),
    [
      [1, winner.id, 1, 2, 2],
      [2, loser.id, 0, 2, 0],
    ],
  );
  assert.deepEqual(wr.me, { rank: 2, value: 0, games: 2, wins: 0, need: 0 });
  const wrCarol = await s.api('GET', '/api/leaderboard?type=winrate', { token: carol.token });
  assert.deepEqual(wrCarol.me, { rank: null, value: 0, games: 0, wins: 0, need: 2 });
  assert.equal((await s.http('GET', '/api/leaderboard?type=bogus', { token: carol.token })).status, 400);

  // /api/me 的统计与棋谱列表（3 局，倒序；分页）
  const meW = await s.api('GET', '/api/me', { token: winner.token });
  assert.deepEqual(meW.stats, { games: 2, wins: 2, losses: 0, draws: 0, winrate: 1, curStreak: 2, maxStreak: 2 });
  assert.deepEqual(meW.activeGameIds, []);
  const page1 = await s.api('GET', '/api/games?limit=2', { token: winner.token });
  assert.deepEqual(page1.items.map((i) => i.id), [g3.gameId, g2.gameId]);
  assert.equal(page1.items[0].myResult, 'loss');
  assert.equal(typeof page1.next, 'number');
  const page2 = await s.api('GET', `/api/games?limit=2&before=${page1.next}`, { token: winner.token });
  assert.deepEqual(page2.items.map((i) => i.id), [g.gameId]);
  assert.equal(page2.next, null);

  // ---------- 统计只计一次 ----------
  assert.equal(s.repos.stats.applyRanked({ gameId: g.gameId, winnerId: winner.id, loserId: loser.id }), false);
  const before = s.repos.stats.get(winner.id);
  await s.restart(); // 重启不会重放终局
  await s.reconnect(ann);
  await s.reconnect(ben);
  assert.deepEqual(ann.hello.activeGames, []);
  const after = s.repos.stats.get(winner.id);
  assert.deepEqual(after, before);
  // 重启后已结束的对局从数据库重建快照
  const old = (await winner.c.req('game.sync', { gameId: g.gameId })).game;
  assert.equal(old.status, 'ended');
  assert.equal(old.result.text, 'B+1.5');
  assert.equal(old.result.counted, true);
  assert.deepEqual(old.scoring.dead, [DEAD_WHITE]);
  assert.deepEqual(s.repos.stats.get(winner.id), before);
  s.noErrors();
});
