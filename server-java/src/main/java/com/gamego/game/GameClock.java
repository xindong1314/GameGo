package com.gamego.game;

import com.fasterxml.jackson.databind.JsonNode;
import com.gamego.config.TimeControl;
import java.util.Map;

/**
 * 读秒（byo-yomi）纯逻辑（设计文档 6.1，移植自 Node 版 game/clock.js）。时间一律为毫秒整数，now 由调用方传入。
 *
 * <p>每方的存量 {@link Side} = { mainMs, periodsLeft }；读秒周期长度 periodMs 来自用时设置，所有周期等长。
 *
 * <ul>
 *   <li>轮到某方时开始计时；落子/pass 时扣除耗时：先扣基本时间，基本时间用完后进入读秒，每用满一个完整周期消耗一次，
 *       本手在周期内完成则周期重置。
 *   <li>本手耗时 ≥ 基本时间 + 剩余次数 × 周期 即超时。定时器也在这个时刻判负，二者一致。
 * </ul>
 *
 * 对外的时钟快照 Clocks = { 1: ClockView, 2: ClockView, running: 1|2|null }，ClockView = { mainMs, periodsLeft, periodMs }：
 * 未在走的一方存量原样、periodMs 为完整周期；正在走的一方按发送时刻推算，已进入读秒时 periodMs 为"当前周期还剩多少"。
 */
public final class GameClock {

  /** 一方的存量。 */
  public record Side(long mainMs, long periodsLeft) {}

  /** {@link #consume} 的结果。 */
  public record Consumed(Side side, boolean timedOut) {}

  /** {@link #stop} 的结果：color 为刚停下的一方（0 表示本来就没在走）。 */
  public record Stopped(int color, boolean timedOut) {}

  /** 某一方的显示量。 */
  public record View(long mainMs, long periodsLeft, long periodMs) {
    Map<String, Object> toJson() {
      return Msg.of("mainMs", mainMs, "periodsLeft", periodsLeft, "periodMs", periodMs);
    }
  }

  final TimeControl tc;
  final Side[] sides = new Side[3];
  /** 正在走的一方（1/2），0 表示没在走。 */
  int running;
  /** 这一手开始的时刻（没在走时无意义）。 */
  long startedAt;

  public GameClock(TimeControl tc) {
    this(tc, null);
  }

  /** saved：持久化的读秒（{@link #toJson()} 的格式，JSON），非法的一方回落到初始值。 */
  public GameClock(TimeControl tc, JsonNode saved) {
    this.tc = normalizeTimeControl(tc);
    sides[1] = initialSide(this.tc);
    sides[2] = initialSide(this.tc);
    if (saved != null && saved.isObject()) {
      for (int c = 1; c <= 2; c++) {
        JsonNode s = saved.get(String.valueOf(c));
        if (s != null && s.isObject()) {
          Long main = Json.safeInt(s.get("mainMs"));
          Long periods = Json.safeInt(s.get("periodsLeft"));
          if (main != null && main >= 0 && periods != null && periods >= 0) sides[c] = new Side(main, periods);
        }
      }
    }
  }

  /** 校验用时设置：非负整数；有读秒次数时周期必须大于 0；基本时间与读秒不能同时为 0。 */
  public static TimeControl normalizeTimeControl(TimeControl tc) {
    if (tc == null) throw new IllegalArgumentException("用时设置应为 { mainMs, periods, periodMs }");
    if (tc.mainMs() < 0 || tc.periods() < 0 || tc.periodMs() < 0) {
      throw new IllegalArgumentException("用时设置必须是非负整数：" + tc);
    }
    if (tc.periods() > 0 && tc.periodMs() <= 0) throw new IllegalArgumentException("有读秒次数时读秒周期必须大于 0");
    if (tc.mainMs() + tc.periods() * tc.periodMs() <= 0) throw new IllegalArgumentException("基本时间与读秒不能同时为 0");
    return tc;
  }

  public static Side initialSide(TimeControl tc) {
    return new Side(tc.mainMs(), tc.periods());
  }

  /** 从轮到这一方开始，还能用多久。 */
  public static long totalMs(Side side, long periodMs) {
    return side.mainMs() + side.periodsLeft() * periodMs;
  }

  static long toElapsed(long elapsed) {
    return Math.max(0, elapsed);
  }

