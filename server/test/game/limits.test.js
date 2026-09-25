'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupManager } = require('./helpers/setup');
const { flush } = require('./helpers/fake-clock');
const { createFakeAi } = require('../helpers/fake-ai');
const { GameError } = require('../../src/game/errors');
const { Matchmaker } = require('../../src/game/matchmaker');
const { RoomRegistry } = require('../../src/game/rooms');
const { Lobby } = require('../../src/game/lobby');

// 管理器 / 大厅层面的回归测试：
// - SG-1 拖延：继续对局次数有限，局面不变时不重复请求死子判断
// - SG-3 继续对局要求对手在线；已同意的一方掉线 → 按数子终局
// - SG-7 终局写库失败：推送不谎报"已计入"，之后重试补写；关机前再写一次
// - SL-2 AI 请求名额（每人 / 全服），超出排队
// - SL-4 ai.start 限流、空局删除、终局缓存上限
// - SL-10 猜房号限流；PX-11 排位/好友对局中不能开人机；CS-1 新连接顶替时退出匹配

const WALL = [4, 5, 13, 14, 22, 23, 31, 32, 40, 41, 49, 50, 58, 59, 67, 68, 76, 77, 72, 10];

function ranked(ctx) {
  return ctx.manager.createHumanGame({ mode: 'ranked', size: 9, blackId: ctx.alice.id, whiteId: ctx.bob.id });
}

function play(ctx, s, moves) {
  for (const idx of moves) {
    const uid = s.players[s.toPlay];
    if (idx === -1) ctx.manager.pass(uid, s.id, s.moves.length + 1);
    else ctx.manager.move(uid, s.id, s.moves.length + 1, idx);
  }
}

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof GameError, `应为 GameError：${err && err.stack}`);
    return err.code;
  }
  assert.fail('应当抛错');
}

function lobbySetup(opts = {}) {
  const ctx = setupManager(opts);
  const matchmaker = new Matchmaker({ now: ctx.clock.now });
  const rooms = new RoomRegistry({ ttlMs: 60000, now: ctx.clock.now, timers: ctx.clock.timers });
  const lobby = new Lobby({
    manager: ctx.manager,
    matchmaker,
    rooms,
    repos: ctx.repos,
    hub: ctx.hub,
    settings: ctx.settings,
    logger: ctx.logger,
    now: ctx.clock.now,
    randomInt: () => 0,
  });
  return { ...ctx, matchmaker, rooms, lobby };
}

// ---------- SG-1 / SG-3 ----------

test('拖延：pass → pass → 继续对局的循环最多各一次，之后自动确认终局；死子判断只请求一次（SG-1 / PX-2）', async () => {
  const ctx = setupManager({ ai: createFakeAi({ dead: [10] }) });
  const s = ranked(ctx);
  play(ctx, s, WALL);
  let cycles = 0;
  for (let i = 0; i < 50; i++) {
    play(ctx, s, [-1, -1]);
    await flush();
    const loser = ctx.bob.id; // 建议 [10]：黑胜
    try {
      ctx.manager.resumeScore(loser, s.id);
      cycles += 1;
    } catch (err) {
      assert.equal(err.code, 'wrong_phase');
      break;
    }
  }
  assert.equal(cycles, 1, '输棋的一方只能继续一次');
  assert.equal(s.status, 'scoring');
  assert.equal(ctx.ai.calls.judgeDead.length, 1, '局面没变：第二次数子复用死子判断');
  const sc = ctx.hub.of('game.scoring', ctx.alice.id).at(-1).scoring;
  assert.deepEqual(sc.resumesLeft, { 1: 1, 2: 0 });
  ctx.clock.advance(180000);
  assert.equal(s.status, 'ended');
  assert.equal(s.result.winner, 1);
  assert.equal(s.result.reason, 'score');
});

