'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupManager } = require('./helpers/setup');
const { flush } = require('./helpers/fake-clock');
const { createFakeAi } = require('../helpers/fake-ai');
const { GameError } = require('../../src/game/errors');
const { ENDED_KEEP_MS } = require('../../src/game/manager');

// 9 路：黑墙 x=4，白墙 x=5，黑地里一颗白死子（10）。标记 10 为死子 → B+1.5
const WALL = [4, 5, 13, 14, 22, 23, 31, 32, 40, 41, 49, 50, 58, 59, 67, 68, 76, 77, 72, 10];
const TEN = [0, 8, 1, 7, 2, 6, 9, 17, 10, 16]; // 10 手无提子的着手

function ranked(ctx, opts = {}) {
  return ctx.manager.createHumanGame({ mode: 'ranked', size: 9, blackId: ctx.alice.id, whiteId: ctx.bob.id, ...opts });
}

// 轮到谁就用谁的身份下
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

test('建局：写库、登记进行中的对局、在线状态取自 hub', () => {
  const ctx = setupManager();
  ctx.hub.online.delete(ctx.bob.id);
  const s = ranked(ctx);
  assert.equal(ctx.repos.callsOf('games.insert').length, 1);
  const row = ctx.repos._db.games.get(s.id);
  assert.equal(row.mode, 'ranked');
  assert.equal(row.blackId, ctx.alice.id);
  assert.deepEqual(row.timeControl, { mainMs: 180000, periods: 3, periodMs: 20000 });
  assert.match(s.id, /^[0-9a-z]{12}$/);
  assert.deepEqual(ctx.manager.activeGamesOf(ctx.alice.id), [{ id: s.id, mode: 'ranked' }]);
  assert.equal(ctx.manager.humanGameOf(ctx.bob.id), s);
  assert.equal(ctx.manager.humanGameOf(ctx.carol.id), null);
  assert.deepEqual(s.online, { 1: true, 2: false });
  assert.throws(() => ctx.manager.createHumanGame({ mode: 'ai', size: 9, blackId: 1, whiteId: 2 }), TypeError);
  assert.equal(codeOf(() => ctx.manager.createHumanGame({ mode: 'friend', size: 7, blackId: 1, whiteId: 2 })), 'bad_request');
  noErrors(ctx);
});

test('落子：推送 game.move（含读秒）并保存进度；越权与不存在的对局', () => {
  const ctx = setupManager();
  const s = ranked(ctx);
  ctx.clock.advance(3000);
  ctx.manager.move(ctx.alice.id, s.id, 1, 40);
  const moves = ctx.hub.of('game.move');
  assert.equal(moves.length, 2); // 双方各一条
  assert.deepEqual(moves[0], {
    t: 'game.move',
    gameId: s.id,
    n: 1,
    idx: 40,
    color: 1,
    captured: [],
    clocks: {
      running: 2,
      1: { mainMs: 177000, periodsLeft: 3, periodMs: 20000 },
      2: { mainMs: 180000, periodsLeft: 3, periodMs: 20000 },
    },
  });
  assert.ok(ctx.hub.sent.every((x) => x.gameId === s.id));
  const saved = ctx.repos.callsOf('games.saveProgress').at(-1);
  assert.deepEqual(saved[2].moves, [40]);
  assert.equal(saved[2].status, 'playing');
  assert.equal(codeOf(() => ctx.manager.move(ctx.carol.id, s.id, 2, 41)), 'not_player');
  assert.equal(codeOf(() => ctx.manager.move(ctx.alice.id, 'zzzzzzzzzzzz', 1, 41)), 'not_found');
  assert.equal(codeOf(() => ctx.manager.move(ctx.alice.id, s.id, 2, 41)), 'not_your_turn');
  assert.equal(codeOf(() => ctx.manager.move(ctx.bob.id, s.id, 1, 41)), 'stale');
  assert.equal(codeOf(() => ctx.manager.move(ctx.bob.id, s.id, 2, 40)), 'illegal');
  assert.equal(codeOf(() => ctx.manager.undo(ctx.bob.id, s.id)), 'bad_request');
  noErrors(ctx);
});

test('首手超时：黑方 60 秒未落子 → 作废，不计统计', () => {
  const ctx = setupManager();
  const s = ranked(ctx);
  ctx.clock.advance(59999);
  assert.equal(ctx.hub.of('game.end').length, 0);
  ctx.clock.advance(1);
  const ends = ctx.hub.of('game.end');
  assert.equal(ends.length, 2);
  assert.equal(ends[0].result.reason, 'abort');
  assert.equal(ends[0].result.text, 'Void');
  assert.equal(ends[0].result.counted, false);
  assert.ok(ends[0].stats, '排位赛附带双方统计');
  assert.deepEqual(ends[0].stats[1], { games: 0, wins: 0, losses: 0, draws: 0, winrate: 0, curStreak: 0, maxStreak: 0 });
  assert.equal(ctx.repos.callsOf('stats.applyRanked').length, 0);
  assert.equal(ctx.repos._db.games.get(s.id).status, 'ended');
  assert.equal(ctx.repos._db.games.get(s.id).reason, 'abort');
  assert.deepEqual(ctx.manager.activeGamesOf(ctx.alice.id), []);
  assert.equal(codeOf(() => ctx.manager.move(ctx.alice.id, s.id, 1, 40)), 'wrong_phase');
  noErrors(ctx);
});

