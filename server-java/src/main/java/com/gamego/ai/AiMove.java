package com.gamego.ai;

/**
 * chooseMove 的结果。move 为落点 idx（y * n + x，左上角 0），-1 表示 pass；resign 为 true 时 move 为 -1。
 * info 为 AI 视角的评估，可能为 null（内置练习 AI、测试替身等）。
 */
public record AiMove(int move, boolean resign, AiMoveInfo info) {
  public static final int PASS = -1;

  public static AiMove of(int move) {
    return new AiMove(move, false, null);
  }

  public static AiMove pass() {
    return new AiMove(PASS, false, null);
  }

  public static AiMove resignMove() {
    return new AiMove(PASS, true, null);
  }

  public boolean isPass() {
    return move == PASS;
  }
}
