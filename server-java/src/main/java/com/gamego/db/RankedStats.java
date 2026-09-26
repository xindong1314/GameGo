package com.gamego.db;

/**
 * 排位统计（只统计排位赛，设计文档 3.2 / 第 4 节）。winrate 为 0~1（games=0 时为 0）；
 * curStreakAt / maxStreakAt 为当前 / 最高连胜达到现值的时间（毫秒，可能为 null），只在内部排序用。
 */
public record RankedStats(
    long games,
    long wins,
    long losses,
    long draws,
    double winrate,
    long curStreak,
    long maxStreak,
    Long curStreakAt,
    Long maxStreakAt) {

  /** 没有记录时的全 0 统计。 */
  public static RankedStats empty() {
    return new RankedStats(0, 0, 0, 0, 0, 0, 0, null, null);
  }
}
