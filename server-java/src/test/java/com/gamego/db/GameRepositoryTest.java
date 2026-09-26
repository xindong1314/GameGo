package com.gamego.db;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.gamego.config.TimeControl;
import com.gamego.testsupport.IntegrationTestBase;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DuplicateKeyException;

/** games 仓储（对应 Node 测试 db.test.js 与 db-hygiene.test.js 的对局部分）。 */
class GameRepositoryTest extends IntegrationTestBase {

  private long[] seedUsers(int n) {
    long[] ids = new long[n];
    for (int i = 0; i < n; i++) ids[i] = users.create("u" + i, "用户" + i, "", T0).id();
    return ids;
  }

  @Test
  void insertAndFindParseJson() {
    long[] u = seedUsers(2);
    TimeControl tc = new TimeControl(180000, 3, 20000);
    GameRow row = games.insert(new NewGame().id("abc123def456").mode("ranked").size(9).komi(7.5).blackId(u[0])
        .whiteId(u[1]).timeControl(tc).status("playing").moves(List.of(40, -1, 30))
        .clocks(Map.of("1", Map.of("mainMs", 1000, "periodsLeft", 3, "periodMs", 20000), "running", 2)).createdAt(T0));
    assertThat(row.id()).isEqualTo("abc123def456");
    assertThat(row.mode()).isEqualTo("ranked");
    assertThat(row.size()).isEqualTo(9);
    assertThat(row.komi()).isEqualTo(7.5);
    assertThat(row.blackId()).isEqualTo(u[0]);
    assertThat(row.whiteId()).isEqualTo(u[1]);
    assertThat(row.aiLevel()).isNull();
    assertThat(row.timeControl()).isEqualTo(tc);
    assertThat(row.status()).isEqualTo("playing");
    assertThat(row.moves()).containsExactly(40, -1, 30);
    assertThat(row.clocks().get("running").asInt()).isEqualTo(2);
    assertThat(row.clocks().get("1").get("periodsLeft").asInt()).isEqualTo(3);
    assertThat(row.dead()).isNull();
    assertThat(row.winner()).isNull();
    assertThat(row.reason()).isNull();
    assertThat(row.scoreBlack()).isNull();
    assertThat(row.resultText()).isNull();
    assertThat(row.counted()).isFalse();
    assertThat(row.state()).isNull();
    assertThat(row.cause()).isNull();
    assertThat(row.createdAt()).isEqualTo(T0);
    assertThat(row.updatedAt()).isEqualTo(T0);
    assertThat(row.endedAt()).isNull();
    assertThat(games.findById("abc123def456")).isEqualTo(row);
    assertThat(games.findById("nope")).isNull();
    assertThat(games.findById("../x")).isNull();
    assertThat(games.findById(null)).isNull();
    // 数据库里存的是紧凑 JSON
    assertThat(jdbc.queryForObject("SELECT moves FROM games WHERE id = 'abc123def456'", String.class)).isEqualTo("[40,-1,30]");
    assertThat(jdbc.queryForObject("SELECT time_control FROM games WHERE id = 'abc123def456'", String.class))
        .isEqualTo("{\"mainMs\":180000,\"periods\":3,\"periodMs\":20000}");

    GameRow ai = games.insert(new NewGame().id("aigame000001").mode("ai").size(13).komi(7.5).blackId(null)
        .whiteId(u[0]).aiLevel("k5").createdAt(T0 + 5).updatedAt(T0 + 6));
    assertThat(ai.blackId()).isNull();
    assertThat(ai.whiteId()).isEqualTo(u[0]);
    assertThat(ai.aiLevel()).isEqualTo("k5");
    assertThat(ai.timeControl()).isNull();
    assertThat(ai.moves()).isEmpty();
    assertThat(ai.createdAt()).isEqualTo(T0 + 5);
    assertThat(ai.updatedAt()).isEqualTo(T0 + 6);
  }

