'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { displayClock, displayClocks } = require('../../miniprogram/utils/clock');

const S = 1000;
const MIN = 60 * S;

function pick(d) {
  return { text: d.text, sub: d.sub, urgent: d.urgent, timeout: d.timeout, phase: d.phase };
}

test('基本时间：mm:ss 向上取整，显示读秒次数', () => {
  const clock = { mainMs: 10 * MIN, periodsLeft: 3, periodMs: 30 * S };
  assert.deepEqual(pick(displayClock(clock, 0)), { text: '10:00', sub: '读秒 3 次', urgent: false, timeout: false, phase: 'main' });
  assert.equal(displayClock(clock, 1500).text, '09:59'); // 剩 598.5 秒 → 599 秒
  assert.equal(displayClock(clock, 2 * S).text, '09:58');
  assert.equal(displayClock(clock, 10 * MIN - 1).text, '00:01');
  assert.equal(displayClock(clock, 10 * MIN - 1).remainingMs, 1);
  // 有读秒时基本时间快用完也不算紧急
  assert.equal(displayClock(clock, 10 * MIN - 5 * S).urgent, false);
});

test('没有读秒：基本时间 ≤30 秒为紧急，用完即超时', () => {
  const clock = { mainMs: 60 * S, periodsLeft: 0, periodMs: 0 };
  assert.equal(displayClock(clock, 29 * S).urgent, false); // 剩 31 秒
  const d = displayClock(clock, 30 * S);
  assert.equal(d.text, '00:30');
  assert.equal(d.sub, '');
  assert.equal(d.urgent, true);
  assert.deepEqual(pick(displayClock(clock, 60 * S)), { text: '00:00', sub: '超时', urgent: true, timeout: true, phase: 'timeout' });
  assert.equal(displayClock(clock, 99 * MIN).timeout, true);
});

test('基本时间用完进入读秒：显示当前周期剩余秒数', () => {
  const clock = { mainMs: 5 * S, periodsLeft: 3, periodMs: 30 * S };
  // 恰好用完基本时间：进入第一个读秒周期，周期完整
  assert.deepEqual(pick(displayClock(clock, 5 * S)), { text: '30', sub: '读秒 3 次', urgent: false, timeout: false, phase: 'byoyomi' });
  assert.equal(displayClock(clock, 5 * S + 2500).text, '28'); // 剩 27.5 → 28
  // ≤10 秒紧急
  assert.equal(displayClock(clock, 5 * S + 19 * S).urgent, false); // 剩 11 秒
  assert.equal(displayClock(clock, 5 * S + 20 * S).urgent, true); // 剩 10 秒
  assert.equal(displayClock(clock, 5 * S + 20 * S).text, '10');
});

test('用满一个周期消耗一次，全部用完超时', () => {
  const clock = { mainMs: 0, periodsLeft: 3, periodMs: 30 * S };
  assert.deepEqual(pick(displayClock(clock, 0)), { text: '30', sub: '读秒 3 次', urgent: false, timeout: false, phase: 'byoyomi' });
  assert.equal(displayClock(clock, 30 * S - 1).sub, '读秒 3 次');
  assert.equal(displayClock(clock, 30 * S - 1).text, '1');
  // 恰好用满一个周期：消耗一次，新周期完整
  let d = displayClock(clock, 30 * S);
  assert.equal(d.sub, '读秒 2 次');
  assert.equal(d.text, '30');
  d = displayClock(clock, 65 * S);
  assert.equal(d.sub, '读秒 1 次');
  assert.equal(d.text, '25');
  // 最后一个周期用完：超时
  d = displayClock(clock, 90 * S);
  assert.deepEqual(pick(d), { text: '0', sub: '超时', urgent: true, timeout: true, phase: 'timeout' });
  assert.equal(displayClock(clock, 90 * S - 1).timeout, false);
});

test('与服务端判负时刻一致：基本时间 + 次数 × 周期', () => {
  const clock = { mainMs: 3 * MIN, periodsLeft: 3, periodMs: 20 * S };
  const deadline = 3 * MIN + 3 * 20 * S;
  assert.equal(displayClock(clock, deadline - 1).timeout, false);
  assert.equal(displayClock(clock, deadline).timeout, true);
});

