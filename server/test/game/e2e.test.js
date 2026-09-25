'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startServer, testConfig, createTestLogger } = require('./helpers/setup');
const { createFakeAi } = require('../helpers/fake-ai');
const { createMemoryRepos } = require('../helpers/memory-repos');
const { TestClient } = require('../helpers/ws-client');
const { createRealtime } = require('../../src/realtime');

// 端到端：真实 http 服务器（端口 0）+ createRealtime + 内存仓储 + 假 AI + 真实 ws 客户端

// 9 路：黑墙 x=4，白墙 x=5，黑地里一颗白死子（10）。标记 10 为死子 → B+1.5
const WALL = [4, 5, 13, 14, 22, 23, 31, 32, 40, 41, 49, 50, 58, 59, 67, 68, 76, 77, 72, 10];

function noErrors(srv) {
  assert.deepEqual(srv.logger.logs.error, [], '服务端不应有 error 日志');
}

// 双方 game.sync，按执子颜色返回 { 1: player, 2: player }
async function syncBoth(a, b, gameId) {
  const ga = (await a.c.req('game.sync', { gameId })).game;
  const gb = (await b.c.req('game.sync', { gameId })).game;
  assert.equal(ga.myColor + gb.myColor, 3);
  return ga.myColor === 1 ? { 1: a, 2: b, snap: ga } : { 1: b, 2: a, snap: gb };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 按手数轮流下；双方都要收到 game.move 推送。
// 每手间隔一点时间：服务端限流每连接每秒 20 条，真实客户端不会这么快。
async function playMoves(byColor, gameId, moves, startN = 1) {
  let n = startN;
  for (const idx of moves) {
    await sleep(60);
    const color = n % 2 === 1 ? 1 : 2;
    const p = byColor[color];
    if (idx === -1) await p.c.req('game.pass', { gameId, n });
    else await p.c.req('game.move', { gameId, n, idx });
    for (const c of [1, 2]) {
      const m = await byColor[c].c.waitFor('game.move', { filter: (x) => x.gameId === gameId && x.n === n });
      assert.equal(m.idx, idx);
      assert.equal(m.color, color);
    }
    n += 1;
  }
  return n;
}

test('鉴权：无令牌、令牌无效 → 401；路径不对 → 404；hello 与 ping', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  await assert.rejects(TestClient.connect(srv.wsUrl), (err) => err.statusCode === 401 && /unauthorized/.test(err.body));
  await assert.rejects(TestClient.connect(srv.wsUrl, { token: 'nope' }), (err) => err.statusCode === 401);
  const u = srv.user('Ann');
  await assert.rejects(TestClient.connect(srv.wsUrl.replace('/ws', '/other'), { token: u.token }), (err) => err.statusCode === 404);
  srv.repos.sessions.revoke(u.token);
  await assert.rejects(TestClient.connect(srv.wsUrl, { token: u.token }), (err) => err.statusCode === 401);

  const v = srv.user('Ben');
  const c = await srv.connect(v.token);
  assert.deepEqual(await c.req('hello'), { activeGames: [], room: null, matching: null });
  c.send({ t: 'ping', rid: 99 });
  const pong = await c.waitFor('pong');
  assert.equal(typeof pong.ts, 'number');
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!c.log.some((m) => m.t === 'res' && m.rid === 99), 'ping 不回 res');
  noErrors(srv);
});

