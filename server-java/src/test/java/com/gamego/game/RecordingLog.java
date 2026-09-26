package com.gamego.game;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/** 记录日志的 GameLog（对应 Node 测试的 createTestLogger），便于断言"没有意外错误"。 */
public class RecordingLog implements GameLog {
  public final List<String> debug = new CopyOnWriteArrayList<>();
  public final List<String> info = new CopyOnWriteArrayList<>();
  public final List<String> warn = new CopyOnWriteArrayList<>();
  public final List<String> error = new CopyOnWriteArrayList<>();
  private final boolean echo;

  public RecordingLog() {
    this(Boolean.getBoolean("gamego.test.echoLog"));
  }

  public RecordingLog(boolean echo) {
    this.echo = echo;
  }

  @Override
  public void debug(String msg) {
    debug.add(msg);
  }

  @Override
  public void info(String msg) {
    info.add(msg);
    if (echo) System.out.println("[info] " + msg);
  }

  @Override
  public void warn(String msg) {
    warn.add(msg);
    if (echo) System.out.println("[warn] " + msg);
  }

  @Override
  public void error(String msg, Throwable err) {
    error.add(err == null ? msg : msg + " :: " + err);
    if (echo) {
      System.out.println("[error] " + msg);
      if (err != null) err.printStackTrace(System.out);
    }
  }
}
