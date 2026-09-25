'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Matchmaker } = require('../../src/game/matchmaker');
const { RoomRegistry } = require('../../src/game/rooms');
const { Lobby } = require('../../src/game/lobby');
const { GameError } = require('../../src/game/errors');
const { createFakeClock } = require('./helpers/fake-clock');
const { setupManager } = require('./helpers/setup');

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof GameError, `应为 GameError：${err && err.stack}`);
    return err.code;
  }
  assert.fail('应当抛错');
}

// ---------- Matchmaker ----------

test('匹配：按路数先进先出配对', () => {
  const m = new Matchmaker();
  assert.deepEqual(m.join(1, 9), { size: 9, pair: null });
  assert.deepEqual(m.join(2, 13), { size: 13, pair: null });
  assert.deepEqual(m.join(3, 9), { size: 9, pair: [1, 3] });
  assert.equal(m.statusOf(1), null);
  assert.deepEqual(m.statusOf(2), { size: 13 });
  assert.equal(m.queueLength(9), 0);
  assert.throws(() => m.join(4, 7), TypeError);
});

test('匹配：同一用户只在一个队列；重复加入同一路数保持位置；取消', () => {
  const m = new Matchmaker();
  m.join(1, 9);
  assert.deepEqual(m.join(1, 9), { size: 9, pair: null });
  assert.equal(m.queueLength(9), 1);
  m.join(1, 19); // 换到 19 路
  assert.equal(m.queueLength(9), 0);
  assert.deepEqual(m.statusOf(1), { size: 19 });
  assert.equal(m.cancel(1), true);
  assert.equal(m.cancel(1), false);
  assert.equal(m.queueLength(19), 0);
  m.join(5, 9);
  m.requeueFront(6, 9);
  assert.deepEqual(m.join(7, 9).pair, [6, 5]);
  m.join(8, 9);
  m.clear();
  assert.equal(m.statusOf(8), null);
});

// ---------- RoomRegistry ----------

function registry(opts = {}) {
  const clock = createFakeClock();
  const expired = [];
  let codes = opts.codes ? [...opts.codes] : null;
  const rooms = new RoomRegistry({
    ttlMs: 1000,
    now: clock.now,
    timers: clock.timers,
    randomInt: codes ? () => codes.shift() : undefined,
    onExpire: (room) => expired.push(room),
  });
  return { clock, rooms, expired };
}

test('好友房：6 位房号，冲突时重新生成；每人一个房间', () => {
  const { rooms } = registry({ codes: [42, 42, 123456, 7] });
  const a = rooms.create(1, 9, 'black');
  assert.equal(a.room.code, '000042');
  assert.equal(a.replaced, null);
  const b = rooms.create(2, 13, 'random');
  assert.equal(b.room.code, '123456'); // 42 已被占用
  const c = rooms.create(1, 19, 'white'); // 房主再建：旧房间关闭
  assert.equal(c.replaced.code, '000042');
  assert.equal(c.replaced.status, 'closed');
  assert.equal(rooms.get('000042'), null);
  assert.equal(rooms.ofOwner(1).code, '000007');
  assert.equal(rooms.count, 2);
  assert.equal(rooms.get('abc'), null);
  assert.equal(rooms.get(123456), null);
});

test('好友房：到期关闭并回调；视图带剩余时间', () => {
  const { clock, rooms, expired } = registry();
  const { room } = rooms.create(1, 9, 'black');
  clock.advance(400);
  const v = rooms.view(room, { userId: 1, nickname: 'A', avatarUrl: '' });
  assert.deepEqual(v, { code: room.code, owner: { userId: 1, nickname: 'A', avatarUrl: '' }, size: 9, color: 'black', status: 'waiting', expiresIn: 600 });
  clock.advance(599);
  assert.equal(expired.length, 0);
  clock.advance(1);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].status, 'closed');
  assert.equal(rooms.get(room.code), null);
  assert.equal(rooms.ofOwner(1), null);
  assert.equal(rooms.view(room, null).expiresIn, 0);
});

test('好友房：remove 与 clear 清掉定时器', () => {
  const { clock, rooms, expired } = registry();
  const { room } = rooms.create(1, 9, 'black');
  rooms.create(2, 9, 'black');
  assert.equal(rooms.remove(room.code).code, room.code);
  assert.equal(rooms.remove(room.code), null);
  rooms.clear();
  assert.equal(clock.pendingCount(), 0);
  clock.advance(5000);
  assert.equal(expired.length, 0);
  assert.throws(() => new RoomRegistry({ ttlMs: 0, timers: clock.timers }), TypeError);
});

