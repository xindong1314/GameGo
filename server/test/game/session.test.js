'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GameSession, replayMoves, normalizeRow } = require('../../src/game/session');
const { GameError } = require('../../src/game/errors');

const SETTINGS = {
  firstMoveTimeoutMs: 60000,
  abandonMs: 90000,
  scoringTimeoutMs: 180000,
  aiIdleTimeoutMs: 86400000,
  minMovesRanked: 10,
};
const TC = { mainMs: 60000, periods: 3, periodMs: 10000 };
const T0 = 1000000;

// 9 路：黑墙 x=4，白墙 x=5，黑地里一颗白死子（10），黑多一子在 72。双方 pass 后进入数子。
// 标记 10 为死子：黑 45，白 36 + 7.5 → B+1.5；不标：黑 10，白 44.5 → W+34.5
const WALL = [4, 5, 13, 14, 22, 23, 31, 32, 40, 41, 49, 50, 58, 59, 67, 68, 76, 77, 72, 10];

function human(opts = {}) {
  return new GameSession({
    id: 'g00000000001',
    mode: 'ranked',
    size: 9,
    komi: 7.5,
    blackId: 1,
    whiteId: 2,
    timeControl: TC,
    settings: SETTINGS,
    now: T0,
    ...opts,
  });
}

function aiGame(humanColor = 1, opts = {}) {
  return new GameSession({
    id: 'a00000000001',
    mode: 'ai',
    size: 9,
    komi: 7.5,
    blackId: humanColor === 1 ? 1 : null,
    whiteId: humanColor === 2 ? 1 : null,
    aiLevel: 'k10',
    settings: SETTINGS,
    now: T0,
    ...opts,
  });
}

function playAll(s, moves, now = T0) {
  for (const mv of moves) {
    const c = s.toPlay;
    if (mv === -1) s.pass(c, s.moves.length + 1, now);
    else s.play(c, s.moves.length + 1, mv, now);
  }
}

function assertCode(fn, code) {
  assert.throws(fn, (err) => err instanceof GameError && err.code === code);
}

test('构造：校验模式、玩家与难度', () => {
  assert.throws(() => human({ mode: 'x' }), TypeError);
  assert.throws(() => human({ whiteId: 1 }), TypeError);
  assert.throws(() => human({ whiteId: null }), TypeError);
  assert.throws(() => human({ size: 20 }), TypeError);
  assert.throws(() => aiGame(1, { aiLevel: '' }), TypeError);
  assert.throws(() => aiGame(1, { whiteId: 2 }), TypeError);
  assert.throws(() => human({ settings: {} }), TypeError);
  const s = human();
  assert.equal(s.status, 'playing');
  assert.equal(s.toPlay, 1);
  assert.equal(s.clock.running, 1);
  assert.equal(s.colorOf(1), 1);
  assert.equal(s.colorOf(2), 2);
  assert.equal(s.colorOf(3), 0);
  assert.deepEqual(s.userIds(), [1, 2]);
  const a = aiGame(2);
  assert.equal(a.aiColor, 1);
  assert.equal(a.humanColor, 2);
  assert.equal(a.clock, null);
  assert.equal(a.timeControl, null);
  assert.deepEqual(a.online, { 1: true, 2: false });
  assert.deepEqual(a.userIds(), [1]);
});

test('落子：记录着手、返回提子、切换计时、版本递增', () => {
  const s = human();
  const v0 = s.version;
  const r1 = s.play(1, 1, 1, T0 + 5000);
  assert.deepEqual(r1, { n: 1, idx: 1, color: 1, captured: [], scoring: false });
  assert.equal(s.clock.running, 2);
  assert.deepEqual(s.clock.sides[1], { mainMs: 55000, periodsLeft: 3 });
  assert.ok(s.version > v0);
  s.play(2, 2, 0, T0 + 6000);
  const r3 = s.play(1, 3, 9, T0 + 7000);
  assert.deepEqual(r3.captured, [0]);
  assert.deepEqual(s.moves, [1, 0, 9]);
  assert.equal(s.turnStartedAt, T0 + 7000);
});

