package com.gamego.db;

import com.gamego.config.TimeControl;
import java.util.List;

/**
 * {@link GameRepository#insert(NewGame)} 的参数（对应 Node 版 games.insert(row)）。
 * clocks / state 可以是任意能被 Jackson 序列化的值（Map、POJO、JsonNode），内部 JSON 化。
 *
 * <pre>
 * repo.insert(new NewGame().id(id).mode("ranked").size(9).komi(7.5).blackId(a).whiteId(b)
 *     .timeControl(tc).createdAt(now));
 * </pre>
 */
public class NewGame {
  String id;
  String mode;
  Integer size;
  Double komi;
  Long blackId;
  Long whiteId;
  String aiLevel;
  TimeControl timeControl;
  String status = "playing";
  List<Integer> moves = List.of();
  Object clocks;
  List<Integer> dead;
  Integer winner;
  String reason;
  Double scoreBlack;
  Double scoreWhite;
  String resultText;
  boolean counted;
  Object state;
  String cause;
  Long createdAt;
  Long updatedAt;
  Long endedAt;

  public NewGame id(String v) {
    id = v;
    return this;
  }

  public NewGame mode(String v) {
    mode = v;
    return this;
  }

  public NewGame size(int v) {
    size = v;
    return this;
  }

  public NewGame komi(double v) {
    komi = v;
    return this;
  }

  public NewGame blackId(Long v) {
    blackId = v;
    return this;
  }

  public NewGame whiteId(Long v) {
    whiteId = v;
    return this;
  }

  public NewGame aiLevel(String v) {
    aiLevel = v;
    return this;
  }

  public NewGame timeControl(TimeControl v) {
    timeControl = v;
    return this;
  }

  public NewGame status(String v) {
    status = v;
    return this;
  }

  public NewGame moves(List<Integer> v) {
    moves = v;
    return this;
  }

  public NewGame clocks(Object v) {
    clocks = v;
    return this;
  }

  public NewGame dead(List<Integer> v) {
    dead = v;
    return this;
  }

  public NewGame winner(Integer v) {
    winner = v;
    return this;
  }

  public NewGame reason(String v) {
    reason = v;
    return this;
  }

  public NewGame scoreBlack(Double v) {
    scoreBlack = v;
    return this;
  }

  public NewGame scoreWhite(Double v) {
    scoreWhite = v;
    return this;
  }

  public NewGame resultText(String v) {
    resultText = v;
    return this;
  }

  public NewGame counted(boolean v) {
    counted = v;
    return this;
  }

  public NewGame state(Object v) {
    state = v;
    return this;
  }

  public NewGame cause(String v) {
    cause = v;
    return this;
  }

  public NewGame createdAt(long v) {
    createdAt = v;
    return this;
  }

  /** 省略时等于 createdAt。 */
  public NewGame updatedAt(long v) {
    updatedAt = v;
    return this;
  }

  public NewGame endedAt(Long v) {
    endedAt = v;
    return this;
  }
}