test('读秒用尽判负；定时器提前触发时按当前时间重新安排', () => {
  const ctx = setupManager({ config: { timeControls: { 9: { mainMs: 10000, periods: 2, periodMs: 5000 } }, minMovesRanked: 2 } });
  const s = ranked(ctx);
  play(ctx, s, [40, 41]);
  ctx.clock.advance(5000);
  ctx.manager._onDeadline(s.id); // 模拟定时器提前触发：没到期，不应判负
  assert.equal(s.status, 'playing');
  ctx.clock.advance(14999);
  assert.equal(s.status, 'playing');
  ctx.clock.advance(1);
  assert.equal(s.status, 'ended');
  const end = ctx.hub.of('game.end', ctx.bob.id)[0];
  assert.equal(end.result.reason, 'timeout');
  assert.equal(end.result.winner, 2);
  assert.equal(end.result.text, 'W+T');
  assert.equal(end.result.counted, true);
  assert.equal(ctx.repos.callsOf('stats.applyRanked').length, 1);
  assert.deepEqual(end.stats[2].curStreak, 1);
  noErrors(ctx);
});

test('超时后到达的落子请求：先判超时，请求返回 wrong_phase', () => {
  const ctx = setupManager({ config: { timeControls: { 9: { mainMs: 10000, periods: 0, periodMs: 0 } } } });
  const s = ranked(ctx);
  play(ctx, s, [40]);
  ctx.manager._disarm(s.id); // 让定时器"来不及"触发
  const t = ctx.clock.now() + 10000;
  // 手动把时间推到超时之后而不触发定时器
  const orig = ctx.manager.now;
  ctx.manager.now = () => t;
  assert.equal(codeOf(() => ctx.manager.move(ctx.bob.id, s.id, 2, 41)), 'wrong_phase');
  ctx.manager.now = orig;
  assert.equal(s.result.reason, 'timeout');
  assert.equal(s.result.winner, 1);
});

test('掉线弃局：只有轮到的一方掉线超过 abandonMs 才判负；重连取消；推送 presence', () => {
  // 只有读秒（没有基本时间）：掉线 abandonMs 后判负（有基本时间时要等基本时间用完，见 fairness.test.js）
  const ctx = setupManager({ config: { timeControls: { 9: { mainMs: 0, periods: 100, periodMs: 30000 } } } });
  const s = ranked(ctx);
  play(ctx, s, TEN); // 10 手，轮到黑（alice）
  ctx.hub.clear();
  ctx.manager.userOffline(ctx.bob.id); // 白掉线：不影响
  const pres = ctx.hub.of('game.presence', ctx.alice.id);
  assert.equal(pres.length, 1);
  assert.deepEqual({ ...pres[0], clocks: undefined }, { t: 'game.presence', gameId: s.id, color: 2, online: false, clocks: undefined });
  assert.equal(pres[0].clocks.running, 1, '附带读秒快照（FS-9）');
  ctx.clock.advance(100000);
  assert.equal(s.status, 'playing');
  ctx.manager.userOnline(ctx.bob.id);
  ctx.manager.userOffline(ctx.alice.id); // 轮到的一方掉线
  assert.equal(ctx.hub.of('game.presence', ctx.bob.id).at(-1).online, false);
  ctx.clock.advance(60000);
  ctx.manager.userOnline(ctx.alice.id); // 90 秒内回来
  ctx.clock.advance(60000);
  assert.equal(s.status, 'playing');
  ctx.manager.userOffline(ctx.alice.id);
  ctx.clock.advance(89999);
  assert.equal(s.status, 'playing');
  ctx.clock.advance(1);
  assert.equal(s.status, 'ended');
  assert.equal(s.result.reason, 'timeout');
  assert.equal(s.result.winner, 2);
  assert.equal(s.counted, true);
  assert.equal(ctx.repos.callsOf('stats.applyRanked').length, 1);
  noErrors(ctx);
});

test('掉线弃局：掉线的一方还一手没下则作废；双方都下过则判超时负并计入（COMP-5）', () => {
  const ctx = setupManager({ config: { timeControls: { 9: { mainMs: 30000, periods: 5, periodMs: 20000 } } } });
  const s = ranked(ctx);
  play(ctx, s, [40]); // 轮到白，白还一手没下
  ctx.manager.userOffline(ctx.bob.id);
  ctx.clock.advance(90000);
  assert.equal(s.result.reason, 'abort');
  assert.equal(ctx.hub.of('game.end', ctx.alice.id).at(-1).result.cause, 'abandon');
  assert.equal(ctx.repos.callsOf('stats.applyRanked').length, 0);

  ctx.manager.userOnline(ctx.bob.id);
  const t = ranked(ctx);
  play(ctx, t, [40, 41, 42]); // 轮到白
  ctx.manager.userOffline(ctx.bob.id);
  ctx.clock.advance(90000);
  assert.equal(t.result.reason, 'timeout');
  assert.equal(t.counted, true);
  const end = ctx.hub.of('game.end', ctx.alice.id).at(-1);
  assert.equal(end.result.cause, 'abandon');
  assert.equal(ctx.repos.callsOf('stats.applyRanked').length, 1);
  assert.equal(ctx.repos._db.games.get(t.id).cause, 'abandon');
});

