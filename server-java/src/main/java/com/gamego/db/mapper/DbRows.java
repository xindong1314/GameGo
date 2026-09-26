package com.gamego.db.mapper;

/**
 * MyBatis 读写用的原始行（列名下划线自动映射为驼峰字段，见 mybatis.configuration.map-underscore-to-camel-case）。
 * 只在 com.gamego.db 内部使用；对外一律是 {@link com.gamego.db.User} 等不可变记录。
 */
public final class DbRows {
  private DbRows() {}

  /** users 表。 */
  public static class UserRow {
    public Long id;
    public String openid;
    public String nickname;
    public String avatar;
    public Long createdAt;
    public Long lastLoginAt;
  }

  /** sessions 表的查询结果。 */
  public static class SessionRow {
    public Long userId;
    public Long expiresAt;
  }

  /** games 表（JSON 列为原始文本）。 */
  public static class GameDbRow {
    public String id;
    public String mode;
    public Integer size;
    public Double komi;
    public Long blackId;
    public Long whiteId;
    public String aiLevel;
    public String timeControl;
    public String status;
    public String moves;
    public String clocks;
    public String dead;
    public Integer winner;
    public String reason;
    public Double scoreBlack;
    public Double scoreWhite;
    public String resultText;
    public Integer counted;
    public Long createdAt;
    public Long updatedAt;
    public Long endedAt;
    public String state;
    public String cause;
  }

  /** user_stats 表。 */
  public static class StatsRow {
    public Long userId;
    public Long games;
    public Long wins;
    public Long losses;
    public Long draws;
    public Long curStreak;
    public Long maxStreak;
    public Long curStreakAt;
    public Long maxStreakAt;
    public Long updatedAt;
  }

  /** 排行榜查询结果。 */
  public static class LeaderRow {
    public Long userId;
    public Long games;
    public Long wins;
    public Long val;
    public String nickname;
    public String avatar;
  }

  /** 人机战绩统计结果。 */
  public static class CountRow {
    public Long games;
    public Long wins;
  }
}
