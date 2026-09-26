package com.gamego.ai;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** AI 模块内部用的极简日志接口：生产环境转给 SLF4J，测试里可以换成记录日志的实现。 */
public interface AiLog {
  void debug(String msg);

  void info(String msg);

  void warn(String msg);

  void error(String msg);

  static AiLog slf4j(Class<?> owner) {
    Logger l = LoggerFactory.getLogger(owner);
    return new AiLog() {
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
      public void error(String msg) {
        l.error(msg);
      }
    };
  }

  AiLog SILENT =
      new AiLog() {
        @Override
        public void debug(String msg) {}

        @Override
        public void info(String msg) {}

        @Override
        public void warn(String msg) {}

        @Override
        public void error(String msg) {}
      };
}
