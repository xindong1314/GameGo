package com.gamego.game;

import static com.gamego.game.Ctx.WALL;
import static com.gamego.game.Ctx.concat;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.gamego.config.TimeControl;
import com.gamego.db.GameRow;
import com.gamego.engine.Result;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** 对局会话（对应 Node 测试 game/session.test.js 与 game/fairness.test.js 的会话部分）。 */
class GameSessionTest {

  static final GameSettings SETTINGS = GameSettings.defaults();
  static final TimeControl TC = new TimeControl(60000, 3, 10000);
  static final long T0 = 1000000;
  static final Result B_WINS = new Result(1, "score", 45.0, 43.5);

  static GameSession human() {
    return human("ranked", TC, SETTINGS);
  }

  static GameSession human(TimeControl tc) {
    return human("ranked", tc, SETTINGS);
  }

  static GameSession human(String mode, TimeControl tc, GameSettings st) {
    return new GameSession("g00000000001", mode, 9, 7.5, 1L, 2L, null, tc, st, T0, null);
  }

  static GameSession aiGame(int humanColor) {
    return new GameSession(
        "a00000000001", "ai", 9, 7.5, humanColor == 1 ? 1L : null, humanColor == 2 ? 1L : null, "k10", null, SETTINGS, T0, null);
  }

  static void playAll(GameSession s, long now, int... moves) {
    for (int mv : moves) {
      int c = s.toPlay();
      if (mv == -1) s.pass(c, s.moves.size() + 1, now);
      else s.play(c, s.moves.size() + 1, mv, now);
    }
  }

  static void playAll(GameSession s, int... moves) {
    playAll(s, T0, moves);
  }

  static void assertCode(Runnable fn, String code) {
    assertThat(Ctx.codeOf(fn)).isEqualTo(code);
  }

  static GameSession online(GameSession s) {
    s.setOnline(1, true, T0);
    s.setOnline(2, true, T0);
    return s;
  }

  /** 双方 pass（黑先 pass）后给出 KataGo 建议 [10]（黑胜 1.5）。 */
  static GameSession scoredGame(TimeControl tc, GameSettings st) {
    GameSession s = online(human("ranked", tc, st));
    playAll(s, concat(WALL, -1, -1));
    assertThat(s.applyJudge(s.judgeToken(), new int[] {10}, T0)).isTrue();
    return s;
  }

  static GameSession scoredGame() {
    return scoredGame(TC, SETTINGS);
  }

  static GameSession manualGame(TimeControl tc) {
    GameSession s = online(human(tc));
    playAll(s, concat(WALL, -1, -1));
    assertThat(s.applyJudge(s.judgeToken(), null, T0)).isTrue();
    assertThat(s.scoring.source).isEqualTo("manual");
    return s;
  }

  static Map<String, Object> map(Object o) {
    return Ctx.map(o);
  }

  static String json(Object o) {
    return Json.write(o);
  }

  // ---------------------------------------------------------------- session.test.js

