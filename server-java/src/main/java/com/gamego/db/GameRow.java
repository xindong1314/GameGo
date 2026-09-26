package com.gamego.db;

import com.fasterxml.jackson.databind.JsonNode;
import com.gamego.config.TimeControl;
import java.util.List;

/**
 * 一局对局的数据库记录（设计文档第 3 节 games 表），JSON 列已解析。
 *
 * @param id 12 位随机 base36（规则：[A-Za-z0-9_-]{1,64}）
 * @param mode "ranked" | "friend" | "ai"
 * @param blackId 执黑用户 id，AI 一方为 null
 * @param whiteId 执白用户 id，AI 一方为 null
 * @param aiLevel 人机对局的难度 id，否则 null
 * @param timeControl 读秒设置，人机为 null
 * @param status "playing" | "scoring" | "ended"
 * @param moves 着手序列（落子为 idx，pass 为 -1）
 * @param clocks 读秒快照（重启恢复用），可能为 null
 * @param dead 终局时的死子数组，可能为 null
 * @param winner 0/1/2，未结束为 null
 * @param reason "score" | "resign" | "timeout" | "abort"，未结束为 null
 * @param counted 已计入排行统计（只由 {@link StatsRepository#applyRanked} 置为 true）
 * @param state 会话附加状态 {@code { resumesUsed, guard }}（6.5），进行中随进度保存，终局清空；损坏时按 null
 * @param cause 终局细分原因（Result.cause，5.4），旧记录为 null
 */
public record GameRow(
    String id,
    String mode,
    int size,
    double komi,
    Long blackId,
    Long whiteId,
    String aiLevel,
    TimeControl timeControl,
    String status,
    List<Integer> moves,
    JsonNode clocks,
    List<Integer> dead,
    Integer winner,
    String reason,
    Double scoreBlack,
    Double scoreWhite,
    String resultText,
    boolean counted,
    JsonNode state,
    String cause,
    long createdAt,
    long updatedAt,
    Long endedAt) {}
