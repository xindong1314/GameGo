package com.gamego.db;

/**
 * {@link GameRepository#listUnfinished()} 的一项：能解析的记录带 {@link #game()}；
 * 解析不了的（JSON 损坏）只带 id 与错误信息，{@link #broken()} 为 true，由恢复逻辑作废。
 * （只是 state 坏了按 null 处理，不算 broken。）
 */
public record UnfinishedGame(String id, GameRow game, String error) {
  public boolean broken() {
    return game == null;
  }
}
