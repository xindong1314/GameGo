'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeAi } = require('../helpers/fake-ai');
const { startStack, matchPair, syncPair, playMoves, sleep } = require('./helpers');

// 集成：超时（极短用时）、掉线弃局、好友房、人机对局（悔棋、AI pass 后数子）。

const TEN = [40, 41, 30, 31, 20, 21, 10, 11, 0, 1];

test('超时：极短用时，双方都下过就计入；读秒快照结构；超时的一方一手没下不计入', async (t) => {
  const s = await startStack({
    config: { timeControls: { 13: { mainMs: 1200, periods: 1, periodMs: 600 } } },
  });
  t.after(() => s.close());
  const a = await s.player('device-to-a1', 'Tia');
  const b = await s.player('device-to-b1', 'Tib');

  const g = await matchPair(a, b, 13);
  assert.deepEqual(g.snap.timeControl, { mainMs: 1200, periods: 1, periodMs: 600 });
  assert.deepEqual(g.snap.clocks[2], { mainMs: 1200, periodsLeft: 1, periodMs: 600 });
  assert.equal(g.snap.clocks.running, 1);
  const pushes = await playMoves(g, TEN, 1, { pace: 20 });
  const last = pushes[pushes.length - 1];
  assert.equal(last.clocks.running, 1);
  for (const c of [1, 2]) {
    assert.ok(last.clocks[c].mainMs <= 1200 && last.clocks[c].mainMs > 0, '基本时间在减少');
    assert.equal(last.clocks[c].periodsLeft, 1);
    assert.equal(last.clocks[c].periodMs, 600);
  }
  // 黑方不下：基本时间 + 一次读秒用完 → 超时负
  const end = await g[2].c.waitFor('game.end', { timeout: 4000 });
  assert.equal(end.result.reason, 'timeout');
  assert.equal(end.result.winner, 2);
  assert.equal(end.result.text, 'W+T');
  assert.equal(end.result.counted, true);
  assert.equal(end.stats[2].wins, 1);
  assert.equal(end.stats[1].losses, 1);
  await g[1].c.waitFor('game.end');
  // 超时之后再落子 → wrong_phase
  await assert.rejects(g[1].c.req('game.move', { gameId: g.gameId, n: 11, idx: 50 }), (e) => e.code === 'wrong_phase');

  // 白方一手没下就超时（相当于没开始）：不计入
  const g2 = await matchPair(a, b, 13);
  await playMoves(g2, [40], 1, { pace: 20 });
  const e2 = await g2[1].c.waitFor('game.end', { timeout: 4000 });
  assert.equal(e2.result.reason, 'timeout');
  assert.equal(e2.result.winner, 1, '白方（第 2 手）超时');
  assert.equal(e2.result.cause, 'clock');
  assert.equal(e2.result.counted, false);
  assert.equal(e2.result.uncounted, 'short');
  assert.equal(s.repos.games.findById(g2.gameId).counted, false);
  const statsA = (await s.api('GET', '/api/me', { token: g[2].token })).stats;
  assert.equal(statsA.games, 1, '第二局不计入');
  s.noErrors();
});

test('首手超时作废；轮到的一方掉线超过 abandonMs 判负', async (t) => {
  // 基本时间很短（掉线后要等基本时间用完与 abandonMs 两者中较晚的一个），读秒很长（不会先超时）
  const s = await startStack({
    config: { firstMoveTimeoutMs: 400, abandonMs: 400, timeControls: { 9: { mainMs: 300, periods: 5, periodMs: 3000 } } },
  });
  t.after(() => s.close());
  const a = await s.player('device-ab-a1', 'Aba');
  const b = await s.player('device-ab-b1', 'Abb');

  // 黑方 400ms 内不下第一手 → 作废
  const g = await matchPair(a, b, 9);
  const end = await g[1].c.waitFor('game.end', { timeout: 3000 });
  assert.equal(end.result.reason, 'abort');
  assert.equal(end.result.text, 'Void');
  assert.equal(end.result.counted, false);
  assert.ok(end.stats, '排位赛终局总是附统计');
  await g[2].c.waitFor('game.end');

  // 下满 10 手后轮到黑方，黑方掉线 → 对手收到离线 → 400ms 后判黑负
  const g2 = await matchPair(a, b, 9);
  await playMoves(g2, TEN, 1, { pace: 20 });
  await g2[1].c.terminate();
  const pres = await g2[2].c.waitFor('game.presence');
  assert.deepEqual({ color: pres.color, online: pres.online }, { color: 1, online: false });
  const e2 = await g2[2].c.waitFor('game.end', { timeout: 3000 });
  assert.equal(e2.result.reason, 'timeout');
  assert.equal(e2.result.winner, 2);
  assert.equal(e2.result.counted, true);
  s.noErrors();
});