test('排位赛全流程：匹配 → 落子 → pass → 数子（建议、点选、确认）→ 终局与统计', async (t) => {
  const srv = await startServer({ ai: createFakeAi({ dead: [10] }) });
  t.after(() => srv.close());
  const a = await srv.player('Ann');
  const b = await srv.player('Ben');
  assert.deepEqual(await a.c.req('match.join', { size: 9 }), { size: 9 });
  assert.deepEqual((await a.c.req('hello')).matching, { size: 9 });
  const res = await b.c.request('match.join', { size: 9 });
  assert.deepEqual(res.data, { size: 9 });
  const fa = await a.c.waitFor('match.found');
  const fb = await b.c.waitFor('match.found');
  assert.equal(fa.gameId, fb.gameId);
  // res 先于它引起的推送
  const log = b.c.log;
  assert.ok(log.indexOf(res) < log.findIndex((m) => m.t === 'match.found'));
  const gameId = fa.gameId;
  assert.deepEqual(srv.realtime.activeGamesOf(a.id), [{ id: gameId, mode: 'ranked' }]);
  assert.deepEqual((await a.c.req('hello')).activeGames, [{ id: gameId, mode: 'ranked' }]);

  const p = await syncBoth(a, b, gameId);
  assert.equal(p.snap.mode, 'ranked');
  assert.equal(p.snap.status, 'playing');
  assert.deepEqual(p.snap.timeControl, { mainMs: 180000, periods: 3, periodMs: 20000 });
  assert.equal(p.snap.clocks.running, 1);
  assert.deepEqual(p.snap.presence, { 1: true, 2: true });
  assert.equal(p.snap.players[1].userId, p[1].id);
  assert.equal(p.snap.players[2].nickname, p[2].user.nickname);

  // 错误：不是自己的回合 / 手数不对 / 非法 / 已在对局中
  assert.equal((await p[2].c.request('game.move', { gameId, n: 1, idx: 0 })).err.code, 'not_your_turn');
  assert.equal((await p[1].c.request('game.move', { gameId, n: 2, idx: 0 })).err.code, 'stale');
  assert.equal((await a.c.request('match.join', { size: 13 })).err.code, 'in_game');

  let n = await playMoves(p, gameId, WALL);
  const illegal = await p[1].c.request('game.move', { gameId, n, idx: 4 });
  assert.equal(illegal.err.code, 'illegal');
  assert.equal(illegal.err.reason, 'occupied');
  n = await playMoves(p, gameId, [-1, -1], n);

  const pending = await p[1].c.waitFor('game.scoring', { filter: (m) => m.scoring.pending });
  assert.equal(pending.scoring.version, 0);
  const prop = await p[2].c.waitFor('game.scoring', { filter: (m) => !m.scoring.pending });
  assert.equal(prop.scoring.source, 'katago');
  assert.deepEqual(prop.scoring.dead, [10]);
  assert.equal(prop.scoring.winner, 1);
  assert.ok(prop.scoring.deadline > 170000 && prop.scoring.deadline <= 180000);
  assert.equal(prop.scoring.owner.length, 81);
  p[1].c.drain('game.scoring');
  p[2].c.drain('game.scoring');

  // 数子阶段不能落子
  assert.equal((await p[1].c.request('game.move', { gameId, n, idx: 0 })).err.code, 'wrong_phase');
  // 白方点选 10 为活 → 版本 2，确认清零
  await p[2].c.req('game.score.toggle', { gameId, idx: 10 });
  const t2 = await p[1].c.waitFor('game.scoring');
  assert.equal(t2.scoring.version, 2);
  assert.deepEqual(t2.scoring.dead, []);
  assert.equal(t2.scoring.winner, 2);
  assert.equal((await p[1].c.request('game.score.accept', { gameId, version: 1 })).err.code, 'stale');
  // 黑方再点回去 → 版本 3
  await p[1].c.req('game.score.toggle', { gameId, idx: 10 });
  const t3 = await p[2].c.waitFor('game.scoring', { filter: (m) => m.scoring.version === 3 });
  assert.deepEqual(t3.scoring.dead, [10]);
  await p[1].c.req('game.score.accept', { gameId, version: 3 });
  const acc = await p[2].c.waitFor('game.scoring', { filter: (m) => m.scoring.accepted[1] });
  assert.deepEqual(acc.scoring.accepted, { 1: true, 2: false });
  await p[2].c.req('game.score.accept', { gameId, version: 3 });

  for (const c of [1, 2]) {
    const end = await p[c].c.waitFor('game.end');
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
  }
  const row = await srv.repos.games.findById(gameId);
  assert.equal(row.status, 'ended');
  assert.equal(row.resultText, 'B+1.5');
  assert.deepEqual(row.dead, [10]);
  assert.equal(row.counted, true);
  assert.equal(srv.repos.callsOf('stats.applyRanked').length, 1);
  assert.deepEqual((await a.c.req('hello')).activeGames, []);
  // 终局后仍可同步到结果
  const after = (await p[2].c.req('game.sync', { gameId })).game;
  assert.equal(after.status, 'ended');
  assert.equal(after.result.text, 'B+1.5');
  assert.equal((await p[2].c.request('game.resign', { gameId })).err.code, 'wrong_phase');
  noErrors(srv);
});

