package com.gamego.ai;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 难度表（设计文档 7.5，移植自 server/src/ai/levels.js）。
 *
 * <ul>
 *   <li>kind {@code rank} —— KaTrain "Calibrated Rank"：每步 1 次神经网络评估，按级位从随机抽取的若干合法点里选 policy 最高者
 *   <li>kind {@code policy} —— 直接下 policy 最高点（开局 22 手内按 KaTrain 规则加随机性）
 *   <li>kind {@code search} —— KataGo 真正的搜索
 * </ul>
 *
 * KaTrain 的级位校准只针对 19 路；同样的参数在小棋盘上明显更强，所以 13 路 kyu +5、9 路 kyu +10（上限 30）。
 * kyu 采用 KaTrain 的约定：18 = 18 级 … 1 = 1 级，0 = 1 段，-1 = 2 段，-2 = 3 段。
 */
public final class Levels {
  private Levels() {}

  public static final String KIND_RANK = "rank";
  public static final String KIND_POLICY = "policy";
  public static final String KIND_SEARCH = "search";

  /** 一档难度的完整定义。不适用的数值字段为 null。 */
  public record Level(
      String id,
      String name,
      String kind,
      Integer kyu,
      Integer openingMoves,
      Integer maxVisits,
      Integer maxTimeSec,
      String desc) {
    public AiLevel toPublic() {
      return new AiLevel(id, name, desc);
    }
  }

  public static final List<Level> LEVELS =
      List.of(
          new Level("k18", "入门", KIND_RANK, 18, null, null, null, "刚学会规则也能赢，常下出随意的棋（19 路约 18 级）"),
          new Level("k12", "初级", KIND_RANK, 12, null, null, null, "会吃子、会做活，但经常看漏对方的威胁（19 路约 12 级）"),
          new Level("k8", "中级", KIND_RANK, 8, null, null, null, "棋形像样，中盘战斗时有漏算（19 路约 8 级）"),
          new Level("k4", "中高级", KIND_RANK, 4, null, null, null, "布局扎实，攻防有章法，偶尔出现失误（19 路约 4 级）"),
          new Level("k1", "高级", KIND_RANK, 1, null, null, null, "全局判断较好，需要一定实力才能取胜（19 路约 1 级）"),
          new Level("d3", "业余 3 段", KIND_RANK, -2, null, null, null, "棋感敏锐、少有漏着（19 路约业余 3 段）"),
          new Level("d5", "业余高段", KIND_POLICY, null, 22, null, null, "凭神经网络的第一感落子，不做计算（19 路约业余 5 段）"),
          new Level("max", "最强", KIND_SEARCH, null, null, 300, 8, "KataGo 完整搜索，每步最多思考 8 秒（19 路远超业余顶尖水平）"));

  public static final Set<String> LEVEL_IDS;

  static {
    Set<String> ids = new LinkedHashSet<>();
    for (Level l : LEVELS) ids.add(l.id());
    LEVEL_IDS = java.util.Collections.unmodifiableSet(ids);
  }

  /** 小棋盘的级位修正（初始值，未经实测校准；可按实际胜率调整）。 */
  public static final Map<Integer, Integer> SIZE_KYU_OFFSET = Map.of(9, 10, 13, 5, 19, 0);

  /** KaTrain 公式在 kyu ≥ 36 左右退化，这里留足余量。 */
  public static final int MAX_KYU = 30;

  /** 按 id 取难度；没有返回 null。 */
  public static Level get(String id) {
    for (Level l : LEVELS) if (l.id().equals(id)) return l;
    return null;
  }

  /** rank 档在某个路数上实际使用的 kyu。 */
  public static int kyuFor(Level level, int size) {
    if (level == null || !KIND_RANK.equals(level.kind())) {
      throw new IllegalArgumentException("难度 " + (level == null ? null : level.id()) + " 不是 rank 档");
    }
    int offset = SIZE_KYU_OFFSET.getOrDefault(size, 0);
    return Math.min(MAX_KYU, level.kyu() + offset);
  }

  /** 对外只给 { id, name, desc }。 */
  public static List<AiLevel> publicLevels() {
    return LEVELS.stream().map(Level::toPublic).toList();
  }
}
