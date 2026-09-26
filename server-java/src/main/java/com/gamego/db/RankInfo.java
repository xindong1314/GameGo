package com.gamego.db;

/**
 * "我的名次"（设计文档 3.3）：rank 为 null 表示未上榜；need 仅胜率榜有意义（还差几局上榜），其余为 0。
 * value：连胜榜为 Long，胜率榜为 Double。
 */
public record RankInfo(Integer rank, Number value, long games, long wins, long need) {}