test('房主离线开局：到场前不走他的钟、不按 90 秒弃局；到场后正常计时；一直不来则宽限后作废', () => {
  const ctx = setupManager();
  ctx.hub.online.delete(ctx.bob.id);
  const s = ctx.manager.createHumanGame({ mode: 'friend', size: 9, blackId: ctx.alice.id, whiteId: ctx.bob.id });
  assert.equal(s.awaitingArrival(2), true);
  play(ctx, s, [40]);
  assert.equal(s.clock.running, null, '白（房主）还没到场：不走钟');
  ctx.clock.advance(90000);
  assert.equal(s.status, 'playing', '不按掉线弃局判负');
  ctx.hub.online.add(ctx.bob.id);
  ctx.manager.userOnline(ctx.bob.id); // 房主回来了（hello.activeGames 里有这局）
  assert.equal(s.clock.running, 2);
  assert.equal(s.clock.sides[2].mainMs, 180000, '等待的时间不计');
  play(ctx, s, [41]);
  assert.equal(s.status, 'playing');

  const late = setupManager();
  late.hub.online.delete(late.bob.id);
  const g = late.manager.createHumanGame({ mode: 'friend', size: 9, blackId: late.alice.id, whiteId: late.bob.id });
  play(late, g, [40]);
  late.clock.advance(300000);
  assert.equal(g.result.reason, 'abort');
  assert.equal(late.hub.of('game.end')[0].stats, undefined, '好友对局不附统计');
});