test('认输与继续对局：数子阶段继续对局后再认输', async (t) => {
  const srv = await startServer({ ai: createFakeAi({ available: false }) });
  t.after(() => srv.close());
  const a = await srv.player('Ann');
  const b = await srv.player('Ben');
  await a.c.req('match.join', { size: 9 });
  await b.c.req('match.join', { size: 9 });
  const { gameId } = await a.c.waitFor('match.found');
  const p = await syncBoth(a, b, gameId);
  let n = await playMoves(p, gameId, [40, -1, -1]);
  const manual = await p[1].c.waitFor('game.scoring', { filter: (m) => !m.scoring.pending });
  assert.equal(manual.scoring.source, 'manual');
  await p[1].c.req('game.score.resume', { gameId });
  for (const c of [1, 2]) {
    const r = await p[c].c.waitFor('game.resumed');
    assert.equal(r.toPlay, 2);
    assert.equal(r.clocks.running, 2);
  }
  n = await playMoves(p, gameId, [41], n);
  await p[1].c.req('game.resign', { gameId });
  const end = await p[2].c.waitFor('game.end');
  assert.equal(end.result.winner, 2);
  assert.equal(end.result.reason, 'resign');
  assert.equal(end.result.counted, true); // 双方都下过：早早认输也计入（COMP-5）
  assert.equal(srv.repos.callsOf('stats.applyRanked').length, 1);
  noErrors(srv);
});

test('好友房：创建 → 查看 → 加入即开局；离开；过期推送 room.update', async (t) => {
  const srv = await startServer({ config: { roomTtlMs: 300 } });
  t.after(() => srv.close());
  const owner = await srv.player('Owner');
  const guest = await srv.player('Guest');
  const other = await srv.player('Other');
  const { room } = await owner.c.req('room.create', { size: 13, color: 'black' });
  assert.match(room.code, /^\d{6}$/);
  assert.equal(room.status, 'waiting');
  assert.deepEqual(room.owner, { userId: owner.id, nickname: 'Owner', avatarUrl: '' });
  assert.deepEqual((await owner.c.req('hello')).room.code, room.code);
  assert.equal((await guest.c.req('room.get', { code: room.code })).room.code, room.code);
  await other.c.req('room.get', { code: room.code });
  assert.equal((await guest.c.request('room.get', { code: '000000' === room.code ? '000001' : '000000' })).err.code, 'room_not_found');
  assert.equal((await owner.c.request('room.join', { code: room.code })).err.code, 'own_room');
  const { gameId } = await guest.c.req('room.join', { code: room.code });
  for (const c of [owner.c, guest.c]) assert.deepEqual(await c.waitFor('game.start'), { t: 'game.start', gameId, mode: 'friend' });
  const closed = await other.c.waitFor('room.update');
  assert.equal(closed.room.status, 'closed');
  const snap = (await owner.c.req('game.sync', { gameId })).game;
  assert.equal(snap.mode, 'friend');
  assert.equal(snap.size, 13);
  assert.equal(snap.myColor, 1);
  assert.deepEqual(snap.timeControl, { mainMs: 360000, periods: 3, periodMs: 30000 });
  assert.equal((await other.c.request('room.join', { code: room.code })).err.code, 'room_not_found');

  // 离开：关闭自己的房间
  const r2 = (await other.c.req('room.create', { size: 9, color: 'random' })).room;
  await other.c.req('room.leave');
  assert.equal((await guest.c.request('room.get', { code: r2.code })).err.code, 'room_not_found');
  await other.c.req('room.leave');

  // 过期：房主收到 closed
  const r3 = (await other.c.req('room.create', { size: 19, color: 'white' })).room;
  const exp = await other.c.waitFor('room.update', { timeout: 2000 });
  assert.equal(exp.room.code, r3.code);
  assert.equal(exp.room.status, 'closed');
  assert.equal(exp.room.expiresIn, 0);
  assert.equal((await other.c.req('hello')).room, null);
  noErrors(srv);
});

