package com.gamego.ai;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/** 记录日志的 AiLog（对应 Node 测试的 captureLogger）。 */
final class CaptureLog implements AiLog {
  final List<String> debug = new CopyOnWriteArrayList<>();
  final List<String> info = new CopyOnWriteArrayList<>();
  final List<String> warn = new CopyOnWriteArrayList<>();
  final List<String> error = new CopyOnWriteArrayList<>();

  @Override
  public void debug(String msg) {
    debug.add(msg);
  }

  @Override
  public void info(String msg) {
    info.add(msg);
  }

  @Override
  public void warn(String msg) {
    warn.add(msg);
  }

  @Override
  public void error(String msg) {
    error.add(msg);
  }

  /** lines 里有没有同时包含所有 parts 的一行。 */
  static boolean any(List<String> lines, String... parts) {
    for (String l : lines) {
      boolean all = true;
      for (String p : parts) if (!l.contains(p)) all = false;
      if (all) return true;
    }
    return false;
  }

  static long count(List<String> lines, String part) {
    return lines.stream().filter(l -> l.contains(part)).count();
  }
}
