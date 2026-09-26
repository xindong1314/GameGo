package com.gamego.testsupport;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.concurrent.atomic.AtomicLong;

/** 可以手动推进的时钟（对应 Node 测试里的 makeClock）。 */
public class MutableClock extends Clock {
  /** 2026-09-25T00:00:00Z。 */
  public static final long T0 = 1790294400000L;
  public static final long DAY = 86400000L;

  private final AtomicLong t = new AtomicLong(T0);

  public void set(long v) {
    t.set(v);
  }

  public void advance(long ms) {
    t.addAndGet(ms);
  }

  @Override
  public long millis() {
    return t.get();
  }

  @Override
  public ZoneId getZone() {
    return ZoneOffset.UTC;
  }

  @Override
  public Clock withZone(ZoneId zone) {
    return this;
  }

  @Override
  public Instant instant() {
    return Instant.ofEpochMilli(t.get());
  }
}