test('继续对局：对手离线时拒绝；已同意的一方在继续后掉线 → 撤销继续对局、按数子判胜（SG-3）', async () => {
  const ctx = setupManager({
    ai: createFakeAi({ dead: [10] }),
    config: { timeControls: { 9: { mainMs: 0, periods: 10, periodMs: 30000 } } },
  });
  const s = ranked(ctx);
  play(ctx, s, [...WALL, -1, -1]);
  await flush();
  ctx.manager.acceptScore(ctx.alice.id, s.id, 1); // 黑（赢）同意
  ctx.manager.userOffline(ctx.alice.id); // 黑离开了小程序
  assert.equal(codeOf(() => ctx.manager.resumeScore(ctx.bob.id, s.id)), 'wrong_phase');
  ctx.manager.userOnline(ctx.alice.id);
  ctx.manager.resumeScore(ctx.bob.id, s.id); // 黑还在线的最后几秒里白继续
  ctx.clock.advance(5000);
  ctx.manager.userOffline(ctx.alice.id);
  ctx.hub.clear();
  ctx.clock.advance(90000);
  assert.equal(s.status, 'ended');
  assert.deepEqual(s.result, { winner: 1, reason: 'score', black: 45, white: 43.5 });
  assert.deepEqual(ctx.hub.types(ctx.bob.id), ['game.scoring', 'game.end']);
  const row = ctx.repos._db.games.get(s.id);
  assert.deepEqual(row.moves, [...WALL, -1, -1]);
  assert.equal(row.reason, 'score');
  assert.equal(ctx.repos.callsOf('stats.applyRanked')[0][1].winnerId, ctx.alice.id);
  assert.deepEqual(ctx.logger.logs.error, []);
});

// ---------- SG-7 ----------

test('终局写库失败：推送 counted=false 且不附统计；1 秒后重试补写，统计只计一次（SG-7）', () => {
  const ctx = setupManager();
  const s = ranked(ctx);
  play(ctx, s, [0, 8, 1, 7, 2, 6, 9, 17, 10, 16, 18, 26]);
  ctx.repos.failOn('stats.applyRanked', new Error('database or disk is full'));
  ctx.manager.resign(ctx.bob.id, s.id);
  const end = ctx.hub.of('game.end', ctx.alice.id)[0];
  assert.equal(end.result.counted, false, '还没写进数据库，不能说已计入');
  assert.equal(end.stats, undefined);
  assert.equal(ctx.repos._db.games.get(s.id).status, 'playing', '事务整体回滚');
  assert.equal(ctx.logger.logs.error.length, 1);
  // 内存里已结束：不能再落子；game.sync 看到的是已结束
  assert.equal(codeOf(() => ctx.manager.move(ctx.alice.id, s.id, 13, 30)), 'wrong_phase');
  assert.equal(ctx.manager.sync(ctx.alice.id, s.id).status, 'ended');
  ctx.clock.advance(1000);
  const row = ctx.repos._db.games.get(s.id);
  assert.equal(row.status, 'ended');
  assert.equal(row.reason, 'resign');
  assert.equal(row.counted, true);
  assert.equal(ctx.repos.stats.get(ctx.alice.id).wins, 1);
  assert.equal(s.counted, true);
  assert.equal(ctx.manager.sync(ctx.alice.id, s.id).result.counted, true);
  ctx.clock.advance(120000);
  assert.equal(ctx.repos.callsOf('stats.applyRanked').length, 2, '失败 1 次 + 成功 1 次');
  assert.equal(ctx.repos.stats.get(ctx.bob.id).losses, 1);
});

test('终局写库一直失败：按间隔重试；关机前再写一次，重启后不会被当成进行中的对局恢复（SG-7）', () => {
  const ctx = setupManager();
  const s = ranked(ctx);
  play(ctx, s, [0, 8, 1, 7, 2, 6, 9, 17, 10, 16, 18, 26]);
  const orig = ctx.repos.transaction;
  let fails = 4;
  ctx.repos.transaction = (fn) => {
    if (fails > 0) {
      fails -= 1;
      throw new Error('SQLITE_IOERR');
    }
    return orig(fn);
  };
  ctx.manager.resign(ctx.bob.id, s.id);
  ctx.clock.advance(1000 + 5000 + 15000); // 3 次重试都失败
  assert.equal(ctx.repos._db.games.get(s.id).status, 'playing');
  ctx.manager.shutdown(); // 关机：第 5 次写成功
  assert.equal(ctx.repos._db.games.get(s.id).status, 'ended');
  assert.equal(ctx.repos._db.games.get(s.id).counted, true);
  const m2 = ctx.makeManager();
  assert.equal(m2.restore(), 0);
});

