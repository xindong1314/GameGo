'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GameClock,
  normalizeTimeControl,
  consume,
  sideView,
  totalMs,
  msUntilTimeout,
} = require('../../src/game/clock');

const TC = { mainMs: 60000, periods: 3, periodMs: 10000 };
const P = TC.periodMs;

test('normalizeTimeControl 校验非负整数、读秒周期与总时长', () => {
  assert.deepEqual(normalizeTimeControl(TC), TC);
  assert.deepEqual(normalizeTimeControl({ mainMs: 0, periods: 2, periodMs: 5000 }), { mainMs: 0, periods: 2, periodMs: 5000 });
  assert.deepEqual(normalizeTimeControl({ mainMs: 5000, periods: 0, periodMs: 0 }), { mainMs: 5000, periods: 0, periodMs: 0 });
  assert.throws(() => normalizeTimeControl(null), TypeError);
  assert.throws(() => normalizeTimeControl({ mainMs: -1, periods: 3, periodMs: 1000 }), TypeError);
  assert.throws(() => normalizeTimeControl({ mainMs: 1.5, periods: 3, periodMs: 1000 }), TypeError);
  assert.throws(() => normalizeTimeControl({ mainMs: 1000, periods: 3, periodMs: 0 }), TypeError);
  assert.throws(() => normalizeTimeControl({ mainMs: 0, periods: 0, periodMs: 0 }), TypeError);
  assert.throws(() => normalizeTimeControl({ mainMs: '1000', periods: 3, periodMs: 1000 }), TypeError);
});

test('consume：基本时间内只扣基本时间', () => {
  const r = consume({ mainMs: 60000, periodsLeft: 3 }, 15000, P);
  assert.deepEqual(r, { side: { mainMs: 45000, periodsLeft: 3 }, timedOut: false });
});

test('consume：恰好用完基本时间 → 基本时间归零，读秒次数不变', () => {
  const r = consume({ mainMs: 60000, periodsLeft: 3 }, 60000, P);
  assert.deepEqual(r, { side: { mainMs: 0, periodsLeft: 3 }, timedOut: false });
});

test('consume：用完基本时间进入读秒，周期内完成则周期重置、次数不减', () => {
  const r = consume({ mainMs: 60000, periodsLeft: 3 }, 60000 + 9999, P);
  assert.deepEqual(r, { side: { mainMs: 0, periodsLeft: 3 }, timedOut: false });
});

test('consume：用满一个完整周期消耗一次（恰好边界也算消耗）', () => {
  assert.deepEqual(consume({ mainMs: 60000, periodsLeft: 3 }, 60000 + 10000, P).side, { mainMs: 0, periodsLeft: 2 });
  assert.deepEqual(consume({ mainMs: 0, periodsLeft: 3 }, 10000, P).side, { mainMs: 0, periodsLeft: 2 });
  assert.deepEqual(consume({ mainMs: 0, periodsLeft: 3 }, 9999, P).side, { mainMs: 0, periodsLeft: 3 });
});

test('consume：一手跨多个周期，消耗多次', () => {
  const r = consume({ mainMs: 5000, periodsLeft: 3 }, 5000 + 25000, P);
  assert.deepEqual(r, { side: { mainMs: 0, periodsLeft: 1 }, timedOut: false });
});

test('consume：耗时达到 基本时间 + 次数×周期 即超时（恰好边界算超时）', () => {
  assert.deepEqual(consume({ mainMs: 5000, periodsLeft: 3 }, 35000, P), { side: { mainMs: 0, periodsLeft: 0 }, timedOut: true });
  assert.equal(consume({ mainMs: 5000, periodsLeft: 3 }, 34999, P).timedOut, false);
  assert.deepEqual(consume({ mainMs: 5000, periodsLeft: 3 }, 34999, P).side, { mainMs: 0, periodsLeft: 1 });
  assert.equal(consume({ mainMs: 0, periodsLeft: 1 }, 10000, P).timedOut, true);
  assert.equal(consume({ mainMs: 0, periodsLeft: 1 }, 99999, P).timedOut, true);
});

test('consume：没有读秒时基本时间用完即超时', () => {
  assert.equal(consume({ mainMs: 5000, periodsLeft: 0 }, 5000, 0).timedOut, true);
  assert.deepEqual(consume({ mainMs: 5000, periodsLeft: 0 }, 4999, 0), { side: { mainMs: 1, periodsLeft: 0 }, timedOut: false });
});

test('consume：负数、NaN 耗时按 0 处理，不修改入参', () => {
  const side = { mainMs: 1000, periodsLeft: 2 };
  assert.deepEqual(consume(side, -500, P).side, side);
  assert.deepEqual(consume(side, NaN, P).side, side);
  consume(side, 5000, P);
  assert.deepEqual(side, { mainMs: 1000, periodsLeft: 2 });
});

