package com.gamego.game;

import java.time.Clock;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/** 生产用的游戏循环：一个单线程 ScheduledExecutorService（线程名 game-loop），时间取自注入的 {@link Clock}。 */
public class ExecutorGameLoop implements GameLoop {

  private static final long CALL_TIMEOUT_MS = 15000;

  private final Clock clock;
  private final GameLog log;
  private final ScheduledThreadPoolExecutor executor;
  private volatile Thread thread;

  public ExecutorGameLoop(Clock clock) {
    this(clock, GameLog.slf4j(ExecutorGameLoop.class));
  }

  public ExecutorGameLoop(Clock clock, GameLog log) {
    this.clock = clock;
    this.log = log;
    this.executor =
        new ScheduledThreadPoolExecutor(
            1,
            r -> {
              Thread t = new Thread(r, "game-loop");
              t.setDaemon(true);
              thread = t;
              return t;
            });
    this.executor.setRemoveOnCancelPolicy(true);
    this.executor.setExecuteExistingDelayedTasksAfterShutdownPolicy(false);
  }

  private Runnable safe(Runnable fn) {
    return () -> {
      try {
        fn.run();
      } catch (Throwable err) {
        log.error("游戏循环任务出错", err);
      }
    };
  }

  @Override
  public long now() {
    return clock.millis();
  }

  @Override
  public Timer schedule(Runnable fn, long delayMs) {
    try {
      ScheduledFuture<?> f = executor.schedule(safe(fn), Math.max(0, delayMs), TimeUnit.MILLISECONDS);
      return () -> f.cancel(false);
    } catch (RejectedExecutionException e) {
      return () -> {}; // 已关闭
    }
  }

  @Override
  public Timer every(Runnable fn, long periodMs) {
    try {
      ScheduledFuture<?> f = executor.scheduleAtFixedRate(safe(fn), periodMs, periodMs, TimeUnit.MILLISECONDS);
      return () -> f.cancel(false);
    } catch (RejectedExecutionException e) {
      return () -> {}; // 已关闭
    }
  }

  @Override
  public void execute(Runnable fn) {
    try {
      executor.execute(safe(fn));
    } catch (RejectedExecutionException e) {
      // 已关闭
    }
  }

  @Override
  public boolean inLoop() {
    return Thread.currentThread() == thread;
  }

  @Override
  public <T> T call(Callable<T> fn) {
    if (inLoop()) {
      try {
        return fn.call();
      } catch (RuntimeException e) {
        throw e;
      } catch (Exception e) {
        throw new IllegalStateException(e);
      }
    }
    Future<T> f = executor.submit(fn);
    try {
      return f.get(CALL_TIMEOUT_MS, TimeUnit.MILLISECONDS);
    } catch (ExecutionException e) {
      Throwable c = e.getCause();
      if (c instanceof RuntimeException re) throw re;
      if (c instanceof Error er) throw er;
      throw new IllegalStateException(c);
    } catch (TimeoutException e) {
      f.cancel(false);
      throw new IllegalStateException("游戏循环繁忙，调用超时", e);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException(e);
    }
  }

  /** 关闭（不再执行排队中的定时器）。 */
  public void shutdown() {
    executor.shutdownNow();
  }
}
