'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GameSession } = require('../../src/game/session');
const { GameError } = require('../../src/game/errors');

// 数子与弃局规则的公平性（回归测试）：
// - 继续对局的次数限制；对手不在线不能继续；继续后已同意的一方掉线 → 撤销继续对局按数子终局
// - 自动确认时限到：不采用单方面的点选（回退到双方认可过的版本，或最初的建议）；点选顺延时限
// - 重启恢复 / 开局时不在线：到场前不走钟、不判负，超时作废
// - 掉线弃局：基本时间没用完之前不判负
// - 人机对局：死子判断失败（manual）时可以点选
// - 局面没变时复用死子判断

const SETTINGS = {
  firstMoveTimeoutMs: 60000,
  abandonMs: 90000,
  scoringTimeoutMs: 180000,
  aiIdleTimeoutMs: 86400000,
  minMovesRanked: 10,
};
const TC = { mainMs: 60000, periods: 3, periodMs: 10000 };
const T0 = 1000000;

// 9 路：黑墙 x=4，白墙 x=5，黑地里一颗白死子（10）。标记 10 为死子 → B+1.5；什么都不标 → W+34.5
const WALL = [4, 5, 13, 14, 22, 23, 31, 32, 40, 41, 49, 50, 58, 59, 67, 68, 76, 77, 72, 10];
const B_WINS = { winner: 1, reason: 'score', black: 45, white: 43.5 };

