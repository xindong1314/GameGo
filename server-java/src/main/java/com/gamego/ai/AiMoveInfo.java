package com.gamego.ai;

/** AI 视角的局面评估：胜率（0~1）、目差（+ 表示 AI 领先）、搜索次数。 */
public record AiMoveInfo(double winrate, double scoreLead, int visits) {}