test('落子：手数不对 → stale，不是自己的回合 → not_your_turn', () => {
  const s = human();
  assertCode(() => s.play(1, 2, 40, T0), 'stale');
  assertCode(() => s.play(2, 1, 40, T0), 'not_your_turn');
  s.play(1, 1, 40, T0);
  assertCode(() => s.play(1, 2, 41, T0), 'not_your_turn');
  assertCode(() => s.pass(2, 1, T0), 'stale');
  try {
    s.play(2, 5, 41, T0);
  } catch (err) {
    assert.equal(err.toJSON().expected, 2);
  }
});

test('落子：非法着手带原因（occupied / ko / suicide），越界为 bad_request', () => {
  const s = human();
  s.play(1, 1, 40, T0);
  assert.throws(
    () => s.play(2, 2, 40, T0),
    (err) => err.code === 'illegal' && err.extra.reason === 'occupied' && /棋子/.test(err.msg),
  );
  assertCode(() => s.play(2, 2, 81, T0), 'bad_request');
  assertCode(() => s.play(2, 2, -3, T0), 'bad_request');

  const k = human();
  playAll(k, [1, 2, 9, 10, 19, 12, 80, 20, 11]); // 黑 11 提白 10，形成劫
  assert.throws(() => k.play(2, 10, 10, T0), (err) => err.code === 'illegal' && err.extra.reason === 'ko');

  const su = human();
  playAll(su, [1, 80, 9]);
  assert.throws(() => su.play(2, 4, 0, T0), (err) => err.code === 'illegal' && err.extra.reason === 'suicide');
  assert.deepEqual(su.moves, [1, 80, 9]);
});

test('落子：已超时的一方不能再落子（wrong_phase）', () => {
  const s = human();
  assertCode(() => s.play(1, 1, 40, T0 + 90000), 'wrong_phase');
  assert.deepEqual(s.moves, []);
  s.play(1, 1, 40, T0 + 89999);
  assert.deepEqual(s.clock.sides[1], { mainMs: 0, periodsLeft: 1 });
});

test('双方连续 pass → scoring：停钟、等待死子建议', () => {
  const s = human();
  s.play(1, 1, 40, T0);
  const r1 = s.pass(2, 2, T0 + 1000);
  assert.equal(r1.scoring, false);
  assert.equal(r1.idx, -1);
  const r2 = s.pass(1, 3, T0 + 2000);
  assert.deepEqual(r2, { n: 3, idx: -1, color: 1, captured: [], scoring: true });
  assert.equal(s.status, 'scoring');
  assert.equal(s.clock.running, null);
  assert.equal(s.scoring.pending, true);
  assert.equal(s.scoring.version, 0);
  assert.equal(s.judgeToken, s.scoring.judgeSeq);
  assertCode(() => s.play(2, 4, 41, T0), 'wrong_phase');
  assertCode(() => s.pass(2, 4, T0), 'wrong_phase');
  const v = s.scoringView(T0);
  assert.equal(v.pending, true);
  assert.equal(v.deadline, null);
  assert.equal(v.owner.length, 81);
});

test('死子建议：过期序号被忽略；到达后 version=1、开始倒计时；null 表示手动', () => {
  const s = human();
  playAll(s, [...WALL, -1, -1]);
  assert.equal(s.status, 'scoring');
  const seq = s.judgeToken;
  assert.equal(s.applyJudge(seq + 1, [10], T0), false);
  assert.equal(s.applyJudge(seq, [10, 999, 'x', 30], T0 + 500), true); // 非法项被过滤；30 是空点 → 忽略
  const v = s.scoringView(T0 + 1500);
  assert.equal(v.pending, false);
  assert.equal(v.source, 'katago');
  assert.equal(v.version, 1);
  assert.deepEqual(v.dead, [10]);
  assert.equal(v.black, 45);
  assert.equal(v.white, 43.5);
  assert.equal(v.winner, 1);
  assert.deepEqual(v.accepted, { 1: false, 2: false });
  assert.equal(v.deadline, 179000);
  assert.equal(s.applyJudge(seq, [], T0), false); // 已不在等待中

  const m = human();
  playAll(m, [...WALL, -1, -1]);
  assert.equal(m.applyJudge(m.judgeToken, null, T0), true);
  assert.equal(m.scoring.source, 'manual');
  assert.deepEqual(m.scoring.dead, []);
  assert.equal(m.scoring.winner, 2);
});