test('人机对局：落子、AI 应手、悔棋、pass 后数子、确认终局', async (t) => {
  const srv = await startServer({ ai: createFakeAi({ dead: [] }) });
  t.after(() => srv.close());
  const a = await srv.player('Ann');
  assert.equal((await a.c.request('ai.start', { size: 9, level: 'nope', color: 'black' })).err.code, 'bad_request');
  const { gameId } = await a.c.req('ai.start', { size: 9, level: 'k5', color: 'black' });
  const snap = (await a.c.req('game.sync', { gameId })).game;
  assert.equal(snap.mode, 'ai');
  assert.equal(snap.myColor, 1);
  assert.deepEqual(snap.players[2], { ai: true, level: 'k5', nickname: 'AI · 5级', avatarUrl: '' });
  assert.equal(snap.timeControl, null);
  assert.equal(snap.canUndo, false);
  assert.deepEqual(snap.presence, { 1: true, 2: true });

  await a.c.req('game.move', { gameId, n: 1, idx: 40 });
  await a.c.waitFor('game.move', { filter: (m) => m.n === 1 });
  assert.equal((await a.c.waitFor('game.ai')).thinking, true);
  const aiMove = await a.c.waitFor('game.move', { filter: (m) => m.n === 2 });
  assert.equal(aiMove.color, 2);
  assert.equal(aiMove.clocks, null);
  assert.equal((await a.c.waitFor('game.ai')).thinking, false);
  assert.equal((await a.c.req('game.sync', { gameId })).game.canUndo, true);

  await a.c.req('game.undo', { gameId });
  assert.deepEqual((await a.c.waitFor('game.undo')).moves, []);
  assert.equal((await a.c.request('game.undo', { gameId })).err.code, 'nothing_to_undo');

  await a.c.req('game.move', { gameId, n: 1, idx: 30 });
  await a.c.waitFor('game.move', { filter: (m) => m.n === 2 });
  await a.c.req('game.pass', { gameId, n: 3 });
  const aiPass = await a.c.waitFor('game.move', { filter: (m) => m.n === 4 });
  assert.equal(aiPass.idx, -1);
  const sc = await a.c.waitFor('game.scoring', { filter: (m) => !m.scoring.pending });
  assert.deepEqual(sc.scoring.accepted, { 1: false, 2: true });
  assert.equal(sc.scoring.deadline, null);
  assert.equal((await a.c.request('game.score.toggle', { gameId, idx: 30 })).err.code, 'bad_request');
  await a.c.req('game.score.accept', { gameId, version: sc.scoring.version });
  const end = await a.c.waitFor('game.end');
  assert.equal(end.result.reason, 'score');
  assert.equal(end.result.counted, false);
  assert.equal(end.stats, undefined);
  noErrors(srv);
});

test('人机对局：再开一局会作废旧局；AI 不可用 → ai_unavailable', async (t) => {
  const ai = createFakeAi();
  const srv = await startServer({ ai });
  t.after(() => srv.close());
  const a = await srv.player('Ann');
  const g1 = (await a.c.req('ai.start', { size: 9, level: 'k10', color: 'white' })).gameId;
  await a.c.req('game.sync', { gameId: g1 });
  const g2 = (await a.c.req('ai.start', { size: 13, level: 'k10', color: 'random' })).gameId;
  const end = await a.c.waitFor('game.end', { filter: (m) => m.gameId === g1 });
  assert.equal(end.result.reason, 'abort');
  assert.deepEqual((await a.c.req('hello')).activeGames, [{ id: g2, mode: 'ai' }]);
  ai.set({ available: false });
  assert.equal((await a.c.request('ai.start', { size: 9, level: 'k10', color: 'black' })).err.code, 'ai_unavailable');
  noErrors(srv);
});

test('断线重连：对手收到上下线推送；重连后 hello 列出对局，sync 之前收不到该局推送', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const a = await srv.player('Ann');
  const b = await srv.player('Ben');
  await a.c.req('match.join', { size: 9 });
  await b.c.req('match.join', { size: 9 });
  const { gameId } = await a.c.waitFor('match.found');
  const p = await syncBoth(a, b, gameId);
  await playMoves(p, gameId, [40, 41, 42]);
  // 白掉线
  await p[2].c.close();
  const off = await p[1].c.waitFor('game.presence');
  assert.deepEqual({ ...off, clocks: undefined }, { t: 'game.presence', gameId, color: 2, online: false, clocks: undefined });
  assert.equal(off.clocks.running, 2, 'presence 附带读秒');
  // 重连
  const c2 = await srv.connect(p[2].token);
  const on = await p[1].c.waitFor('game.presence');
  assert.deepEqual({ ...on, clocks: undefined }, { t: 'game.presence', gameId, color: 2, online: true, clocks: undefined });
  const hello = await c2.req('hello');
  assert.deepEqual(hello.activeGames, [{ id: gameId, mode: 'ranked' }]);
  // 未 sync 前收不到该局推送
  await p[1].c.req('game.resign', { gameId });
  assert.equal((await p[1].c.waitFor('game.end')).result.winner, 2);
  await c2.expectNone('game.end', 100);
  noErrors(srv);
});

