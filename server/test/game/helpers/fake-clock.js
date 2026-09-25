'use strict';

// 假时间 + 假定时器：now() 只在 advance() 时前进，定时器按到期时刻顺序同步执行。
// 与 createRealtime 的 timers 参数形状一致：{ setTimeout, clearTimeout, setInterval, clearInterval }。

function createFakeClock(start = 1700000000000) {
  let current = start;
  let seq = 0;
  const timers = new Map(); // id → { at, fn, interval, seq }

  function add(fn, ms, interval) {
    if (typeof fn !== 'function') throw new TypeError('fake timer: fn 必须是函数');
    const delay = Math.max(0, Math.floor(Number(ms)) || 0);
    seq += 1;
    timers.set(seq, { at: current + delay, fn, interval: interval ? Math.max(1, delay) : 0, seq });
    return seq;
  }

  function nextDue(limit) {
    let best = null;
    for (const [id, t] of timers) {
      if (t.at > limit) continue;
      if (!best || t.at < best.t.at || (t.at === best.t.at && t.seq < best.t.seq)) best = { id, t };
    }
    return best;
  }

  // 前进 ms 毫秒，依次执行期间到期的定时器（回调里新建的定时器若也到期同样执行）
  function advance(ms) {
    const target = current + ms;
    for (let guard = 0; guard < 100000; guard++) {
      const next = nextDue(target);
      if (!next) break;
      current = Math.max(current, next.t.at);
      if (next.t.interval) {
        next.t.at += next.t.interval;
        next.t.seq = ++seq;
      } else {
        timers.delete(next.id);
      }
      next.t.fn();
    }
    current = target;
  }

  return {
    now: () => current,
    advance,
    // 执行所有已到期（at <= now）的定时器
    tick: () => advance(0),
    pendingCount: () => timers.size,
    nextAt: () => {
      let min = null;
      for (const t of timers.values()) if (min === null || t.at < min) min = t.at;
      return min;
    },
    timers: {
      setTimeout: (fn, ms) => add(fn, ms, false),
      clearTimeout: (id) => {
        timers.delete(id);
      },
      setInterval: (fn, ms) => add(fn, ms, true),
      clearInterval: (id) => {
        timers.delete(id);
      },
    },
  };
}

// 让已完成的 Promise 回调都跑完
function flush(times = 3) {
  let p = Promise.resolve();
  for (let i = 0; i < times; i++) p = p.then(() => new Promise((r) => setImmediate(r)));
  return p;
}

module.exports = { createFakeClock, flush };