test('数子：等待建议时不能点选/确认；点选切换整块、版本 +1、双方确认清零', () => {
  const s = human();
  playAll(s, [...WALL, -1, -1]);
  assertCode(() => s.toggleDead(1, 10, T0), 'wrong_phase');
  assertCode(() => s.accept(1, 0, T0), 'wrong_phase');
  s.applyJudge(s.judgeToken, [], T0);
  s.accept(1, 1, T0);
  assert.equal(s.scoring.accepted[1], true);
  const r = s.toggleDead(2, 10, T0);
  assert.deepEqual(r, { changed: true });
  assert.equal(s.scoring.version, 2);
  assert.deepEqual(s.scoring.dead, [10]);
  assert.deepEqual(s.scoring.accepted, { 1: false, 2: false });
  assert.equal(s.scoring.winner, 1);
  // 点空点：不变
  assert.deepEqual(s.toggleDead(1, 0, T0), { changed: false });
  assert.equal(s.scoring.version, 2);
  // 整块切换：黑墙整块
  s.toggleDead(1, 4, T0);
  assert.equal(s.scoring.dead.length, 10);
  s.toggleDead(1, 13, T0);
  assert.deepEqual(s.scoring.dead, [10]);
  assert.equal(s.scoring.version, 4);
  assertCode(() => s.toggleDead(1, 81, T0), 'bad_request');
});

