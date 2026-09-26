package com.gamego.web;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/** 并发上限：{@link #acquire()} 成功返回释放句柄（只生效一次），满了返回 null。 */
public class ConcurrencyLimit {

  /** 释放句柄。 */
  public interface Release extends AutoCloseable {
    @Override
    void close();
  }

  private final int max;
  private final AtomicInteger active = new AtomicInteger();

  public ConcurrencyLimit(int max) {
    if (max < 1) throw new IllegalArgumentException("ConcurrencyLimit: max 必须是正整数");
    this.max = max;
  }

  public Release acquire() {
    while (true) {
      int a = active.get();
      if (a >= max) return null;
      if (active.compareAndSet(a, a + 1)) break;
    }
    AtomicBoolean released = new AtomicBoolean(false);
    return () -> {
      if (released.compareAndSet(false, true)) active.decrementAndGet();
    };
  }

  public int active() {
    return active.get();
  }
}