  @Test
  void constructorValidates() {
    assertThatThrownBy(() -> human("x", TC, SETTINGS)).isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> new GameSession("g", "ranked", 9, 7.5, 1L, 1L, null, TC, SETTINGS, T0, null))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> new GameSession("g", "ranked", 9, 7.5, 1L, null, null, TC, SETTINGS, T0, null))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> new GameSession("g", "ranked", 20, 7.5, 1L, 2L, null, TC, SETTINGS, T0, null))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> new GameSession("g", "ai", 9, 7.5, 1L, null, "", null, SETTINGS, T0, null))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> new GameSession("g", "ai", 9, 7.5, 1L, 2L, "k10", null, SETTINGS, T0, null))
        .isInstanceOf(IllegalArgumentException.class);
    GameSession s = human();
    assertThat(s.status()).isEqualTo("playing");
    assertThat(s.toPlay()).isEqualTo(1);
    assertThat(s.clock.running()).isEqualTo(1);
    assertThat(s.colorOf(1L)).isEqualTo(1);
    assertThat(s.colorOf(2L)).isEqualTo(2);
    assertThat(s.colorOf(3L)).isEqualTo(0);
    assertThat(s.userIds()).containsExactly(1L, 2L);
    GameSession a = aiGame(2);
    assertThat(a.aiColor).isEqualTo(1);
    assertThat(a.humanColor()).isEqualTo(2);
    assertThat(a.clock).isNull();
    assertThat(a.timeControl).isNull();
    assertThat(a.online[1]).isTrue();
    assertThat(a.online[2]).isFalse();
    assertThat(a.userIds()).containsExactly(1L);
  }

  @Test
  void playRecordsCapturesAndSwitchesClock() {
    GameSession s = human();
    int v0 = s.version;
    GameSession.MoveInfo r1 = s.play(1, 1, 1, T0 + 5000);
    assertThat(r1.n()).isEqualTo(1);
    assertThat(r1.idx()).isEqualTo(1);
    assertThat(r1.color()).isEqualTo(1);
    assertThat(r1.captured()).isEmpty();
    assertThat(r1.scoring()).isFalse();
    assertThat(s.clock.running()).isEqualTo(2);
    assertThat(s.clock.side(1)).isEqualTo(new GameClock.Side(55000, 3));
    assertThat(s.version).isGreaterThan(v0);
    s.play(2, 2, 0, T0 + 6000);
    GameSession.MoveInfo r3 = s.play(1, 3, 9, T0 + 7000);
    assertThat(r3.captured()).containsExactly(0);
    assertThat(s.moves).containsExactly(1, 0, 9);
    assertThat(s.turnStartedAt).isEqualTo(T0 + 7000);
  }

  @Test
  void staleAndNotYourTurn() {
    GameSession s = human();
    assertCode(() -> s.play(1, 2, 40, T0), "stale");
    assertCode(() -> s.play(2, 1, 40, T0), "not_your_turn");
    s.play(1, 1, 40, T0);
    assertCode(() -> s.play(1, 2, 41, T0), "not_your_turn");
    assertCode(() -> s.pass(2, 1, T0), "stale");
    try {
      s.play(2, 5, 41, T0);
    } catch (GameError e) {
      assertThat(e.toJson().get("expected")).isEqualTo(2);
    }
  }

  @Test
  void illegalMovesCarryReason() {
    GameSession s = human();
    s.play(1, 1, 40, T0);
    GameError e = (GameError) catchThrown(() -> s.play(2, 2, 40, T0));
    assertThat(e.code()).isEqualTo("illegal");
    assertThat(e.extra().get("reason")).isEqualTo("occupied");
    assertThat(e.msg()).contains("棋子");
    assertCode(() -> s.play(2, 2, 81, T0), "bad_request");
    assertCode(() -> s.play(2, 2, -3, T0), "bad_request");

    GameSession k = human();
    playAll(k, 1, 2, 9, 10, 19, 12, 80, 20, 11); // 黑 11 提白 10，形成劫
    GameError ko = (GameError) catchThrown(() -> k.play(2, 10, 10, T0));
    assertThat(ko.code()).isEqualTo("illegal");
    assertThat(ko.extra().get("reason")).isEqualTo("ko");

    GameSession su = human();
    playAll(su, 1, 80, 9);
    GameError sui = (GameError) catchThrown(() -> su.play(2, 4, 0, T0));
    assertThat(sui.extra().get("reason")).isEqualTo("suicide");
    assertThat(su.moves).containsExactly(1, 80, 9);
  }

  static Throwable catchThrown(Runnable r) {
    try {
      r.run();
    } catch (Throwable t) {
      return t;
    }
    throw new AssertionError("应当抛错");
  }

  @Test
  void timedOutSideCannotMove() {
    GameSession s = human();
    assertCode(() -> s.play(1, 1, 40, T0 + 90000), "wrong_phase");
    assertThat(s.moves).isEmpty();
    s.play(1, 1, 40, T0 + 89999);
    assertThat(s.clock.side(1)).isEqualTo(new GameClock.Side(0, 1));
  }

  @Test
  void twoPassesEnterScoring() {
    GameSession s = human();
    s.play(1, 1, 40, T0);
    GameSession.MoveInfo r1 = s.pass(2, 2, T0 + 1000);
    assertThat(r1.scoring()).isFalse();
    assertThat(r1.idx()).isEqualTo(-1);
    GameSession.MoveInfo r2 = s.pass(1, 3, T0 + 2000);
    assertThat(r2.scoring()).isTrue();
    assertThat(r2.n()).isEqualTo(3);
    assertThat(s.status()).isEqualTo("scoring");
    assertThat(s.clock.running()).isEqualTo(0);
    assertThat(s.scoring.pending).isTrue();
    assertThat(s.scoring.version).isEqualTo(0);
    assertThat(s.judgeToken()).isEqualTo(s.scoring.judgeSeq);
    assertCode(() -> s.play(2, 4, 41, T0), "wrong_phase");
    assertCode(() -> s.pass(2, 4, T0), "wrong_phase");
    Map<String, Object> v = s.scoringView(T0);
    assertThat(v.get("pending")).isEqualTo(true);
    assertThat(v.get("deadline")).isNull();
    assertThat(Ctx.list(v.get("owner"))).hasSize(81);
  }

  @Test
  void applyJudge() {
    GameSession s = human();
    playAll(s, concat(WALL, -1, -1));
    int seq = s.judgeToken();
    assertThat(s.applyJudge(seq + 1, new int[] {10}, T0)).isFalse();
    assertThat(s.applyJudge(seq, new int[] {10, 999, 30}, T0 + 500)).isTrue(); // 越界、空点忽略
    Map<String, Object> v = s.scoringView(T0 + 1500);
    assertThat(v.get("pending")).isEqualTo(false);
    assertThat(v.get("source")).isEqualTo("katago");
    assertThat(v.get("version")).isEqualTo(1);
    assertThat(v.get("dead")).isEqualTo(List.of(10));
    assertThat(v.get("black")).isEqualTo(45.0);
    assertThat(v.get("white")).isEqualTo(43.5);
    assertThat(v.get("winner")).isEqualTo(1);
    assertThat(json(v.get("accepted"))).isEqualTo("{\"1\":false,\"2\":false}");
    assertThat(v.get("deadline")).isEqualTo(179000L);
    assertThat(s.applyJudge(seq, new int[0], T0)).isFalse();

    GameSession m = human();
    playAll(m, concat(WALL, -1, -1));
    assertThat(m.applyJudge(m.judgeToken(), null, T0)).isTrue();
    assertThat(m.scoring.source).isEqualTo("manual");
    assertThat(m.scoring.dead).isEmpty();
    assertThat(m.scoring.winner).isEqualTo(2);
  }

  @Test
  void toggleWholeGroupAndResetAccepts() {
    GameSession s = human();
    playAll(s, concat(WALL, -1, -1));
    assertCode(() -> s.toggleDead(1, 10, T0, null), "wrong_phase");
    assertCode(() -> s.accept(1, 0, T0), "wrong_phase");
    s.applyJudge(s.judgeToken(), new int[0], T0);
    s.accept(1, 1, T0);
    assertThat(s.scoring.accepted[1]).isTrue();
    assertThat(s.toggleDead(2, 10, T0, null)).isTrue();
    assertThat(s.scoring.version).isEqualTo(2);
    assertThat(s.scoring.dead).containsExactly(10);
    assertThat(s.scoring.accepted[1]).isFalse();
    assertThat(s.scoring.winner).isEqualTo(1);
    assertThat(s.toggleDead(1, 0, T0, null)).isFalse();
    assertThat(s.scoring.version).isEqualTo(2);
    s.toggleDead(1, 4, T0, null);
    assertThat(s.scoring.dead).hasSize(10);
    s.toggleDead(1, 13, T0, null);
    assertThat(s.scoring.dead).containsExactly(10);
    assertThat(s.scoring.version).isEqualTo(4);
    assertCode(() -> s.toggleDead(1, 81, T0, null), "bad_request");
  }

  @Test
  void acceptRequiresCurrentVersionAndFinishes() {
    GameSession s = human();
    playAll(s, concat(WALL, -1, -1));
    s.applyJudge(s.judgeToken(), new int[] {10}, T0);
    assertCode(() -> s.accept(1, 2, T0), "stale");
    assertThat(s.accept(1, 1, T0)).isFalse();
    assertThat(s.accept(1, 1, T0)).isFalse();
    assertThat(s.accept(2, 1, T0)).isTrue();
    Result result = s.finishByScore(T0 + 10);
    assertThat(result).isEqualTo(B_WINS);
    assertThat(s.status()).isEqualTo("ended");
    assertThat(s.counted).isTrue();
    assertThat(json(s.resultView()))
        .isEqualTo("{\"winner\":1,\"reason\":\"score\",\"black\":45,\"white\":43.5,\"text\":\"B+1.5\",\"label\":\"黑胜 1.5 目\","
            + "\"counted\":true,\"cause\":\"agreed\",\"uncounted\":null,\"pending\":false}");
    assertThat(s.scoringView(T0).get("deadline")).isNull();
    assertThat(s.finishFields().dead()).containsExactly(10);
    assertThat(s.finishFields().resultText()).isEqualTo("B+1.5");
  }

  @Test
  void resumeReturnsToPlayAndInvalidatesJudge() {
    GameSession s = online(human("ranked", TC, SETTINGS.toBuilder().resumeLimit(2).build()));
    s.play(1, 1, 40, T0);
    s.pass(2, 2, T0 + 1000);
    s.pass(1, 3, T0 + 2000);
    int seq = s.judgeToken();
    assertThat(s.resume(1, T0 + 5000)).isEqualTo(2);
    assertThat(s.status()).isEqualTo("playing");
    assertThat(s.scoring).isNull();
    assertThat(s.clock.running()).isEqualTo(2);
    assertThat(s.turnStartedAt).isEqualTo(T0 + 5000);
    assertThat(s.applyJudge(seq, new int[0], T0)).isFalse();
    assertCode(() -> s.resume(1, T0), "wrong_phase");
    s.pass(2, 4, T0 + 6000);
    assertThat(s.status()).isEqualTo("playing");
    s.pass(1, 5, T0 + 7000);
    assertThat(s.status()).isEqualTo("scoring");
  }

  @Test
  void resign() {
    GameSession s = human();
    s.play(1, 1, 40, T0);
    s.resign(1, T0 + 100);
    assertThat(s.result).isEqualTo(new Result(2, "resign"));
    assertThat(s.counted).isFalse();
    assertCode(() -> s.resign(2, T0), "wrong_phase");
    assertCode(() -> s.play(2, 2, 41, T0), "wrong_phase");

    GameSession sc = human();
    playAll(sc, 40, -1, -1);
    sc.resign(2, T0);
    assertThat(sc.result.winner()).isEqualTo(1);
    assertThat(sc.scoring).isNull();
  }

  @Test
  void countedRule66() {
    GameSession lng = human();
    playAll(lng, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9);
    lng.resign(1, T0);
    assertThat(lng.counted).isTrue();

    GameSession timeout = human();
    playAll(timeout, 0, 1, 2);
    timeout.timeoutLoss(2, T0, "clock");
    assertThat(timeout.counted).isTrue();
    assertThat(timeout.result.reason()).isEqualTo("timeout");
    assertThat(timeout.result.winner()).isEqualTo(1);
    GameSession early = human();
    playAll(early, 0, 1);
    early.resign(1, T0);
    assertThat(early.counted).isTrue();
    assertThat(early.resultView().get("uncounted")).isNull();

    GameSession refuse = human();
    playAll(refuse, 0);
    refuse.resign(2, T0);
    assertThat(refuse.counted).isFalse();
    assertThat(refuse.resultView().get("uncounted")).isEqualTo("short");
    GameSession refuseB = human();
    refuseB.resign(1, T0);
    assertThat(refuseB.counted).isFalse();

    GameSession ab = human();
    playAll(ab, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10);
    ab.abort(T0, null);
    assertThat(ab.counted).isFalse();
    assertThat(ab.resultView().get("text")).isEqualTo("Void");

    GameSession friend = human("friend", TC, SETTINGS);
    playAll(friend, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10);
    friend.resign(2, T0);
    assertThat(friend.counted).isFalse();

    GameSession scored = human();
    playAll(scored, 40, -1, -1);
    scored.applyJudge(scored.judgeToken(), new int[0], T0);
    scored.finishByScore(T0);
    assertThat(scored.counted).isFalse();
    assertThat(scored.resultView().get("uncounted")).isEqualTo("short");
    GameSession full = human();
    playAll(full, concat(WALL, -1, -1));
    full.applyJudge(full.judgeToken(), new int[] {10}, T0);
    full.finishByScore(T0);
    assertThat(full.counted).isTrue();
    assertThat(full.resultView().get("uncounted")).isNull();
    assertThat(friend.resultView().get("uncounted")).isNull();
    assertThat(ab.resultView().get("uncounted")).isNull();
  }

  @Test
  void firstMoveTimeoutVoids() {
    GameSession s = human();
    assertThat(s.nextDeadline()).isEqualTo(T0 + 60000);
    assertThat(s.dueAction(T0 + 59999)).isNull();
    assertThat(s.dueAction(T0 + 60000)).isEqualTo("first_move");
    s.applyDue("first_move", T0 + 60000);
    assertThat(s.result.reason()).isEqualTo("abort");
    assertThat(s.deadlines()).isEmpty();
  }

  @Test
  void byoYomiTimeoutLoses() {
    GameSession s = human("ranked", new TimeControl(1000, 1, 1000), SETTINGS.toBuilder().firstMoveTimeoutMs(999999).build());
    assertThat(s.dueAction(T0 + 2000)).isEqualTo("first_move");
    s.play(1, 1, 40, T0 + 500);
    assertThat(s.nextDeadline()).isEqualTo(T0 + 500 + 2000);
    assertThat(s.dueAction(T0 + 2499)).isNull();
    assertThat(s.dueAction(T0 + 2500)).isEqualTo("timeout");
    s.applyDue("timeout", T0 + 2500);
    assertThat(s.result).isEqualTo(new Result(1, "timeout"));
    assertThat(s.clock.side(2)).isEqualTo(new GameClock.Side(0, 0));
  }

  static GameSession.Deadline abandonOf(GameSession s) {
    return s.deadlines().stream().filter(d -> d.kind().equals("abandon")).findFirst().orElse(null);
  }

  @Test
  void abandonOnlyForSideToPlay() {
    GameSession s = human(new TimeControl(0, 30, 30000));
    s.setOnline(1, true, T0);
    s.setOnline(2, true, T0);
    playAll(s, T0 + 1000, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9);
    s.setOnline(2, false, T0 + 2000);
    assertThat(abandonOf(s)).isNull();
    s.setOnline(1, false, T0 + 3000);
    assertThat(abandonOf(s).at()).isEqualTo(T0 + 3000 + 90000);
    s.setOnline(1, true, T0 + 4000);
    assertThat(abandonOf(s)).isNull();
    s.setOnline(1, false, T0 + 5000);
    assertThat(s.dueAction(T0 + 95000)).isEqualTo("abandon");
    s.applyDue("abandon", T0 + 95000);
    assertThat(s.result).isEqualTo(new Result(2, "timeout"));
    assertThat(s.counted).isTrue();

    GameSession few = human(new TimeControl(30000, 3, 10000));
    few.setOnline(1, true, T0);
    playAll(few, T0, 0);
    long at = abandonOf(few).at();
    assertThat(at).isEqualTo(T0 + 90000);
    few.applyDue("abandon", at);
    assertThat(few.result.reason()).isEqualTo("abort");
    assertThat(few.resultView().get("cause")).isEqualTo("abandon");

    GameSession early = human(new TimeControl(30000, 3, 10000));
    early.setOnline(1, true, T0);
    playAll(early, T0, 0, 1, 2);
    early.applyDue("abandon", abandonOf(early).at());
    assertThat(early.result.reason()).isEqualTo("timeout");
    assertThat(early.resultView().get("cause")).isEqualTo("abandon");
    assertThat(early.counted).isTrue();
  }

  @Test
  void offlineBeforeTurnCountsFromTurnStart() {
    GameSession s = human(new TimeControl(30000, 3, 10000));
    s.setOnline(1, true, T0);
    s.setOnline(2, false, T0);
    s.play(1, 1, 40, T0 + 30000);
    assertThat(abandonOf(s).at()).isEqualTo(T0 + 30000 + 90000);
  }

  @Test
  void scoringDeadlineAndAiIdle() {
    GameSession s = human();
    playAll(s, concat(WALL, -1, -1));
    assertThat(s.nextDeadline()).isNull();
    s.applyJudge(s.judgeToken(), new int[] {10}, T0 + 1000);
    assertThat(s.nextDeadline()).isEqualTo(T0 + 181000);
    assertThat(s.dueAction(T0 + 181000)).isEqualTo("scoring");
    s.applyDue("scoring", T0 + 181000);
    assertThat(s.result.reason()).isEqualTo("score");
    assertThat(s.result.winner()).isEqualTo(1);

    GameSession a = aiGame(1);
    assertThat(a.deadlines()).containsExactly(new GameSession.Deadline("idle", T0 + 86400000));
    a.touch(T0 + 5000);
    assertThat(a.nextDeadline()).isEqualTo(T0 + 5000 + 86400000);
    assertThat(a.dueAction(T0 + 5000 + 86400000)).isEqualTo("idle");
    a.applyDue("idle", T0 + 5000 + 86400000);
    assertThat(a.result.reason()).isEqualTo("abort");
  }

  @Test
  void aiUndo() {
    GameSession s = aiGame(1);
    assertThat(s.canUndo()).isFalse();
    assertCode(() -> s.undo(1, T0), "nothing_to_undo");
    s.play(1, 1, 40, T0);
    s.play(2, 2, 0, T0);
    assertThat(s.canUndo()).isTrue();
    int v = s.version;
    assertThat(s.undo(1, T0)).isEmpty();
    assertThat(s.toPlay()).isEqualTo(1);
    assertThat(s.version).isGreaterThan(v);
    assertThat(s.canUndo()).isFalse();

    GameSession b = aiGame(2); // AI 执黑
    b.play(1, 1, 40, T0);
    assertThat(b.canUndo()).isFalse();
    assertCode(() -> b.undo(2, T0), "nothing_to_undo");
    b.play(2, 2, 41, T0);
    b.aiThinking = true;
    assertThat(b.undo(2, T0)).containsExactly(40);
    assertThat(b.aiThinking).isFalse();
    assertThat(b.toPlay()).isEqualTo(2);

    GameSession c = aiGame(1);
    playAll(c, 40, 0, -1, -1);
    assertThat(c.status()).isEqualTo("scoring");
    assertThat(c.undo(1, T0)).containsExactly(40, 0);
    assertThat(c.status()).isEqualTo("playing");
    assertThat(c.scoring).isNull();
    assertThat(c.toPlay()).isEqualTo(1);

    GameSession t = aiGame(1);
    playAll(t, 40, -1, -1);
    assertThat(t.undo(1, T0)).containsExactly(40, -1);
    assertThat(t.status()).isEqualTo("playing");
    assertThat(t.toPlay()).isEqualTo(1);
    assertThat(t.humanJustPassed()).isFalse();
  }

  @Test
  void humanCannotUndoAiCannotToggle() {
    GameSession h = human();
    h.play(1, 1, 40, T0);
    assertCode(() -> h.undo(1, T0), "bad_request");
    GameSession a = aiGame(1);
    playAll(a, 40, -1, -1);
    a.applyJudge(a.judgeToken(), new int[0], T0);
    assertThat(a.scoring.accepted[2]).isTrue();
    assertThat(a.scoring.deadlineAt).isNull();
    assertCode(() -> a.toggleDead(1, 40, T0, null), "bad_request");
    assertThat(a.accept(1, 1, T0)).isTrue();
    a.finishByScore(T0);
    assertCode(() -> a.undo(1, T0), "wrong_phase");
    assertThat(a.canUndo()).isFalse();
    assertThat(a.counted).isFalse();
  }

  @Test
  void humanJustPassed() {
    GameSession s = aiGame(2);
    s.play(1, 1, 40, T0);
    s.pass(2, 2, T0);
    assertThat(s.humanJustPassed()).isTrue();
    s.pass(1, 3, T0);
    s.resume(2, T0);
    assertThat(s.toPlay()).isEqualTo(2);
    s.pass(2, 4, T0);
    assertThat(s.humanJustPassed()).isTrue();
  }

  @Test
  void presence() {
    GameSession a = aiGame(1);
    assertThat(a.setOnline(2, false, T0)).isFalse();
    assertThat(a.online[2]).isTrue();
    assertThat(a.setOnline(1, true, T0)).isTrue();
    assertThat(a.setOnline(1, true, T0)).isFalse();
    assertThat(a.setOnline(3, true, T0)).isFalse();
  }

  @Test
  void snapshotShape() {
    GameSession s = human();
    s.setOnline(1, true, T0);
    s.play(1, 1, 40, T0 + 1000);
    Map<String, Object> players =
        Msg.byColor(Msg.of("userId", 1, "nickname", "A", "avatarUrl", ""), Msg.of("userId", 2, "nickname", "B", "avatarUrl", ""));
    Map<String, Object> snap = s.snapshot(2, T0 + 3000, players);
    assertThat(json(snap))
        .isEqualTo("{\"id\":\"g00000000001\",\"mode\":\"ranked\",\"size\":9,\"komi\":7.5,"
            + "\"players\":{\"1\":{\"userId\":1,\"nickname\":\"A\",\"avatarUrl\":\"\"},\"2\":{\"userId\":2,\"nickname\":\"B\",\"avatarUrl\":\"\"}},"
            + "\"myColor\":2,\"moves\":[40],\"status\":\"playing\",\"toPlay\":2,"
            + "\"timeControl\":{\"mainMs\":60000,\"periods\":3,\"periodMs\":10000},"
            + "\"clocks\":{\"1\":{\"mainMs\":59000,\"periodsLeft\":3,\"periodMs\":10000},\"2\":{\"mainMs\":58000,\"periodsLeft\":3,\"periodMs\":10000},\"running\":2},"
            + "\"scoring\":null,\"result\":null,\"presence\":{\"1\":true,\"2\":false},\"aiThinking\":false,\"canUndo\":false}");
    Ctx.list(snap.get("moves")).add(1);
    assertThat(s.moves).containsExactly(40);
  }

  @Test
  void replayMoves() {
    var st = GameSession.replayMoves(9, 7.5, List.of(40, -1, -1, 41, 42));
    assertThat(st.status).isEqualTo("playing");
    assertThat(st.board.get(41)).isEqualTo(2);
    assertThat(st.board.get(42)).isEqualTo(1);
    assertThat(GameSession.replayMoves(9, 7.5, List.of(40, -1, -1)).status).isEqualTo("scoring");
    assertThatThrownBy(() -> GameSession.replayMoves(9, 7.5, List.of(40, 40)))
        .isInstanceOfSatisfying(GameSession.ReplayException.class, e -> assertThat(e.moveIndex).isEqualTo(1));
    assertThatThrownBy(() -> GameSession.replayMoves(9, 7.5, List.of(81)))
        .isInstanceOfSatisfying(GameSession.ReplayException.class, e -> assertThat(e.moveIndex).isEqualTo(0));
  }

  // ---------------------------------------------------------------- fromRow

  /** GameRow 构建器（字段同 games 表）。 */
  static final class RowB {
    String id = "g00000000001";
    String mode = "ranked";
    int size = 9;
    double komi = 7.5;
    Long blackId = 1L;
    Long whiteId = 2L;
    String aiLevel;
    TimeControl timeControl = TC;
    String status = "playing";
    List<Integer> moves = List.of();
    JsonNode clocks;
    List<Integer> dead;
    Integer winner;
    String reason;
    Double scoreBlack;
    Double scoreWhite;
    boolean counted;
    JsonNode state;
    String cause;
    long createdAt = 1;
    long updatedAt = 2;
    Long endedAt;

    static RowB of(GameSession s) {
      RowB r = new RowB();
      r.id = s.id;
      r.mode = s.mode;
      r.size = s.size;
      r.komi = s.komi;
      r.blackId = s.players[1];
      r.whiteId = s.players[2];
      r.aiLevel = s.aiLevel;
      r.timeControl = s.timeControl;
      r.status = s.status();
      r.moves = List.copyOf(s.moves);
      r.clocks = s.clock == null ? null : Json.tree(s.clock.toJson());
      r.createdAt = s.createdAt;
      r.updatedAt = T0;
      return r;
    }

    RowB progress(GameSession s) {
      GameSession.Progress p = s.progress();
      status = p.status();
      moves = p.moves();
      clocks = p.clocks() == null ? null : Json.tree(p.clocks());
      state = p.state() == null ? null : Json.tree(p.state());
      return this;
    }

    GameRow build() {
      return new GameRow(id, mode, size, komi, blackId, whiteId, aiLevel, timeControl, status, moves, clocks, dead, winner, reason,
          scoreBlack, scoreWhite, null, counted, state, cause, createdAt, updatedAt, endedAt);
    }
  }

  @Test
  void fromRowRestoresClocksWithoutDowntime() {
    GameSession s = human();
    s.play(1, 1, 40, T0 + 20000);
    s.play(2, 2, 41, T0 + 30000);
    RowB rb = RowB.of(s).progress(s);
    rb.updatedAt = T0 + 30000;
    long later = T0 + 10L * 3600 * 1000;
    GameSession r = GameSession.fromRow(rb.build(), SETTINGS, later);
    assertThat(r.moves).containsExactly(40, 41);
    assertThat(r.status()).isEqualTo("playing");
    assertThat(r.toPlay()).isEqualTo(1);
    assertThat(r.clock.running()).isEqualTo(1);
    assertThat(r.clock.side(1)).isEqualTo(new GameClock.Side(40000, 3));
    assertThat(r.clock.side(2)).isEqualTo(new GameClock.Side(50000, 3));
    assertThat(r.clock.timeoutAt()).isEqualTo(later + 70000);
    assertThat(r.online[1]).isFalse();
    assertThat(r.online[2]).isFalse();
    assertThat(r.startedAt).isEqualTo(later);
  }

  @Test
  void fromRowResumedOrScoring() {
    GameSession s = human();
    playAll(s, 40, -1, -1);
    RowB a = RowB.of(s);
    a.status = "playing";
    a.moves = List.of(40, -1, -1);
    GameSession resumed = GameSession.fromRow(a.build(), SETTINGS, T0);
    assertThat(resumed.status()).isEqualTo("playing");
    assertThat(resumed.toPlay()).isEqualTo(2);
    RowB b = RowB.of(s);
    b.status = "scoring";
    b.moves = List.of(40, -1, -1);
    GameSession scoring = GameSession.fromRow(b.build(), SETTINGS, T0);
    assertThat(scoring.status()).isEqualTo("scoring");
    assertThat(scoring.scoring.pending).isTrue();
    assertThat(scoring.clock.running()).isEqualTo(0);
    assertThat(scoring.judgeToken()).isNotNull();
  }

  @Test
  void fromRowEndedAndAi() {
    GameSession s = human();
    playAll(s, concat(WALL, -1, -1));
    RowB rb = RowB.of(s);
    rb.status = "ended";
    rb.dead = List.of(10);
    rb.winner = 1;
    rb.reason = "score";
    rb.scoreBlack = 45.0;
    rb.scoreWhite = 43.5;
    rb.counted = true;
    rb.endedAt = T0 + 5;
    GameSession ended = GameSession.fromRow(rb.build(), SETTINGS, T0 + 100);
    assertThat(ended.status()).isEqualTo("ended");
    Map<String, Object> snap = ended.snapshot(1, T0 + 100, Msg.of());
    assertThat(map(snap.get("result")).get("text")).isEqualTo("B+1.5");
    assertThat(map(snap.get("result")).get("counted")).isEqualTo(true);
    assertThat(map(snap.get("scoring")).get("dead")).isEqualTo(List.of(10));
    assertThat(json(map(snap.get("scoring")).get("accepted"))).isEqualTo("{\"1\":true,\"2\":true}");
    assertThat(map(snap.get("scoring")).get("deadline")).isNull();
    assertThat(map(snap.get("clocks")).get("running")).isNull();
    assertThat(ended.deadlines()).isEmpty();

    GameSession a = aiGame(1);
    a.play(1, 1, 40, T0);
    RowB ar = RowB.of(a);
    ar.moves = List.of(40);
    ar.updatedAt = T0 + 7;
    GameSession restored = GameSession.fromRow(ar.build(), SETTINGS, T0 + 1000);
    assertThat(restored.lastActivityAt).isEqualTo(T0 + 7);
    assertThat(restored.aiColor).isEqualTo(2);
    assertThat(restored.toPlay()).isEqualTo(2);
    assertThat(restored.clock).isNull();

    RowB bad = RowB.of(human());
    bad.moves = List.of(40, 40);
    assertThatThrownBy(() -> GameSession.fromRow(bad.build(), SETTINGS, T0)).isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void persistenceFields() {
    GameSession s = human();
    GameSession.InsertRow row = s.insertRow(T0);
    assertThat(row.blackId()).isEqualTo(1L);
    assertThat(row.whiteId()).isEqualTo(2L);
    assertThat(row.aiLevel()).isNull();
    assertThat(row.timeControl()).isEqualTo(TC);
    assertThat(row.status()).isEqualTo("playing");
    assertThat(row.moves()).isEmpty();
    assertThat(row.clocks().get("running")).isEqualTo(1);
    s.play(1, 1, 40, T0 + 1000);
    assertThat(json(s.progress()))
        .isEqualTo("{\"status\":\"playing\",\"moves\":[40],"
            + "\"clocks\":{\"1\":{\"mainMs\":59000,\"periodsLeft\":3,\"periodMs\":10000},\"2\":{\"mainMs\":60000,\"periodsLeft\":3,\"periodMs\":10000},\"running\":2},"
            + "\"state\":{\"resumesUsed\":{\"1\":0,\"2\":0},\"guard\":null}}");
    s.resign(2, T0 + 2000);
    assertThat(s.finishFields())
        .isEqualTo(new GameSession.FinishFields(List.of(40), null, 1, "resign", null, null, "B+R", false, null));
    assertThat(aiGame(2).progress().state()).isNull();
    GameSession.InsertRow a = aiGame(2).insertRow(T0);
    assertThat(a.blackId()).isNull();
    assertThat(a.whiteId()).isEqualTo(1L);
    assertThat(a.aiLevel()).isEqualTo("k10");
    assertThat(a.timeControl()).isNull();
    assertThat(a.clocks()).isNull();
  }

  // ---------------------------------------------------------------- fairness.test.js

  @Test
  void resumeLimitPerSide() {
    GameSession s = scoredGame();
    assertThat(json(s.scoringView(T0).get("resumesLeft"))).isEqualTo("{\"1\":1,\"2\":1}");
    s.resume(2, T0 + 1000);
    playAll(s, T0 + 2000, -1, -1);
    assertThat(s.status()).isEqualTo("scoring");
    assertThat(s.cachedJudge()).containsExactly(10);
    s.applyJudge(s.judgeToken(), s.cachedJudge(), T0 + 2000);
    assertThat(json(s.scoringView(T0 + 2000).get("resumesLeft"))).isEqualTo("{\"1\":1,\"2\":0}");
    GameError e = (GameError) catchThrown(() -> s.resume(2, T0 + 3000));
    assertThat(e.code()).isEqualTo("wrong_phase");
    assertThat(e.msg()).contains("继续对局");
    s.resume(1, T0 + 4000);
    playAll(s, T0 + 5000, -1, -1);
    s.applyJudge(s.judgeToken(), new int[] {10}, T0 + 5000);
    assertCode(() -> s.resume(1, T0 + 6000), "wrong_phase");
    assertCode(() -> s.resume(2, T0 + 6000), "wrong_phase");
    assertThat(s.dueAction(T0 + 5000 + 180000)).isEqualTo("scoring");
    s.applyDue("scoring", T0 + 5000 + 180000);
    assertThat(s.result).isEqualTo(B_WINS);

    GameSession zero = scoredGame(TC, SETTINGS.toBuilder().resumeLimit(0).build());
    assertCode(() -> zero.resume(1, T0), "wrong_phase");

    GameSession ai = new GameSession("a00000000001", "ai", 9, 7.5, 1L, null, "k10", null, SETTINGS, T0, null);
    for (int i = 0; i < 3; i++) {
      playAll(ai, -1, -1);
      ai.applyJudge(ai.judgeToken(), new int[0], T0);
      assertThat(ai.scoringView(T0).get("resumesLeft")).isNull();
      ai.resume(1, T0);
    }
  }

  @Test
  void resumeNeedsOpponentOnline() {
    GameSession s = scoredGame();
    s.setOnline(1, false, T0 + 1000);
    GameError e = (GameError) catchThrown(() -> s.resume(2, T0 + 1000));
    assertThat(e.msg()).contains("对手不在线");
    assertThat(s.status()).isEqualTo("scoring");
    s.setOnline(1, true, T0 + 2000);
    s.resume(2, T0 + 2000);
    assertThat(s.status()).isEqualTo("playing");
  }

  @Test
  void resumeGuardUndoesResume() {
    TimeControl byo = new TimeControl(0, 10, 30000);
    GameSession s = scoredGame(byo, SETTINGS);
    s.accept(1, 1, T0 + 1000);
    s.resume(2, T0 + 2000);
    assertThat(s.toPlay()).isEqualTo(1);
    s.setOnline(1, false, T0 + 7000);
    GameSession.Deadline due = abandonOf(s);
    assertThat(due.at()).isEqualTo(T0 + 7000 + 90000);
    assertThat(s.dueAction(due.at())).isEqualTo("abandon");
    s.applyDue("abandon", due.at());
    assertThat(s.result).isEqualTo(B_WINS);
    assertThat(s.counted).isTrue();
    assertThat(s.resumeUndone).isTrue();
    assertThat(s.moves).containsExactlyElementsOf(Msg.list(concat(WALL, -1, -1)));
    assertThat(s.finishFields().dead()).containsExactly(10);

    GameSession w = online(human(byo));
    playAll(w, concat(WALL, 36, -1, -1));
    w.applyJudge(w.judgeToken(), new int[] {10}, T0);
    w.accept(1, 1, T0);
    w.resume(2, T0 + 1000);
    assertThat(w.toPlay()).isEqualTo(2);
    w.pass(2, w.moves.size() + 1, T0 + 2000);
    w.setOnline(1, false, T0 + 3000);
    w.applyDue(w.dueAction(T0 + 3000 + 90000), T0 + 3000 + 90000);
    assertThat(w.result.reason()).isEqualTo("score");
    assertThat(w.result.winner()).isEqualTo(1);
    assertThat(w.moves).containsExactlyElementsOf(Msg.list(concat(WALL, 36, -1, -1)));

    GameSession t = online(human(new TimeControl(0, 1, 20000)));
    playAll(t, concat(WALL, -1, -1));
    t.applyJudge(t.judgeToken(), new int[] {10}, T0);
    t.accept(1, 1, T0);
    t.resume(2, T0);
    t.setOnline(1, false, T0 + 1000);
    assertThat(t.dueAction(T0 + 20000)).isEqualTo("timeout");
    t.applyDue("timeout", T0 + 20000);
    assertThat(t.result.reason()).isEqualTo("score");

    GameSession back = scoredGame(byo, SETTINGS);
    back.accept(1, 1, T0);
    back.resume(2, T0);
    back.play(1, back.moves.size() + 1, 36, T0 + 1000);
    back.pass(2, back.moves.size() + 1, T0 + 2000);
    back.setOnline(1, false, T0 + 3000);
    back.applyDue("abandon", T0 + 3000 + 90000);
    assertThat(back.result.reason()).isEqualTo("timeout");
    assertThat(back.result.winner()).isEqualTo(2);

    GameSession none = scoredGame();
    none.resume(2, T0);
    assertThat(none.resumeGuard).isNull();
  }

  @Test
  void lastSecondUnilateralToggleDoesNotDecide() {
    GameSession s = scoredGame();
    s.accept(1, 1, T0 + 1000);
    long at = T0 + 179900;
    s.toggleDead(2, 4, at, null);
    assertThat(s.scoring.winner).isEqualTo(2);
    assertThat(s.scoring.accepted[1]).isFalse();
    assertThat(s.scoringView(at).get("deadline")).isEqualTo(60000L);
    assertThat(s.dueAction(T0 + 180000)).isNull();
    assertThat(s.dueAction(at + 60000)).isEqualTo("scoring");
    s.applyDue("scoring", at + 60000);
    assertThat(s.result).isEqualTo(B_WINS);
    assertThat(s.finishFields().dead()).containsExactly(10);
    assertThat(s.scoring.version).isEqualTo(3);
  }

  @Test
  void deadlineFallbackRules() {
    GameSession off = scoredGame();
    off.setOnline(1, false, T0 + 5000);
    off.toggleDead(2, 4, T0 + 6000, null);
    off.toggleDead(2, 72, T0 + 7000, null);
    off.applyDue("scoring", off.nextDeadline());
    assertThat(off.result).isEqualTo(B_WINS);

    GameSession agreed = scoredGame();
    agreed.toggleDead(2, 10, T0 + 1000, null);
    agreed.accept(1, 2, T0 + 2000);
    assertThat(agreed.scoring.accepted[1]).isTrue();
    assertThat(agreed.scoring.accepted[2]).isFalse();
    agreed.applyDue("scoring", agreed.nextDeadline());
    assertThat(agreed.result.winner()).isEqualTo(2);
    assertThat(agreed.finishFields().dead()).isEmpty();

    GameSession back = scoredGame();
    back.toggleDead(2, 10, T0 + 1000, null);
    back.accept(1, 2, T0 + 2000);
    back.toggleDead(2, 4, T0 + 3000, null);
    back.applyDue("scoring", back.nextDeadline());
    assertThat(back.finishFields().dead()).isEmpty();
    assertThat(back.result.winner()).isEqualTo(2);

    GameSession undo = scoredGame();
    undo.toggleDead(2, 4, T0 + 1000, null);
    undo.toggleDead(1, 4, T0 + 2000, null);
    undo.applyDue("scoring", undo.nextDeadline());
    assertThat(undo.result).isEqualTo(B_WINS);

    GameSession manual = online(human());
    playAll(manual, concat(WALL, -1, -1));
    manual.applyJudge(manual.judgeToken(), null, T0);
    manual.toggleDead(1, 10, T0 + 1000, null);
    assertThat(json(manual.scoringView(T0 + 1000).get("atDeadline"))).isEqualTo("{\"void\":true,\"cause\":\"score_dispute\"}");
    manual.applyDue("scoring", manual.nextDeadline());
    assertThat(manual.result.reason()).isEqualTo("abort");
    assertThat(manual.resultView().get("cause")).isEqualTo("score_dispute");
    assertThat(manual.counted).isFalse();
  }

  @Test
  void toggleExtendsDeadlineButCapped() {
    GameSession s = scoredGame();
    long t = T0;
    for (int i = 0; i < 20; i++) {
      t += 30000;
      s.toggleDead(i % 2 == 1 ? 1 : 2, 10, t, null);
    }
    assertThat(s.nextDeadline()).isEqualTo(T0 + 360000);
  }

  static RowB restoredRow(int... moves) {
    RowB r = new RowB();
    r.id = "r00000000001";
    r.size = 19;
    r.timeControl = new TimeControl(600000, 3, 30000);
    r.moves = Msg.list(moves);
    try {
      r.clocks = Json.parse("{\"running\":1,\"1\":{\"mainMs\":500000,\"periodsLeft\":3,\"periodMs\":30000},\"2\":{\"mainMs\":550000,\"periodsLeft\":3,\"periodMs\":30000}}");
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
    return r;
  }

  static final int[] TWELVE = {0, 18, 1, 17, 2, 16, 3, 15, 4, 14, 5, 13};

  @Test
  void restoredNobodyBackVoids() {
    long t1 = T0 + 20 * 60000;
    GameSession s = GameSession.fromRow(restoredRow(TWELVE).build(), SETTINGS, t1);
    s.expectArrival(t1);
    assertThat(s.clock.running()).isEqualTo(0);
    assertThat(s.deadlines()).containsExactly(new GameSession.Deadline("abandon", t1 + 300000));
    assertThat(s.dueAction(t1 + 299999)).isNull();
    s.applyDue(s.dueAction(t1 + 300000), t1 + 300000);
    assertThat(s.result.reason()).isEqualTo("abort");
    assertThat(s.counted).isFalse();
  }

  @Test
  void restoredClockStartsOnArrival() {
    long t1 = T0 + 60000;
    GameSession s = GameSession.fromRow(restoredRow(TWELVE).build(), SETTINGS, t1);
    s.expectArrival(t1);
    s.setOnline(1, true, t1 + 100000);
    assertThat(s.clock.running()).isEqualTo(1);
    assertThat(map(s.clocksView(t1 + 100000).get("1")).get("mainMs")).isEqualTo(500000L);
    s.play(1, 13, 100, t1 + 110000);
    assertThat(s.clock.running()).isEqualTo(0);
    assertThat(s.clock.side(1).mainMs()).isEqualTo(490000);
    assertThat(abandonOf(s).at()).isEqualTo(t1 + 110000 + 300000);
    s.setOnline(2, true, t1 + 120000);
    assertThat(s.arrival).isNull();
    assertThat(s.clock.running()).isEqualTo(2);
    s.setOnline(2, false, t1 + 130000);
    GameSession.Deadline ab2 = abandonOf(s);
    assertThat(ab2.at()).isEqualTo(t1 + 120000 + 550000);
    s.applyDue("abandon", ab2.at());
    assertThat(s.result.reason()).isEqualTo("timeout");
    assertThat(s.counted).isTrue();
  }

  @Test
  void friendRoomOwnerOffline() {
    GameSession s = new GameSession("f00000000001", "friend", 9, 7.5, 1L, 2L, null, TC, SETTINGS, T0, null);
    s.setOnline(2, true, T0);
    s.expectArrival(T0);
    assertThat(s.awaitingArrival(1)).isTrue();
    assertThat(s.clock.running()).isEqualTo(0);
    assertThat(s.deadlines().stream().anyMatch(d -> d.kind().equals("first_move"))).isFalse();
    assertThat(s.dueAction(T0 + 60000)).isNull();
    s.setOnline(1, true, T0 + 120000);
    assertThat(s.clock.running()).isEqualTo(1);
    assertThat(s.deadlines()).contains(new GameSession.Deadline("first_move", T0 + 120000 + 60000));

    GameSession w = new GameSession("f00000000002", "friend", 9, 7.5, 2L, 1L, null, TC, SETTINGS, T0, null);
    w.setOnline(1, true, T0);
    w.expectArrival(T0);
    w.play(1, 1, 40, T0 + 5000);
    assertThat(w.clock.running()).isEqualTo(0);
    assertThat(w.dueAction(T0 + 5000 + 90000)).isNull();
    w.applyDue(w.dueAction(T0 + 5000 + 300000), T0 + 5000 + 300000);
    assertThat(w.result.reason()).isEqualTo("abort");
  }

  @Test
  void offlineWaitsForMainTime() {
    GameSession s = online(new GameSession("g", "ranked", 19, 7.5, 1L, 2L, null, new TimeControl(600000, 3, 30000), SETTINGS, T0, null));
    playAll(s, T0, TWELVE);
    s.setOnline(1, false, T0 + 1000);
    assertThat(abandonOf(s).at()).isEqualTo(T0 + 600000);
    assertThat(s.dueAction(T0 + 121000)).isNull();
    s.setOnline(1, true, T0 + 121000);
    s.play(1, 13, 100, T0 + 122000);
    assertThat(s.status()).isEqualTo("playing");
    assertThat(s.clock.side(1).mainMs()).isEqualTo(600000 - 122000);

    GameSession byo = online(human(new TimeControl(0, 5, 30000)));
    int[] m = new int[TWELVE.length];
    for (int i = 0; i < m.length; i++) m[i] = TWELVE[i] % 81;
    playAll(byo, T0, m);
    byo.setOnline(1, false, T0 + 1000);
    assertThat(abandonOf(byo).at()).isEqualTo(T0 + 1000 + 90000);
  }

  @Test
  void aiManualScoringCanToggle() {
    GameSession m = new GameSession("a00000000001", "ai", 9, 7.5, 1L, null, "k10", null, SETTINGS, T0, null);
    playAll(m, concat(WALL, -1, -1));
    m.applyJudge(m.judgeToken(), null, T0);
    assertThat(m.scoring.source).isEqualTo("manual");
    assertThat(m.scoring.winner).isEqualTo(2);
    assertThat(m.toggleDead(1, 10, T0, null)).isTrue();
    assertThat(m.scoring.dead).containsExactly(10);
    assertThat(m.scoring.accepted[1]).isFalse();
    assertThat(m.scoring.accepted[2]).isTrue();
    assertThat(m.scoringView(T0).get("deadline")).isNull();
    assertThat(m.nextDeadline()).isEqualTo(T0 + 86400000);
    assertThat(m.accept(1, 2, T0)).isTrue();
    m.finishByScore(T0);
    assertThat(m.result.winner()).isEqualTo(1);

    GameSession k = new GameSession("a00000000001", "ai", 9, 7.5, 1L, null, "k10", null, SETTINGS, T0, null);
    playAll(k, concat(WALL, -1, -1));
    k.applyJudge(k.judgeToken(), new int[] {10}, T0);
    assertCode(() -> k.toggleDead(1, 10, T0, null), "bad_request");
  }

  @Test
  void judgeCache() {
    GameSession s = scoredGame();
    assertThat(s.cachedJudge()).containsExactly(10);
    s.resume(2, T0);
    s.play(1, s.moves.size() + 1, 36, T0);
    assertThat(s.cachedJudge()).isNull();
    GameSession m = online(human());
    playAll(m, concat(WALL, -1, -1));
    m.applyJudge(m.judgeToken(), null, T0);
    assertThat(m.cachedJudge()).isNull();
  }

  @Test
  void fs1ManualBeneficiaryOfflineVoids() {
    GameSession s = manualGame(TC);
    s.setOnline(2, false, T0 + 1000);
    s.toggleDead(1, 10, T0 + 2000, null);
    s.accept(1, s.scoring.version, T0 + 3000);
    GameError e = (GameError) catchThrown(() -> s.resume(1, T0 + 4000));
    assertThat(e.msg()).contains("对手不在线");
    long at = s.nextDeadline();
    s.applyDue(s.dueAction(at), at);
    assertThat(s.result.reason()).isEqualTo("abort");
    assertThat(s.resultView().get("cause")).isEqualTo("score_dispute");
    assertThat(s.counted).isFalse();
  }

  @Test
  void fs1ManualResumeUndoneVoids() {
    GameSession s = manualGame(new TimeControl(0, 10, 30000));
    s.accept(2, 1, T0 + 1000);
    s.resume(1, T0 + 2000);
    assertThat(s.resumeGuard).isNotNull();
    s.play(1, s.moves.size() + 1, 19, T0 + 3000);
    s.setOnline(2, false, T0 + 4000);
    s.applyDue("abandon", abandonOf(s).at());
    assertThat(s.resumeUndone).isTrue();
    assertThat(s.result.reason()).isEqualTo("abort");
    assertThat(s.resultView().get("cause")).isEqualTo("score_dispute");
    assertThat(s.counted).isFalse();
  }

  @Test
  void fs1ManualNoObjectionOrBothEndorsed() {
    GameSession quiet = manualGame(TC);
    quiet.accept(2, 1, T0 + 1000);
    assertThat(json(quiet.scoringView(T0 + 1000).get("atDeadline")))
        .isEqualTo("{\"void\":false,\"dead\":[],\"black\":10,\"white\":44.5,\"winner\":2,\"same\":true}");
    quiet.applyDue("scoring", quiet.nextDeadline());
    assertThat(quiet.result.reason()).isEqualTo("score");
    assertThat(quiet.result.winner()).isEqualTo(2);

    GameSession both = manualGame(TC);
    both.toggleDead(1, 10, T0 + 1000, null);
    both.accept(2, 2, T0 + 2000);
    both.toggleDead(1, 72, T0 + 3000, null);
    both.toggleDead(1, 72, T0 + 4000, null);
    both.accept(1, both.scoring.version, T0 + 5000);
    assertThat(both.scoring.accepted[2]).isFalse();
    both.applyDue("scoring", both.nextDeadline());
    assertThat(both.result).isEqualTo(B_WINS);
    assertThat(both.resultView().get("cause")).isEqualTo("deadline");
  }

  @Test
  void fs1ManualRestartNobodyBack() {
    RowB rb = new RowB();
    rb.id = "m00000000001";
    rb.status = "scoring";
    rb.moves = Msg.list(concat(WALL, -1, -1));
    GameSession s = GameSession.fromRow(rb.build(), SETTINGS, T0);
    s.expectArrival(T0);
    s.applyJudge(s.judgeToken(), null, T0);
    assertThat(json(s.scoringView(T0).get("atDeadline"))).isEqualTo("{\"void\":true,\"cause\":\"arrival\"}");
    s.applyDue("scoring", s.nextDeadline());
    assertThat(s.result.reason()).isEqualTo("abort");
    assertThat(s.resultView().get("cause")).isEqualTo("arrival");
    assertThat(s.counted).isFalse();
  }

  @Test
  void fs2ToggleOnOpponentsChangeNotEndorsed() {
    GameSession race = manualGame(TC);
    race.toggleDead(2, 4, T0 + 1000, null);
    race.toggleDead(1, 10, T0 + 1100, null);
    race.accept(2, race.scoring.version, T0 + 1200);
    assertThat(race.scoring.agreed).isNull();
    race.toggleDead(1, 4, T0 + 3000, null);
    assertThat(race.scoring.dead).containsExactly(10);
    race.applyDue("scoring", race.nextDeadline());
    assertThat(race.result.winner()).isNotEqualTo(2);
    assertThat(race.result.reason()).isEqualTo("abort");

    GameSession k = scoredGame();
    k.toggleDead(2, 4, T0 + 1000, null);
    k.toggleDead(2, 72, T0 + 2000, null);
    k.toggleDead(1, 72, T0 + 3000, null);
    k.accept(2, k.scoring.version, T0 + 4000);
    assertThat(k.scoring.agreed).isNull();
    k.toggleDead(1, 4, T0 + 5000, null);
    k.accept(1, k.scoring.version, T0 + 6000);
    k.applyDue("scoring", k.nextDeadline());
    assertThat(k.result).isEqualTo(B_WINS);

    GameSession m = manualGame(TC);
    m.toggleDead(2, 4, T0 + 1000, null);
    m.toggleDead(2, 72, T0 + 2000, null);
    m.toggleDead(1, 72, T0 + 3000, null);
    m.accept(2, m.scoring.version, T0 + 4000);
    m.toggleDead(1, 4, T0 + 5000, null);
    m.toggleDead(1, 10, T0 + 6000, null);
    m.accept(1, m.scoring.version, T0 + 7000);
    m.applyDue("scoring", m.nextDeadline());
    assertThat(m.result.reason()).isEqualTo("abort");
  }

  @Test
  void fs2ToggleVersionAndAtDeadline() {
    GameSession s = scoredGame();
    assertCode(() -> s.toggleDead(2, 4, T0 + 1000, 5), "stale");
    assertThat(s.scoring.version).isEqualTo(1);
    s.toggleDead(2, 4, T0 + 1000, 1);
    assertThat(s.scoring.version).isEqualTo(2);
    Map<String, Object> v = s.scoringView(T0 + 1000);
    assertThat(v.get("winner")).isEqualTo(2);
    assertThat(json(v.get("atDeadline"))).isEqualTo("{\"void\":false,\"dead\":[10],\"black\":45,\"white\":43.5,\"winner\":1,\"same\":false}");
    s.accept(1, 2, T0 + 2000);
    assertThat(map(s.scoringView(T0 + 2000).get("atDeadline")).get("same")).isEqualTo(true);
    s.accept(2, 2, T0 + 3000);
    s.finishByScore(T0 + 3000);
    assertThat(s.scoringView(T0 + 3000).get("atDeadline")).isNull();
  }

  @Test
  void fs3OnlineButClockRunsOutUndoesResume() {
    GameSession s = scoredGame(new TimeControl(0, 3, 20000), SETTINGS);
    s.accept(1, 1, T0 + 1000);
    s.resume(2, T0 + 2000);
    assertThat(s.toPlay()).isEqualTo(1);
    assertThat(s.online[1]).isTrue();
    long at = s.deadlines().stream().filter(d -> d.kind().equals("timeout")).findFirst().orElseThrow().at();
    assertThat(s.dueAction(at)).isEqualTo("timeout");
    s.applyDue("timeout", at);
    assertThat(s.result).isEqualTo(B_WINS);
    assertThat(s.resultView().get("cause")).isEqualTo("resume_undone");
    assertThat(s.counted).isTrue();
  }

  @Test
  void fs11GuardedOfflineAfterAbandonMs() {
    GameSession s = scoredGame(new TimeControl(600000, 3, 30000), SETTINGS);
    s.accept(1, 1, T0);
    s.resume(2, T0 + 1000);
    s.setOnline(1, false, T0 + 7000);
    assertThat(abandonOf(s).at()).isEqualTo(T0 + 7000 + 90000);
    s.applyDue(s.dueAction(T0 + 97000), T0 + 97000);
    assertThat(s.result).isEqualTo(B_WINS);
    GameSession n = scoredGame(new TimeControl(600000, 3, 30000), SETTINGS);
    n.resume(2, T0 + 1000);
    n.setOnline(1, false, T0 + 7000);
    assertThat(abandonOf(n).at()).isGreaterThan(T0 + 500000);
  }

  @Test
  void fs67ResumeStatePersists() throws Exception {
    GameSession s = scoredGame(new TimeControl(0, 10, 30000), SETTINGS);
    s.accept(1, 1, T0);
    s.resume(2, T0 + 1000);
    Map<String, Object> st = s.progress().state();
    assertThat(json(st.get("resumesUsed"))).isEqualTo("{\"1\":0,\"2\":1}");
    assertThat(map(st.get("guard")).get("color")).isEqualTo(1);
    assertThat(map(st.get("guard")).get("movesLen")).isEqualTo(WALL.length + 2);
    RowB rb = RowB.of(s).progress(s);
    rb.state = Json.parse(json(st));
    long t1 = T0 + 600000;
    GameSession r = GameSession.fromRow(rb.build(), SETTINGS, t1);
    r.expectArrival(t1);
    assertThat(r.resumesLeft(2)).isEqualTo(0);
    assertThat(r.resumesLeft(1)).isEqualTo(1);
    assertThat(r.resumeGuard.color()).isEqualTo(1);
    GameSession.Deadline ab = abandonOf(r);
    assertThat(ab.at()).isEqualTo(t1 + 90000);
    r.applyDue(r.dueAction(ab.at()), ab.at());
    assertThat(r.result).isEqualTo(B_WINS);
    assertThat(r.resultView().get("cause")).isEqualTo("resume_undone");
    assertThat(r.finishFields().dead()).containsExactly(10);

    RowB bad = RowB.of(s).progress(s);
    bad.state = null;
    GameSession b = GameSession.fromRow(bad.build(), SETTINGS, t1);
    assertThat(b.resumeGuard).isNull();
    assertThat(b.resumesLeft(2)).isEqualTo(1);
    RowB wrong = RowB.of(s).progress(s);
    wrong.state = Json.parse(json(st).replace("\"movesLen\":" + (WALL.length + 2), "\"movesLen\":3"));
    assertThat(GameSession.fromRow(wrong.build(), SETTINGS, t1).resumeGuard).isNull();
  }

  @Test
  void endCauses() {
    GameSession first = online(human());
    first.applyDue(first.dueAction(T0 + 60000), T0 + 60000);
    assertThat(first.resultView().get("cause")).isEqualTo("first_move");

    GameSession owner = human("friend", TC, SETTINGS);
    owner.setOnline(2, true, T0);
    owner.expectArrival(T0);
    long at = owner.nextDeadline();
    assertThat(at).isEqualTo(T0 + 300000);
    owner.applyDue(owner.dueAction(at), at);
    assertThat(owner.result.reason()).isEqualTo("abort");
    assertThat(owner.resultView().get("cause")).isEqualTo("arrival");

    GameSession clock = online(human(new TimeControl(0, 1, 10000)));
    playAll(clock, 0, 1);
    clock.applyDue(clock.dueAction(T0 + 10000), T0 + 10000);
    assertThat(clock.result.reason()).isEqualTo("timeout");
    assertThat(clock.resultView().get("cause")).isEqualTo("clock");
  }
}
