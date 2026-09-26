package com.gamego.game;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;

/**
 * 假时间 + 假定时器的游戏循环（对应 Node 测试的 fake-clock）：now() 只在 advance() 时前进，定时器按到期时刻顺序同步执行；
 * execute() 提交的任务（AI 回调等）排队，flush() 时才执行（对应 Node 测试里的 await flush()）。
 */
public class ManualLoop implements GameLoop {

  public static final long START = 1700000000000L;

  private static final class T implements Timer {
    long at;
    final Runnable fn;
    final long interval;
    long seq;
    boolean cancelled;

    T(long at, Runnable fn, long interval, long seq) {
      this.at = at;
      this.fn = fn;
      this.interval = interval;
      this.seq = seq;
    }

    @Override
    public void cancel() {
      cancelled = true;
    }
  }

  private long current;
  private long seq = 0;
  private final List<T> timers = new ArrayList<>();
  private final ArrayDeque<Runnable> tasks = new ArrayDeque<>();

  public ManualLoop() {
    this(START);
  }

  public ManualLoop(long start) {
    this.current = start;
  }

  @Override
  public long now() {
    return current;
  }

  @Override
  public Timer schedule(Runnable fn, long delayMs) {
    T t = new T(current + Math.max(0, delayMs), fn, 0, ++seq);
    timers.add(t);
    return t;
  }

  @Override
  public Timer every(Runnable fn, long periodMs) {
    long p = Math.max(1, periodMs);
    T t = new T(current + p, fn, p, ++seq);
    timers.add(t);
    return t;
  }

  @Override
  public void execute(Runnable fn) {
    tasks.add(fn);
  }

  @Override
  public boolean inLoop() {
    return true;
  }

  @Override
  public <V> V call(Callable<V> fn) {
    try {
      return fn.call();
    } catch (RuntimeException e) {
      throw e;
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }

  private T nextDue(long limit) {
    T best = null;
    for (T t : timers) {
      if (t.cancelled || t.at > limit) continue;
      if (best == null || t.at < best.at || (t.at == best.at && t.seq < best.seq)) best = t;
    }
    return best;
  }

  /** 前进 ms 毫秒，依次执行期间到期的定时器（回调里新建的定时器若也到期同样执行）。 */
  public void advance(long ms) {
    long target = current + ms;
    timers.removeIf(t -> t.cancelled);
    for (int guard = 0; guard < 100000; guard++) {
      T next = nextDue(target);
      if (next == null) break;
      current = Math.max(current, next.at);
      if (next.interval > 0) {
        next.at += next.interval;
        next.seq = ++seq;
      } else {
        timers.remove(next);
      }
      next.fn.run();
    }
    current = target;
  }

  /** 执行所有已到期（at &lt;= now）的定时器。 */
  public void tick() {
    advance(0);
  }

  /** 执行排队的任务（直到队列为空）。 */
  public void flush() {
    for (int guard = 0; guard < 100000 && !tasks.isEmpty(); guard++) tasks.poll().run();
  }

  public int pendingTimers() {
    timers.removeIf(t -> t.cancelled);
    return timers.size();
  }
}