test('断线重连：game.sync 后继续收推送、继续下棋', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const a = await srv.player('Ann');
  const b = await srv.player('Ben');
  await a.c.req('match.join', { size: 9 });
  await b.c.req('match.join', { size: 9 });
  const { gameId } = await a.c.waitFor('match.found');
  const p = await syncBoth(a, b, gameId);
  await playMoves(p, gameId, [40, 41]);
  p[1].c.terminate();
  await p[2].c.waitFor('game.presence', { filter: (m) => !m.online });
  const c1 = await srv.connect(p[1].token);
  const snap = (await c1.req('game.sync', { gameId })).game;
  assert.deepEqual(snap.moves, [40, 41]);
  assert.equal(snap.myColor, 1);
  assert.equal(snap.toPlay, 1);
  assert.deepEqual(snap.presence, { 1: true, 2: true });
  const q = { 1: { ...p[1], c: c1 }, 2: p[2] };
  await playMoves(q, gameId, [42, 43], 3);
  noErrors(srv);
});

test('同一用户第二条连接顶替第一条：旧连接收到 kicked 并以 4001 关闭，不算掉线', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const a = await srv.player('Ann');
  const b = await srv.player('Ben');
  await a.c.req('match.join', { size: 9 });
  await b.c.req('match.join', { size: 9 });
  const { gameId } = await a.c.waitFor('match.found');
  await syncBoth(a, b, gameId);
  const a2 = await srv.connect(a.token);
  assert.deepEqual(await a.c.waitFor('kicked'), { t: 'kicked', reason: 'replaced' });
  const info = await a.c.closed;
  assert.equal(info.code, 4001);
  await b.c.expectNone('game.presence', 100);
  assert.deepEqual((await a2.req('hello')).activeGames, [{ id: gameId, mode: 'ranked' }]);
  const snap = (await a2.req('game.sync', { gameId })).game;
  assert.equal(snap.presence[snap.myColor], true);
  noErrors(srv);
});

test('非对局者不能查看或操作别人的对局', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const a = await srv.player('Ann');
  const b = await srv.player('Ben');
  const x = await srv.player('Eve');
  await a.c.req('match.join', { size: 9 });
  await b.c.req('match.join', { size: 9 });
  const { gameId } = await a.c.waitFor('match.found');
  const p = await syncBoth(a, b, gameId);
  for (const [tp, params] of [
    ['game.sync', {}],
    ['game.move', { n: 1, idx: 40 }],
    ['game.pass', { n: 1 }],
    ['game.resign', {}],
    ['game.undo', {}],
    ['game.score.toggle', { idx: 1 }],
    ['game.score.accept', { version: 1 }],
    ['game.score.resume', {}],
  ]) {
    const r = await x.c.request(tp, { gameId, ...params });
    assert.equal(r.ok, false);
    assert.equal(r.err.code, 'not_player', tp);
  }
  assert.equal((await x.c.request('game.sync', { gameId: 'aaaaaaaaaaaa' })).err.code, 'not_found');
  await playMoves(p, gameId, [40]);
  await x.c.expectNone('game.move', 100);
  noErrors(srv);
});

test('畸形消息：坏 JSON、二进制被忽略；参数不对回 bad_request；未知类型；超大消息 1009', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const a = await srv.player('Ann');
  a.c.sendRaw('{not json');
  a.c.sendRaw(Buffer.from([1, 2, 3]));
  a.c.send([1, 2, 3]);
  a.c.send({ t: 'game.move', gameId: 'x' }); // 无 rid：不回复
  assert.deepEqual(await a.c.req('hello'), { activeGames: [], room: null, matching: null });
  const r1 = await a.c.request('game.teleport');
  assert.equal(r1.err.code, 'bad_request');
  const r2 = await a.c.request('match.join', { size: '9' });
  assert.equal(r2.err.code, 'bad_request');
  assert.equal(r2.err.field, 'size');
  a.c.send({ t: 'hello', rid: 'abc' });
  await new Promise((r) => setTimeout(r, 50));
  const echoed = a.c.log.find((m) => m.t === 'res' && m.rid === 'abc');
  assert.equal(echoed.ok, false);
  assert.equal(a.c.inbox.filter((m) => m.t !== 'res').length, 0);
  a.c.sendRaw(JSON.stringify({ t: 'hello', pad: 'x'.repeat(17 * 1024) }));
  const info = await a.c.closed;
  assert.equal(info.code, 1009);
  noErrors(srv);
});

