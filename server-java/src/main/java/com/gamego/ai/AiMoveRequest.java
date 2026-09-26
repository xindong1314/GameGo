package com.gamego.ai;

import java.util.Arrays;

/**
 * chooseMove 的参数（设计文档 7.1）。
 *
 * @param size 路数（9 / 13 / 19）
 * @param komi 贴目（整数或半整数）
 * @param moves 着手序列（idx，-1 为 pass），黑先、交替
 * @param color AI 执子颜色（1 黑 / 2 白），必须等于轮到的一方
 * @param level 难度 id（见 {@link AiService#levels()}）
 * @param humanJustPassed 对手（人）上一手是否 pass
 */
public record AiMoveRequest(int size, double komi, int[] moves, int color, String level, boolean humanJustPassed) {
  @Override
  public boolean equals(Object o) {
    return o instanceof AiMoveRequest r
        && r.size == size
        && Double.compare(r.komi, komi) == 0
        && Arrays.equals(r.moves, moves)
        && r.color == color
        && java.util.Objects.equals(r.level, level)
        && r.humanJustPassed == humanJustPassed;
  }

  @Override
  public int hashCode() {
    return java.util.Objects.hash(size, komi, Arrays.hashCode(moves), color, level, humanJustPassed);
  }

  @Override
  public String toString() {
    return "AiMoveRequest[size=" + size + ", komi=" + komi + ", moves=" + Arrays.toString(moves) + ", color=" + color
        + ", level=" + level + ", humanJustPassed=" + humanJustPassed + "]";
  }
}
