'use strict';

// 按键（用户 id、IP 等）的令牌桶限流。时间由调用方注入，便于用假时间测试。
//   const lim = new RateLimiter({ capacity: 10, refillPerSec: 1, now });
//   if (!lim.take(key)) → 拒绝
// capacity：桶容量（允许的突发数）；refillPerSec：每秒补充的令牌数。
// 满桶的条目没有保存的必要，prune() 会清掉它们（maxKeys 超出时也会自动清理），内存占用有界。

const DEFAULT_MAX_KEYS = 100000;

class RateLimiter {
  constructor({ capacity, refillPerSec, now = Date.now, maxKeys = DEFAULT_MAX_KEYS } = {}) {
    if (!(capacity >= 1) || !Number.isFinite(capacity)) throw new TypeError('RateLimiter: capacity 必须 ≥ 1');
    if (!(refillPerSec > 0) || !Number.isFinite(refillPerSec)) throw new TypeError('RateLimiter: refillPerSec 必须 > 0');
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.now = now;
    this.maxKeys = maxKeys;
    this.buckets = new Map(); // key → { tokens, t }
  }

  _bucket(key, t) {
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.prune(t);
      b = { tokens: this.capacity, t };
      this.buckets.set(key, b);
      return b;
    }
    if (t > b.t) {
      b.tokens = Math.min(this.capacity, b.tokens + ((t - b.t) / 1000) * this.refillPerSec);
      b.t = t;
    }
    return b;
  }

  // 还有令牌则消耗 cost 个并返回 true
  take(key, cost = 1) {
    const b = this._bucket(key, this.now());
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }

  // 只看不取：当前是否还有 cost 个令牌
  allows(key, cost = 1) {
    const b = this.buckets.get(key);
    if (!b) return true;
    const t = this.now();
    const tokens = t > b.t ? Math.min(this.capacity, b.tokens + ((t - b.t) / 1000) * this.refillPerSec) : b.tokens;
    return tokens >= cost;
  }

  // 距离下一个令牌还要多少毫秒（有令牌时为 0），用于 Retry-After
  retryAfterMs(key, cost = 1) {
    const b = this.buckets.get(key);
    if (!b) return 0;
    const t = this.now();
    const tokens = t > b.t ? Math.min(this.capacity, b.tokens + ((t - b.t) / 1000) * this.refillPerSec) : b.tokens;
    if (tokens >= cost) return 0;
    return Math.ceil(((cost - tokens) / this.refillPerSec) * 1000);
  }

  // 清掉已经补满的桶
  prune(t = this.now()) {
    for (const [key, b] of this.buckets) {
      const tokens = b.tokens + ((t - b.t) / 1000) * this.refillPerSec;
      if (tokens >= this.capacity) this.buckets.delete(key);
    }
    // 仍然太多（大量不同的键在同一时刻涌入）：丢掉最早的一半，宁可放过也不无限增长
    if (this.buckets.size >= this.maxKeys) {
      let drop = Math.ceil(this.buckets.size / 2);
      for (const key of this.buckets.keys()) {
        if (drop-- <= 0) break;
        this.buckets.delete(key);
      }
    }
  }

  get size() {
    return this.buckets.size;
  }
}

// 并发上限：acquire() 成功返回释放函数（只生效一次），满了返回 null
function createConcurrencyLimit(max) {
  if (!Number.isSafeInteger(max) || max < 1) throw new TypeError('createConcurrencyLimit: max 必须是正整数');
  let active = 0;
  return {
    acquire() {
      if (active >= max) return null;
      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active -= 1;
      };
    },
    get active() {
      return active;
    },
  };
}

module.exports = { RateLimiter, createConcurrencyLimit };