test('限流：每秒超过 20 条消息以 4008 关闭', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const u = srv.user('Ann');
  const c = await srv.connect(u.token);
  for (let i = 0; i < 25; i++) c.send({ t: 'ping' });
  const info = await c.closed;
  assert.equal(info.code, 4008);
  assert.equal(c.log.filter((m) => m.t === 'pong').length, 20);
  // 按用户计：马上重连也还在同一个 1 秒窗口里，不能靠重连绕过
  const c2 = await srv.connect(u.token);
  c2.send({ t: 'ping' });
  assert.equal((await c2.closed).code, 4008);
  // 窗口过去之后正常
  await sleep(1100);
  const c3 = await srv.connect(u.token);
  await c3.req('hello');
});

test('心跳：连续两次没有 pong 就断开；正常客户端保持连接', async (t) => {
  const beats = [];
  const timers = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
    setInterval: (fn) => {
      beats.push(fn);
      return beats.length;
    },
    clearInterval: () => {},
  };
  const srv = await startServer({ timers });
  t.after(() => srv.close());
  // 第一个是 hub 的心跳，第二个是大厅限流表的定期清理
  assert.equal(beats.length, 2);
  const u1 = srv.user('Mute');
  const u2 = srv.user('Good');
  const mute = await srv.connect(u1.token, { autoPong: false });
  const good = await srv.connect(u2.token);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  beats[0]();
  await wait(50);
  beats[0]();
  await wait(50);
  assert.ok(mute.isOpen);
  beats[0]();
  const info = await mute.closed;
  assert.equal(info.code, 1006);
  assert.ok(good.isOpen);
  await good.req('hello');
});

test('realtime.close()：以 1001 关闭所有连接，之后拒绝新连接', async () => {
  const srv = await startServer();
  const u = srv.user('Ann');
  const c = await srv.connect(u.token);
  await srv.realtime.close();
  const info = await c.closed;
  assert.equal(info.code, 1001);
  await assert.rejects(TestClient.connect(srv.wsUrl, { token: u.token }));
  await srv.close();
});

test('createRealtime：参数校验；未提供 AI 时 ai.start → ai_unavailable；启动时恢复对局', async (t) => {
  const httpServer = http.createServer();
  assert.throws(() => createRealtime({ httpServer, repos: {}, config: testConfig() }), TypeError);
  assert.throws(() => createRealtime({ repos: createMemoryRepos(), config: testConfig() }), TypeError);
  assert.throws(
    () => createRealtime({ httpServer, repos: createMemoryRepos(), config: testConfig({ abandonMs: -1 }) }),
    TypeError,
  );

  const repos = createMemoryRepos();
  const u = repos.users.create({ openid: 'a', nickname: 'A' }, Date.now());
  const v = repos.users.create({ openid: 'b', nickname: 'B' }, Date.now());
  repos.games.insert({
    id: 'restored0001',
    mode: 'friend',
    size: 9,
    komi: 7.5,
    black_id: u.id,
    white_id: v.id,
    time_control: { mainMs: 180000, periods: 3, periodMs: 20000 },
    status: 'playing',
    moves: [40, 41],
    clocks: { running: 1, 1: { mainMs: 170000, periodsLeft: 3, periodMs: 20000 }, 2: { mainMs: 175000, periodsLeft: 3, periodMs: 20000 } },
    created_at: Date.now(),
  });
  const logger = createTestLogger();
  const rt = createRealtime({ httpServer, repos, config: testConfig(), logger });
  t.after(() => rt.close());
  assert.deepEqual(rt.activeGamesOf(u.id), [{ id: 'restored0001', mode: 'friend' }]);
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => httpServer.close(r)));
  const token = repos.sessions.create(u.id, Date.now());
  const c = await TestClient.connect(`ws://127.0.0.1:${httpServer.address().port}/ws`, { token });
  t.after(() => c.terminate());
  const snap = (await c.req('game.sync', { gameId: 'restored0001' })).game;
  assert.deepEqual(snap.moves, [40, 41]);
  assert.equal(snap.clocks[1].mainMs <= 170000, true);
  assert.equal(snap.clocks[2].mainMs, 175000);
  // 好友对局进行中不能开人机；认输之后 → AI 不可用
  assert.equal((await c.request('ai.start', { size: 9, level: 'k10', color: 'black' })).err.code, 'in_game');
  await c.req('game.resign', { gameId: 'restored0001' });
  assert.equal((await c.request('ai.start', { size: 9, level: 'k10', color: 'black' })).err.code, 'ai_unavailable');
  assert.deepEqual(logger.logs.error, []);
});
