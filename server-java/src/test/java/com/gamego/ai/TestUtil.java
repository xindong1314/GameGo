package com.gamego.ai;

import static org.junit.jupiter.api.Assertions.fail;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

/** AI 模块测试的公共小工具（对应 server/test/ai/helpers.js）。 */
final class TestUtil {
  private TestUtil() {}

  /** 轮询等待条件成立。 */
  static void waitFor(BooleanSupplier pred, long timeoutMs, String what) {
    long deadline = System.currentTimeMillis() + timeoutMs;
    while (!pred.getAsBoolean()) {
      if (System.currentTimeMillis() > deadline) fail("等待超时：" + what);
      sleep(10);
    }
  }

  /** 等待 future 失败，返回（解包后的）异常。 */
  static Throwable rejects(CompletableFuture<?> f) {
    try {
      Object v = f.get(60, TimeUnit.SECONDS);
      fail("应当失败，却得到：" + v);
      return null;
    } catch (Exception e) {
      return AiException.unwrap(e);
    }
  }

  /** 等待 future 失败，返回 AiException 的错误码。 */
  static String code(CompletableFuture<?> f) {
    Throwable t = rejects(f);
    if (t instanceof AiException ae) return ae.getCode();
    fail("不是 AiException：" + t);
    return null;
  }

  static <T> T get(CompletableFuture<T> f) {
    try {
      return f.get(60, TimeUnit.SECONDS);
    } catch (Exception e) {
      Throwable c = AiException.unwrap(e);
      throw new AssertionError("future 失败：" + c, c);
    }
  }

  static void sleep(long ms) {
    try {
      Thread.sleep(ms);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
    }
  }
}
