package com.gamego.config;

/** 配置错误：启动时发现非法配置直接拒绝启动（对应 Node 版 config.js 的 ConfigError）。 */
public class ConfigError extends IllegalStateException {
  public ConfigError(String msg) {
    super(msg);
  }
}