// ---------- SL-2 ----------

test('AI 名额：每个玩家最多 2 个在途请求（含已作废的），反复开局 / 悔棋不会让请求无限堆积（SL-2）', async () => {
  const ctx = setupManager({ ai: createFakeAi({ manual: true }), config: { aiStartBurst: 100 } });
  const uid = ctx.alice.id;
  // 执白：AI 先下；反复开局
  for (let i = 0; i < 20; i++) {
    const g = ctx.manager.startAiGame(uid, { size: 9, level: 'k10', color: 'white' });
    assert.equal(g.aiThinking, true, '排队中也显示 AI 思考中');
  }
  assert.equal(ctx.ai.calls.chooseMove.length, 2);
  assert.equal(ctx.manager.aiInflight.get(uid), 2);
  assert.equal(ctx.manager.aiWaiting.size, 1, '只有当前这局在排队');
  // 旧请求结束（结果作废）→ 名额空出 → 当前这局派发
  ctx.ai.resolveNextMove();
  await flush();
  assert.equal(ctx.ai.calls.chooseMove.length, 3);
  ctx.ai.resolveNextMove();
  await flush();
  const cur = ctx.manager.aiGamesOf(uid)[0];
  ctx.ai.resolveNextMove({ move: 0, resign: false });
  await flush();
  assert.deepEqual(cur.moves, [0]);
  assert.equal(ctx.manager.aiInflight.has(uid), false);

  // 下一手 → 悔棋，反复 30 次：同时在途的最多 2 个
  let maxInflight = 0;
  for (let i = 0; i < 30; i++) {
    ctx.manager.move(uid, cur.id, cur.moves.length + 1, 40);
    maxInflight = Math.max(maxInflight, ctx.manager.aiInflight.get(uid) || 0);
    ctx.manager.undo(uid, cur.id);
  }
  assert.equal(maxInflight, 2);
  assert.equal(ctx.ai.calls.chooseMove.length, 3 + 2, '只有 2 个新请求真正发给了 AI');
  // 超时也会释放名额（AI 迟迟不回应）
  ctx.clock.advance(60000);
  await flush();
  assert.equal(ctx.manager.aiInflight.has(uid), false);
});

test('AI 名额：全服上限，超出的对局排队、按先来后到派发', async () => {
  const ctx = setupManager({ ai: createFakeAi({ manual: true }), config: { aiMaxInflight: 2 } });
  const users = [ctx.alice, ctx.bob, ctx.carol].map((u) => u.id);
  const games = users.map((uid) => ctx.manager.startAiGame(uid, { size: 9, level: 'k10', color: 'white' }));
  assert.equal(ctx.ai.calls.chooseMove.length, 2);
  assert.equal(ctx.manager.aiWaiting.has(games[2].id), true);
  ctx.ai.resolveNextMove({ move: 0, resign: false });
  await flush();
  assert.equal(ctx.ai.calls.chooseMove.length, 3);
  assert.deepEqual(games[0].moves, [0]);
  // 排队中的对局被认输：出队，不再请求
  ctx.manager.resign(ctx.carol.id, games[2].id);
  ctx.ai.resolveNextMove({ move: 0, resign: false });
  ctx.ai.resolveNextMove({ move: 0, resign: false });
  await flush();
  assert.equal(ctx.manager.aiWaiting.size, 0);
  assert.equal(ctx.manager.aiInflightTotal, 0);
});

// ---------- SL-4 ----------

