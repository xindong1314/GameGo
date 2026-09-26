package com.gamego.web;

import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.LongSupplier;

/**
 * 按键（用户 id、IP 等）的令牌桶限流（对应 Node 版 util/rate-limit.js）。时间由调用方注入，便于用假时间测试。
 * capacity：桶容量（允许的突发数）；refillPerSec：每秒补充的令牌数。满桶的条目没有保存的必要，
 * {@link #prune()} 会清掉它们（条目过多时也会自动清理），内存占用有界。线程安全。
 */
public class RateLimiter {

  static final int DEFAULT_MAX_KEYS = 100000;

  private static final class Bucket {
    double tokens;
    long t;

    Bucket(double tokens, long t) {
      this.tokens = tokens;
      this.t = t;
    }
  }

  private final double capacity;
  private final double refillPerSec;
  private final LongSupplier now;
  private final int maxKeys;
  private final LinkedHashMap<Object, Bucket> buckets = new LinkedHashMap<>();

  public RateLimiter(double capacity, double refillPerSec, LongSupplier now) {
    this(capacity, refillPerSec, now, DEFAULT_MAX_KEYS);
  }

  public RateLimiter(double capacity, double refillPerSec, LongSupplier now, int maxKeys) {
    if (!(capacity >= 1) || !Double.isFinite(capacity)) throw new IllegalArgumentException("RateLimiter: capacity 必须 ≥ 1");
    if (!(refillPerSec > 0) || !Double.isFinite(refillPerSec)) {
      throw new IllegalArgumentException("RateLimiter: refillPerSec 必须 > 0");
    }
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.now = now;
    this.maxKeys = maxKeys;
  }

  private Bucket bucket(Object key, long t) {
    Bucket b = buckets.get(key);
    if (b == null) {
      if (buckets.size() >= maxKeys) prune(t);
      b = new Bucket(capacity, t);
      buckets.put(key, b);
      return b;
    }
    if (t > b.t) {
      b.tokens = Math.min(capacity, b.tokens + ((t - b.t) / 1000.0) * refillPerSec);
      b.t = t;
    }
    return b;
  }

  private double tokensAt(Bucket b, long t) {
    return t > b.t ? Math.min(capacity, b.tokens + ((t - b.t) / 1000.0) * refillPerSec) : b.tokens;
  }

  /** 还有令牌则消耗 1 个并返回 true。 */
  public boolean take(Object key) {
    return take(key, 1);
  }

  public synchronized boolean take(Object key, double cost) {
    Bucket b = bucket(key, now.getAsLong());
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }

  /** 只看不取：当前是否还有 1 个令牌。 */
  public synchronized boolean allows(Object key) {
    Bucket b = buckets.get(key);
    if (b == null) return true;
    return tokensAt(b, now.getAsLong()) >= 1;
  }

  /** 距离下一个令牌还要多少毫秒（有令牌时为 0），用于 Retry-After。 */
  public synchronized long retryAfterMs(Object key) {
    Bucket b = buckets.get(key);
    if (b == null) return 0;
    double tokens = tokensAt(b, now.getAsLong());
    if (tokens >= 1) return 0;
    return (long) Math.ceil(((1 - tokens) / refillPerSec) * 1000);
  }

  /** 清掉已经补满的桶。 */
  public synchronized void prune() {
    prune(now.getAsLong());
  }

  private void prune(long t) {
    buckets.entrySet().removeIf(e -> e.getValue().tokens + ((t - e.getValue().t) / 1000.0) * refillPerSec >= capacity);
    // 仍然太多（大量不同的键在同一时刻涌入）：丢掉最早的一半，宁可放过也不无限增长
    if (buckets.size() >= maxKeys) {
      int drop = (int) Math.ceil(buckets.size() / 2.0);
      Iterator<Map.Entry<Object, Bucket>> it = buckets.entrySet().iterator();
      while (it.hasNext() && drop-- > 0) {
        it.next();
        it.remove();
      }
    }
  }

  public synchronized int size() {
    return buckets.size();
  }
}
