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

// 公平性与防护（管理器层的回归测试，最终评审 FS-* / COMP-5 / LS-8）：
// - 手动数子有争议 → 作废，不计入（FS-1）；死子判断失败重试一次（FS-1）
// - 继续对局次数与保护经数据库跨重启保留（FS-6 / FS-7）
// - 死子判断每局最多一个在途请求、结果按局面缓存（FS-8）
// - presence 附读秒、终局原因、写库失败时的 pending 与补推（FS-9 / FS-10）
// - 同一对手 24 小时内计入排行的局数上限（COMP-5）
// - 大厅限流表定期清理（LS-8）

// 9 路：黑墙 x=4，白墙 x=5，黑地里一颗白死子（10）。标记 10 为死子 → B+1.5；不标 → W+34.5
const WALL = [4, 5, 13, 14, 22, 23, 31, 32, 40, 41, 49, 50, 58, 59, 67, 68, 76, 77, 72, 10];
const TEN = [0, 8, 1, 7, 2, 6, 9, 17, 10, 16];

function ranked(ctx, opts = {}) {
  return ctx.manager.createHumanGame({ mode: 'ranked', size: 9, blackId: ctx.alice.id, whiteId: ctx.bob.id, ...opts });
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

function noErrors(ctx) {
  assert.deepEqual(ctx.logger.logs.error, [], '不应有 error 日志');
}

function offline(ctx, user) {
  ctx.hub.online.delete(user.id);
  ctx.manager.userOffline(user.id);
}

test('FS-1 没有 KataGo：死子的主人掉线、对方标出死子 → 时限到作废，统计不变（原来是计入排行的 W+34.5）', async () => {
  const ctx = setupManager({ ai: createFakeAi({ available: false }) });
  const s = ranked(ctx);
  play(ctx, s, [...WALL, -1, -1]);
  await flush();
  assert.equal(s.scoring.source, 'manual');
  offline(ctx, ctx.bob);
  ctx.manager.toggleDead(ctx.alice.id, s.id, 10);
  ctx.manager.acceptScore(ctx.alice.id, s.id, s.scoring.version);
  assert.equal(codeOf(() => ctx.manager.resumeScore(ctx.alice.id, s.id)), 'wrong_phase');
  const last = ctx.hub.of('game.scoring', ctx.alice.id).at(-1).scoring;
  assert.deepEqual(last.atDeadline, { void: true, cause: 'score_dispute' }, '客户端能提示：到时将作废');
  ctx.clock.advance(10 * 60 * 1000);
  const row = ctx.repos._db.games.get(s.id);
  assert.equal(row.reason, 'abort');
  assert.equal(row.cause, 'score_dispute');
  assert.equal(row.counted, false);
  assert.equal(ctx.hub.of('game.end', ctx.alice.id).at(-1).result.cause, 'score_dispute');
  assert.equal(ctx.repos.stats.get(ctx.bob.id).wins, 0);
  assert.equal(ctx.repos.stats.get(ctx.alice.id).losses, 0);
  noErrors(ctx);
});

test('FS-1 死子判断失败时重试一次；重试成功就用 KataGo 的建议', async () => {
  const ai = createFakeAi({ manualJudge: true });
  const ctx = setupManager({ ai });
  const s = ranked(ctx);
  play(ctx, s, [...WALL, -1, -1]);
  ai.rejectNextJudge();
  await flush();
  assert.equal(s.scoring.pending, true, '第一次失败：重试，仍在判断');
  assert.equal(ai.calls.judgeDead.length, 2);
  ai.resolveNextJudge([10]);
  await flush();
  assert.equal(s.scoring.source, 'katago');
  assert.deepEqual(s.scoring.dead, [10]);
  noErrors(ctx);
});

test('FS-6 / FS-7 重启：已用的继续对局次数不恢复；已同意的一方没回来 → 撤销继续对局按数子计分（不是作废）', async () => {
  const ctx = setupManager({
    config: { timeControls: { 9: { mainMs: 0, periods: 10, periodMs: 30000 } } },
    ai: createFakeAi({ dead: [10] }),
  });
  const s = ranked(ctx);
  play(ctx, s, [...WALL, -1, -1]);
  await flush();
  ctx.manager.acceptScore(ctx.alice.id, s.id, 1); // 黑（赢棋）同意
  ctx.manager.resumeScore(ctx.bob.id, s.id); // 白继续对局
  const saved = ctx.repos._db.games.get(s.id).state;
  assert.deepEqual(saved.resumesUsed, { 1: 0, 2: 1 });
  assert.equal(saved.guard.color, 1);

  // 重启，谁都还没回来
  ctx.manager.shutdown();
  ctx.hub.online.clear();
  const m2 = ctx.makeManager();
  m2.restore();
  const r = m2.getSession(s.id);
  assert.equal(r.resumesLeft(2), 0);
  assert.ok(r.resumeGuard);
  // 白回来了，黑没回来：90 秒后撤销继续对局
  ctx.hub.online.add(ctx.bob.id);
  m2.userOnline(ctx.bob.id);
  assert.equal(codeOf(() => m2.resumeScore(ctx.bob.id, s.id)), 'wrong_phase', '正在对局中，不能再继续对局');
  ctx.clock.advance(90000);
  const row = ctx.repos._db.games.get(s.id);
  assert.equal(row.status, 'ended');
  assert.equal(row.reason, 'score');
  assert.equal(row.cause, 'resume_undone');
  assert.equal(row.resultText, 'B+1.5');
  assert.deepEqual(row.moves, [...WALL, -1, -1]);
  assert.equal(ctx.repos.stats.get(ctx.alice.id).wins, 1);
  m2.shutdown();
});

test('FS-8 人机对局反复 pass / 悔棋：同一局面只请求一次死子判断；别的局面排队，不同时占用 KataGo', async () => {
  const ai = createFakeAi({ manualJudge: true });
  const ctx = setupManager({ ai });
  const s = ctx.manager.startAiGame(ctx.alice.id, { size: 9, level: 'k10', color: 'black' });
  ctx.manager.move(ctx.alice.id, s.id, 1, 40);
  await flush();
  for (let i = 0; i < 5; i++) {
    ctx.manager.pass(ctx.alice.id, s.id, s.moves.length + 1);
    await flush(); // AI 也 pass → 数子
    assert.equal(s.status, 'scoring');
    ctx.manager.undo(ctx.alice.id, s.id);
    assert.equal(s.status, 'playing');
  }
  ctx.manager.pass(ctx.alice.id, s.id, s.moves.length + 1);
  await flush();
  assert.equal(ai.calls.judgeDead.length, 1, '同一局面：只请求一次');
  ai.resolveNextJudge([]);
  await flush();
  assert.equal(s.scoring.pending, false, '那一次的结果用在了当前的数子阶段');
  const judged = ai.calls.judgeDead.length;

  // 换一个局面（在判断中又悔棋、落子、再 pass）：排在前一个后面
  ctx.manager.undo(ctx.alice.id, s.id);
  ctx.manager.move(ctx.alice.id, s.id, s.moves.length + 1, 30);
  await flush();
  ctx.manager.pass(ctx.alice.id, s.id, s.moves.length + 1);
  await flush();
  assert.equal(ai.calls.judgeDead.length, judged + 1);
  ctx.manager.undo(ctx.alice.id, s.id);
  ctx.manager.move(ctx.alice.id, s.id, s.moves.length + 1, 50);
  await flush();
  ctx.manager.pass(ctx.alice.id, s.id, s.moves.length + 1);
  await flush();
  assert.equal(ai.pendingJudges.length, 1, '前一个局面还在判断：新局面排队，不并发');
  ai.resolveNextJudge([]); // 过期局面的结果：记进缓存
  await flush();
  assert.equal(ai.calls.judgeDead.length, judged + 2, '前一个结束后才请求新局面');
  ai.resolveNextJudge([]);
  await flush();
  assert.equal(s.scoring.pending, false);
  noErrors(ctx);
});

test('FS-9 到场的一方上线：对手收到的 presence 带读秒（他的钟开始走了）', () => {
  const ctx = setupManager();
  ctx.hub.online.delete(ctx.bob.id);
  const s = ctx.manager.createHumanGame({ mode: 'friend', size: 9, blackId: ctx.alice.id, whiteId: ctx.bob.id });
  play(ctx, s, [40]);
  assert.equal(s.clock.running, null);
  ctx.hub.online.add(ctx.bob.id);
  ctx.manager.userOnline(ctx.bob.id);
  const p = ctx.hub.of('game.presence', ctx.alice.id).at(-1);
  assert.equal(p.online, true);
  assert.equal(p.clocks.running, 2);
  noErrors(ctx);
});

test('FS-10 终局写库失败：先推送 pending（不计入、无统计），补写成功后再推送一次 game.end（计入、附统计）', () => {
  const ctx = setupManager();
  const s = ranked(ctx);
  play(ctx, s, TEN);
  ctx.repos.failOn('games.finish');
  ctx.manager.resign(ctx.bob.id, s.id);
  const first = ctx.hub.of('game.end', ctx.alice.id);
  assert.equal(first.length, 1);
  assert.equal(first[0].result.counted, false);
  assert.equal(first[0].result.pending, true);
  assert.equal(first[0].stats, undefined);
  assert.equal(ctx.manager.sync(ctx.alice.id, s.id).result.pending, true);
  ctx.clock.advance(1000);
  const ends = ctx.hub.of('game.end', ctx.alice.id);
  assert.equal(ends.length, 2, '补写成功后再推送一次');
  assert.equal(ends[1].result.pending, false);
  assert.equal(ends[1].result.counted, true);
  assert.equal(ends[1].stats[1].wins, 1);
  assert.equal(ctx.hub.of('game.end', ctx.bob.id).length, 2);
  assert.equal(ctx.manager.sync(ctx.bob.id, s.id).result.counted, true);
});

test('COMP-5 同一对手 24 小时内最多计入 rankedPairDailyMax 局（默认 3），超出的标 pair_limit；过了 24 小时又计入', () => {
  const ctx = setupManager();
  const games = [];
  for (let i = 0; i < 4; i++) {
    const s = ranked(ctx);
    play(ctx, s, TEN);
    ctx.manager.resign(ctx.bob.id, s.id);
    games.push(s);
  }
  assert.deepEqual(games.map((g) => g.counted), [true, true, true, false]);
  const end = ctx.hub.of('game.end', ctx.alice.id).at(-1);
  assert.equal(end.result.uncounted, 'pair_limit');
  assert.equal(ctx.repos.stats.get(ctx.alice.id).wins, 3);
  // 从数据库重建的快照也能说明原因
  assert.equal(ctx.manager.sync(ctx.alice.id, games[3].id).result.uncounted, 'pair_limit');
  // 与别人下不受影响
  const other = ctx.manager.createHumanGame({ mode: 'ranked', size: 9, blackId: ctx.carol.id, whiteId: ctx.bob.id });
  ctx.hub.online.add(ctx.carol.id);
  ctx.manager.userOnline(ctx.carol.id);
  play(ctx, other, TEN);
  ctx.manager.resign(ctx.bob.id, other.id);
  assert.equal(other.counted, true);
  // 24 小时之后
  ctx.clock.advance(86400000 + 1);
  const later = ranked(ctx);
  play(ctx, later, TEN);
  ctx.manager.resign(ctx.bob.id, later.id);
  assert.equal(later.counted, true);

  const unlimited = setupManager({ config: { rankedPairDailyMax: 0 } });
  for (let i = 0; i < 5; i++) {
    const s = ranked(unlimited);
    play(unlimited, s, TEN);
    unlimited.manager.resign(unlimited.bob.id, s.id);
    assert.equal(s.counted, true);
  }
});

test('LS-8 大厅限流表（ai.start、猜房号）定期清掉补满的桶', () => {
  const ctx = setupManager();
  const rooms = new RoomRegistry({ ttlMs: 60000, now: ctx.clock.now, timers: ctx.clock.timers, logger: ctx.logger });
  const lobby = new Lobby({
    manager: ctx.manager,
    matchmaker: new Matchmaker(),
    rooms,
    repos: ctx.repos,
    hub: ctx.hub,
    settings: ctx.settings,
    logger: ctx.logger,
    now: ctx.clock.now,
  });
  for (let uid = 1000; uid < 1100; uid++) {
    lobby.aiStartLimit.take(uid);
    lobby.roomMissLimit.take(uid);
  }
  assert.equal(lobby.aiStartLimit.size, 100);
  lobby.prune();
  assert.equal(lobby.aiStartLimit.size, 100, '还没补满的不清');
  ctx.clock.advance(60000);
  lobby.prune();
  assert.equal(lobby.aiStartLimit.size, 0);
  assert.equal(lobby.roomMissLimit.size, 0);
  rooms.clear();
});