test('好友房：创建 → 查看 → 加入 → 开局 → 认输（不计排行）', async (t) => {
  const s = await startStack();
  t.after(() => s.close());
  const owner = await s.player('device-room-o', 'Owner');
  const guest = await s.player('device-room-g', 'Guest');

  const { room } = await owner.c.req('room.create', { size: 9, color: 'white' });
  assert.match(room.code, /^\d{6}$/);
  assert.equal(room.status, 'waiting');
  assert.deepEqual(room.owner, { userId: owner.id, nickname: 'Owner', avatarUrl: '' });
  assert.equal(room.size, 9);
  assert.equal(room.color, 'white');
  assert.ok(room.expiresIn > 0 && room.expiresIn <= 1800000);
  assert.deepEqual((await owner.c.req('hello')).room.code, room.code);
  await assert.rejects(owner.c.req('room.join', { code: room.code }), (e) => e.code === 'own_room');
  const bogus = room.code === '000000' ? '000001' : '000000';
  await assert.rejects(guest.c.req('room.get', { code: bogus }), (e) => e.code === 'room_not_found');

  const got = await guest.c.req('room.get', { code: room.code });
  assert.equal(got.room.code, room.code);
  assert.equal(got.room.owner.nickname, 'Owner');
  const { gameId } = await guest.c.req('room.join', { code: room.code });
  const sa = await owner.c.waitFor('game.start');
  const sb = await guest.c.waitFor('game.start');
  assert.deepEqual(sa, { t: 'game.start', gameId, mode: 'friend' });
  assert.deepEqual(sb, sa);
  // 房间已关闭
  await assert.rejects(guest.c.req('room.get', { code: room.code }), (e) => e.code === 'room_not_found');
  assert.equal((await owner.c.req('hello')).room, null);

  const g = await syncPair(owner, guest, gameId);
  assert.equal(g[2].id, owner.id, '房主执白');
  assert.equal(g.snap.mode, 'friend');
  assert.ok(g.snap.timeControl, '好友对局计时');
  await playMoves(g, TEN);
  await sleep(40);
  await guest.c.req('game.resign', { gameId });
  const end = await owner.c.waitFor('game.end');
  assert.equal(end.result.winner, 2);
  assert.equal(end.result.reason, 'resign');
  assert.equal(end.result.counted, false);
  assert.equal(end.stats, undefined, '好友对局不附统计');
  await guest.c.waitFor('game.end');
  const me = await s.api('GET', '/api/me', { token: owner.token });
  assert.equal(me.stats.games, 0);
  const list = await s.api('GET', '/api/games', { token: owner.token });
  assert.equal(list.items[0].mode, 'friend');
  assert.equal(list.items[0].myResult, 'win');

  // 离开房间：room.leave 关闭，受邀者收到 room.update closed
  const r2 = (await owner.c.req('room.create', { size: 13, color: 'random' })).room;
  await guest.c.req('room.get', { code: r2.code });
  await owner.c.req('room.leave');
  const upd = await guest.c.waitFor('room.update');
  assert.equal(upd.room.code, r2.code);
  assert.equal(upd.room.status, 'closed');
  s.noErrors();
});