test('终局缓存有上限；没下过子就被顶替的人机空局直接删除（SL-4）', () => {
  const ctx = setupManager({ config: { endedCacheMax: 3 } });
  for (let i = 0; i < 6; i++) {
    const g = ctx.manager.startAiGame(ctx.alice.id, { size: 9, level: 'k10', color: 'black' });
    ctx.manager.move(ctx.alice.id, g.id, 1, 40 + i);
    ctx.manager.resign(ctx.alice.id, g.id);
  }
  assert.equal(ctx.manager.endedCache.size, 3);
  for (let i = 0; i < 10; i++) ctx.manager.startAiGame(ctx.alice.id, { size: 9, level: 'k10', color: 'black' });
  const rows = [...ctx.repos._db.games.values()];
  assert.equal(rows.length, 6 + 1, '10 个空局只剩当前这一局');
  assert.equal(ctx.manager.endedCache.size, 3);
});

test('大厅：ai.start 按用户限流（突发 5 次，之后每 10 秒 1 次）；排位/好友对局中不能开人机（SL-4 / PX-11）', () => {
  const ctx = lobbySetup();
  const { alice, bob, lobby } = ctx;
  for (let i = 0; i < 5; i++) lobby.aiStart(alice.id, { size: 9, level: 'k10', color: 'black' });
  assert.equal(codeOf(() => lobby.aiStart(alice.id, { size: 9, level: 'k10', color: 'black' })), 'rate_limited');
  ctx.clock.advance(10000);
  lobby.aiStart(alice.id, { size: 9, level: 'k10', color: 'black' });
  assert.equal(codeOf(() => lobby.aiStart(alice.id, { size: 9, level: 'k10', color: 'black' })), 'rate_limited');

  lobby.matchJoin(bob.id, 9);
  lobby.matchJoin(ctx.carol.id, 9);
  assert.ok(ctx.manager.humanGameOf(bob.id));
  assert.equal(codeOf(() => lobby.aiStart(bob.id, { size: 9, level: 'k10', color: 'black' })), 'in_game');
});

// ---------- SL-10 / CS-1 / CS-8 ----------

test('大厅：猜房号限流（找不到房间 10 次后暂停），按用户计；找到房间不扣次数（SL-10）', () => {
  const ctx = lobbySetup();
  const { alice, bob, lobby } = ctx;
  const { room } = lobby.roomCreate(alice.id, 9, 'black');
  for (let i = 0; i < 10; i++) {
    lobby.roomGet(bob.id, room.code); // 查到了：不扣
    assert.equal(codeOf(() => lobby.roomGet(bob.id, String(100000 + i))), 'room_not_found');
  }
  assert.equal(codeOf(() => lobby.roomGet(bob.id, '123456')), 'rate_limited');
  assert.equal(codeOf(() => lobby.roomJoin(bob.id, room.code)), 'rate_limited', '暂停期间真的房号也查不了');
  ctx.clock.advance(6000);
  lobby.roomJoin(bob.id, room.code);
  assert.equal(codeOf(() => lobby.roomGet(ctx.carol.id, '654321')), 'room_not_found', '别人不受影响');
});

test('大厅：新连接顶替旧连接时退出匹配队列，好友房保留；房主不在线时也能加入房间（CS-1 / CS-8）', () => {
  const ctx = lobbySetup();
  const { alice, bob, carol, lobby } = ctx;
  lobby.matchJoin(alice.id, 9);
  lobby.userReplaced(alice.id);
  assert.equal(lobby.hello(alice.id).matching, null);
  lobby.matchJoin(bob.id, 9);
  assert.equal(ctx.manager.humanGameOf(alice.id), null, '没有在不知情的情况下被配对');

  const { room } = lobby.roomCreate(carol.id, 9, 'black');
  lobby.userReplaced(carol.id);
  assert.equal(lobby.hello(carol.id).room.code, room.code);
  ctx.hub.online.delete(carol.id); // 房主切到后台
  const { gameId } = lobby.roomJoin(alice.id, room.code);
  const s = ctx.manager.getSession(gameId);
  assert.equal(s.awaitingArrival(1), true);
  assert.deepEqual(lobby.hello(carol.id).activeGames, [{ id: gameId, mode: 'friend' }]);
});
