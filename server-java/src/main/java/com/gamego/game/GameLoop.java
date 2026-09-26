package com.gamego.game;

import java.util.concurrent.Callable;

/**
 * "游戏循环"：所有对局 / 大厅状态只在这一个线程上读写（Node 版是单线程的，这样移植最忠实、也不会有竞态）。
 * 定时器在它上面触发，AI 的 CompletableFuture 回调也经 {@link #execute} 回到它上面执行。
 *
 * <p>实现：{@link ExecutorGameLoop}（生产，单线程 ScheduledExecutorService + 注入的 Clock）；
 * 测试里用手动推进的假时间实现（对应 Node 测试的 fake-clock）。
 */
public interface GameLoop {

  /** 可以取消的定时器。 */
  interface Timer {
    void cancel();
  }

  /** 当前时间（毫秒）。 */
  long now();

  /** delayMs 毫秒后在循环线程上执行 fn（只执行一次）。 */
  Timer schedule(Runnable fn, long delayMs);

  /** 每隔 periodMs 毫秒执行一次。 */
  Timer every(Runnable fn, long periodMs);

  /** 尽快在循环线程上执行 fn（排在已提交的任务之后）。 */
  void execute(Runnable fn);

  /** 当前线程是不是循环线程。 */
  boolean inLoop();

  /**
   * 在循环线程上执行 fn 并等待结果（供 HTTP 线程、测试等调用）；已在循环线程上时直接执行。
   * fn 抛出的异常原样抛出（受检异常包成 RuntimeException）。
   */
  <T> T call(Callable<T> fn);
}