test('人机对局：AI 落子、悔棋、玩家 pass 后 AI pass → 数子（AI 自动同意）→ 确认终局', async (t) => {
  const ai = createFakeAi({ dead: [] });
  const s = await startStack({ ai });
  t.after(() => s.close());
  const p = await s.player('device-ai-p1', 'Human');

  await assert.rejects(p.c.req('ai.start', { size: 9, level: 'nope', color: 'black' }), (e) => e.code === 'bad_request');
  const { gameId } = await p.c.req('ai.start', { size: 9, level: 'k5', color: 'black' });
  assert.deepEqual((await p.c.req('hello')).activeGames, [{ id: gameId, mode: 'ai' }]);
  const snap = (await p.c.req('game.sync', { gameId })).game;
  assert.equal(snap.mode, 'ai');
  assert.equal(snap.myColor, 1);
  assert.deepEqual(snap.players[2], { ai: true, level: 'k5', nickname: 'AI · 5级', avatarUrl: '' });
  assert.equal(snap.players[1].nickname, 'Human');
  assert.equal(snap.timeControl, null);
  assert.equal(snap.clocks, null);
  assert.deepEqual(snap.presence, { 1: true, 2: true });
  assert.equal(snap.canUndo, false);
  await assert.rejects(p.c.req('game.undo', { gameId }), (e) => e.code === 'nothing_to_undo');

  // 玩家落子 → AI 思考 → AI 落子
  async function humanMove(n, idx) {
    await sleep(30);
    await p.c.req('game.move', { gameId, n, idx });
    const mine = await p.c.waitFor('game.move', { filter: (m) => m.n === n });
    assert.equal(mine.idx, idx);
    assert.equal(mine.clocks, null);
    await p.c.waitFor('game.ai', { filter: (m) => m.thinking === true });
    const reply = await p.c.waitFor('game.move', { filter: (m) => m.n === n + 1 });
    assert.equal(reply.color, 2);
    await p.c.waitFor('game.ai', { filter: (m) => m.thinking === false });
    return reply.idx;
  }
  const r1 = await humanMove(1, 40);
  const r2 = await humanMove(3, 30);
  assert.equal(ai.calls.chooseMove.length, 2);
  assert.deepEqual(ai.calls.chooseMove[1].moves, [40, r1, 30]);
  assert.equal(ai.calls.chooseMove[1].color, 2);
  assert.equal(ai.calls.chooseMove[1].level, 'k5');
  assert.equal(ai.calls.chooseMove[1].humanJustPassed, false);

  // 悔棋：撤回玩家最近一手及 AI 应手
  await sleep(30);
  await p.c.req('game.undo', { gameId });
  const u = await p.c.waitFor('game.undo');
  assert.deepEqual(u.moves, [40, r1]);
  const afterUndo = (await p.c.req('game.sync', { gameId })).game;
  assert.deepEqual(afterUndo.moves, [40, r1]);
  assert.equal(afterUndo.toPlay, 1);
  assert.equal(afterUndo.canUndo, true);
  void r2;

  // 玩家 pass → AI（humanJustPassed）pass → 数子
  await sleep(30);
  await p.c.req('game.pass', { gameId, n: 3 });
  await p.c.waitFor('game.move', { filter: (m) => m.n === 3 && m.idx === -1 });
  const aiPass = await p.c.waitFor('game.move', { filter: (m) => m.n === 4 });
  assert.equal(aiPass.idx, -1);
  assert.equal(ai.calls.chooseMove[ai.calls.chooseMove.length - 1].humanJustPassed, true);
  const prop = await p.c.waitFor('game.scoring', { filter: (m) => !m.scoring.pending });
  assert.equal(prop.scoring.accepted[2], true, 'AI 一方自动同意');
  assert.equal(prop.scoring.accepted[1], false);
  assert.equal(prop.scoring.deadline, null, '人机没有自动确认时限');
  // 人机不允许点选
  await assert.rejects(p.c.req('game.score.toggle', { gameId, idx: 40 }), (e) => e.code === 'bad_request');

  // 数子阶段悔棋 = 撤回 pass 回到对局
  await sleep(30);
  await p.c.req('game.undo', { gameId });
  const u2 = await p.c.waitFor('game.undo');
  assert.deepEqual(u2.moves, [40, r1]);
  const back = (await p.c.req('game.sync', { gameId })).game;
  assert.equal(back.status, 'playing');
  assert.equal(back.scoring, null);

  // 再次 pass → 数子 → 确认
  await sleep(30);
  await p.c.req('game.pass', { gameId, n: 3 });
  const prop2 = await p.c.waitFor('game.scoring', { filter: (m) => !m.scoring.pending });
  await sleep(30);
  await p.c.req('game.score.accept', { gameId, version: prop2.scoring.version });
  const end = await p.c.waitFor('game.end');
  assert.equal(end.result.reason, 'score');
  assert.equal(end.result.counted, false);
  assert.equal(end.stats, undefined);
  const me = await s.api('GET', '/api/me', { token: p.token });
  assert.equal(me.stats.games, 0, '人机不计排位');
  assert.deepEqual(me.ai, { games: 1, wins: end.result.winner === 1 ? 1 : 0 });
  const rec = await s.api('GET', `/api/games/${gameId}`, { token: p.token });
  assert.deepEqual(rec.opponent, { ai: true, level: 'k5', levelName: '5级' });
  assert.deepEqual(rec.players[2], { ai: true, level: 'k5', nickname: 'AI · 5级', avatarUrl: '' });
  assert.deepEqual(rec.moves, [40, r1, -1, -1]);

  // 新开一局人机会作废旧的：玩家下过子的保留作废记录，一手没下的直接删除
  await sleep(1000); // 本测试前面发得很快，别碰到每秒 20 条的限流
  const { gameId: g2 } = await p.c.req('ai.start', { size: 9, level: 'k10', color: 'white' });
  await sleep(50);
  const { gameId: g3 } = await p.c.req('ai.start', { size: 9, level: 'k10', color: 'white' });
  assert.notEqual(g2, g3);
  assert.equal(s.repos.games.findById(g2), null, '玩家一手没下：记录删除');
  await sleep(50);
  const snap3 = (await p.c.req('game.sync', { gameId: g3 })).game;
  assert.equal(snap3.moves.length, 1, 'AI 执黑先下');
  await sleep(30);
  await p.c.req('game.move', { gameId: g3, n: 2, idx: snap3.moves[0] === 40 ? 41 : 40 });
  await sleep(50);
  const { gameId: g4 } = await p.c.req('ai.start', { size: 9, level: 'k10', color: 'black' });
  assert.notEqual(g4, g3);
  assert.equal(s.repos.games.findById(g3).reason, 'abort');
  s.noErrors();
});
