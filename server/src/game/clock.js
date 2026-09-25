'use strict';

// 读秒（byo-yomi）纯逻辑（设计文档 6.1）。时间一律为毫秒整数，now 由调用方传入，便于用假时间测试。
//
// 每方的存量 Side = { mainMs, periodsLeft }；读秒周期长度 periodMs 来自用时设置，所有周期等长。
// - 轮到某方时开始计时；落子/pass 时扣除耗时：先扣基本时间，
//   基本时间用完后进入读秒，每用满一个完整周期消耗一次，本手在周期内完成则周期重置。
// - 本手耗时 ≥ 基本时间 + 剩余次数 × 周期 即超时。定时器也在这个时刻判负，二者一致。
//
// 对外的时钟快照 Clocks = { 1: ClockView, 2: ClockView, running: 1|2|null }，
// ClockView = { mainMs, periodsLeft, periodMs }：
// - 未在走的一方：存量原样，periodMs 为完整周期长度；
// - 正在走的一方：按发送时刻推算的剩余量；已进入读秒时 periodMs 为"当前周期还剩多少"，
//   这个周期用完后下一个周期是完整长度（用时设置里的 periodMs）。

function isNonNegInt(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

function normalizeTimeControl(tc) {
  if (!tc || typeof tc !== 'object') throw new TypeError('用时设置应为 { mainMs, periods, periodMs }');
  const { mainMs, periods, periodMs } = tc;
  if (!isNonNegInt(mainMs) || !isNonNegInt(periods) || !isNonNegInt(periodMs)) {
    throw new TypeError(`用时设置必须是非负整数：${JSON.stringify(tc)}`);
  }
  if (periods > 0 && periodMs <= 0) throw new TypeError('有读秒次数时读秒周期必须大于 0');
  if (mainMs + periods * periodMs <= 0) throw new TypeError('基本时间与读秒不能同时为 0');
  return { mainMs, periods, periodMs };
}

function initialSide(tc) {
  return { mainMs: tc.mainMs, periodsLeft: tc.periods };
}

// 从轮到这一方开始，还能用多久
function totalMs(side, periodMs) {
  return side.mainMs + side.periodsLeft * periodMs;
}

function toElapsed(elapsed) {
  const e = Math.floor(Number(elapsed));
  return Number.isFinite(e) && e > 0 ? e : 0;
}

// 扣除一手的耗时，返回新的存量（不修改入参）
function consume(side, elapsed, periodMs) {
  const e = toElapsed(elapsed);
  if (e >= totalMs(side, periodMs)) return { side: { mainMs: 0, periodsLeft: 0 }, timedOut: true };
  if (e <= side.mainMs) {
    return { side: { mainMs: side.mainMs - e, periodsLeft: side.periodsLeft }, timedOut: false };
  }
  // 走到这里说明 periodsLeft > 0 且 periodMs > 0（否则上面已判超时）
  const over = e - side.mainMs;
  const used = Math.floor(over / periodMs);
  return { side: { mainMs: 0, periodsLeft: side.periodsLeft - used }, timedOut: false };
}

// 这一方已走了 elapsed 毫秒时的显示量
function sideView(side, elapsed, periodMs) {
  const e = toElapsed(elapsed);
  if (e >= totalMs(side, periodMs)) return { mainMs: 0, periodsLeft: 0, periodMs: 0 };
  if (e < side.mainMs) return { mainMs: side.mainMs - e, periodsLeft: side.periodsLeft, periodMs };
  const over = e - side.mainMs;
  const used = Math.floor(over / periodMs);
  return { mainMs: 0, periodsLeft: side.periodsLeft - used, periodMs: periodMs - (over % periodMs) };
}

function msUntilTimeout(side, elapsed, periodMs) {
  return Math.max(0, totalMs(side, periodMs) - toElapsed(elapsed));
}

function validSavedSide(s) {
  return !!s && typeof s === 'object' && isNonNegInt(s.mainMs) && isNonNegInt(s.periodsLeft);
}

// 一局棋双方的时钟。running 为正在走的一方，startedAt 为这一手开始的时刻。
class GameClock {
  constructor(tc, saved) {
    this.tc = normalizeTimeControl(tc);
    this.sides = { 1: initialSide(this.tc), 2: initialSide(this.tc) };
    this.running = null;
    this.startedAt = null;
    if (saved && typeof saved === 'object') {
      for (const c of [1, 2]) {
        if (validSavedSide(saved[c])) this.sides[c] = { mainMs: saved[c].mainMs, periodsLeft: saved[c].periodsLeft };
      }
    }
  }

  get periodMs() {
    return this.tc.periodMs;
  }

  // 开始给 color 计时；若另一方正在走，先结算它
  start(color, now) {
    if (color !== 1 && color !== 2) throw new TypeError(`非法颜色 ${color}`);
    if (this.running) this.stop(now);
    this.running = color;
    this.startedAt = now;
  }

  // 停钟并结算正在走的一方，返回 { color, timedOut }
  stop(now) {
    if (!this.running) return { color: null, timedOut: false };
    const color = this.running;
    const r = consume(this.sides[color], now - this.startedAt, this.tc.periodMs);
    this.sides[color] = r.side;
    this.running = null;
    this.startedAt = null;
    return { color, timedOut: r.timedOut };
  }

  // 超时判负后把这一方清零
  zero(color) {
    this.sides[color] = { mainMs: 0, periodsLeft: 0 };
    if (this.running === color) {
      this.running = null;
      this.startedAt = null;
    }
  }

  elapsed(now) {
    return this.running ? toElapsed(now - this.startedAt) : 0;
  }

  // 正在走的一方的超时时刻（绝对时间）；没在走返回 null
  timeoutAt() {
    if (!this.running) return null;
    return this.startedAt + totalMs(this.sides[this.running], this.tc.periodMs);
  }

  // 正在走的一方基本时间用完（进入读秒）的时刻；已在读秒中则为这一手开始的时刻；没在走返回 null
  mainOutAt() {
    if (!this.running) return null;
    return this.startedAt + this.sides[this.running].mainMs;
  }

  msUntilTimeout(now) {
    if (!this.running) return null;
    return msUntilTimeout(this.sides[this.running], now - this.startedAt, this.tc.periodMs);
  }

  isTimedOut(now) {
    const at = this.timeoutAt();
    return at !== null && now >= at;
  }

  // 发送给客户端的快照（按 now 推算正在走的一方）
  snapshot(now) {
    const out = { running: this.running };
    for (const c of [1, 2]) {
      const s = this.sides[c];
      out[c] =
        c === this.running
          ? sideView(s, now - this.startedAt, this.tc.periodMs)
          : { mainMs: s.mainMs, periodsLeft: s.periodsLeft, periodMs: this.tc.periodMs };
    }
    return out;
  }

  // 持久化用：存量（不含正在走的这一手的耗时，重启后这一手重新计时）
  toJSON() {
    const out = { running: this.running };
    for (const c of [1, 2]) {
      out[c] = { mainMs: this.sides[c].mainMs, periodsLeft: this.sides[c].periodsLeft, periodMs: this.tc.periodMs };
    }
    return out;
  }

  static fromJSON(tc, saved) {
    return new GameClock(tc, saved);
  }
}

module.exports = {
  GameClock,
  normalizeTimeControl,
  initialSide,
  totalMs,
  consume,
  sideView,
  msUntilTimeout,
};