  @Test
  void insertValidation() {
    long[] u = seedUsers(2);
    java.util.function.Supplier<NewGame> ok =
        () -> new NewGame().id("x1").mode("friend").size(19).komi(7.5).blackId(u[0]).whiteId(u[1]).createdAt(T0);
    List<Consumer<NewGame>> bad = new ArrayList<>();
    bad.add(g -> g.id(""));
    bad.add(g -> g.id("a b"));
    bad.add(g -> g.mode("blitz"));
    bad.add(g -> g.size(20));
    bad.add(g -> g.blackId(null));
    bad.add(g -> g.whiteId(u[0]));
    bad.add(g -> g.status("paused"));
    bad.add(g -> g.moves(java.util.Arrays.asList(1, null)));
    bad.add(g -> g.moves(List.of(-2)));
    bad.add(g -> g.winner(3));
    bad.add(g -> g.reason("quit"));
    bad.add(g -> g.mode("ai").aiLevel("k5")); // 两方都是人
    bad.add(g -> g.mode("ai").blackId(null).aiLevel(""));
    bad.add(g -> g.blackId(-1L));
    bad.add(g -> g.cause("DROP TABLE"));
    for (Consumer<NewGame> patch : bad) {
      NewGame g = ok.get();
      patch.accept(g);
      assertThatThrownBy(() -> games.insert(g)).isInstanceOf(IllegalArgumentException.class);
    }
    games.insert(ok.get());
    assertThatThrownBy(() -> games.insert(ok.get())).isInstanceOf(DuplicateKeyException.class);
  }

  @Test
  void saveProgressOnlyGivenFieldsAndNotEnded() {
    long[] u = seedUsers(2);
    String id = insertRanked(u[0], u[1], T0);
    assertThat(games.saveProgress(id, GameProgress.of().moves(List.of(1, 2)).clocks(Map.of("running", 1)), T0 + 10)).isTrue();
    GameRow g = games.findById(id);
    assertThat(g.moves()).containsExactly(1, 2);
    assertThat(g.clocks().get("running").asInt()).isEqualTo(1);
    assertThat(g.status()).isEqualTo("playing");
    assertThat(g.updatedAt()).isEqualTo(T0 + 10);

    assertThat(games.saveProgress(id, GameProgress.of().status("scoring").moves(List.of(1, 2, -1, -1)), T0 + 20)).isTrue();
    g = games.findById(id);
    assertThat(g.status()).isEqualTo("scoring");
    assertThat(g.clocks().get("running").asInt()).isEqualTo(1);
    assertThat(games.saveProgress(id, GameProgress.of().clocks(null), T0 + 21)).isTrue();
    assertThat(games.findById(id).clocks()).isNull();

    assertThatThrownBy(() -> games.saveProgress(id, GameProgress.of().status("ended"), T0))
        .isInstanceOf(IllegalArgumentException.class);
    assertThat(games.saveProgress("missing", GameProgress.of().moves(List.of()), T0)).isFalse();

    games.finish(id, GameFinish.of(1, "resign"), T0 + 30);
    assertThat(games.saveProgress(id, GameProgress.of().status("playing").moves(List.of()), T0 + 40)).isFalse();
    g = games.findById(id);
    assertThat(g.status()).isEqualTo("ended");
    assertThat(g.moves()).containsExactly(1, 2, -1, -1);
  }

