package com.gamego.config;

import java.util.List;

/**
 * 读秒设置（设计文档 6.1）：基本时间 + 读秒次数 × 每次读秒。JSON 形如 {@code {mainMs, periods, periodMs}}，
 * 数据库 games.time_control 与 WebSocket 快照都用这个格式。
 */
public record TimeControl(long mainMs, int periods, long periodMs) {

  /** 解析环境变量格式 "基本秒,读秒次数,每次秒"（如 600,3,30），规则与 Node 版 parseTimeControl 相同。 */
  public static TimeControl parse(String raw, String name) {
    String[] parts = String.valueOf(raw).split(",", -1);
    List<String> trimmed = new java.util.ArrayList<>();
    for (String p : parts) trimmed.add(p.trim());
    boolean ok = trimmed.size() == 3 && trimmed.stream().allMatch(p -> p.matches("\\d+"));
    if (!ok) {
      throw new ConfigError(name + " 格式应为 \"基本秒,读秒次数,每次秒\"（如 600,3,30），当前为 \"" + raw + "\"");
    }
    long mainSec;
    long periods;
    long periodSec;
    try {
      mainSec = Long.parseLong(trimmed.get(0));
      periods = Long.parseLong(trimmed.get(1));
      periodSec = Long.parseLong(trimmed.get(2));
    } catch (NumberFormatException e) {
      throw new ConfigError(name + " 数值过大：\"" + raw + "\"");
    }
    if (mainSec > 86400) throw new ConfigError(name + " 基本时间不能超过 86400 秒");
    if (periods > 100) throw new ConfigError(name + " 读秒次数不能超过 100");
    if (periodSec > 3600) throw new ConfigError(name + " 每次读秒不能超过 3600 秒");
    if (periods > 0 && periodSec < 1) throw new ConfigError(name + " 有读秒次数时每次读秒至少 1 秒");
    if (mainSec == 0 && periods == 0) throw new ConfigError(name + " 基本时间与读秒不能同时为 0");
    return new TimeControl(mainSec * 1000, (int) periods, periodSec * 1000);
  }
}