test('当前周期已用掉一部分：之后的周期按完整长度（timeControl）计算', () => {
  // 快照：正在读秒，当前周期还剩 12 秒，还有 2 次，完整周期 30 秒
  const clock = { mainMs: 0, periodsLeft: 2, periodMs: 12 * S };
  const tc = { mainMs: 600 * S, periods: 3, periodMs: 30 * S };
  assert.equal(displayClock(clock, 0, tc).text, '12');
  assert.equal(displayClock(clock, 0, tc).urgent, false);
  let d = displayClock(clock, 12 * S, tc);
  assert.equal(d.sub, '读秒 1 次');
  assert.equal(d.text, '30');
  d = displayClock(clock, 20 * S, tc);
  assert.equal(d.text, '22');
  assert.equal(displayClock(clock, 42 * S - 1, tc).timeout, false);
  assert.equal(displayClock(clock, 42 * S, tc).timeout, true);
  // 也可以直接传数字
  assert.equal(displayClock(clock, 20 * S, 30 * S).text, '22');
  // 不传时按快照里的 periodMs 计算
  assert.equal(displayClock(clock, 20 * S).text, '4');
});

test('一次跨越多个周期', () => {
  const clock = { mainMs: 10 * S, periodsLeft: 5, periodMs: 10 * S };
  const d = displayClock(clock, 10 * S + 35 * S);
  assert.equal(d.sub, '读秒 2 次');
  assert.equal(d.text, '5');
  assert.equal(d.urgent, true);
});

test('空时钟与非法输入', () => {
  assert.deepEqual(pick(displayClock(null, 0)), { text: '', sub: '', urgent: false, timeout: false, phase: 'none' });
  assert.equal(displayClock(undefined).text, '');
  // 非法数字按 0 处理；负的耗时按 0
  const d = displayClock({ mainMs: NaN, periodsLeft: 'x', periodMs: -1 }, 0);
  assert.equal(d.timeout, true);
  assert.equal(d.text, '00:00');
  const c = { mainMs: 60 * S, periodsLeft: 1, periodMs: 10 * S };
  assert.equal(displayClock(c, -5000).text, '01:00');
  assert.equal(displayClock(c, NaN).text, '01:00');
  // 读秒次数为小数时取整
  assert.equal(displayClock({ mainMs: 0, periodsLeft: 2.7, periodMs: 10 * S }, 0).sub, '读秒 2 次');
});

test('超过一小时的基本时间仍显示为分钟', () => {
  assert.equal(displayClock({ mainMs: 75 * MIN, periodsLeft: 0, periodMs: 0 }, 0).text, '75:00');
});

test('displayClocks：只有 running 一方计入耗时', () => {
  const clocks = {
    1: { mainMs: 60 * S, periodsLeft: 3, periodMs: 30 * S },
    2: { mainMs: 60 * S, periodsLeft: 3, periodMs: 30 * S },
    running: 2,
  };
  const d = displayClocks(clocks, 10 * S);
  assert.equal(d[1].text, '01:00');
  assert.equal(d[2].text, '00:50');
  const stopped = displayClocks(Object.assign({}, clocks, { running: null }), 10 * S);
  assert.equal(stopped[2].text, '01:00');
  const none = displayClocks(null, 1000);
  assert.equal(none[1].text, '');
  assert.equal(none[2].phase, 'none');
});

// 与服务端 server/src/game/clock.js 交叉验证：客户端从快照倒数 d 毫秒的显示，
// 应与服务端在 s + d 时刻直接给出的快照显示一致（服务端模块不存在时跳过）
let serverClock = null;
try {
  serverClock = require('../../server/src/game/clock');
} catch (err) {
  serverClock = null;
}
const canCrossCheck = !!serverClock && typeof serverClock.sideView === 'function';

test('与服务端读秒推演一致（随机交叉验证）', { skip: canCrossCheck ? false : '服务端 clock.js 不可用' }, () => {
  let seed = 12345;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % (n + 1);
  };
  let checked = 0;
  for (let i = 0; i < 3000; i++) {
    const tc = { mainMs: rand(60) * 1000, periods: rand(3), periodMs: (1 + rand(29)) * 1000 };
    const side = { mainMs: rand(tc.mainMs), periodsLeft: rand(tc.periods) };
    const total = side.mainMs + side.periodsLeft * tc.periodMs;
    if (total <= 0) continue;
    const s = rand(total + 5000);
    const d = rand(total + 5000);
    const snap = serverClock.sideView(side, s, tc.periodMs);
    const direct = displayClock(serverClock.sideView(side, s + d, tc.periodMs), 0, tc);
    const counted = displayClock(snap, d, tc);
    const ctx = JSON.stringify({ tc, side, s, d });
    assert.equal(counted.timeout, direct.timeout, ctx);
    if (!direct.timeout) {
      assert.equal(counted.text, direct.text, ctx);
      assert.equal(counted.sub, direct.sub, ctx);
      assert.equal(counted.urgent, direct.urgent, ctx);
      assert.equal(counted.remainingMs, direct.remainingMs, ctx);
    }
    checked += 1;
  }
  assert.ok(checked > 2000);
});