// ---------- Lobby ----------

function lobbySetup(opts = {}) {
  const ctx = setupManager({ config: { roomTtlMs: 5000 }, ...opts });
  const matchmaker = new Matchmaker({ now: ctx.clock.now });
  let lobby;
  const rooms = new RoomRegistry({
    ttlMs: 5000,
    now: ctx.clock.now,
    timers: ctx.clock.timers,
    onExpire: (room) => lobby.onRoomExpired(room),
  });
  lobby = new Lobby({
    manager: ctx.manager,
    matchmaker,
    rooms,
    repos: ctx.repos,
    hub: ctx.hub,
    settings: ctx.settings,
    logger: ctx.logger,
    randomInt: () => 0,
  });
  return { ...ctx, matchmaker, rooms, lobby };
}

test('大厅：匹配成功建排位对局并通知双方；已在对局中 → in_game', () => {
  const ctx = lobbySetup();
  const { alice, bob, carol, lobby } = ctx;
  assert.deepEqual(lobby.matchJoin(alice.id, 9), { size: 9 });
  assert.deepEqual(lobby.hello(alice.id), { activeGames: [], room: null, matching: { size: 9 } });
  assert.deepEqual(lobby.matchJoin(bob.id, 9), { size: 9 });
  const found = ctx.hub.of('match.found');
  assert.equal(found.length, 2);
  const s = ctx.manager.getSession(found[0].gameId);
  assert.equal(s.mode, 'ranked');
  assert.deepEqual(s.players, { 1: alice.id, 2: bob.id }); // randomInt → 0：先排队者执黑
  assert.equal(codeOf(() => lobby.matchJoin(alice.id, 13)), 'in_game');
  assert.equal(codeOf(() => lobby.roomCreate(bob.id, 9, 'black')), 'in_game');
  assert.equal(codeOf(() => lobby.matchJoin(carol.id, 7)), 'bad_request');
  assert.deepEqual(lobby.hello(alice.id).activeGames, [{ id: s.id, mode: 'ranked' }]);
  lobby.matchJoin(carol.id, 9);
  lobby.matchCancel(carol.id);
  lobby.matchCancel(carol.id);
  assert.equal(lobby.hello(carol.id).matching, null);
});

test('大厅：建局失败时先排队的人回到队首，请求者收到错误', () => {
  const ctx = lobbySetup();
  ctx.lobby.matchJoin(ctx.alice.id, 9);
  ctx.repos.failOn('games.insert');
  assert.throws(() => ctx.lobby.matchJoin(ctx.bob.id, 9), /games.insert/);
  assert.deepEqual(ctx.matchmaker.statusOf(ctx.alice.id), { size: 9 });
  assert.equal(ctx.matchmaker.statusOf(ctx.bob.id), null);
});

test('大厅：好友房创建/查看/加入，开局通知双方；房主执子按设置', () => {
  const ctx = lobbySetup();
  const { alice, bob, carol, lobby } = ctx;
  lobby.matchJoin(alice.id, 9);
  const { room } = lobby.roomCreate(alice.id, 13, 'white');
  assert.equal(ctx.matchmaker.statusOf(alice.id), null, '建房取消匹配');
  assert.match(room.code, /^\d{6}$/);
  assert.deepEqual(room.owner, { userId: alice.id, nickname: 'Alice', avatarUrl: 'http://test.local/avatars/a1.png' });
  assert.equal(room.status, 'waiting');
  assert.equal(room.expiresIn, 5000);
  assert.deepEqual(lobby.hello(alice.id).room, room);
  assert.equal(codeOf(() => lobby.roomGet(bob.id, '999999')), 'room_not_found');
  assert.deepEqual(lobby.roomGet(bob.id, room.code).room, room);
  lobby.roomGet(carol.id, room.code);
  assert.equal(codeOf(() => lobby.roomJoin(alice.id, room.code)), 'own_room');
  const { gameId } = lobby.roomJoin(bob.id, room.code);
  const s = ctx.manager.getSession(gameId);
  assert.equal(s.mode, 'friend');
  assert.equal(s.size, 13);
  assert.deepEqual(s.players, { 1: bob.id, 2: alice.id });
  assert.deepEqual(ctx.hub.of('game.start', alice.id), [{ t: 'game.start', gameId, mode: 'friend' }]);
  assert.deepEqual(ctx.hub.of('game.start', bob.id), [{ t: 'game.start', gameId, mode: 'friend' }]);
  // 另一位查看过房间的人收到关闭通知
  const upd = ctx.hub.of('room.update', carol.id);
  assert.equal(upd.length, 1);
  assert.equal(upd[0].room.status, 'closed');
  assert.equal(ctx.hub.of('room.update', bob.id).length, 0);
  assert.equal(codeOf(() => lobby.roomJoin(carol.id, room.code)), 'room_not_found');
  assert.equal(lobby.hello(alice.id).room, null);
});

