package com.gamego.db;

/**
 * 排行榜的一项（设计文档 3.3）。value：连胜榜为整数（Long），胜率榜为 0~1 的小数（Double）。
 * avatar 为文件名，avatarUrl 为完整地址。
 */
public record LeaderboardEntry(
    int rank, long userId, String nickname, String avatar, String avatarUrl, Number value, long games, long wins) {}