test('数子：确认须带当前版本；双方确认后按当前死子计分终局', () => {
  const s = human();
  playAll(s, [...WALL, -1, -1]);
  s.applyJudge(s.judgeToken, [10], T0);
  assertCode(() => s.accept(1, 2, T0), 'stale');
  assert.deepEqual(s.accept(1, 1, T0), { done: false });
  assert.deepEqual(s.accept(1, 1, T0), { done: false }); // 重复确认无害
  assert.deepEqual(s.accept(2, 1, T0), { done: true });
  const result = s.finishByScore(T0 + 10);
  assert.deepEqual(result, { winner: 1, reason: 'score', black: 45, white: 43.5 });
  assert.equal(s.status, 'ended');
  assert.equal(s.counted, true);
  assert.deepEqual(s.resultView(), {
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
  assert.equal(s.scoringView(T0).deadline, null);
  assert.deepEqual(s.finishFields().dead, [10]);
  assert.equal(s.finishFields().resultText, 'B+1.5');
});

function online(s, now = T0) {
  s.setOnline(1, true, now);
  s.setOnline(2, true, now);
  return s;
}

test('继续对局：回到 playing，轮到最先 pass 的一方，重新计时，过期的死子判断作废', () => {
  const s = online(human({ settings: { ...SETTINGS, resumeLimit: 2 } }));
  s.play(1, 1, 40, T0);
  s.pass(2, 2, T0 + 1000); // 白先 pass
  s.pass(1, 3, T0 + 2000);
  const seq = s.judgeToken;
  const r = s.resume(1, T0 + 5000);
  assert.deepEqual(r, { toPlay: 2 });
  assert.equal(s.status, 'playing');
  assert.equal(s.scoring, null);
  assert.equal(s.clock.running, 2);
  assert.equal(s.turnStartedAt, T0 + 5000);
  assert.equal(s.applyJudge(seq, [], T0), false);
  assertCode(() => s.resume(1, T0), 'wrong_phase');
  // 继续后再 pass 一次不会立即进入数子
  s.pass(2, 4, T0 + 6000);
  assert.equal(s.status, 'playing');
  s.pass(1, 5, T0 + 7000);
  assert.equal(s.status, 'scoring');
});

test('认输：对局中或数子阶段均可；终局后不能再认输', () => {
  const s = human();
  s.play(1, 1, 40, T0);
  s.resign(1, T0 + 100);
  assert.deepEqual(s.result, { winner: 2, reason: 'resign', black: null, white: null });
  assert.equal(s.counted, false); // 手数不足 10
  assertCode(() => s.resign(2, T0), 'wrong_phase');
  assertCode(() => s.play(2, 2, 41, T0), 'wrong_phase');

  const sc = human();
  playAll(sc, [40, -1, -1]);
  sc.resign(2, T0);
  assert.equal(sc.result.winner, 1);
  assert.equal(sc.scoring, null); // 等待建议中认输：没有数子信息
});

test('计入排行（6.6）：排位 + 非作废 +（认输/超时：双方都下过一手；数子：落子 ≥ minMovesRanked）', () => {
  const long = human();
  playAll(long, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  long.resign(1, T0);
  assert.equal(long.counted, true);

  // 开局几手就超时/认输也计入（COMP-5：不能靠早早认输躲开强手、保住连胜）
  const timeout = human();
  playAll(timeout, [0, 1, 2]);
  timeout.timeoutLoss(2, T0);
  assert.equal(timeout.counted, true);
  assert.equal(timeout.result.reason, 'timeout');
  assert.equal(timeout.result.winner, 1);
  const early = human();
  playAll(early, [0, 1]);
  early.resign(1, T0);
  assert.equal(early.counted, true);
  assert.equal(early.resultView().uncounted, null);

  // 自己还一手没下就认输/超时（相当于拒绝这盘棋）：不计
  const refuse = human();
  playAll(refuse, [0]);
  refuse.resign(2, T0);
  assert.equal(refuse.counted, false);
  assert.equal(refuse.resultView().uncounted, 'short');
  const refuseB = human();
  refuseB.resign(1, T0);
  assert.equal(refuseB.counted, false);

  const ab = human();
  playAll(ab, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  ab.abort(T0);
  assert.equal(ab.counted, false);
  assert.equal(ab.resultView().text, 'Void');

  const friend = human({ mode: 'friend' });
  playAll(friend, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  friend.resign(2, T0);
  assert.equal(friend.counted, false);

  // 数子终局：落子（不含 pass）不足 minMovesRanked 不计——开局就双方 pass 刷不了胜局
  const scored = human();
  playAll(scored, [40, -1, -1]);
  scored.applyJudge(scored.judgeToken, [], T0);
  scored.finishByScore(T0);
  assert.equal(scored.counted, false);
  assert.equal(scored.resultView().uncounted, 'short');
  const full = human();
  playAll(full, [...WALL, -1, -1]);
  full.applyJudge(full.judgeToken, [10], T0);
  full.finishByScore(T0);
  assert.equal(full.counted, true);
  assert.equal(full.resultView().uncounted, null);
  // 好友、人机、作废：uncounted 为 null（客户端按 mode / reason 说明）
  assert.equal(friend.resultView().uncounted, null);
  assert.equal(ab.resultView().uncounted, null);
});

test('到期事件：首手超时作废', () => {
  const s = human();
  assert.equal(s.nextDeadline(), T0 + 60000);
  assert.equal(s.dueAction(T0 + 59999), null);
  assert.equal(s.dueAction(T0 + 60000), 'first_move');
  s.applyDue('first_move', T0 + 60000);
  assert.equal(s.result.reason, 'abort');
  assert.deepEqual(s.deadlines(), []);
});

test('到期事件：读秒用尽判负；没下第一手时一律按作废', () => {
  const s = human({ timeControl: { mainMs: 1000, periods: 1, periodMs: 1000 }, settings: { ...SETTINGS, firstMoveTimeoutMs: 999999 } });
  assert.equal(s.dueAction(T0 + 2000), 'first_move');
  s.play(1, 1, 40, T0 + 500);
  assert.equal(s.nextDeadline(), T0 + 500 + 2000);
  assert.equal(s.dueAction(T0 + 2499), null);
  assert.equal(s.dueAction(T0 + 2500), 'timeout');
  s.applyDue('timeout', T0 + 2500);
  assert.deepEqual(s.result, { winner: 1, reason: 'timeout', black: null, white: null });
  assert.deepEqual(s.clock.sides[2], { mainMs: 0, periodsLeft: 0 });
});

test('到期事件：只有轮到的一方掉线才会弃局；手数不足作废，否则超时负', () => {
  // 只有读秒（没有基本时间）：掉线 abandonMs 后判负
  const s = human({ timeControl: { mainMs: 0, periods: 30, periodMs: 30000 } });
  s.setOnline(1, true, T0);
  s.setOnline(2, true, T0);
  playAll(s, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], T0 + 1000); // 10 手后轮到黑
  s.setOnline(2, false, T0 + 2000); // 白掉线，但轮到黑
  assert.ok(!s.deadlines().some((d) => d.kind === 'abandon'));
  s.setOnline(1, false, T0 + 3000);
  const ab = s.deadlines().find((d) => d.kind === 'abandon');
  assert.equal(ab.at, T0 + 3000 + 90000);
  s.setOnline(1, true, T0 + 4000);
  assert.ok(!s.deadlines().some((d) => d.kind === 'abandon'));
  s.setOnline(1, false, T0 + 5000);
  assert.equal(s.dueAction(T0 + 95000), 'abandon');
  s.applyDue('abandon', T0 + 95000);
  assert.deepEqual(s.result, { winner: 2, reason: 'timeout', black: null, white: null });
  assert.equal(s.counted, true);

  // 轮到的一方还一手没下（总手数 < 2）就掉线：作废
  const few = human({ timeControl: { mainMs: 30000, periods: 3, periodMs: 10000 } });
  few.setOnline(1, true, T0);
  playAll(few, [0], T0); // 轮到白，白掉线
  const at = few.deadlines().find((d) => d.kind === 'abandon').at;
  assert.equal(at, T0 + 90000);
  few.applyDue('abandon', at);
  assert.equal(few.result.reason, 'abort');
  assert.equal(few.resultView().cause, 'abandon');

  // 双方都下过：掉线判超时负并计入（不再因为手数不足 10 就作废）
  const early = human({ timeControl: { mainMs: 30000, periods: 3, periodMs: 10000 } });
  early.setOnline(1, true, T0);
  playAll(early, [0, 1, 2], T0); // 轮到白
  early.applyDue('abandon', early.deadlines().find((d) => d.kind === 'abandon').at);
  assert.equal(early.result.reason, 'timeout');
  assert.equal(early.resultView().cause, 'abandon');
  assert.equal(early.counted, true);
});

test('到期事件：掉线早于轮到自己时，从轮到自己起算', () => {
  const s = human({ timeControl: { mainMs: 30000, periods: 3, periodMs: 10000 } });
  s.setOnline(1, true, T0);
  s.setOnline(2, false, T0);
  s.play(1, 1, 40, T0 + 30000);
  assert.equal(s.deadlines().find((d) => d.kind === 'abandon').at, T0 + 30000 + 90000);
});

test('到期事件：数子自动确认、人机闲置作废', () => {
  const s = human();
  playAll(s, [...WALL, -1, -1], T0);
  assert.equal(s.nextDeadline(), null); // 等待建议时没有时限
  s.applyJudge(s.judgeToken, [10], T0 + 1000);
  assert.equal(s.nextDeadline(), T0 + 181000);
  assert.equal(s.dueAction(T0 + 181000), 'scoring');
  s.applyDue('scoring', T0 + 181000);
  assert.equal(s.result.reason, 'score');
  assert.equal(s.result.winner, 1);

  const a = aiGame(1);
  assert.deepEqual(a.deadlines(), [{ kind: 'idle', at: T0 + 86400000 }]);
  a.touch(T0 + 5000);
  assert.equal(a.nextDeadline(), T0 + 5000 + 86400000);
  assert.equal(a.dueAction(T0 + 5000 + 86400000), 'idle');
  a.applyDue('idle', T0 + 5000 + 86400000);
  assert.equal(a.result.reason, 'abort');
});

test('人机悔棋：轮到人时撤回人的一手和 AI 的应手', () => {
  const s = aiGame(1); // 人执黑
  assert.equal(s.canUndo(), false);
  assertCode(() => s.undo(1, T0), 'nothing_to_undo');
  s.play(1, 1, 40, T0);
  s.play(2, 2, 0, T0); // AI
  assert.equal(s.canUndo(), true);
  const v = s.version;
  assert.deepEqual(s.undo(1, T0), { moves: [] });
  assert.equal(s.toPlay, 1);
  assert.ok(s.version > v);
  assert.equal(s.canUndo(), false);
});

test('人机悔棋：AI 思考中只撤回人的一手；AI 先手时第一手不可悔', () => {
  const s = aiGame(2); // AI 执黑
  s.play(1, 1, 40, T0);
  assert.equal(s.canUndo(), false);
  assertCode(() => s.undo(2, T0), 'nothing_to_undo');
  s.play(2, 2, 41, T0);
  s.aiThinking = true;
  assert.deepEqual(s.undo(2, T0), { moves: [40] });
  assert.equal(s.aiThinking, false);
  assert.equal(s.toPlay, 2);
});

test('人机悔棋：数子阶段悔棋 = 撤回 pass 回到对局', () => {
  const s = aiGame(1);
  playAll(s, [40, 0, -1, -1]); // 人 pass，AI pass
  assert.equal(s.status, 'scoring');
  assert.deepEqual(s.undo(1, T0).moves, [40, 0]);
  assert.equal(s.status, 'playing');
  assert.equal(s.scoring, null);
  assert.equal(s.toPlay, 1);

  const t = aiGame(1);
  playAll(t, [40, -1, -1]); // AI 先 pass，人再 pass
  assert.equal(t.status, 'scoring');
  assert.deepEqual(t.undo(1, T0).moves, [40, -1]);
  assert.equal(t.status, 'playing');
  assert.equal(t.toPlay, 1);
  assert.equal(t.humanJustPassed(), false);
});

test('人机：真人对局不能悔棋，人机对局不能点选死子，终局后不能悔棋', () => {
  const h = human();
  h.play(1, 1, 40, T0);
  assertCode(() => h.undo(1, T0), 'bad_request');
  const a = aiGame(1);
  playAll(a, [40, -1, -1]);
  a.applyJudge(a.judgeToken, [], T0);
  assert.equal(a.scoring.accepted[2], true); // AI 自动确认
  assert.equal(a.scoring.deadlineAt, null);
  assertCode(() => a.toggleDead(1, 40, T0), 'bad_request');
  assert.deepEqual(a.accept(1, 1, T0), { done: true });
  a.finishByScore(T0);
  assertCode(() => a.undo(1, T0), 'wrong_phase');
  assert.equal(a.canUndo(), false);
  assert.equal(a.counted, false);
});

test('humanJustPassed：人刚 pass 为真；继续对局后为假', () => {
  const s = aiGame(2); // AI 执黑
  s.play(1, 1, 40, T0);
  s.pass(2, 2, T0);
  assert.equal(s.humanJustPassed(), true);
  s.pass(1, 3, T0); // AI pass → 数子
  s.resume(2, T0); // 轮到最先 pass 的人
  assert.equal(s.toPlay, 2);
  s.pass(2, 4, T0);
  assert.equal(s.humanJustPassed(), true);
});

test('在线状态：AI 一方恒为在线；返回是否变化', () => {
  const a = aiGame(1);
  assert.equal(a.setOnline(2, false, T0), false);
  assert.equal(a.online[2], true);
  assert.equal(a.setOnline(1, true, T0), true);
  assert.equal(a.setOnline(1, true, T0), false);
  assert.equal(a.setOnline(3, true, T0), false);
});

test('快照：字段齐全', () => {
  const s = human();
  s.setOnline(1, true, T0);
  s.play(1, 1, 40, T0 + 1000);
  const players = { 1: { userId: 1, nickname: 'A', avatarUrl: '' }, 2: { userId: 2, nickname: 'B', avatarUrl: '' } };
  const snap = s.snapshot(2, T0 + 3000, players);
  assert.deepEqual(snap, {
    id: 'g00000000001',
    mode: 'ranked',
    size: 9,
    komi: 7.5,
    players,
    myColor: 2,
    moves: [40],
    status: 'playing',
    toPlay: 2,
    timeControl: TC,
    clocks: {
      running: 2,
      1: { mainMs: 59000, periodsLeft: 3, periodMs: 10000 },
      2: { mainMs: 58000, periodsLeft: 3, periodMs: 10000 },
    },
    scoring: null,
    result: null,
    presence: { 1: true, 2: false },
    aiThinking: false,
    canUndo: false,
  });
  snap.moves.push(1);
  assert.deepEqual(s.moves, [40]); // 快照是副本
});

test('replayMoves：支持"继续对局"后的着手序列；非法着手报错', () => {
  const st = replayMoves(9, 7.5, [40, -1, -1, 41, 42]);
  assert.equal(st.status, 'playing');
  assert.equal(st.board.get(41), 2);
  assert.equal(st.board.get(42), 1);
  assert.equal(replayMoves(9, 7.5, [40, -1, -1]).status, 'scoring');
  assert.throws(() => replayMoves(9, 7.5, [40, 40]), (err) => err.moveIndex === 1);
  assert.throws(() => replayMoves(9, 7.5, [81]), (err) => err.moveIndex === 0);
  assert.throws(() => replayMoves(9, 7.5, [1.5]), /坐标非法/);
  assert.throws(() => replayMoves(9, 7.5, 'x'), /数组/);
});

test('normalizeRow：兼容下划线字段与 JSON 字符串', () => {
  const row = normalizeRow({
    id: 'x',
    mode: 'ranked',
    size: 9,
    komi: 7.5,
    black_id: 1,
    white_id: 2,
    time_control: JSON.stringify(TC),
    status: 'playing',
    moves: '[1,2]',
    clocks: null,
    counted: 1,
    created_at: 5,
    updated_at: 6,
  });
  assert.equal(row.blackId, 1);
  assert.deepEqual(row.timeControl, TC);
  assert.deepEqual(row.moves, [1, 2]);
  assert.equal(row.counted, true);
  assert.equal(row.updatedAt, 6);
  assert.throws(() => normalizeRow({ id: 'x', moves: '[' }), /JSON/);
  assert.throws(() => normalizeRow(null), TypeError);
});

function rowOf(s, patch = {}) {
  const r = s.insertRow(T0);
  return {
    id: r.id,
    mode: r.mode,
    size: r.size,
    komi: r.komi,
    blackId: r.black_id,
    whiteId: r.white_id,
    aiLevel: r.ai_level,
    timeControl: r.time_control,
    status: r.status,
    moves: r.moves,
    clocks: r.clocks,
    dead: null,
    winner: null,
    reason: null,
    scoreBlack: null,
    scoreWhite: null,
    resultText: null,
    counted: false,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    endedAt: null,
    ...patch,
  };
}

test('fromRow：恢复进行中的对局，读秒按保存值继续，停机时间不计入', () => {
  const s = human();
  s.play(1, 1, 40, T0 + 20000);
  s.play(2, 2, 41, T0 + 30000);
  const row = rowOf(s, { ...s.progress(), updatedAt: T0 + 30000 });
  const later = T0 + 10 * 3600 * 1000;
  const r = GameSession.fromRow(row, { settings: SETTINGS, now: later });
  assert.deepEqual(r.moves, [40, 41]);
  assert.equal(r.status, 'playing');
  assert.equal(r.toPlay, 1);
  assert.equal(r.clock.running, 1);
  assert.deepEqual(r.clock.sides[1], { mainMs: 40000, periodsLeft: 3 });
  assert.deepEqual(r.clock.sides[2], { mainMs: 50000, periodsLeft: 3 });
  assert.equal(r.clock.timeoutAt(), later + 70000);
  assert.deepEqual(r.online, { 1: false, 2: false });
  assert.equal(r.startedAt, later);
});

test('fromRow：两次 pass 后已继续对局（库里为 playing）→ playing；库里为 scoring → 重新等待死子建议', () => {
  const s = human();
  playAll(s, [40, -1, -1]);
  const resumed = GameSession.fromRow(rowOf(s, { status: 'playing', moves: [40, -1, -1] }), { settings: SETTINGS, now: T0 });
  assert.equal(resumed.status, 'playing');
  assert.equal(resumed.toPlay, 2);
  const scoring = GameSession.fromRow(rowOf(s, { status: 'scoring', moves: [40, -1, -1] }), { settings: SETTINGS, now: T0 });
  assert.equal(scoring.status, 'scoring');
  assert.equal(scoring.scoring.pending, true);
  assert.equal(scoring.clock.running, null);
  assert.ok(scoring.judgeToken !== null);
});

test('fromRow：已结束的对局可生成终局快照；人机对局恢复闲置时间', () => {
  const s = human();
  playAll(s, [...WALL, -1, -1]);
  const ended = GameSession.fromRow(
    rowOf(s, {
      status: 'ended',
      moves: s.moves,
      dead: [10],
      winner: 1,
      reason: 'score',
      scoreBlack: 45,
      scoreWhite: 43.5,
      counted: true,
      endedAt: T0 + 5,
    }),
    { settings: SETTINGS, now: T0 + 100 },
  );
  assert.equal(ended.status, 'ended');
  const snap = ended.snapshot(1, T0 + 100, {});
  assert.equal(snap.result.text, 'B+1.5');
  assert.equal(snap.result.counted, true);
  assert.deepEqual(snap.scoring.dead, [10]);
  assert.deepEqual(snap.scoring.accepted, { 1: true, 2: true });
  assert.equal(snap.scoring.deadline, null);
  assert.equal(snap.clocks.running, null);
  assert.deepEqual(ended.deadlines(), []);

  const a = aiGame(1);
  a.play(1, 1, 40, T0);
  const restored = GameSession.fromRow(rowOf(a, { moves: [40], updatedAt: T0 + 7 }), { settings: SETTINGS, now: T0 + 1000 });
  assert.equal(restored.lastActivityAt, T0 + 7);
  assert.equal(restored.aiColor, 2);
  assert.equal(restored.toPlay, 2);
  assert.equal(restored.clock, null);
});

test('fromRow：着手序列损坏时抛错', () => {
  const s = human();
  assert.throws(() => GameSession.fromRow(rowOf(s, { moves: [40, 40] }), { settings: SETTINGS, now: T0 }));
});

test('持久化字段：insertRow / progress / finishFields', () => {
  const s = human();
  const row = s.insertRow(T0);
  assert.equal(row.black_id, 1);
  assert.equal(row.white_id, 2);
  assert.equal(row.ai_level, null);
  assert.deepEqual(row.time_control, TC);
  assert.equal(row.status, 'playing');
  assert.deepEqual(row.moves, []);
  assert.equal(row.counted, 0);
  assert.equal(row.clocks.running, 1);
  s.play(1, 1, 40, T0 + 1000);
  assert.deepEqual(s.progress(), {
    status: 'playing',
    moves: [40],
    clocks: { running: 2, 1: { mainMs: 59000, periodsLeft: 3, periodMs: 10000 }, 2: { mainMs: 60000, periodsLeft: 3, periodMs: 10000 } },
    state: { resumesUsed: { 1: 0, 2: 0 }, guard: null },
  });
  s.resign(2, T0 + 2000);
  assert.deepEqual(s.finishFields(), {
    status: 'ended',
    moves: [40],
    dead: null,
    winner: 1,
    reason: 'resign',
    scoreBlack: null,
    scoreWhite: null,
    resultText: 'B+R',
    counted: false,
    cause: null,
  });
  assert.equal(aiGame(2).progress().state, null, '人机对局没有附加状态');
  const a = aiGame(2).insertRow(T0);
  assert.equal(a.black_id, null);
  assert.equal(a.white_id, 1);
  assert.equal(a.ai_level, 'k10');
  assert.equal(a.time_control, null);
  assert.equal(a.clocks, null);
});