function human(opts = {}) {
  const s = new GameSession({
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
  return s;
}

function online(s, now = T0) {
  s.setOnline(1, true, now);
  s.setOnline(2, true, now);
  return s;
}

function playAll(s, moves, now = T0) {
  for (const mv of moves) {
    const c = s.toPlay;
    if (mv === -1) s.pass(c, s.moves.length + 1, now);
    else s.play(c, s.moves.length + 1, mv, now);
  }
}

function assertCode(fn, code, re) {
  assert.throws(fn, (err) => err instanceof GameError && err.code === code && (!re || re.test(err.msg)));
}

// 双方 pass（黑先 pass）后给出 KataGo 建议 [10]（黑胜 1.5）
function scoredGame(opts) {
  const s = online(human(opts));
  playAll(s, [...WALL, -1, -1]);
  assert.equal(s.applyJudge(s.judgeToken, [10], T0), true);
  return s;
}

// ---------- 继续对局：次数与在线 ----------

test('继续对局：真人对局每方每局 1 次（resumesLeft 随之变化），用完 → wrong_phase；人机不限', () => {
  const s = scoredGame();
  assert.deepEqual(s.scoringView(T0).resumesLeft, { 1: 1, 2: 1 });
  s.resume(2, T0 + 1000); // 白不同意
  playAll(s, [-1, -1], T0 + 2000); // 黑、白又都 pass
  assert.equal(s.status, 'scoring');
  assert.deepEqual(s.cachedJudge(), [10], '局面没变，可以直接复用死子判断');
  s.applyJudge(s.judgeToken, s.cachedJudge(), T0 + 2000);
  assert.deepEqual(s.scoringView(T0 + 2000).resumesLeft, { 1: 1, 2: 0 });
  assertCode(() => s.resume(2, T0 + 3000), 'wrong_phase', /继续对局/);
  assert.equal(s.status, 'scoring');
  // 黑还有 1 次
  s.resume(1, T0 + 4000);
  playAll(s, [-1, -1], T0 + 5000);
  s.applyJudge(s.judgeToken, [10], T0 + 5000);
  assertCode(() => s.resume(1, T0 + 6000), 'wrong_phase');
  assertCode(() => s.resume(2, T0 + 6000), 'wrong_phase');
  // 谁都不能再继续：自动确认时限到了按建议终局，拖延到此为止
  assert.equal(s.dueAction(T0 + 5000 + 180000), 'scoring');
  s.applyDue('scoring', T0 + 5000 + 180000);
  assert.deepEqual(s.result, B_WINS);

  const zero = scoredGame({ settings: { ...SETTINGS, resumeLimit: 0 } });
  assertCode(() => zero.resume(1, T0), 'wrong_phase');

  const ai = new GameSession({ id: 'a00000000001', mode: 'ai', size: 9, komi: 7.5, blackId: 1, aiLevel: 'k10', settings: SETTINGS, now: T0 });
  for (let i = 0; i < 3; i++) {
    playAll(ai, [-1, -1]);
    ai.applyJudge(ai.judgeToken, [], T0);
    assert.equal(ai.scoringView(T0).resumesLeft, null);
    ai.resume(1, T0);
  }
});

test('继续对局：对手不在线时不能继续（交给自动确认）', () => {
  const s = scoredGame();
  s.setOnline(1, false, T0 + 1000);
  assertCode(() => s.resume(2, T0 + 1000), 'wrong_phase', /对手不在线/);
  assert.equal(s.status, 'scoring');
  s.setOnline(1, true, T0 + 2000);
  s.resume(2, T0 + 2000);
  assert.equal(s.status, 'playing');
});

test('继续对局后，此前已同意的一方还没走下一手就掉线：撤销继续对局，按当时的建议数子终局（不是超时负）', () => {
  // 黑是最先 pass 的一方：白继续对局后立即轮到黑（只有读秒：掉线 90 秒后到期）
  const BYO = { mainMs: 0, periods: 10, periodMs: 30000 };
  const s = scoredGame({ timeControl: BYO });
  s.accept(1, 1, T0 + 1000); // 黑（赢棋的一方）已同意
  s.resume(2, T0 + 2000); // 白（输棋的一方）继续对局
  assert.equal(s.toPlay, 1);
  s.setOnline(1, false, T0 + 7000); // 黑已经离开了小程序
  const due = s.deadlines().find((d) => d.kind === 'abandon');
  assert.equal(due.at, T0 + 7000 + 90000);
  assert.equal(s.dueAction(due.at), 'abandon');
  s.applyDue('abandon', due.at);
  assert.deepEqual(s.result, B_WINS);
  assert.equal(s.counted, true);
  assert.equal(s.resumeUndone, true);
  assert.deepEqual(s.moves, [...WALL, -1, -1]);
  assert.deepEqual(s.finishFields().dead, [10]);

  // 白是最先 pass 的一方：白继续后先 pass 一手，轮到掉线的黑 → 同样撤销（白 pass 的那手作废）
  const w = online(human({ timeControl: BYO }));
  playAll(w, [...WALL, 36, -1, -1]); // 黑在自己地里补一手（数子不变），白先 pass
  w.applyJudge(w.judgeToken, [10], T0);
  w.accept(1, 1, T0);
  w.resume(2, T0 + 1000);
  assert.equal(w.toPlay, 2);
  w.pass(2, w.moves.length + 1, T0 + 2000);
  w.setOnline(1, false, T0 + 3000);
  w.applyDue(w.dueAction(T0 + 3000 + 90000), T0 + 3000 + 90000);
  assert.equal(w.result.reason, 'score');
  assert.equal(w.result.winner, 1);
  assert.deepEqual(w.moves, [...WALL, 36, -1, -1]);

  // 读秒比弃局时限先到（掉线期间）：同样撤销
  const t = online(human({ timeControl: { mainMs: 0, periods: 1, periodMs: 20000 } }));
  playAll(t, [...WALL, -1, -1]);
  t.applyJudge(t.judgeToken, [10], T0);
  t.accept(1, 1, T0);
  t.resume(2, T0);
  t.setOnline(1, false, T0 + 1000);
  assert.equal(t.dueAction(T0 + 20000), 'timeout');
  t.applyDue('timeout', T0 + 20000);
  assert.equal(t.result.reason, 'score');

  // 黑回来走了一手之后再掉线：保护结束，照常按弃局判负
  const back = scoredGame({ timeControl: BYO });
  back.accept(1, 1, T0);
  back.resume(2, T0);
  back.play(1, back.moves.length + 1, 36, T0 + 1000);
  back.pass(2, back.moves.length + 1, T0 + 2000);
  back.setOnline(1, false, T0 + 3000);
  back.applyDue('abandon', T0 + 3000 + 90000);
  assert.equal(back.result.reason, 'timeout');
  assert.equal(back.result.winner, 2);

  // 继续对局时对方并没有同意：没有保护
  const none = scoredGame();
  none.resume(2, T0);
  assert.equal(none.resumeGuard, null);
});

// ---------- 自动确认时限 ----------

test('自动确认：最后一刻单方面点选对方活棋为死 → 时限顺延，到时仍按最初的建议终局（SG-2 / PX-1）', () => {
  const s = scoredGame();
  s.accept(1, 1, T0 + 1000); // 黑同意公平的建议
  const at = T0 + 179900;
  s.toggleDead(2, 4, at); // 白在最后 100ms 把黑整条墙点成死棋
  assert.equal(s.scoring.winner, 2);
  assert.deepEqual(s.scoring.accepted, { 1: false, 2: false });
  const v = s.scoringView(at);
  assert.equal(v.deadline, 60000, '对方至少还有 60 秒可以回应');
  assert.equal(s.dueAction(T0 + 180000), null);
  assert.equal(s.dueAction(at + 60000), 'scoring');
  s.applyDue('scoring', at + 60000);
  assert.deepEqual(s.result, B_WINS, '白单方面的点选不算数');
  assert.deepEqual(s.finishFields().dead, [10]);
  assert.equal(s.scoring.version, 3, '最终采用的死子与当前显示的不同：版本 +1');
});

test('自动确认：趁对方不在点选 → 按最初的建议；一方点选、另一方同意 → 采用；采用最近一个双方都认可的版本', () => {
  // 对方掉线期间随便点：不算数
  const off = scoredGame();
  off.setOnline(1, false, T0 + 5000);
  off.toggleDead(2, 4, T0 + 6000);
  off.toggleDead(2, 72, T0 + 7000);
  off.applyDue('scoring', off.nextDeadline());
  assert.deepEqual(off.result, B_WINS);

  // 白点选（说 10 是活的），黑同意 → 双方都认可 → 时限到时采用（即使白还没按"同意"）
  const agreed = scoredGame();
  agreed.toggleDead(2, 10, T0 + 1000);
  agreed.accept(1, 2, T0 + 2000);
  assert.deepEqual(agreed.scoring.accepted, { 1: true, 2: false });
  agreed.applyDue('scoring', agreed.nextDeadline());
  assert.equal(agreed.result.winner, 2);
  assert.deepEqual(agreed.finishFields().dead, []);

  // 双方认可过 C1 之后白又单方面改成 C2：回退到 C1
  const back = scoredGame();
  back.toggleDead(2, 10, T0 + 1000); // C1 = []
  back.accept(1, 2, T0 + 2000); // 黑认可 C1
  back.toggleDead(2, 4, T0 + 3000); // C2：黑墙死
  back.applyDue('scoring', back.nextDeadline());
  assert.deepEqual(back.finishFields().dead, []);
  assert.equal(back.result.winner, 2);

  // 一方点选后又点回最初的建议：就是最初的建议
  const undo = scoredGame();
  undo.toggleDead(2, 4, T0 + 1000);
  undo.toggleDead(1, 4, T0 + 2000);
  undo.applyDue('scoring', undo.nextDeadline());
  assert.deepEqual(undo.result, B_WINS);

  // 没有 KataGo 建议（manual，无死子不是中立的建议）：一方标死子、另一方不回应 → 有争议，作废（不再按无死子判白胜，FS-1）
  const manual = online(human());
  playAll(manual, [...WALL, -1, -1]);
  manual.applyJudge(manual.judgeToken, null, T0);
  manual.toggleDead(1, 10, T0 + 1000);
  assert.deepEqual(manual.scoringView(T0 + 1000).atDeadline, { void: true, cause: 'score_dispute' });
  manual.applyDue('scoring', manual.nextDeadline());
  assert.equal(manual.result.reason, 'abort');
  assert.equal(manual.resultView().cause, 'score_dispute');
  assert.equal(manual.counted, false);
});

test('自动确认：点选不断顺延时限，但总时长不超过 2 × scoringTimeoutMs', () => {
  const s = scoredGame();
  let t = T0;
  for (let i = 0; i < 20; i++) {
    t += 30000;
    s.toggleDead(i % 2 ? 1 : 2, 10, t);
  }
  assert.equal(s.nextDeadline(), T0 + 360000);
});

// ---------- 到场（重启恢复、开局时不在线） ----------

function restoredRow(moves, extra = {}) {
  return {
    id: 'r00000000001',
    mode: 'ranked',
    size: 19,
    komi: 7.5,
    blackId: 1,
    whiteId: 2,
    timeControl: { mainMs: 600000, periods: 3, periodMs: 30000 },
    status: 'playing',
    moves,
    clocks: { running: 1, 1: { mainMs: 500000, periodsLeft: 3, periodMs: 30000 }, 2: { mainMs: 550000, periodsLeft: 3, periodMs: 30000 } },
    createdAt: 1,
    updatedAt: 2,
    ...extra,
  };
}

const TWELVE = [0, 18, 1, 17, 2, 16, 3, 15, 4, 14, 5, 13];

test('重启恢复：玩家回来之前不走钟、不判负；一直没回来 → 作废（不计入），不是超时负（SG-4）', () => {
  const T1 = T0 + 20 * 60000; // 停机 20 分钟后恢复
  const s = GameSession.fromRow(restoredRow(TWELVE), { settings: SETTINGS, now: T1 });
  s.expectArrival(T1); // 管理器恢复时调用：此时谁都不在线
  assert.equal(s.clock.running, null, '轮到的一方还没回来：不走钟');
  assert.deepEqual(s.deadlines(), [{ kind: 'abandon', at: T1 + 300000 }]);
  assert.equal(s.dueAction(T1 + 299999), null);
  s.applyDue(s.dueAction(T1 + 300000), T1 + 300000);
  assert.equal(s.result.reason, 'abort');
  assert.equal(s.counted, false);
});

test('重启恢复：轮到的一方回来后才开始计时（等待的时间不计），另一方回来之前轮到他也一样', () => {
  const T1 = T0 + 60000;
  const s = GameSession.fromRow(restoredRow(TWELVE), { settings: SETTINGS, now: T1 });
  s.expectArrival(T1);
  s.setOnline(1, true, T1 + 100000); // 黑 100 秒后才回来
  assert.equal(s.clock.running, 1);
  assert.equal(s.clocksView(T1 + 100000)[1].mainMs, 500000, '等待的 100 秒不扣');
  s.play(1, 13, 100, T1 + 110000);
  // 白还没回来：轮到白也不走钟，按到场宽限作废
  assert.equal(s.clock.running, null);
  assert.equal(s.clock.sides[1].mainMs, 490000);
  const ab = s.deadlines().find((d) => d.kind === 'abandon');
  assert.equal(ab.at, T1 + 110000 + 300000);
  s.setOnline(2, true, T1 + 120000);
  assert.equal(s.arrival, null);
  assert.equal(s.clock.running, 2);
  // 都到场之后恢复正常规则：白掉线 → 基本时间用完或 90 秒后判负
  s.setOnline(2, false, T1 + 130000);
  const ab2 = s.deadlines().find((d) => d.kind === 'abandon');
  assert.equal(ab2.at, T1 + 120000 + 550000);
  s.applyDue('abandon', ab2.at);
  assert.equal(s.result.reason, 'timeout');
  assert.equal(s.counted, true);
});

test('好友房房主不在线时开局：房主到场前首手不计时、不判负；超过宽限作废（CS-8）', () => {
  // 房主执黑、不在线
  const s = new GameSession({ id: 'f00000000001', mode: 'friend', size: 9, komi: 7.5, blackId: 1, whiteId: 2, timeControl: TC, settings: SETTINGS, now: T0 });
  s.setOnline(2, true, T0);
  s.expectArrival(T0);
  assert.equal(s.awaitingArrival(1), true);
  assert.equal(s.clock.running, null);
  assert.ok(!s.deadlines().some((d) => d.kind === 'first_move'), '房主没到场，首手不计时');
  assert.equal(s.dueAction(T0 + 60000), null, '60 秒后不作废');
  s.setOnline(1, true, T0 + 120000); // 房主回来了
  assert.equal(s.clock.running, 1);
  assert.deepEqual(s.deadlines().find((d) => d.kind === 'first_move'), { kind: 'first_move', at: T0 + 120000 + 60000 });

  // 房主执白：加入者先下，轮到房主时房主还没到场 → 不走钟，宽限后作废
  const w = new GameSession({ id: 'f00000000002', mode: 'friend', size: 9, komi: 7.5, blackId: 2, whiteId: 1, timeControl: TC, settings: SETTINGS, now: T0 });
  w.setOnline(1, true, T0);
  w.expectArrival(T0);
  w.play(1, 1, 40, T0 + 5000);
  assert.equal(w.clock.running, null);
  assert.equal(w.dueAction(T0 + 5000 + 90000), null);
  w.applyDue(w.dueAction(T0 + 5000 + 300000), T0 + 5000 + 300000);
  assert.equal(w.result.reason, 'abort');
});

// ---------- 掉线弃局与基本时间 ----------

test('掉线弃局：基本时间还没用完就不判负（接个 2 分钟电话不会输），用完后才判；读秒中掉线 90 秒判负（PX-4）', () => {
  const s = online(human({ size: 19, timeControl: { mainMs: 600000, periods: 3, periodMs: 30000 } }));
  playAll(s, TWELVE, T0);
  s.setOnline(1, false, T0 + 1000);
  const ab = s.deadlines().find((d) => d.kind === 'abandon');
  assert.equal(ab.at, T0 + 600000, '基本时间用完的时刻');
  assert.equal(s.dueAction(T0 + 121000), null);
  s.setOnline(1, true, T0 + 121000); // 2 分钟后回来
  s.play(1, 13, 100, T0 + 122000);
  assert.equal(s.status, 'playing');
  assert.equal(s.clock.sides[1].mainMs, 600000 - 122000, '掉线期间照常走钟');

  const byo = online(human({ timeControl: { mainMs: 0, periods: 5, periodMs: 30000 } }));
  playAll(byo, TWELVE.map((i) => i % 81), T0);
  byo.setOnline(1, false, T0 + 1000);
  assert.equal(byo.deadlines().find((d) => d.kind === 'abandon').at, T0 + 1000 + 90000);
});

// ---------- 人机数子 ----------

test('人机对局：死子判断失败（manual）时玩家可以点选，AI 一方保持同意、没有时限；KataGo 给出建议时不能点选（SG-5）', () => {
  const ai = () => new GameSession({ id: 'a00000000001', mode: 'ai', size: 9, komi: 7.5, blackId: 1, aiLevel: 'k10', settings: SETTINGS, now: T0 });
  const m = ai();
  playAll(m, [...WALL, -1, -1]);
  m.applyJudge(m.judgeToken, null, T0);
  assert.equal(m.scoring.source, 'manual');
  assert.equal(m.scoring.winner, 2);
  assert.deepEqual(m.toggleDead(1, 10, T0), { changed: true });
  assert.deepEqual(m.scoring.dead, [10]);
  assert.deepEqual(m.scoring.accepted, { 1: false, 2: true });
  assert.equal(m.scoringView(T0).deadline, null);
  assert.equal(m.nextDeadline(), T0 + 86400000, '人机只有闲置时限');
  assert.deepEqual(m.accept(1, 2, T0), { done: true });
  m.finishByScore(T0);
  assert.equal(m.result.winner, 1);

  const k = ai();
  playAll(k, [...WALL, -1, -1]);
  k.applyJudge(k.judgeToken, [10], T0);
  assertCode(() => k.toggleDead(1, 10, T0), 'bad_request');
});

test('死子判断缓存：局面不变时复用（继续对局后没落子、人机悔棋后再 pass），局面变了失效；手动结果不缓存', () => {
  const s = scoredGame();
  assert.deepEqual(s.cachedJudge(), [10]);
  s.resume(2, T0);
  s.play(1, s.moves.length + 1, 36, T0);
  assert.equal(s.cachedJudge(), null);

  const m = online(human());
  playAll(m, [...WALL, -1, -1]);
  m.applyJudge(m.judgeToken, null, T0);
  assert.equal(m.cachedJudge(), null);
});

// ---------- 最终评审（FS-*）：手动数子、点选认可、继续对局保护的持久化 ----------

// 手动数子（死子判断失败 / 没有 KataGo）：建议是"无死子"
function manualGame(opts) {
  const s = online(human(opts));
  playAll(s, [...WALL, -1, -1]);
  assert.equal(s.applyJudge(s.judgeToken, null, T0), true);
  assert.equal(s.scoring.source, 'manual');
  return s;
}

test('FS-1 手动数子：得益于"无死子"的一方掉线，另一方标出死子 → 时限到作废，不再判得益方胜', () => {
  const s = manualGame();
  s.setOnline(2, false, T0 + 1000); // 白（死子 10 的主人）切到后台
  s.toggleDead(1, 10, T0 + 2000);
  s.accept(1, s.scoring.version, T0 + 3000);
  assertCode(() => s.resume(1, T0 + 4000), 'wrong_phase', /对手不在线/);
  const at = s.nextDeadline();
  s.applyDue(s.dueAction(at), at);
  assert.equal(s.result.reason, 'abort');
  assert.equal(s.resultView().cause, 'score_dispute');
  assert.equal(s.counted, false, '不会出现计入排行的 W+34.5');
});

test('FS-1 手动数子：得益方先同意"无死子"，对方继续对局去提子，得益方掉线 → 撤销继续对局后作废（不是 W+33.5）', () => {
  const s = manualGame({ timeControl: { mainMs: 0, periods: 10, periodMs: 30000 } });
  s.accept(2, 1, T0 + 1000); // 白同意错误的"无死子"
  s.resume(1, T0 + 2000); // 黑继续对局（黑最先 pass → 轮到黑）
  assert.ok(s.resumeGuard);
  s.play(1, s.moves.length + 1, 19, T0 + 3000); // 黑去提白 10
  s.setOnline(2, false, T0 + 4000); // 轮到白，白掉线
  const at = s.deadlines().find((d) => d.kind === 'abandon').at;
  s.applyDue('abandon', at);
  assert.equal(s.resumeUndone, true);
  assert.equal(s.result.reason, 'abort');
  assert.equal(s.resultView().cause, 'score_dispute');
  assert.equal(s.counted, false);
});

test('FS-1 手动数子：谁都没有异议 → 按无死子计分；双方确认过同一集合（不同版本）→ 采用', () => {
  const quiet = manualGame();
  quiet.accept(2, 1, T0 + 1000); // 只有白同意，黑没表态
  assert.deepEqual(quiet.scoringView(T0 + 1000).atDeadline, { void: false, dead: [], black: 10, white: 44.5, winner: 2, same: true });
  quiet.applyDue('scoring', quiet.nextDeadline());
  assert.equal(quiet.result.reason, 'score');
  assert.equal(quiet.result.winner, 2);

  const both = manualGame();
  both.toggleDead(1, 10, T0 + 1000);
  both.accept(2, 2, T0 + 2000); // 白同意 [10]
  both.toggleDead(1, 72, T0 + 3000); // 黑又改（中间状态）
  both.toggleDead(1, 72, T0 + 4000); // 又改回 [10]
  both.accept(1, both.scoring.version, T0 + 5000); // 黑同意 [10]：白是在版本 2 同意的
  assert.equal(both.scoring.accepted[2], false);
  both.applyDue('scoring', both.nextDeadline());
  assert.deepEqual(both.result, B_WINS);
  assert.equal(both.resultView().cause, 'deadline');
});

test('FS-1 手动数子：重启后谁都没回来 → 时限到作废（arrival），不按无死子计分', () => {
  const row = {
    id: 'm00000000001',
    mode: 'ranked',
    size: 9,
    komi: 7.5,
    blackId: 1,
    whiteId: 2,
    timeControl: TC,
    status: 'scoring',
    moves: [...WALL, -1, -1],
    clocks: null,
    createdAt: 1,
    updatedAt: 2,
  };
  const s = GameSession.fromRow(row, { settings: SETTINGS, now: T0 });
  s.expectArrival(T0);
  s.applyJudge(s.judgeToken, null, T0); // 重新判断死子又失败
  assert.deepEqual(s.scoringView(T0).atDeadline, { void: true, cause: 'arrival' });
  s.applyDue('scoring', s.nextDeadline());
  assert.equal(s.result.reason, 'abort');
  assert.equal(s.resultView().cause, 'arrival');
  assert.equal(s.counted, false);
});

test('FS-2 点选落在对方的修改之上、或改到一半的中间状态，被对方立即确认也不算"双方认可"', () => {
  // 竞态：白把黑墙点死，黑没看到白的推送就把 10 点死，白立即确认，黑再把墙改回来
  const race = manualGame();
  race.toggleDead(2, 4, T0 + 1000);
  race.toggleDead(1, 10, T0 + 1100);
  race.accept(2, race.scoring.version, T0 + 1200);
  assert.equal(race.scoring.agreed, null, '黑的点选包含白的修改：不算黑认可');
  race.toggleDead(1, 4, T0 + 3000);
  assert.deepEqual(race.scoring.dead, [10]);
  race.applyDue('scoring', race.nextDeadline());
  assert.notEqual(race.result.winner, 2, '不会按白确认过的"黑墙全死"计分');
  assert.equal(race.result.reason, 'abort', '手动数子有争议：作废');

  // 非竞态：白点死黑墙和 72，黑一处处改回来，白在中间状态确认；KataGo 建议下回到原建议
  const k = scoredGame();
  k.toggleDead(2, 4, T0 + 1000);
  k.toggleDead(2, 72, T0 + 2000);
  k.toggleDead(1, 72, T0 + 3000); // 黑改回 72：此时的集合（黑墙死）有白的修改
  k.accept(2, k.scoring.version, T0 + 4000);
  assert.equal(k.scoring.agreed, null);
  k.toggleDead(1, 4, T0 + 5000); // 黑改回墙：回到原建议 [10]
  k.accept(1, k.scoring.version, T0 + 6000);
  k.applyDue('scoring', k.nextDeadline());
  assert.deepEqual(k.result, B_WINS);

  // 同样的操作在手动数子下：黑最后标出 10 并确认，白确认的是中间状态 → 作废（原来会按白确认的集合判 W+43.5）
  const m = manualGame();
  m.toggleDead(2, 4, T0 + 1000);
  m.toggleDead(2, 72, T0 + 2000);
  m.toggleDead(1, 72, T0 + 3000);
  m.accept(2, m.scoring.version, T0 + 4000);
  m.toggleDead(1, 4, T0 + 5000);
  m.toggleDead(1, 10, T0 + 6000);
  m.accept(1, m.scoring.version, T0 + 7000);
  m.applyDue('scoring', m.nextDeadline());
  assert.equal(m.result.reason, 'abort');
});

test('FS-2 点选可带版本：不是当前版本 → stale；atDeadline 告诉客户端时限到会按什么计分', () => {
  const s = scoredGame();
  assertCode(() => s.toggleDead(2, 4, T0 + 1000, 5), 'stale');
  assert.equal(s.scoring.version, 1);
  s.toggleDead(2, 4, T0 + 1000, 1);
  assert.equal(s.scoring.version, 2);
  const v = s.scoringView(T0 + 1000);
  assert.equal(v.winner, 2, '当前显示：黑墙死，白胜');
  assert.deepEqual(v.atDeadline, { void: false, dead: [10], black: 45, white: 43.5, winner: 1, same: false }, '到时按原建议');
  s.accept(1, 2, T0 + 2000); // 黑同意白的修改 → 双方认可
  assert.equal(s.scoringView(T0 + 2000).atDeadline.same, true);
  // 终局后没有 atDeadline
  s.accept(2, 2, T0 + 3000);
  s.finishByScore(T0 + 3000);
  assert.equal(s.scoringView(T0 + 3000).atDeadline, null);
});

test('FS-3 继续对局后，已同意的一方在线但没注意、读秒用完：同样撤销继续对局，按同意的结果计分（不是超时负）', () => {
  const s = scoredGame({ timeControl: { mainMs: 0, periods: 3, periodMs: 20000 } });
  s.accept(1, 1, T0 + 1000); // 黑（赢棋的一方）同意
  s.resume(2, T0 + 2000); // 白继续对局，轮到黑（最先 pass 的一方）
  assert.equal(s.toPlay, 1);
  assert.equal(s.online[1], true, '黑一直在线');
  const at = s.deadlines().find((d) => d.kind === 'timeout').at;
  assert.equal(s.dueAction(at), 'timeout');
  s.applyDue('timeout', at);
  assert.deepEqual(s.result, B_WINS);
  assert.equal(s.resultView().cause, 'resume_undone');
  assert.equal(s.counted, true);
});

test('FS-11 继续对局保护下的一方掉线：abandonMs 后就撤销继续对局，不必等他的基本时间用完', () => {
  const s = scoredGame({ timeControl: { mainMs: 600000, periods: 3, periodMs: 30000 } });
  s.accept(1, 1, T0);
  s.resume(2, T0 + 1000);
  s.setOnline(1, false, T0 + 7000);
  assert.equal(s.deadlines().find((d) => d.kind === 'abandon').at, T0 + 7000 + 90000);
  s.applyDue(s.dueAction(T0 + 97000), T0 + 97000);
  assert.deepEqual(s.result, B_WINS);
  // 没有保护的掉线仍然等基本时间用完（PX-4）
  const n = scoredGame({ timeControl: { mainMs: 600000, periods: 3, periodMs: 30000 } });
  n.resume(2, T0 + 1000);
  n.setOnline(1, false, T0 + 7000);
  assert.ok(n.deadlines().find((d) => d.kind === 'abandon').at > T0 + 500000);
});

test('FS-6 / FS-7 已用的继续对局次数与继续对局保护随进度保存，重启后恢复', () => {
  const s = scoredGame({ timeControl: { mainMs: 0, periods: 10, periodMs: 30000 } });
  s.accept(1, 1, T0);
  s.resume(2, T0 + 1000);
  const st = s.progress().state;
  assert.deepEqual(st.resumesUsed, { 1: 0, 2: 1 });
  assert.equal(st.guard.color, 1);
  assert.equal(st.guard.movesLen, WALL.length + 2);
  const row = {
    id: 'g00000000001',
    mode: 'ranked',
    size: 9,
    komi: 7.5,
    blackId: 1,
    whiteId: 2,
    timeControl: s.timeControl,
    status: 'playing',
    moves: s.moves.slice(),
    clocks: s.clock.toJSON(),
    state: JSON.parse(JSON.stringify(st)),
    createdAt: 1,
    updatedAt: 2,
  };
  // 重启：谁都还没回来
  const T1 = T0 + 600000;
  const r = GameSession.fromRow(row, { settings: SETTINGS, now: T1 });
  r.expectArrival(T1);
  assert.equal(r.resumesLeft(2), 0, '白的继续对局次数没有因为重启恢复');
  assert.equal(r.resumesLeft(1), 1);
  assert.equal(r.resumeGuard.color, 1);
  // 黑（已同意的一方）一直没回来：撤销继续对局，按同意的结果计分——不是作废（FS-7）
  const ab = r.deadlines().find((d) => d.kind === 'abandon');
  assert.equal(ab.at, T1 + 90000);
  r.applyDue(r.dueAction(ab.at), ab.at);
  assert.deepEqual(r.result, B_WINS);
  assert.equal(r.resultView().cause, 'resume_undone');
  assert.deepEqual(r.finishFields().dead, [10]);

  // 坏掉的 state 不影响恢复
  const bad = GameSession.fromRow({ ...row, state: '{oops' }, { settings: SETTINGS, now: T1 });
  assert.equal(bad.resumeGuard, null);
  assert.equal(bad.resumesLeft(2), 1);
  const wrongLen = GameSession.fromRow({ ...row, state: { ...st, guard: { ...st.guard, movesLen: 3 } } }, { settings: SETTINGS, now: T1 });
  assert.equal(wrongLen.resumeGuard, null, '保护点不在两次 pass 之后：忽略');
});

test('终局原因（Result.cause）：首手超时 / 到场超时 / 读秒', () => {
  const first = online(human());
  first.applyDue(first.dueAction(T0 + 60000), T0 + 60000);
  assert.equal(first.resultView().cause, 'first_move');

  // 好友房房主（执黑）一直没到场：5 分钟后作废，原因是 arrival 而不是"没有在 60 秒内落下第一手"
  const owner = human({ mode: 'friend' });
  owner.setOnline(2, true, T0);
  owner.expectArrival(T0);
  const at = owner.nextDeadline();
  assert.equal(at, T0 + 300000);
  owner.applyDue(owner.dueAction(at), at);
  assert.equal(owner.result.reason, 'abort');
  assert.equal(owner.resultView().cause, 'arrival');

  const clock = online(human({ timeControl: { mainMs: 0, periods: 1, periodMs: 10000 } }));
  playAll(clock, [0, 1]);
  clock.applyDue(clock.dueAction(T0 + 10000), T0 + 10000);
  assert.equal(clock.result.reason, 'timeout');
  assert.equal(clock.resultView().cause, 'clock');
});