  /** 扣除一手的耗时，返回新的存量（不修改入参）。 */
  public static Consumed consume(Side side, long elapsed, long periodMs) {
    long e = toElapsed(elapsed);
    if (e >= totalMs(side, periodMs)) return new Consumed(new Side(0, 0), true);
    if (e <= side.mainMs()) return new Consumed(new Side(side.mainMs() - e, side.periodsLeft()), false);
    // 走到这里说明 periodsLeft > 0 且 periodMs > 0（否则上面已判超时）
    long over = e - side.mainMs();
    long used = over / periodMs;
    return new Consumed(new Side(0, side.periodsLeft() - used), false);
  }

  /** 这一方已走了 elapsed 毫秒时的显示量。 */
  public static View sideView(Side side, long elapsed, long periodMs) {
    long e = toElapsed(elapsed);
    if (e >= totalMs(side, periodMs)) return new View(0, 0, 0);
    if (e < side.mainMs()) return new View(side.mainMs() - e, side.periodsLeft(), periodMs);
    long over = e - side.mainMs();
    long used = over / periodMs;
    return new View(0, side.periodsLeft() - used, periodMs - (over % periodMs));
  }

  public static long msUntilTimeout(Side side, long elapsed, long periodMs) {
    return Math.max(0, totalMs(side, periodMs) - toElapsed(elapsed));
  }

  public long periodMs() {
    return tc.periodMs();
  }

  public TimeControl timeControl() {
    return tc;
  }

  public Side side(int color) {
    return sides[color];
  }

  public void setSide(int color, Side s) {
    sides[color] = s;
  }

  /** 正在走的一方（1/2），没在走为 0。 */
  public int running() {
    return running;
  }

  /** 开始给 color 计时；若另一方正在走，先结算它。 */
  public void start(int color, long now) {
    if (color != 1 && color != 2) throw new IllegalArgumentException("非法颜色 " + color);
    if (running != 0) stop(now);
    running = color;
    startedAt = now;
  }

  /** 停钟并结算正在走的一方。 */
  public Stopped stop(long now) {
    if (running == 0) return new Stopped(0, false);
    int color = running;
    Consumed r = consume(sides[color], now - startedAt, tc.periodMs());
    sides[color] = r.side();
    running = 0;
    startedAt = 0;
    return new Stopped(color, r.timedOut());
  }

  /** 超时判负后把这一方清零。 */
  public void zero(int color) {
    sides[color] = new Side(0, 0);
    if (running == color) {
      running = 0;
      startedAt = 0;
    }
  }

  public long elapsed(long now) {
    return running != 0 ? toElapsed(now - startedAt) : 0;
  }

  /** 正在走的一方的超时时刻（绝对时间）；没在走返回 null。 */
  public Long timeoutAt() {
    if (running == 0) return null;
    return startedAt + totalMs(sides[running], tc.periodMs());
  }

  /** 正在走的一方基本时间用完（进入读秒）的时刻；已在读秒中则为这一手开始的时刻；没在走返回 null。 */
  public Long mainOutAt() {
    if (running == 0) return null;
    return startedAt + sides[running].mainMs();
  }

  public Long msUntilTimeout(long now) {
    if (running == 0) return null;
    return msUntilTimeout(sides[running], now - startedAt, tc.periodMs());
  }

  public boolean isTimedOut(long now) {
    Long at = timeoutAt();
    return at != null && now >= at;
  }

  /** 发送给客户端的快照（按 now 推算正在走的一方）：{ "1": ClockView, "2": ClockView, running }。 */
  public Map<String, Object> snapshot(long now) {
    Map<String, Object> out = new java.util.LinkedHashMap<>();
    for (int c = 1; c <= 2; c++) {
      Side s = sides[c];
      View v = c == running ? sideView(s, now - startedAt, tc.periodMs()) : new View(s.mainMs(), s.periodsLeft(), tc.periodMs());
      out.put(String.valueOf(c), v.toJson());
    }
    out.put("running", running == 0 ? null : running);
    return out;
  }

  /** 持久化用：存量（不含正在走的这一手的耗时，重启后这一手重新计时）。 */
  public Map<String, Object> toJson() {
    Map<String, Object> out = new java.util.LinkedHashMap<>();
    for (int c = 1; c <= 2; c++) {
      out.put(String.valueOf(c), new View(sides[c].mainMs(), sides[c].periodsLeft(), tc.periodMs()).toJson());
    }
    out.put("running", running == 0 ? null : running);
    return out;
  }
}