test('完整数子：死子建议 → 点选 → 双方确认 → 计分终局，统计只计一次', async () => {
  const ctx = setupManager({ ai: createFakeAi({ dead: [10] }) });
  const s = ranked(ctx);
  play(ctx, s, WALL);
  ctx.hub.clear();
  play(ctx, s, [-1, -1]);
  const pend = ctx.hub.of('game.scoring', ctx.alice.id);
  assert.equal(pend.length, 1);
  assert.equal(pend[0].scoring.pending, true);
  assert.equal(ctx.repos.callsOf('games.saveProgress').at(-1)[2].status, 'scoring');
  assert.deepEqual(ctx.ai.calls.judgeDead, [{ size: 9, komi: 7.5, moves: [...WALL, -1, -1] }]);
  await flush();
  const prop = ctx.hub.of('game.scoring', ctx.alice.id).at(-1).scoring;
  assert.equal(prop.pending, false);
  assert.equal(prop.source, 'katago');
  assert.equal(prop.version, 1);
  assert.deepEqual(prop.dead, [10]);
  assert.equal(prop.winner, 1);
  assert.equal(prop.deadline, 180000);

  ctx.manager.acceptScore(ctx.alice.id, s.id, 1);
  assert.deepEqual(ctx.hub.of('game.scoring', ctx.bob.id).at(-1).scoring.accepted, { 1: true, 2: false });
  ctx.manager.toggleDead(ctx.bob.id, s.id, 10); // 白说 10 是活的
  const t = ctx.hub.of('game.scoring', ctx.bob.id).at(-1).scoring;
  assert.equal(t.version, 2);
  assert.deepEqual(t.dead, []);
  assert.deepEqual(t.accepted, { 1: false, 2: false });
  assert.equal(codeOf(() => ctx.manager.acceptScore(ctx.alice.id, s.id, 1)), 'stale');
  const before = ctx.hub.sent.length;
  ctx.manager.toggleDead(ctx.alice.id, s.id, 0); // 空点：不推送
  assert.equal(ctx.hub.sent.length, before);
  ctx.manager.toggleDead(ctx.alice.id, s.id, 10);
  ctx.manager.acceptScore(ctx.alice.id, s.id, 3);
  ctx.manager.acceptScore(ctx.bob.id, s.id, 3);
  const end = ctx.hub.of('game.end', ctx.alice.id);
  assert.equal(end.length, 1);
  assert.deepEqual(end[0].result, {
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
  assert.deepEqual(end[0].stats[1], { games: 1, wins: 1, losses: 0, draws: 0, winrate: 1, curStreak: 1, maxStreak: 1 });
  assert.deepEqual(end[0].stats[2], { games: 1, wins: 0, losses: 1, draws: 0, winrate: 0, curStreak: 0, maxStreak: 0 });
  const applied = ctx.repos.callsOf('stats.applyRanked');
  assert.equal(applied.length, 1);
  assert.deepEqual(applied[0][1], { gameId: s.id, winnerId: ctx.alice.id, loserId: ctx.bob.id, draw: false, userIds: [ctx.alice.id, ctx.bob.id] });
  const row = ctx.repos._db.games.get(s.id);
  assert.equal(row.status, 'ended');
  assert.deepEqual(row.dead, [10]);
  assert.equal(row.resultText, 'B+1.5');
  assert.equal(row.counted, true);
  // 终局后的请求
  assert.equal(codeOf(() => ctx.manager.acceptScore(ctx.alice.id, s.id, 3)), 'wrong_phase');
  assert.equal(codeOf(() => ctx.manager.resign(ctx.bob.id, s.id)), 'wrong_phase');
  assert.equal(codeOf(() => ctx.manager.resign(ctx.carol.id, s.id)), 'not_player');
  assert.equal(ctx.repos.callsOf('stats.applyRanked').length, 1);
  noErrors(ctx);
});

test('数子自动确认：时限到未达成一致 → 不采用单方面的点选，按最初的建议终局；先推送最终死子再推送 game.end', async () => {
  const ctx = setupManager({ ai: createFakeAi({ dead: [10] }) });
  const s = ranked(ctx);
  play(ctx, s, [...WALL, -1, -1]);
  await flush();
  ctx.manager.acceptScore(ctx.alice.id, s.id, 1); // 黑同意公平的建议（黑胜）
  ctx.clock.advance(179000);
  ctx.manager.toggleDead(ctx.bob.id, s.id, 4); // 白在最后一秒把黑墙点成死棋（白胜）
  const t = ctx.hub.of('game.scoring', ctx.alice.id).at(-1).scoring;
  assert.equal(t.winner, 2);
  assert.equal(t.deadline, 60000, '时限顺延，黑还有 60 秒可以回应');
  ctx.clock.advance(1000);
  assert.equal(s.status, 'scoring', '原来的时限到了也不终局');
  ctx.hub.clear();
  ctx.clock.advance(59000);
  assert.equal(s.status, 'ended');
  assert.deepEqual(s.result, { winner: 1, reason: 'score', black: 45, white: 43.5 });
  assert.deepEqual(ctx.hub.types(ctx.alice.id), ['game.scoring', 'game.end']);
  const fin = ctx.hub.of('game.scoring', ctx.alice.id)[0].scoring;
  assert.deepEqual(fin.dead, [10]);
  assert.equal(fin.winner, 1);
  assert.deepEqual(ctx.repos._db.games.get(s.id).dead, [10]);
  assert.equal(ctx.repos.callsOf('stats.applyRanked')[0][1].winnerId, ctx.alice.id);
  noErrors(ctx);
});

test('死子判断失败或超时 → manual、无死子；AI 不可用时直接 manual', async () => {
  const fail = setupManager({ ai: createFakeAi({ judgeFail: true }) });
  const a = ranked(fail);
  play(fail, a, [...WALL, -1, -1]);
  await flush();
  const sc = fail.hub.of('game.scoring', fail.alice.id).at(-1).scoring;
  assert.equal(sc.pending, false);
  assert.equal(sc.source, 'manual');
  assert.deepEqual(sc.dead, []);
  assert.equal(sc.version, 1);

  assert.equal(fail.ai.calls.judgeDead.length, 2, '失败后重试一次（FS-1）');

  // 超时：重试一次，两次都超时才改为手动
  const slow = setupManager({ ai: createFakeAi({ manualJudge: true }) });
  const b = ranked(slow);
  play(slow, b, [...WALL, -1, -1]);
  slow.clock.advance(15000);
  await flush();
  assert.equal(b.scoring.pending, true, '第一次超时后重试');
  assert.equal(slow.ai.calls.judgeDead.length, 2);
  slow.clock.advance(15000);
  await flush();
  assert.equal(b.scoring.pending, false);
  assert.equal(b.scoring.source, 'manual');
  slow.ai.resolveNextJudge([10]); // 迟到的结果不改变已给出的建议（只记进缓存）
  await flush();
  assert.deepEqual(b.scoring.dead, []);
  assert.equal(b.scoring.version, 1);

  const off = setupManager({ ai: createFakeAi({ available: false }) });
  const c = ranked(off);
  play(off, c, [...WALL, -1, -1]);
  const pushes = off.hub.of('game.scoring', off.alice.id);
  assert.equal(pushes.length, 2);
  assert.equal(pushes[0].scoring.pending, true);
  assert.equal(pushes[1].scoring.source, 'manual');
  assert.equal(off.ai.calls.judgeDead.length, 0);

  const bad = setupManager({ ai: createFakeAi({ dead: () => 'oops' }) });
  const d = ranked(bad);
  play(bad, d, [...WALL, -1, -1]);
  await flush();
  assert.equal(d.scoring.source, 'manual');
});

test('继续对局：推送 game.resumed，重新计时；在途的死子判断结果作废', async () => {
  const ctx = setupManager({ ai: createFakeAi({ manualJudge: true }) });
  const s = ranked(ctx);
  play(ctx, s, [40, -1, -1]); // 白先 pass
  ctx.clock.advance(2000);
  ctx.manager.resumeScore(ctx.alice.id, s.id);
  const r = ctx.hub.of('game.resumed', ctx.bob.id)[0];
  assert.equal(r.toPlay, 2);
  assert.equal(r.clocks.running, 2);
  assert.equal(s.status, 'playing');
  assert.equal(ctx.repos.callsOf('games.saveProgress').at(-1)[2].status, 'playing');
  ctx.ai.resolveNextJudge([40]);
  await flush();
  assert.equal(s.scoring, null);
  assert.equal(ctx.hub.of('game.scoring', ctx.bob.id).length, 1); // 只有进入时的 pending
  play(ctx, s, [41]);
  assert.equal(s.moves.length, 4);
  assert.equal(codeOf(() => ctx.manager.resumeScore(ctx.alice.id, s.id)), 'wrong_phase');
  noErrors(ctx);
});

test('认输：自己还一手没下就认输不计入；双方都下过就计入并附统计', () => {
  const ctx = setupManager();
  const s = ranked(ctx);
  play(ctx, s, [40]);
  ctx.manager.resign(ctx.bob.id, s.id);
  assert.equal(s.result.winner, 1);
  assert.equal(s.counted, false);
  assert.equal(ctx.hub.of('game.end', ctx.bob.id)[0].result.uncounted, 'short');
  assert.equal(ctx.repos.callsOf('stats.applyRanked').length, 0);
  assert.equal(ctx.hub.of('game.end', ctx.bob.id)[0].result.text, 'B+R');

  const t = ranked(ctx);
  play(ctx, t, TEN);
  ctx.manager.resign(ctx.alice.id, t.id);
  assert.equal(t.counted, true);
  assert.equal(ctx.repos.callsOf('stats.applyRanked').length, 1);
  assert.equal(ctx.hub.of('game.end', ctx.alice.id).at(-1).stats[2].wins, 1);
});

test('和棋（整数贴目）：applyRanked 以 draw 方式计入', async () => {
  const ctx = setupManager({ config: { komi: 0 }, ai: createFakeAi({ dead: [] }) });
  const s = ranked(ctx);
  // 黑墙 x=3、白墙 x=5，中间一路是公共点：36 : 36 + 0 贴目 → 和棋
  const DRAW = [];
  for (let y = 0; y < 9; y++) DRAW.push(y * 9 + 3, y * 9 + 5);
  play(ctx, s, [...DRAW, -1, -1]);
  await flush();
  ctx.manager.acceptScore(ctx.alice.id, s.id, 1);
  ctx.manager.acceptScore(ctx.bob.id, s.id, 1);
  assert.equal(s.result.winner, 0);
  assert.equal(s.result.reason, 'score');
  const applied = ctx.repos.callsOf('stats.applyRanked');
  assert.equal(applied.length, 1);
  assert.equal(applied[0][1].draw, true);
  assert.deepEqual(applied[0][1].userIds, [ctx.alice.id, ctx.bob.id]);
  assert.equal(ctx.hub.of('game.end')[0].stats[1].draws, 1);
  assert.equal(ctx.hub.of('game.end')[0].result.text, '0');
});

test('写库失败不影响对局推送（记录错误日志）', () => {
  const ctx = setupManager();
  const s = ranked(ctx);
  ctx.repos.failOn('games.saveProgress');
  play(ctx, s, [40]);
  assert.equal(ctx.hub.of('game.move').length, 2);
  assert.equal(ctx.logger.logs.error.length, 1);
  ctx.repos.failOn('games.finish');
  play(ctx, s, [41, 42, 43, 44, 45, 46, 47, 48, 49]);
  ctx.manager.resign(ctx.alice.id, s.id);
  assert.equal(ctx.hub.of('game.end').length, 2);
  assert.equal(ctx.logger.logs.error.length, 2);
  assert.equal(ctx.repos._db.stats.size, 0, '事务回滚：统计未更新');
});

test('人机：玩家执黑时等玩家落子，AI 应手后推送 game.move 与 game.ai', async () => {
  const ctx = setupManager();
  const s = ctx.manager.startAiGame(ctx.alice.id, { size: 9, level: 'k5', color: 'black' });
  assert.equal(s.aiColor, 2);
  assert.equal(ctx.ai.calls.chooseMove.length, 0);
  assert.equal(ctx.repos._db.games.get(s.id).aiLevel, 'k5');
  assert.equal(ctx.repos._db.games.get(s.id).whiteId, null);
  ctx.manager.move(ctx.alice.id, s.id, 1, 40);
  assert.deepEqual(ctx.hub.types(ctx.alice.id), ['game.move', 'game.ai']);
  assert.equal(ctx.hub.of('game.ai')[0].thinking, true);
  assert.equal(s.aiThinking, true);
  assert.deepEqual(ctx.ai.calls.chooseMove[0], { size: 9, komi: 7.5, moves: [40], color: 2, level: 'k5', humanJustPassed: false });
  await flush();
  assert.deepEqual(ctx.hub.types(ctx.alice.id), ['game.move', 'game.ai', 'game.move', 'game.ai']);
  const aiMove = ctx.hub.of('game.move')[1];
  assert.equal(aiMove.n, 2);
  assert.equal(aiMove.color, 2);
  assert.equal(aiMove.idx, 0);
  assert.equal(aiMove.clocks, null);
  assert.equal(ctx.hub.of('game.ai')[1].thinking, false);
  assert.equal(s.aiThinking, false);
  assert.equal(codeOf(() => ctx.manager.move(ctx.alice.id, s.id, 2, 41)), 'stale');
  noErrors(ctx);
});

test('人机：玩家执白时 AI 立即落第一手；random 按随机数分配', async () => {
  const ctx = setupManager({ randomSeq: [1] });
  const s = ctx.manager.startAiGame(ctx.alice.id, { size: 9, level: 'k10', color: 'random' });
  assert.equal(s.humanColor, 2);
  assert.equal(ctx.ai.calls.chooseMove.length, 1);
  await flush();
  assert.deepEqual(s.moves, [0]);
  assert.equal(s.toPlay, 2);
});

test('人机：已有进行中的人机对局会被作废；AI 不可用/未知难度报错', () => {
  const ctx = setupManager();
  const a = ctx.manager.startAiGame(ctx.alice.id, { size: 9, level: 'k10', color: 'black' });
  ctx.manager.move(ctx.alice.id, a.id, 1, 40); // 下过子的旧局：作废并保留记录
  const b = ctx.manager.startAiGame(ctx.alice.id, { size: 13, level: 'k10', color: 'black' });
  assert.equal(a.result.reason, 'abort');
  assert.equal(ctx.repos._db.games.get(a.id).reason, 'abort');
  assert.deepEqual(ctx.manager.activeGamesOf(ctx.alice.id), [{ id: b.id, mode: 'ai' }]);
  // 一手没下就被顶替：直接删除记录、不进终局缓存，推送 game.end（作废）
  ctx.hub.online.add(ctx.alice.id);
  const c = ctx.manager.startAiGame(ctx.alice.id, { size: 9, level: 'k10', color: 'black' });
  assert.equal(ctx.repos._db.games.has(b.id), false);
  assert.equal(ctx.manager.endedCache.has(b.id), false);
  assert.equal(ctx.hub.of('game.end').at(-1).gameId, b.id);
  assert.equal(ctx.hub.of('game.end').at(-1).result.reason, 'abort');
  assert.equal(codeOf(() => ctx.manager.sync(ctx.alice.id, b.id)), 'not_found');
  assert.deepEqual(ctx.manager.activeGamesOf(ctx.alice.id), [{ id: c.id, mode: 'ai' }]);
  assert.equal(codeOf(() => ctx.manager.startAiGame(ctx.alice.id, { size: 9, level: 'nope', color: 'black' })), 'bad_request');
  ctx.ai.set({ available: false });
  assert.equal(codeOf(() => ctx.manager.startAiGame(ctx.alice.id, { size: 9, level: 'k10', color: 'black' })), 'ai_unavailable');
  // 人机对局不妨碍真人对局
  assert.equal(ctx.manager.humanGameOf(ctx.alice.id), null);
});

test('人机：AI 思考中悔棋 → 思考结果作废', async () => {
  const ctx = setupManager({ ai: createFakeAi({ manual: true }) });
  const s = ctx.manager.startAiGame(ctx.alice.id, { size: 9, level: 'k10', color: 'black' });
  ctx.manager.move(ctx.alice.id, s.id, 1, 40);
  assert.equal(s.aiThinking, true);
  ctx.hub.clear();
  ctx.manager.undo(ctx.alice.id, s.id);
  assert.deepEqual(ctx.hub.of('game.undo')[0], { t: 'game.undo', gameId: s.id, moves: [] });
  assert.deepEqual(ctx.hub.of('game.ai')[0], { t: 'game.ai', gameId: s.id, thinking: false });
  assert.equal(s.aiThinking, false);
  ctx.ai.resolveNextMove({ move: 41, resign: false });
  await flush();
  assert.deepEqual(s.moves, []);
  assert.equal(ctx.hub.of('game.move').length, 0);
  // 再下一手：新的请求正常生效
  ctx.manager.move(ctx.alice.id, s.id, 1, 30);
  ctx.ai.resolveNextMove({ move: 31, resign: false });
  await flush();
  assert.deepEqual(s.moves, [30, 31]);
  assert.equal(codeOf(() => ctx.manager.undo(ctx.bob.id, s.id)), 'not_player');
  ctx.manager.undo(ctx.alice.id, s.id);
  assert.deepEqual(s.moves, []);
  assert.equal(codeOf(() => ctx.manager.undo(ctx.alice.id, s.id)), 'nothing_to_undo');
  noErrors(ctx);
});

test('人机：AI 思考中认输 → 思考结果作废', async () => {
  const ctx = setupManager({ ai: createFakeAi({ manual: true }) });
  const s = ctx.manager.startAiGame(ctx.alice.id, { size: 9, level: 'k10', color: 'black' });
  ctx.manager.move(ctx.alice.id, s.id, 1, 40);
  ctx.manager.resign(ctx.alice.id, s.id);
  assert.equal(s.result.winner, 2);
  assert.equal(s.result.reason, 'resign');
  ctx.ai.resolveNextMove({ move: 41, resign: false });
  await flush();
  assert.deepEqual(s.moves, [40]);
  assert.equal(ctx.hub.of('game.end').length, 1);
  assert.equal(ctx.hub.of('game.end')[0].stats, undefined);
  noErrors(ctx);
});

test('人机：玩家 pass 后 AI 也 pass → 数子，AI 自动确认，玩家确认后终局', async () => {
  const ctx = setupManager({ ai: createFakeAi({ dead: [] }) });
  const s = ctx.manager.startAiGame(ctx.alice.id, { size: 9, level: 'k10', color: 'black' });
  ctx.manager.move(ctx.alice.id, s.id, 1, 40);
  await flush();
  ctx.manager.pass(ctx.alice.id, s.id, 3);
  assert.equal(ctx.ai.calls.chooseMove.at(-1).humanJustPassed, true);
  await flush();
  assert.equal(s.status, 'scoring');
  const sc = ctx.hub.of('game.scoring').at(-1).scoring;
  assert.equal(sc.pending, false);
  assert.deepEqual(sc.accepted, { 1: false, 2: true });
  assert.equal(sc.deadline, null);
  // 顺序：AI 的 pass、思考结束、进入数子
  const types = ctx.hub.types(ctx.alice.id);
  assert.deepEqual(types.slice(-5), ['game.ai', 'game.move', 'game.ai', 'game.scoring', 'game.scoring']);
  assert.equal(codeOf(() => ctx.manager.toggleDead(ctx.alice.id, s.id, 40)), 'bad_request');
  ctx.manager.acceptScore(ctx.alice.id, s.id, 1);
  assert.equal(s.status, 'ended');
  assert.equal(s.result.reason, 'score');
  assert.equal(s.counted, false);
  assert.equal(ctx.repos.callsOf('stats.applyRanked').length, 0);
  noErrors(ctx);
});

test('人机：数子阶段可继续对局，轮到 AI 时 AI 继续思考（humanJustPassed=false）', async () => {
  const ctx = setupManager({ ai: createFakeAi({ script: [-1] }) });
  const s = ctx.manager.startAiGame(ctx.alice.id, { size: 9, level: 'k10', color: 'black' });
  ctx.manager.move(ctx.alice.id, s.id, 1, 40);
  await flush(); // AI pass
  ctx.manager.pass(ctx.alice.id, s.id, 3); // → 数子，轮到最先 pass 的 AI
  await flush();
  assert.equal(s.status, 'scoring');
  const calls = ctx.ai.calls.chooseMove.length;
  ctx.manager.resumeScore(ctx.alice.id, s.id);
  assert.equal(ctx.ai.calls.chooseMove.length, calls + 1);
  assert.equal(ctx.ai.calls.chooseMove.at(-1).humanJustPassed, false);
  await flush();
  assert.equal(s.status, 'playing');
  assert.equal(s.moves.length, 4);
  assert.equal(s.toPlay, 1);
});

test('人机：数子阶段悔棋撤回 pass；死子判断失败 → manual', async () => {
  const ctx = setupManager({ ai: createFakeAi({ judgeFail: true }) });
  const s = ctx.manager.startAiGame(ctx.alice.id, { size: 9, level: 'k10', color: 'black' });
  ctx.manager.move(ctx.alice.id, s.id, 1, 40);
  await flush();
  ctx.manager.pass(ctx.alice.id, s.id, 3);
  await flush();
  assert.equal(s.status, 'scoring');
  assert.equal(s.scoring.source, 'manual');
  assert.equal(s.scoring.accepted[2], true);
  ctx.manager.undo(ctx.alice.id, s.id);
  assert.equal(s.status, 'playing');
  assert.deepEqual(s.moves, [40, 0]);
  assert.deepEqual(ctx.hub.of('game.undo').at(-1).moves, [40, 0]);
});

test('人机：AI 认输', async () => {
  const ctx = setupManager({ ai: createFakeAi({ strategy: 'resign' }) });
  const s = ctx.manager.startAiGame(ctx.alice.id, { size: 9, level: 'k10', color: 'white' });
  await flush();
  assert.equal(s.status, 'ended');
  assert.deepEqual(s.result, { winner: 2, reason: 'resign', black: null, white: null });
  const types = ctx.hub.types(ctx.alice.id);
  assert.deepEqual(types, ['game.ai', 'game.ai', 'game.end']);
});

test('人机：AI 落子失败按间隔重试，全部失败则作废；非法着手也算失败', async () => {
  const ctx = setupManager({ config: { aiRetryDelaysMs: [100, 200] }, ai: createFakeAi({ failMoves: 1 }) });
  const s = ctx.manager.startAiGame(ctx.alice.id, { size: 9, level: 'k10', color: 'white' });
  await flush();
  assert.equal(s.aiThinking, false);
  assert.equal(ctx.hub.of('game.ai').at(-1).thinking, false);
  ctx.clock.advance(100);
  await flush();
  assert.deepEqual(s.moves, [0]);
  assert.equal(ctx.ai.calls.chooseMove.length, 2);

  const bad = setupManager({ config: { aiRetryDelaysMs: [100, 200] }, ai: createFakeAi({ strategy: () => ({ move: 999, resign: false }) }) });
  const t = bad.manager.startAiGame(bad.alice.id, { size: 9, level: 'k10', color: 'white' });
  await flush();
  bad.clock.advance(100);
  await flush();
  bad.clock.advance(200);
  await flush();
  assert.equal(bad.ai.calls.chooseMove.length, 3);
  assert.equal(t.status, 'ended');
  assert.equal(t.result.reason, 'abort');
  assert.equal(bad.logger.logs.error.length, 1);
});

test('人机：AI 迟迟不回应时按 aiMoveTimeoutMs 超时并重试', async () => {
  const ctx = setupManager({ config: { aiMoveTimeoutMs: 5000, aiRetryDelaysMs: [100] }, ai: createFakeAi({ manual: true }) });
  const s = ctx.manager.startAiGame(ctx.alice.id, { size: 9, level: 'k10', color: 'white' });
  ctx.clock.advance(5000);
  await flush();
  assert.equal(s.aiThinking, false);
  ctx.clock.advance(100);
  assert.equal(ctx.ai.calls.chooseMove.length, 2);
  ctx.ai.resolveNextMove({ move: 5, resign: false }); // 第一次（已超时）的结果：丢弃
  await flush();
  assert.deepEqual(s.moves, []);
  ctx.ai.resolveNextMove({ move: 6, resign: false });
  await flush();
  assert.deepEqual(s.moves, [6]);
});

test('人机：24 小时无操作自动作废；操作会顺延', async () => {
  const ctx = setupManager();
  const s = ctx.manager.startAiGame(ctx.alice.id, { size: 9, level: 'k10', color: 'black' });
  ctx.clock.advance(86400000 - 1000);
  ctx.manager.move(ctx.alice.id, s.id, 1, 40);
  await flush();
  ctx.clock.advance(86400000 - 1);
  assert.equal(s.status, 'playing');
  ctx.clock.advance(1);
  assert.equal(s.status, 'ended');
  assert.equal(s.result.reason, 'abort');
});

test('同步：进行中的对局返回快照；非对局者 not_player；不存在 not_found', () => {
  const ctx = setupManager();
  const s = ranked(ctx);
  play(ctx, s, [40]);
  const snap = ctx.manager.sync(ctx.bob.id, s.id);
  assert.equal(snap.myColor, 2);
  assert.deepEqual(snap.moves, [40]);
  assert.deepEqual(snap.players[1], { userId: ctx.alice.id, nickname: 'Alice', avatarUrl: 'http://test.local/avatars/a1.png' });
  assert.deepEqual(snap.players[2], { userId: ctx.bob.id, nickname: 'Bob', avatarUrl: '' });
  assert.deepEqual(snap.presence, { 1: true, 2: true });
  assert.equal(codeOf(() => ctx.manager.sync(ctx.carol.id, s.id)), 'not_player');
  assert.equal(codeOf(() => ctx.manager.sync(ctx.alice.id, 'nonexistent12')), 'not_found');

  const a = ctx.manager.startAiGame(ctx.carol.id, { size: 9, level: 'd1', color: 'black' });
  const as = ctx.manager.sync(ctx.carol.id, a.id);
  assert.deepEqual(as.players[2], { ai: true, level: 'd1', nickname: 'AI · 1段', avatarUrl: '' });
  assert.deepEqual(as.presence, { 1: false, 2: true });
  assert.equal(as.timeControl, null);
  assert.equal(as.clocks, null);
});

test('同步：刚结束的对局来自内存，过一段时间后来自数据库', () => {
  const ctx = setupManager();
  const s = ranked(ctx);
  play(ctx, s, [40, 41]);
  ctx.manager.resign(ctx.alice.id, s.id);
  const a = ctx.manager.sync(ctx.alice.id, s.id);
  assert.equal(a.status, 'ended');
  assert.equal(a.result.text, 'W+R');
  const findsBefore = ctx.repos.callsOf('games.findById').length;
  ctx.clock.advance(ENDED_KEEP_MS);
  const b = ctx.manager.sync(ctx.bob.id, s.id);
  assert.ok(ctx.repos.callsOf('games.findById').length > findsBefore);
  assert.equal(b.status, 'ended');
  assert.deepEqual(b.moves, [40, 41]);
  assert.equal(b.result.text, 'W+R');
  assert.equal(b.result.counted, true, '双方都下过一手：认输计入');
  assert.equal(codeOf(() => ctx.manager.sync(ctx.carol.id, s.id)), 'not_player');
  assert.equal(codeOf(() => ctx.manager.move(ctx.carol.id, s.id, 3, 1)), 'not_player');
  assert.equal(codeOf(() => ctx.manager.move(ctx.alice.id, s.id, 3, 1)), 'wrong_phase');
});

test('同步时处理已到期事件', () => {
  const ctx = setupManager();
  const s = ranked(ctx);
  ctx.manager._disarm(s.id);
  const t = ctx.clock.now() + 60000;
  ctx.manager.now = () => t;
  const snap = ctx.manager.sync(ctx.alice.id, s.id);
  assert.equal(snap.status, 'ended');
  assert.equal(snap.result.reason, 'abort');
});

test('重启恢复：进行中/数子中/人机对局从 listUnfinished 恢复，损坏的记录作废', async () => {
  const ctx = setupManager({ ai: createFakeAi({ manual: true, manualJudge: true }) });
  const g1 = ranked(ctx);
  play(ctx, g1, [40, 41, 42]); // 轮到白
  const g2 = ctx.manager.createHumanGame({ mode: 'friend', size: 9, blackId: ctx.carol.id, whiteId: ctx.bob.id });
  play(ctx, g2, [40, -1, -1]); // 数子中
  const g3 = ctx.manager.startAiGame(ctx.alice.id, { size: 9, level: 'k10', color: 'black' });
  ctx.manager.move(ctx.alice.id, g3.id, 1, 40); // 轮到 AI（挂起）
  const clocksBefore = JSON.parse(JSON.stringify(g1.clock.sides));
  ctx.repos.games.insert({
    id: 'broken000001',
    mode: 'ranked',
    size: 9,
    komi: 7.5,
    black_id: ctx.alice.id,
    white_id: ctx.carol.id,
    time_control: { mainMs: 1000, periods: 0, periodMs: 0 },
    status: 'playing',
    moves: [40, 40],
    created_at: ctx.clock.now(),
  });
  ctx.manager.shutdown();

  ctx.clock.advance(3600000); // 停机一小时
  ctx.hub.online.clear();
  const judgeBefore = ctx.ai.calls.judgeDead.length;
  const moveBefore = ctx.ai.calls.chooseMove.length;
  const m2 = ctx.makeManager();
  const n = m2.restore();
  assert.equal(n, 3);
  assert.equal(ctx.repos._db.games.get('broken000001').status, 'ended');
  assert.equal(ctx.repos._db.games.get('broken000001').reason, 'abort');
  assert.equal(ctx.logger.logs.error.length, 1);

  const r1 = m2.getSession(g1.id);
  assert.deepEqual(r1.moves, [40, 41, 42]);
  assert.deepEqual(r1.clock.sides, clocksBefore);
  assert.equal(r1.clock.running, null, '轮到的白方还没重新连上：先不走钟');
  assert.deepEqual(r1.online, { 1: false, 2: false });
  assert.deepEqual(r1.arrival.waiting, { 1: true, 2: true });
  assert.deepEqual(m2.activeGamesOf(ctx.alice.id).map((g) => g.id).sort(), [g1.id, g3.id].sort());

  const r2 = m2.getSession(g2.id);
  assert.equal(r2.status, 'scoring');
  assert.equal(r2.scoring.pending, true);
  assert.equal(ctx.ai.calls.judgeDead.length, judgeBefore + 1);
  ctx.ai.resolveNextJudge(); // 停机前的那次（旧管理器已关闭）→ 忽略
  ctx.ai.resolveNextJudge([]);
  await flush();
  assert.equal(r2.scoring.pending, false);
  assert.equal(r2.scoring.version, 1);

  const r3 = m2.getSession(g3.id);
  assert.equal(r3.aiThinking, true);
  assert.equal(ctx.ai.calls.chooseMove.length, moveBefore + 1);
  ctx.ai.resolveNextMove({ move: 7, resign: false }); // 旧管理器的请求 → 忽略
  ctx.ai.resolveNextMove({ move: 8, resign: false });
  await flush();
  assert.deepEqual(r3.moves, [40, 8]);

  // 恢复后轮到的一方一直没回来：宽限（arrivalGraceMs）后作废，不按掉线判负
  m2.userOnline(ctx.alice.id);
  ctx.clock.advance(90000);
  assert.equal(r1.status, 'playing');
  ctx.clock.advance(210000);
  assert.equal(r1.status, 'ended');
  assert.equal(r1.result.reason, 'abort');
  m2.shutdown();
});

test('重启恢复：人机对局按上次操作时间计算闲置', () => {
  const ctx = setupManager();
  const s = ctx.manager.startAiGame(ctx.alice.id, { size: 9, level: 'k10', color: 'black' });
  ctx.manager.shutdown();
  ctx.clock.advance(86400000 + 5);
  const m2 = ctx.makeManager();
  m2.restore();
  ctx.clock.tick();
  assert.equal(ctx.repos._db.games.get(s.id).reason, 'abort');
  assert.equal(m2.getSession(s.id), null);
});
