package com.gamego.game;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** 对局模块的日志接口（对应 Node 版注入的 logger）：生产环境转给 SLF4J，测试里换成记录日志的实现。 */
public interface GameLog {
  void debug(String msg);

  void info(String msg);

  void warn(String msg);

  void error(String msg, Throwable err);

  default void error(String msg) {
    error(msg, null);
  }

  static GameLog slf4j(Class<?> owner) {
    Logger l = LoggerFactory.getLogger(owner);
    return new GameLog() {
      @Override
      public void debug(String msg) {
        l.debug(msg);
      }

      @Override
      public void info(String msg) {
        l.info(msg);
      }

      @Override
      public void warn(String msg) {
        l.warn(msg);
      }

      @Override
      public void error(String msg, Throwable err) {
        if (err == null) l.error(msg);
        else l.error(msg, err);
      }
    };
  }
}