test('大厅：已在对局中不能加入房间；房主已在对局中则房间作废', () => {
  const ctx = lobbySetup();
  const { alice, bob, carol, lobby } = ctx;
  const { room } = lobby.roomCreate(alice.id, 9, 'random');
  ctx.manager.createHumanGame({ mode: 'ranked', size: 9, blackId: bob.id, whiteId: carol.id });
  assert.equal(codeOf(() => lobby.roomJoin(bob.id, room.code)), 'in_game');
  // 人为制造"房主在对局中"
  ctx.manager.createHumanGame({ mode: 'friend', size: 9, blackId: alice.id, whiteId: ctx.repos.users.create({ openid: 'x', nickname: 'X' }).id });
  const dave = ctx.repos.users.create({ openid: 'dave', nickname: 'Dave' });
  assert.equal(codeOf(() => lobby.roomJoin(dave.id, room.code)), 'room_not_found');
  assert.equal(ctx.rooms.get(room.code), null);
});

test('大厅：重新建房/离开/加入匹配都会关闭旧房间并通知查看者；到期通知房主与查看者', () => {
  const ctx = lobbySetup();
  const { alice, bob, carol, lobby } = ctx;
  const r1 = lobby.roomCreate(alice.id, 9, 'black').room;
  lobby.roomGet(bob.id, r1.code);
  const r2 = lobby.roomCreate(alice.id, 9, 'black').room;
  assert.notEqual(r2.code, r1.code);
  assert.equal(ctx.hub.of('room.update', bob.id).at(-1).room.code, r1.code);
  assert.equal(ctx.hub.of('room.update', alice.id).length, 0);
  lobby.roomGet(bob.id, r2.code);
  lobby.roomLeave(alice.id);
  assert.equal(ctx.hub.of('room.update', bob.id).at(-1).room.code, r2.code);
  lobby.roomLeave(alice.id); // 没有房间也 ok
  const r3 = lobby.roomCreate(alice.id, 9, 'black').room;
  lobby.roomGet(carol.id, r3.code);
  lobby.matchJoin(alice.id, 9);
  assert.equal(ctx.hub.of('room.update', carol.id).at(-1).room.code, r3.code);
  lobby.matchCancel(alice.id);
  const r4 = lobby.roomCreate(alice.id, 19, 'white').room;
  lobby.roomGet(carol.id, r4.code);
  ctx.hub.clear();
  ctx.clock.advance(5000);
  const toOwner = ctx.hub.of('room.update', alice.id);
  assert.equal(toOwner.length, 1);
  assert.deepEqual(toOwner[0].room, { ...r4, status: 'closed', expiresIn: 0 });
  assert.equal(ctx.hub.of('room.update', carol.id).length, 1);
  assert.equal(lobby.hello(alice.id).room, null);
});

test('大厅：人机开局参数校验；掉线取消匹配', () => {
  const ctx = lobbySetup();
  const { alice, lobby } = ctx;
  assert.equal(codeOf(() => lobby.aiStart(alice.id, { size: 8, level: 'k10', color: 'black' })), 'bad_request');
  assert.equal(codeOf(() => lobby.aiStart(alice.id, { size: 9, level: 'k10', color: 'purple' })), 'bad_request');
  assert.equal(codeOf(() => lobby.aiStart(alice.id, { size: 9, level: '', color: 'black' })), 'bad_request');
  const { gameId } = lobby.aiStart(alice.id, { size: 9, level: 'k10', color: 'black' });
  assert.equal(ctx.manager.getSession(gameId).mode, 'ai');
  lobby.matchJoin(alice.id, 9); // 人机对局不妨碍匹配
  lobby.userOffline(alice.id);
  assert.equal(lobby.hello(alice.id).matching, null);
});
