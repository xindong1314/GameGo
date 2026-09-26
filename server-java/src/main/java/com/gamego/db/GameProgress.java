package com.gamego.db;

import java.util.List;

/**
 * {@link GameRepository#saveProgress} 的参数（对应 Node 版 saveProgress(id, { status, moves, clocks, state })）：
 * 只更新调用过的字段；{@code clocks(null)} / {@code state(null)} 表示清空。
 *
 * <pre>
 * repo.saveProgress(id, GameProgress.of().moves(moves).clocks(clocksSnapshot).state(state), now);
 * </pre>
 */
public class GameProgress {
  String status;
  boolean statusSet;
  List<Integer> moves;
  boolean movesSet;
  Object clocks;
  boolean clocksSet;
  Object state;
  boolean stateSet;

  public static GameProgress of() {
    return new GameProgress();
  }

  /** 只能是 "playing" / "scoring"（终局请用 finish）。 */
  public GameProgress status(String v) {
    status = v;
    statusSet = true;
    return this;
  }

  public GameProgress moves(List<Integer> v) {
    moves = v;
    movesSet = true;
    return this;
  }

  public GameProgress clocks(Object v) {
    clocks = v;
    clocksSet = true;
    return this;
  }

  public GameProgress state(Object v) {
    state = v;
    stateSet = true;
    return this;
  }
}