  @Test
  void finishWritesResultAndGeneratesText() {
    long[] u = seedUsers(2);
    String id = insertRanked(u[0], u[1], T0);
    boolean ok = games.finish(id,
        GameFinish.of(2, "score").moves(List.of(40, -1, -1)).dead(List.of(3, 1)).scores(40, 48.5), T0 + 100);
    assertThat(ok).isTrue();
    GameRow g = games.findById(id);
    assertThat(g.status()).isEqualTo("ended");
    assertThat(g.moves()).containsExactly(40, -1, -1);
    assertThat(g.dead()).containsExactly(3, 1);
    assertThat(g.winner()).isEqualTo(2);
    assertThat(g.reason()).isEqualTo("score");
    assertThat(g.scoreBlack()).isEqualTo(40.0);
    assertThat(g.scoreWhite()).isEqualTo(48.5);
    assertThat(g.resultText()).isEqualTo("W+8.5");
    assertThat(g.endedAt()).isEqualTo(T0 + 100);
    assertThat(g.updatedAt()).isEqualTo(T0 + 100);
    assertThat(g.counted()).as("counted 列只由 applyRanked 置 1").isFalse();

    assertThat(games.finish(id, GameFinish.of(1, "resign"), T0 + 200)).isFalse();
    assertThat(games.findById(id).winner()).isEqualTo(2);

    String id2 = insertRanked(u[0], u[1], T0);
    games.finish(id2, GameFinish.of(0, "abort").resultText("Void"), T0 + 1);
    GameRow g2 = games.findById(id2);
    assertThat(g2.resultText()).isEqualTo("Void");
    assertThat(g2.moves()).isEmpty();
    assertThat(g2.dead()).isNull();
    assertThat(g2.scoreBlack()).isNull();

    String id3 = insertRanked(u[0], u[1], T0);
    assertThatThrownBy(() -> games.finish(id3, GameFinish.of(4, "score"), T0)).isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> games.finish(id3, GameFinish.of(1, "nope"), T0)).isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> games.finish(id3, GameFinish.of(1, "score").scoreBlack(Double.NaN), T0))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> games.finish(id3, GameFinish.of(1, "score").dead(List.of(-1)), T0))
        .isInstanceOf(IllegalArgumentException.class);
    assertThat(games.finish("missing", GameFinish.of(1, "resign"), T0)).isFalse();
  }

  @Test
  void resultTextFormats() {
    assertThat(ResultTexts.resultText(1, "resign", null, null)).isEqualTo("B+R");
    assertThat(ResultTexts.resultText(2, "timeout", null, null)).isEqualTo("W+T");
    assertThat(ResultTexts.resultText(1, "score", 44.0, 36.5)).isEqualTo("B+7.5");
    assertThat(ResultTexts.resultText(2, "score", 30.0, 51.5)).isEqualTo("W+21.5");
    assertThat(ResultTexts.resultText(2, "score", 30.0, 38.0)).isEqualTo("W+8");
    assertThat(ResultTexts.resultText(0, "score", 40.0, 40.0)).isEqualTo("0");
    assertThat(ResultTexts.resultText(0, "abort", null, null)).isEqualTo("Void");
    assertThat(ResultTexts.resultText(1, "score", null, null)).isEqualTo("B+");
  }

  @Test
  void listByUserEndedOnlyDescendingWithCursor() {
    long[] u = seedUsers(3);
    long a = u[0];
    long b = u[1];
    long c = u[2];
    List<String> ids = new ArrayList<>();
    for (int i = 0; i < 5; i++) {
      String id = insertRanked(i % 2 == 1 ? a : b, i % 2 == 1 ? b : a, T0 + i * 1000L);
      games.finish(id, GameFinish.of(1, "resign"), T0 + i * 1000L + 500);
      ids.add(id);
    }
    insertRanked(a, b, T0 + 9000); // 进行中，不列出
    String other = insertRanked(b, c, T0 + 8000);
    games.finish(other, GameFinish.of(1, "resign"), T0 + 8500);

    List<String> reversed = new ArrayList<>(ids);
    java.util.Collections.reverse(reversed);
    assertThat(games.listByUser(a, null, null).stream().map(GameRow::id).toList()).isEqualTo(reversed);
    List<GameRow> page1 = games.listByUser(a, null, 2);
    assertThat(page1.stream().map(GameRow::id).toList()).containsExactly(ids.get(4), ids.get(3));
    List<GameRow> page2 = games.listByUser(a, page1.get(1).createdAt(), 2);
    assertThat(page2.stream().map(GameRow::id).toList()).containsExactly(ids.get(2), ids.get(1));
    List<GameRow> page3 = games.listByUser(a, page2.get(1).createdAt(), 2);
    assertThat(page3.stream().map(GameRow::id).toList()).containsExactly(ids.get(0));
    assertThat(games.listByUser(c, null, null)).hasSize(1);
    assertThat(games.listByUser(999, null, null)).isEmpty();
    assertThat(games.listByUser(a, null, 0)).hasSize(1);
    assertThatThrownBy(() -> games.listByUser(0, null, null)).isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void listByUserMergesBlackAndWhite() {
    long[] u = seedUsers(2);
    List<String> ids = new ArrayList<>();
    for (int i = 0; i < 30; i++) {
      boolean aWhite = i % 3 == 0;
      String id = insertRanked(aWhite ? u[1] : u[0], aWhite ? u[0] : u[1], T0 + i * 10L);
      games.finish(id, GameFinish.of(1, "resign"), T0 + i * 10L + 5);
      ids.add(id);
    }
    List<GameRow> page1 = games.listByUser(u[0], null, 12);
    List<String> exp1 = new ArrayList<>(ids.subList(18, 30));
    java.util.Collections.reverse(exp1);
    assertThat(page1.stream().map(GameRow::id).toList()).isEqualTo(exp1);
    List<GameRow> page2 = games.listByUser(u[0], page1.get(page1.size() - 1).createdAt(), 12);
    List<String> exp2 = new ArrayList<>(ids.subList(6, 18));
    java.util.Collections.reverse(exp2);
    assertThat(page2.stream().map(GameRow::id).toList()).isEqualTo(exp2);
  }

  @Test
  void listUnfinishedAndAiRecord() {
    long[] u = seedUsers(2);
    long a = u[0];
    String p = insertRanked(a, u[1], T0 + 2);
    String s = gameId();
    games.insert(new NewGame().id(s).mode("ranked").size(9).komi(7.5).blackId(a).whiteId(u[1]).status("scoring")
        .createdAt(T0 + 1));
    String e = insertRanked(a, u[1], T0);
    games.finish(e, GameFinish.of(1, "resign"), T0 + 3);
    assertThat(games.listUnfinished().stream().map(UnfinishedGame::id).toList()).containsExactly(s, p);

    record Ai(int color, Integer winner, String reason) {}
    for (Ai x : List.of(new Ai(1, 1, "score"), new Ai(2, 2, "resign"), new Ai(2, 1, "score"), new Ai(1, 0, "abort"),
        new Ai(1, null, null))) {
      String id = gameId();
      games.insert(new NewGame().id(id).mode("ai").size(9).komi(7.5).blackId(x.color() == 1 ? a : null)
          .whiteId(x.color() == 2 ? a : null).aiLevel("k5").createdAt(T0));
      if (x.winner() != null) games.finish(id, GameFinish.of(x.winner(), x.reason()), T0 + 1);
    }
    assertThat(games.aiRecord(a)).isEqualTo(new GameRepository.AiRecord(3, 2));
    assertThat(games.aiRecord(u[1])).isEqualTo(new GameRepository.AiRecord(0, 0));
  }

  @Test
  void corruptJsonMarkedBrokenInListUnfinishedButLenientOnRead() {
    long[] u = seedUsers(2);
    String good = gameId();
    games.insert(new NewGame().id(good).mode("ranked").size(9).komi(7.5).blackId(u[0]).whiteId(u[1])
        .moves(List.of(40, 41)).createdAt(T0));
    String bad = insertRanked(u[0], u[1], T0 + 1);
    jdbc.update("UPDATE games SET moves = ? WHERE id = ?", "[40,", bad);
    List<UnfinishedGame> rows = games.listUnfinished();
    assertThat(rows).hasSize(2);
    assertThat(rows.get(0).game().moves()).containsExactly(40, 41);
    assertThat(rows.get(1).id()).isEqualTo(bad);
    assertThat(rows.get(1).broken()).isTrue();
    assertThat(rows.get(1).error()).contains("moves");
    assertThat(games.findById(bad).moves()).as("查看时损坏的字段按空值").isEmpty();
    games.finish(bad, GameFinish.of(0, "abort"), T0 + 2);
    assertThat(games.listByUser(u[0], null, null)).hasSize(1);
  }

  @Test
  void stateSavedWithProgressClearedOnFinishCauseSaved() {
    long[] u = seedUsers(2);
    String id = gameId();
    games.insert(new NewGame().id(id).mode("ranked").size(9).komi(7.5).blackId(u[0]).whiteId(u[1])
        .moves(List.of(40)).createdAt(T0));
    Map<String, Object> state = Map.of("resumesUsed", Map.of("1", 1, "2", 0), "guard", java.util.Collections.emptyMap());
    assertThat(games.saveProgress(id, GameProgress.of().moves(List.of(40, -1, -1, 41)).state(state), T0 + 1)).isTrue();
    JsonNode st = games.findById(id).state();
    assertThat(st.get("resumesUsed").get("1").asInt()).isEqualTo(1);
    assertThat(games.listUnfinished().get(0).game().state()).isEqualTo(st);
    // state 的 JSON 坏了：只把 state 当成空，不让整局变成 broken
    jdbc.update("UPDATE games SET state = '{oops' WHERE id = ?", id);
    UnfinishedGame row = games.listUnfinished().get(0);
    assertThat(row.broken()).isFalse();
    assertThat(row.game().state()).isNull();

    assertThat(games.finish(id, GameFinish.of(0, "abort").cause("score_dispute"), T0 + 2)).isTrue();
    GameRow ended = games.findById(id);
    assertThat(ended.cause()).isEqualTo("score_dispute");
    assertThat(ended.state()).as("终局后不再需要附加状态").isNull();
    assertThatThrownBy(() -> games.finish("x", GameFinish.of(0, "abort").cause("DROP TABLE"), T0))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void countCountedBetweenAndDiscard() {
    long[] u = seedUsers(3);
    long a = u[0];
    long b = u[1];
    long c = u[2];
    java.util.function.BiFunction<long[], Long, String> counted = (pair, at) -> {
      String id = insertRanked(pair[0], pair[1], at);
      games.finish(id, GameFinish.of(1, "resign"), at + 1);
      stats.applyWin(id, pair[0], pair[1], at + 1);
      return id;
    };
    counted.apply(new long[] {a, b}, T0);
    counted.apply(new long[] {b, a}, T0 + 10);
    counted.apply(new long[] {a, c}, T0 + 20);
    String uncounted = insertRanked(a, b, T0 + 30);
    games.finish(uncounted, GameFinish.of(2, "resign"), T0 + 31);
    counted.apply(new long[] {a, b}, T0 - DAY + 50); // 早于 T0
    assertThat(games.countCountedBetween(a, b, T0)).isEqualTo(2);
    assertThat(games.countCountedBetween(b, a, T0)).isEqualTo(2);
    assertThat(games.countCountedBetween(a, c, T0)).isEqualTo(1);
    assertThat(games.countCountedBetween(b, c, T0)).isZero();
    assertThat(games.countCountedBetween(a, b, T0 - DAY)).isEqualTo(3);

    // 同一对手每日计入上限（默认 3，0 = 不限）
    assertThat(stats.pairLimitReached(a, b, T0 + 10)).as("24 小时内已计入 3 局").isTrue();
    assertThat(stats.pairLimitReached(a, c, T0 + 10)).isFalse();
    props.setRankedPairDailyMax(0);
    assertThat(stats.pairLimitReached(a, b, T0 + 10)).isFalse();
    props.setRankedPairDailyMax(3);
    assertThat(stats.pairLimitReached(a, b, T0 + DAY + 5)).as("较早的几局已过 24 小时").isFalse();

    GameRow ai = games.insert(new NewGame().id("aigame000001").mode("ai").size(9).komi(7.5).whiteId(a).aiLevel("k5")
        .createdAt(T0));
    games.finish(ai.id(), GameFinish.of(2, "score").scores(1, 20), T0 + 1);
    GameRow empty = games.insert(new NewGame().id("aigame000002").mode("ai").size(9).komi(7.5).blackId(a).aiLevel("k5")
        .createdAt(T0));
    assertThat(games.discard(empty.id())).isTrue();
    assertThat(games.findById(empty.id())).isNull();
    assertThat(games.discard(ai.id())).isFalse();
    assertThat(games.findById(ai.id())).isNotNull();
    assertThat(games.discard("../x")).isFalse();
  }
}
