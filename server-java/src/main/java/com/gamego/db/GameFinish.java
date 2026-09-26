package com.gamego.db;

import java.util.List;

/**
 * {@link GameRepository#finish} 的参数（对应 Node 版 finish(id, { status: 'ended', moves, dead, winner, reason,
 * scoreBlack, scoreWhite, resultText, cause })）。
 *
 * <ul>
 *   <li>moves / dead 只有调用过才写入（dead(null) 表示写 NULL）；
 *   <li>resultText 省略时按引擎规则生成（B+R / W+T / B+3.5 / 0 / Void）；
 *   <li>不写 counted（counted 只由 applyRanked 置 1），同时清空 state。
 * </ul>
 *
 * <pre>
 * repo.finish(id, GameFinish.of(2, "score").moves(moves).dead(dead).scores(30, 51.5).cause("agreed"), now);
 * </pre>
 */
public class GameFinish {
  final int winner;
  final String reason;
  List<Integer> moves;
  boolean movesSet;
  List<Integer> dead;
  boolean deadSet;
  Double scoreBlack;
  Double scoreWhite;
  String resultText;
  String cause;

  private GameFinish(int winner, String reason) {
    this.winner = winner;
    this.reason = reason;
  }

  /** winner 0/1/2，reason "score" | "resign" | "timeout" | "abort"。 */
  public static GameFinish of(int winner, String reason) {
    return new GameFinish(winner, reason);
  }

  public GameFinish moves(List<Integer> v) {
    moves = v;
    movesSet = true;
    return this;
  }

  public GameFinish dead(List<Integer> v) {
    dead = v;
    deadSet = true;
    return this;
  }

  public GameFinish scoreBlack(Double v) {
    scoreBlack = v;
    return this;
  }

  public GameFinish scoreWhite(Double v) {
    scoreWhite = v;
    return this;
  }

  public GameFinish scores(double black, double white) {
    scoreBlack = black;
    scoreWhite = white;
    return this;
  }

  public GameFinish resultText(String v) {
    resultText = v;
    return this;
  }

  public GameFinish cause(String v) {
    cause = v;
    return this;
  }
}