test('sideView：基本时间中、恰好用完、读秒中、超时', () => {
  const side = { mainMs: 30000, periodsLeft: 3 };
  assert.deepEqual(sideView(side, 0, P), { mainMs: 30000, periodsLeft: 3, periodMs: 10000 });
  assert.deepEqual(sideView(side, 12345, P), { mainMs: 17655, periodsLeft: 3, periodMs: 10000 });
  assert.deepEqual(sideView(side, 30000, P), { mainMs: 0, periodsLeft: 3, periodMs: 10000 });
  assert.deepEqual(sideView(side, 34000, P), { mainMs: 0, periodsLeft: 3, periodMs: 6000 });
  assert.deepEqual(sideView(side, 41000, P), { mainMs: 0, periodsLeft: 2, periodMs: 9000 });
  assert.deepEqual(sideView(side, 59999, P), { mainMs: 0, periodsLeft: 1, periodMs: 1 });
  assert.deepEqual(sideView(side, 60000, P), { mainMs: 0, periodsLeft: 0, periodMs: 0 });
});

test('totalMs / msUntilTimeout', () => {
  assert.equal(totalMs({ mainMs: 30000, periodsLeft: 3 }, P), 60000);
  assert.equal(msUntilTimeout({ mainMs: 30000, periodsLeft: 3 }, 45000, P), 15000);
  assert.equal(msUntilTimeout({ mainMs: 30000, periodsLeft: 3 }, 70000, P), 0);
});

test('GameClock：开局双方满时间，start/stop 结算正在走的一方', () => {
  const c = new GameClock(TC);
  const t0 = 1000;
  c.start(1, t0);
  assert.equal(c.running, 1);
  assert.equal(c.timeoutAt(), t0 + 90000);
  assert.equal(c.msUntilTimeout(t0 + 1000), 89000);
  c.start(2, t0 + 20000); // 黑用了 20 秒
  assert.deepEqual(c.sides[1], { mainMs: 40000, periodsLeft: 3 });
  assert.equal(c.running, 2);
  const r = c.stop(t0 + 25000);
  assert.deepEqual(r, { color: 2, timedOut: false });
  assert.deepEqual(c.sides[2], { mainMs: 55000, periodsLeft: 3 });
  assert.equal(c.running, null);
  assert.equal(c.timeoutAt(), null);
  assert.equal(c.msUntilTimeout(0), null);
  assert.deepEqual(c.stop(t0 + 30000), { color: null, timedOut: false });
});

test('GameClock.snapshot：正在走的一方按 now 推算，另一方原样（periodMs 为完整周期）', () => {
  const c = new GameClock(TC);
  c.sides[2] = { mainMs: 0, periodsLeft: 2 };
  c.start(2, 0);
  assert.deepEqual(c.snapshot(3500), {
    running: 2,
    1: { mainMs: 60000, periodsLeft: 3, periodMs: 10000 },
    2: { mainMs: 0, periodsLeft: 2, periodMs: 6500 },
  });
  assert.deepEqual(c.snapshot(13500)[2], { mainMs: 0, periodsLeft: 1, periodMs: 6500 });
  c.stop(4000);
  assert.deepEqual(c.snapshot(99999)[2], { mainMs: 0, periodsLeft: 2, periodMs: 10000 });
  assert.equal(c.snapshot(99999).running, null);
});

test('GameClock：isTimedOut 与超时结算', () => {
  const c = new GameClock({ mainMs: 1000, periods: 1, periodMs: 1000 });
  c.start(1, 0);
  assert.equal(c.isTimedOut(1999), false);
  assert.equal(c.isTimedOut(2000), true);
  const r = c.stop(2500);
  assert.deepEqual(r, { color: 1, timedOut: true });
  assert.deepEqual(c.sides[1], { mainMs: 0, periodsLeft: 0 });
});

test('GameClock：zero 把一方清零并停钟', () => {
  const c = new GameClock(TC);
  c.start(1, 0);
  c.zero(1);
  assert.deepEqual(c.sides[1], { mainMs: 0, periodsLeft: 0 });
  assert.equal(c.running, null);
});

test('GameClock：toJSON 只存存量，fromJSON 恢复；非法存档回落到初始值', () => {
  const c = new GameClock(TC);
  c.start(1, 0);
  c.start(2, 70000); // 黑进入读秒
  const saved = c.toJSON();
  assert.deepEqual(saved, {
    running: 2,
    1: { mainMs: 0, periodsLeft: 2, periodMs: 10000 },
    2: { mainMs: 60000, periodsLeft: 3, periodMs: 10000 },
  });
  const r = GameClock.fromJSON(TC, JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(r.sides, { 1: { mainMs: 0, periodsLeft: 2 }, 2: { mainMs: 60000, periodsLeft: 3 } });
  assert.equal(r.running, null);
  const bad = GameClock.fromJSON(TC, { 1: { mainMs: -5, periodsLeft: 1 }, 2: 'x' });
  assert.deepEqual(bad.sides, { 1: { mainMs: 60000, periodsLeft: 3 }, 2: { mainMs: 60000, periodsLeft: 3 } });
  assert.deepEqual(GameClock.fromJSON(TC, null).sides[1], { mainMs: 60000, periodsLeft: 3 });
});

test('GameClock.start 拒绝非法颜色', () => {
  const c = new GameClock(TC);
  assert.throws(() => c.start(3, 0), TypeError);
});
