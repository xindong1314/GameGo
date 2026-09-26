package com.gamego.game;

import static com.gamego.game.Ctx.TEN;
import static com.gamego.game.Ctx.WALL;
import static com.gamego.game.Ctx.codeOf;
import static com.gamego.game.Ctx.concat;
import static com.gamego.game.Ctx.map;
import static com.gamego.game.Ctx.tc9;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.gamego.ai.AiMove;
import com.gamego.config.TimeControl;
import com.gamego.engine.Result;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** 对局管理器（对应 Node 测试 game/manager.test.js、limits.test.js 与 fairness-manager.test.js 的管理器部分）。 */
class GameManagerTest {

  static String json(Object o) {
    return Json.write(o);
  }

  static Map<String, Object> scoringOf(Map<String, Object> msg) {
    return map(msg.get("scoring"));
  }

  static Map<String, Object> resultOf(Map<String, Object> msg) {
    return map(msg.get("result"));
  }

  @Test
  void createHumanGame() {
    Ctx ctx = new Ctx();
    ctx.hub.online.remove(ctx.bob.id());
    GameSession s = ctx.ranked();
    assertThat(ctx.store.callsOf("games.insert")).hasSize(1);
    MemoryStore.Row row = ctx.store.row(s.id());
    assertThat(row.mode).isEqualTo("ranked");
    assertThat(row.blackId).isEqualTo(ctx.alice.id());
    assertThat(row.timeControl).isEqualTo(new TimeControl(180000, 3, 20000));
    assertThat(s.id()).matches("^[0-9a-z]{12}$");
    assertThat(json(ctx.manager.activeGamesOf(ctx.alice.id()))).isEqualTo("[{\"id\":\"" + s.id() + "\",\"mode\":\"ranked\"}]");
    assertThat(ctx.manager.humanGameOf(ctx.bob.id())).isSameAs(s);
    assertThat(ctx.manager.humanGameOf(ctx.carol.id())).isNull();
    assertThat(s.online[1]).isTrue();
    assertThat(s.online[2]).isFalse();
    assertThatThrownBy(() -> ctx.manager.createHumanGame("ai", 9, 1, 2)).isInstanceOf(IllegalArgumentException.class);
    assertThat(codeOf(() -> ctx.manager.createHumanGame("friend", 7, 1, 2))).isEqualTo("bad_request");
    ctx.noErrors();
  }

  @Test
  void moveBroadcastsAndSaves() {
    Ctx ctx = new Ctx();
    GameSession s = ctx.ranked();
    ctx.loop.advance(3000);
    ctx.manager.move(ctx.alice.id(), s.id(), 1, 40);
    List<Map<String, Object>> moves = ctx.hub.of("game.move");
    assertThat(moves).hasSize(2);
    assertThat(json(moves.get(0)))
        .isEqualTo("{\"t\":\"game.move\",\"gameId\":\"" + s.id() + "\",\"n\":1,\"idx\":40,\"color\":1,\"captured\":[],"
            + "\"clocks\":{\"1\":{\"mainMs\":177000,\"periodsLeft\":3,\"periodMs\":20000},\"2\":{\"mainMs\":180000,\"periodsLeft\":3,\"periodMs\":20000},\"running\":2}}");
    assertThat(ctx.hub.sent).allMatch(x -> s.id().equals(x.gameId()));
    GameSession.Progress saved = (GameSession.Progress) ctx.store.lastCall("games.saveProgress").arg();
    assertThat(saved.moves()).containsExactly(40);
    assertThat(saved.status()).isEqualTo("playing");
    assertThat(codeOf(() -> ctx.manager.move(ctx.carol.id(), s.id(), 2, 41))).isEqualTo("not_player");
    assertThat(codeOf(() -> ctx.manager.move(ctx.alice.id(), "zzzzzzzzzzzz", 1, 41))).isEqualTo("not_found");
    assertThat(codeOf(() -> ctx.manager.move(ctx.alice.id(), s.id(), 2, 41))).isEqualTo("not_your_turn");
    assertThat(codeOf(() -> ctx.manager.move(ctx.bob.id(), s.id(), 1, 41))).isEqualTo("stale");
    assertThat(codeOf(() -> ctx.manager.move(ctx.bob.id(), s.id(), 2, 40))).isEqualTo("illegal");
    assertThat(codeOf(() -> ctx.manager.undo(ctx.bob.id(), s.id()))).isEqualTo("bad_request");
    ctx.noErrors();
  }

  @Test
  void firstMoveTimeoutVoids() {
    Ctx ctx = new Ctx();
    GameSession s = ctx.ranked();
    ctx.loop.advance(59999);
    assertThat(ctx.hub.of("game.end")).isEmpty();
    ctx.loop.advance(1);
    List<Map<String, Object>> ends = ctx.hub.of("game.end");
    assertThat(ends).hasSize(2);
    assertThat(resultOf(ends.get(0)).get("reason")).isEqualTo("abort");
    assertThat(resultOf(ends.get(0)).get("text")).isEqualTo("Void");
    assertThat(resultOf(ends.get(0)).get("counted")).isEqualTo(false);
    assertThat(ends.get(0).get("stats")).as("排位赛附带双方统计").isNotNull();
    assertThat(json(map(ends.get(0).get("stats")).get("1")))
        .isEqualTo("{\"games\":0,\"wins\":0,\"losses\":0,\"draws\":0,\"winrate\":0,\"curStreak\":0,\"maxStreak\":0}");
    assertThat(ctx.store.callsOf("stats.applyRanked")).isEmpty();
    assertThat(ctx.store.row(s.id()).status).isEqualTo("ended");
    assertThat(ctx.store.row(s.id()).reason).isEqualTo("abort");
    assertThat(ctx.manager.activeGamesOf(ctx.alice.id())).isEmpty();
    assertThat(codeOf(() -> ctx.manager.move(ctx.alice.id(), s.id(), 1, 40))).isEqualTo("wrong_phase");
    ctx.noErrors();
  }

  @Test
  void byoYomiTimeoutAndEarlyTimerRearms() {
    Ctx ctx = new Ctx(tc9(10000, 2, 5000).andThen(b -> b.minMovesRanked(2)), null);
    GameSession s = ctx.ranked();
    ctx.play(s, 40, 41);
    ctx.loop.advance(5000);
    ctx.manager.onDeadline(s.id()); // 模拟定时器提前触发
    assertThat(s.status()).isEqualTo("playing");
    ctx.loop.advance(14999);
    assertThat(s.status()).isEqualTo("playing");
    ctx.loop.advance(1);
    assertThat(s.status()).isEqualTo("ended");
    Map<String, Object> end = ctx.hub.of("game.end", ctx.bob.id()).get(0);
    assertThat(resultOf(end).get("reason")).isEqualTo("timeout");
    assertThat(resultOf(end).get("winner")).isEqualTo(2);
    assertThat(resultOf(end).get("text")).isEqualTo("W+T");
    assertThat(resultOf(end).get("counted")).isEqualTo(true);
    assertThat(ctx.store.callsOf("stats.applyRanked")).hasSize(1);
    assertThat(map(map(end.get("stats")).get("2")).get("curStreak")).isEqualTo(1L);
    ctx.noErrors();
  }

  @Test
  void syncRunsDueEventsFirst() {
    Ctx ctx = new Ctx(tc9(10000, 0, 0), null);
    GameSession s = ctx.ranked();
    ctx.play(s, 40);
    ctx.manager.disarm(s.id());
    // 推进时间但不触发定时器：定时器已解除，advance 只移动时钟
    ctx.loop.advance(10000);
    assertThat(s.status()).isEqualTo("playing");
    assertThat(codeOf(() -> ctx.manager.move(ctx.bob.id(), s.id(), 2, 41))).isEqualTo("wrong_phase");
    assertThat(s.result.reason()).isEqualTo("timeout");
    assertThat(s.result.winner()).isEqualTo(1);

    Ctx c2 = new Ctx();
    GameSession t = c2.ranked();
    c2.manager.disarm(t.id());
    c2.loop.advance(60000);
    Map<String, Object> snap = c2.manager.sync(c2.alice.id(), t.id());
    assertThat(snap.get("status")).isEqualTo("ended");
    assertThat(map(snap.get("result")).get("reason")).isEqualTo("abort");
  }

  @Test
  void abandonOnlyForSideToPlay() {
    Ctx ctx = new Ctx(tc9(0, 100, 30000), null);
    GameSession s = ctx.ranked();
    ctx.play(s, TEN);
    ctx.hub.clear();
    ctx.manager.userOffline(ctx.bob.id());
    List<Map<String, Object>> pres = ctx.hub.of("game.presence", ctx.alice.id());
    assertThat(pres).hasSize(1);
    assertThat(pres.get(0).get("color")).isEqualTo(2);
    assertThat(pres.get(0).get("online")).isEqualTo(false);
    assertThat(map(pres.get(0).get("clocks")).get("running")).as("附带读秒快照（FS-9）").isEqualTo(1);
    ctx.loop.advance(100000);
    assertThat(s.status()).isEqualTo("playing");
    ctx.manager.userOnline(ctx.bob.id());
    ctx.manager.userOffline(ctx.alice.id());
    assertThat(ctx.hub.last("game.presence", ctx.bob.id()).get("online")).isEqualTo(false);
    ctx.loop.advance(60000);
    ctx.manager.userOnline(ctx.alice.id());
    ctx.loop.advance(60000);
    assertThat(s.status()).isEqualTo("playing");
    ctx.manager.userOffline(ctx.alice.id());
    ctx.loop.advance(89999);
    assertThat(s.status()).isEqualTo("playing");
    ctx.loop.advance(1);
    assertThat(s.status()).isEqualTo("ended");
    assertThat(s.result).isEqualTo(new Result(2, "timeout"));
    assertThat(s.counted).isTrue();
    assertThat(ctx.store.callsOf("stats.applyRanked")).hasSize(1);
    ctx.noErrors();
  }

  @Test
  void abandonBeforeOwnMoveVoids() {
    Ctx ctx = new Ctx(tc9(30000, 5, 20000), null);
    GameSession s = ctx.ranked();
    ctx.play(s, 40);
    ctx.manager.userOffline(ctx.bob.id());
    ctx.loop.advance(90000);
    assertThat(s.result.reason()).isEqualTo("abort");
    assertThat(resultOf(ctx.hub.last("game.end", ctx.alice.id())).get("cause")).isEqualTo("abandon");
    assertThat(ctx.store.callsOf("stats.applyRanked")).isEmpty();

    ctx.manager.userOnline(ctx.bob.id());
    GameSession t = ctx.ranked();
    ctx.play(t, 40, 41, 42);
    ctx.manager.userOffline(ctx.bob.id());
    ctx.loop.advance(90000);
    assertThat(t.result.reason()).isEqualTo("timeout");
    assertThat(t.counted).isTrue();
    assertThat(resultOf(ctx.hub.last("game.end", ctx.alice.id())).get("cause")).isEqualTo("abandon");
    assertThat(ctx.store.callsOf("stats.applyRanked")).hasSize(1);
    assertThat(ctx.store.row(t.id()).cause).isEqualTo("abandon");
  }

  @Test
  void ownerOfflineArrival() {
    Ctx ctx = new Ctx();
    ctx.hub.online.remove(ctx.bob.id());
    GameSession s = ctx.manager.createHumanGame("friend", 9, ctx.alice.id(), ctx.bob.id());
    assertThat(s.awaitingArrival(2)).isTrue();
    ctx.play(s, 40);
    assertThat(s.clock.running()).isEqualTo(0);
    ctx.loop.advance(90000);
    assertThat(s.status()).isEqualTo("playing");
    ctx.hub.online.add(ctx.bob.id());
    ctx.manager.userOnline(ctx.bob.id());
    assertThat(s.clock.running()).isEqualTo(2);
    assertThat(s.clock.side(2).mainMs()).isEqualTo(180000);
    ctx.play(s, 41);
    assertThat(s.status()).isEqualTo("playing");
    // FS-9：到场的一方上线，对手收到带读秒的 presence
    Map<String, Object> p = ctx.hub.last("game.presence", ctx.alice.id());
    assertThat(p.get("online")).isEqualTo(true);
    assertThat(map(p.get("clocks")).get("running")).isEqualTo(2);

    Ctx late = new Ctx();
    late.hub.online.remove(late.bob.id());
    GameSession g = late.manager.createHumanGame("friend", 9, late.alice.id(), late.bob.id());
    late.play(g, 40);
    late.loop.advance(300000);
    assertThat(g.result.reason()).isEqualTo("abort");
    assertThat(late.hub.of("game.end").get(0).get("stats")).as("好友对局不附统计").isNull();
  }

  @Test
  void fullScoringFlowCountsOnce() {
    Ctx ctx = new Ctx(null, new TestAi().dead(10));
    GameSession s = ctx.ranked();
    ctx.play(s, WALL);
    ctx.hub.clear();
    ctx.play(s, -1, -1);
    List<Map<String, Object>> pend = ctx.hub.of("game.scoring", ctx.alice.id());
    assertThat(pend).hasSize(1);
    assertThat(scoringOf(pend.get(0)).get("pending")).isEqualTo(true);
    assertThat(((GameSession.Progress) ctx.store.lastCall("games.saveProgress").arg()).status()).isEqualTo("scoring");
    assertThat(ctx.ai.judgeDeadCalls).containsExactly(new TestAi.JudgeCall(9, 7.5, Msg.list(concat(WALL, -1, -1))));
    ctx.flush();
    Map<String, Object> prop = scoringOf(ctx.hub.last("game.scoring", ctx.alice.id()));
    assertThat(prop.get("pending")).isEqualTo(false);
    assertThat(prop.get("source")).isEqualTo("katago");
    assertThat(prop.get("version")).isEqualTo(1);
    assertThat(prop.get("dead")).isEqualTo(List.of(10));
    assertThat(prop.get("winner")).isEqualTo(1);
    assertThat(prop.get("deadline")).isEqualTo(180000L);

    ctx.manager.acceptScore(ctx.alice.id(), s.id(), 1);
    assertThat(json(scoringOf(ctx.hub.last("game.scoring", ctx.bob.id())).get("accepted"))).isEqualTo("{\"1\":true,\"2\":false}");
    ctx.manager.toggleDead(ctx.bob.id(), s.id(), 10, null);
    Map<String, Object> t = scoringOf(ctx.hub.last("game.scoring", ctx.bob.id()));
    assertThat(t.get("version")).isEqualTo(2);
    assertThat(t.get("dead")).isEqualTo(List.of());
    assertThat(json(t.get("accepted"))).isEqualTo("{\"1\":false,\"2\":false}");
    assertThat(codeOf(() -> ctx.manager.acceptScore(ctx.alice.id(), s.id(), 1))).isEqualTo("stale");
    int before = ctx.hub.sent.size();
    ctx.manager.toggleDead(ctx.alice.id(), s.id(), 0, null);
    assertThat(ctx.hub.sent).hasSize(before);
    ctx.manager.toggleDead(ctx.alice.id(), s.id(), 10, null);
    ctx.manager.acceptScore(ctx.alice.id(), s.id(), 3);
    ctx.manager.acceptScore(ctx.bob.id(), s.id(), 3);
    List<Map<String, Object>> end = ctx.hub.of("game.end", ctx.alice.id());
    assertThat(end).hasSize(1);
    assertThat(json(end.get(0).get("result")))
        .isEqualTo("{\"winner\":1,\"reason\":\"score\",\"black\":45,\"white\":43.5,\"text\":\"B+1.5\",\"label\":\"黑胜 1.5 目\","
            + "\"counted\":true,\"cause\":\"agreed\",\"uncounted\":null,\"pending\":false}");
    assertThat(json(map(end.get(0).get("stats")).get("1")))
        .isEqualTo("{\"games\":1,\"wins\":1,\"losses\":0,\"draws\":0,\"winrate\":1,\"curStreak\":1,\"maxStreak\":1}");
    assertThat(json(map(end.get(0).get("stats")).get("2")))
        .isEqualTo("{\"games\":1,\"wins\":0,\"losses\":1,\"draws\":0,\"winrate\":0,\"curStreak\":0,\"maxStreak\":0}");
    List<MemoryStore.Call> applied = ctx.store.callsOf("stats.applyRanked");
    assertThat(applied).hasSize(1);
    assertThat(applied.get(0).arg())
        .isEqualTo(new GameStore.RankedApply(s.id(), ctx.alice.id(), ctx.bob.id(), false, List.of(ctx.alice.id(), ctx.bob.id())));
    MemoryStore.Row row = ctx.store.row(s.id());
    assertThat(row.status).isEqualTo("ended");
    assertThat(row.dead).containsExactly(10);
    assertThat(row.resultText).isEqualTo("B+1.5");
    assertThat(row.counted).isTrue();
    assertThat(codeOf(() -> ctx.manager.acceptScore(ctx.alice.id(), s.id(), 3))).isEqualTo("wrong_phase");
    assertThat(codeOf(() -> ctx.manager.resign(ctx.bob.id(), s.id()))).isEqualTo("wrong_phase");
    assertThat(codeOf(() -> ctx.manager.resign(ctx.carol.id(), s.id()))).isEqualTo("not_player");
    assertThat(ctx.store.callsOf("stats.applyRanked")).hasSize(1);
    ctx.noErrors();
  }

  @Test
  void scoringDeadlineIgnoresUnilateralToggle() {
    Ctx ctx = new Ctx(null, new TestAi().dead(10));
    GameSession s = ctx.ranked();
    ctx.play(s, concat(WALL, -1, -1));
    ctx.flush();
    ctx.manager.acceptScore(ctx.alice.id(), s.id(), 1);
    ctx.loop.advance(179000);
    ctx.manager.toggleDead(ctx.bob.id(), s.id(), 4, null);
    Map<String, Object> t = scoringOf(ctx.hub.last("game.scoring", ctx.alice.id()));
    assertThat(t.get("winner")).isEqualTo(2);
    assertThat(t.get("deadline")).isEqualTo(60000L);
    ctx.loop.advance(1000);
    assertThat(s.status()).isEqualTo("scoring");
    ctx.hub.clear();
    ctx.loop.advance(59000);
    assertThat(s.status()).isEqualTo("ended");
    assertThat(s.result).isEqualTo(new Result(1, "score", 45.0, 43.5));
    assertThat(ctx.hub.types(ctx.alice.id())).containsExactly("game.scoring", "game.end");
    Map<String, Object> fin = scoringOf(ctx.hub.of("game.scoring", ctx.alice.id()).get(0));
    assertThat(fin.get("dead")).isEqualTo(List.of(10));
    assertThat(fin.get("winner")).isEqualTo(1);
    assertThat(ctx.store.row(s.id()).dead).containsExactly(10);
    assertThat(((GameStore.RankedApply) ctx.store.callsOf("stats.applyRanked").get(0).arg()).winnerId()).isEqualTo(ctx.alice.id());
    ctx.noErrors();
  }

  @Test
  void judgeFailureRetriesThenManual() {
    TestAi failAi = new TestAi();
    failAi.judgeFail = true;
    Ctx fail = new Ctx(null, failAi);
    GameSession a = fail.ranked();
    fail.play(a, concat(WALL, -1, -1));
    fail.flush();
    Map<String, Object> sc = scoringOf(fail.hub.last("game.scoring", fail.alice.id()));
    assertThat(sc.get("pending")).isEqualTo(false);
    assertThat(sc.get("source")).isEqualTo("manual");
    assertThat(sc.get("dead")).isEqualTo(List.of());
    assertThat(sc.get("version")).isEqualTo(1);
    assertThat(failAi.judgeDeadCalls).as("失败后重试一次（FS-1）").hasSize(2);

    TestAi slowAi = new TestAi();
    slowAi.manualJudge = true;
    Ctx slow = new Ctx(null, slowAi);
    GameSession b = slow.ranked();
    slow.play(b, concat(WALL, -1, -1));
    slow.loop.advance(15000);
    slow.flush();
    assertThat(b.scoring.pending).as("第一次超时后重试").isTrue();
    assertThat(slowAi.judgeDeadCalls).hasSize(2);
    slow.loop.advance(15000);
    slow.flush();
    assertThat(b.scoring.pending).isFalse();
    assertThat(b.scoring.source).isEqualTo("manual");
    slowAi.resolveNextJudge(10); // 迟到的结果不改变已给出的建议（只记进缓存）
    slow.flush();
    assertThat(b.scoring.dead).isEmpty();
    assertThat(b.scoring.version).isEqualTo(1);

    TestAi offAi = new TestAi();
    offAi.available = false;
    Ctx off = new Ctx(null, offAi);
    GameSession c = off.ranked();
    off.play(c, concat(WALL, -1, -1));
    List<Map<String, Object>> pushes = off.hub.of("game.scoring", off.alice.id());
    assertThat(pushes).hasSize(2);
    assertThat(scoringOf(pushes.get(0)).get("pending")).isEqualTo(true);
    assertThat(scoringOf(pushes.get(1)).get("source")).isEqualTo("manual");
    assertThat(offAi.judgeDeadCalls).isEmpty();

    TestAi badAi = new TestAi();
    badAi.badJudge = true;
    Ctx bad = new Ctx(null, badAi);
    GameSession d = bad.ranked();
    bad.play(d, concat(WALL, -1, -1));
    bad.flush();
    assertThat(d.scoring.source).isEqualTo("manual");
  }

  @Test
  void judgeRetrySucceeds() {
    TestAi ai = new TestAi();
    ai.manualJudge = true;
    Ctx ctx = new Ctx(null, ai);
    GameSession s = ctx.ranked();
    ctx.play(s, concat(WALL, -1, -1));
    ai.rejectNextJudge();
    ctx.flush();
    assertThat(s.scoring.pending).isTrue();
    assertThat(ai.judgeDeadCalls).hasSize(2);
    ai.resolveNextJudge(10);
    ctx.flush();
    assertThat(s.scoring.source).isEqualTo("katago");
    assertThat(s.scoring.dead).containsExactly(10);
    ctx.noErrors();
  }

  @Test
  void resumePushesAndDropsInflightJudge() {
    TestAi ai = new TestAi();
    ai.manualJudge = true;
    Ctx ctx = new Ctx(null, ai);
    GameSession s = ctx.ranked();
    ctx.play(s, 40, -1, -1);
    ctx.loop.advance(2000);
    ctx.manager.resumeScore(ctx.alice.id(), s.id());
    Map<String, Object> r = ctx.hub.of("game.resumed", ctx.bob.id()).get(0);
    assertThat(r.get("toPlay")).isEqualTo(2);
    assertThat(map(r.get("clocks")).get("running")).isEqualTo(2);
    assertThat(s.status()).isEqualTo("playing");
    assertThat(((GameSession.Progress) ctx.store.lastCall("games.saveProgress").arg()).status()).isEqualTo("playing");
    ai.resolveNextJudge(40);
    ctx.flush();
    assertThat(s.scoring).isNull();
    assertThat(ctx.hub.of("game.scoring", ctx.bob.id())).hasSize(1);
    ctx.play(s, 41);
    assertThat(s.moves).hasSize(4);
    assertThat(codeOf(() -> ctx.manager.resumeScore(ctx.alice.id(), s.id()))).isEqualTo("wrong_phase");
    ctx.noErrors();
  }

  @Test
  void resignCounting() {
    Ctx ctx = new Ctx();
    GameSession s = ctx.ranked();
    ctx.play(s, 40);
    ctx.manager.resign(ctx.bob.id(), s.id());
    assertThat(s.result.winner()).isEqualTo(1);
    assertThat(s.counted).isFalse();
    assertThat(resultOf(ctx.hub.of("game.end", ctx.bob.id()).get(0)).get("uncounted")).isEqualTo("short");
    assertThat(ctx.store.callsOf("stats.applyRanked")).isEmpty();
    assertThat(resultOf(ctx.hub.of("game.end", ctx.bob.id()).get(0)).get("text")).isEqualTo("B+R");

    GameSession t = ctx.ranked();
    ctx.play(t, TEN);
    ctx.manager.resign(ctx.alice.id(), t.id());
    assertThat(t.counted).isTrue();
    assertThat(ctx.store.callsOf("stats.applyRanked")).hasSize(1);
    assertThat(map(map(ctx.hub.last("game.end", ctx.alice.id()).get("stats")).get("2")).get("wins")).isEqualTo(1L);
  }

  @Test
  void drawAppliesAsDraw() {
    Ctx ctx = new Ctx(b -> b.komi(0), new TestAi().dead());
    GameSession s = ctx.ranked();
    List<Integer> draw = new ArrayList<>();
    for (int y = 0; y < 9; y++) {
      draw.add(y * 9 + 3);
      draw.add(y * 9 + 5);
    }
    draw.add(-1);
    draw.add(-1);
    ctx.play(s, Msg.ints(draw));
    ctx.flush();
    ctx.manager.acceptScore(ctx.alice.id(), s.id(), 1);
    ctx.manager.acceptScore(ctx.bob.id(), s.id(), 1);
    assertThat(s.result.winner()).isEqualTo(0);
    assertThat(s.result.reason()).isEqualTo("score");
    List<MemoryStore.Call> applied = ctx.store.callsOf("stats.applyRanked");
    assertThat(applied).hasSize(1);
    GameStore.RankedApply ra = (GameStore.RankedApply) applied.get(0).arg();
    assertThat(ra.draw()).isTrue();
    assertThat(ra.userIds()).containsExactly(ctx.alice.id(), ctx.bob.id());
    assertThat(map(map(ctx.hub.of("game.end").get(0).get("stats")).get("1")).get("draws")).isEqualTo(1L);
    assertThat(resultOf(ctx.hub.of("game.end").get(0)).get("text")).isEqualTo("0");
  }

  @Test
  void saveFailureDoesNotBlockPushes() {
    Ctx ctx = new Ctx();
    GameSession s = ctx.ranked();
    ctx.store.failOn("games.saveProgress");
    ctx.play(s, 40);
    assertThat(ctx.hub.of("game.move")).hasSize(2);
    assertThat(ctx.log.error).hasSize(1);
    ctx.store.failOn("games.finish");
    ctx.play(s, 41, 42, 43, 44, 45, 46, 47, 48, 49);
    ctx.manager.resign(ctx.alice.id(), s.id());
    assertThat(ctx.hub.of("game.end")).hasSize(2);
    assertThat(ctx.log.error).hasSize(2);
    assertThat(ctx.store.statsCount()).as("事务回滚：统计未更新").isEqualTo(0);
  }

  // ---------------------------------------------------------------- 人机

  @Test
  void aiRepliesAfterHumanMove() {
    Ctx ctx = new Ctx();
    GameSession s = ctx.manager.startAiGame(ctx.alice.id(), 9, "k5", "black");
    assertThat(s.aiColor).isEqualTo(2);
    assertThat(ctx.ai.chooseMoveCalls).isEmpty();
    assertThat(ctx.store.row(s.id()).aiLevel).isEqualTo("k5");
    assertThat(ctx.store.row(s.id()).whiteId).isNull();
    ctx.manager.move(ctx.alice.id(), s.id(), 1, 40);
    assertThat(ctx.hub.types(ctx.alice.id())).containsExactly("game.move", "game.ai");
    assertThat(ctx.hub.of("game.ai").get(0).get("thinking")).isEqualTo(true);
    assertThat(s.aiThinking).isTrue();
    var call = ctx.ai.chooseMoveCalls.get(0);
    assertThat(call.size()).isEqualTo(9);
    assertThat(call.komi()).isEqualTo(7.5);
    assertThat(call.moves()).containsExactly(40);
    assertThat(call.color()).isEqualTo(2);
    assertThat(call.level()).isEqualTo("k5");
    assertThat(call.humanJustPassed()).isFalse();
    ctx.flush();
    assertThat(ctx.hub.types(ctx.alice.id())).containsExactly("game.move", "game.ai", "game.move", "game.ai");
    Map<String, Object> aiMove = ctx.hub.of("game.move").get(1);
    assertThat(aiMove.get("n")).isEqualTo(2);
    assertThat(aiMove.get("color")).isEqualTo(2);
    assertThat(aiMove.get("idx")).isEqualTo(0);
    assertThat(aiMove).containsEntry("clocks", null);
    assertThat(ctx.hub.of("game.ai").get(1).get("thinking")).isEqualTo(false);
    assertThat(s.aiThinking).isFalse();
    assertThat(codeOf(() -> ctx.manager.move(ctx.alice.id(), s.id(), 2, 41))).isEqualTo("stale");
    ctx.noErrors();
  }

  @Test
  void aiMovesFirstWhenHumanWhite() {
    Ctx ctx = new Ctx(null, null, true, new int[] {1});
    GameSession s = ctx.manager.startAiGame(ctx.alice.id(), 9, "k10", "random");
    assertThat(s.humanColor()).isEqualTo(2);
    assertThat(ctx.ai.chooseMoveCalls).hasSize(1);
    ctx.flush();
    assertThat(s.moves).containsExactly(0);
    assertThat(s.toPlay()).isEqualTo(2);
  }

  @Test
  void newAiGameReplacesOld() {
    Ctx ctx = new Ctx();
    GameSession a = ctx.manager.startAiGame(ctx.alice.id(), 9, "k10", "black");
    ctx.manager.move(ctx.alice.id(), a.id(), 1, 40);
    GameSession b = ctx.manager.startAiGame(ctx.alice.id(), 13, "k10", "black");
    assertThat(a.result.reason()).isEqualTo("abort");
    assertThat(ctx.store.row(a.id()).reason).isEqualTo("abort");
    assertThat(json(ctx.manager.activeGamesOf(ctx.alice.id()))).isEqualTo("[{\"id\":\"" + b.id() + "\",\"mode\":\"ai\"}]");
    GameSession c = ctx.manager.startAiGame(ctx.alice.id(), 9, "k10", "black");
    assertThat(ctx.store.games).doesNotContainKey(b.id());
    assertThat(ctx.manager.endedCache).doesNotContainKey(b.id());
    assertThat(ctx.hub.last("game.end", null).get("gameId")).isEqualTo(b.id());
    assertThat(resultOf(ctx.hub.last("game.end", null)).get("reason")).isEqualTo("abort");
    assertThat(codeOf(() -> ctx.manager.sync(ctx.alice.id(), b.id()))).isEqualTo("not_found");
    assertThat(json(ctx.manager.activeGamesOf(ctx.alice.id()))).isEqualTo("[{\"id\":\"" + c.id() + "\",\"mode\":\"ai\"}]");
    assertThat(codeOf(() -> ctx.manager.startAiGame(ctx.alice.id(), 9, "nope", "black"))).isEqualTo("bad_request");
    ctx.ai.available = false;
    assertThat(codeOf(() -> ctx.manager.startAiGame(ctx.alice.id(), 9, "k10", "black"))).isEqualTo("ai_unavailable");
    assertThat(ctx.manager.humanGameOf(ctx.alice.id())).isNull();
  }

  @Test
  void undoWhileAiThinkingDropsResult() {
    TestAi ai = new TestAi();
    ai.manual = true;
    Ctx ctx = new Ctx(null, ai);
    GameSession s = ctx.manager.startAiGame(ctx.alice.id(), 9, "k10", "black");
    ctx.manager.move(ctx.alice.id(), s.id(), 1, 40);
    assertThat(s.aiThinking).isTrue();
    ctx.hub.clear();
    ctx.manager.undo(ctx.alice.id(), s.id());
    assertThat(json(ctx.hub.of("game.undo").get(0))).isEqualTo("{\"t\":\"game.undo\",\"gameId\":\"" + s.id() + "\",\"moves\":[]}");
    assertThat(json(ctx.hub.of("game.ai").get(0))).isEqualTo("{\"t\":\"game.ai\",\"gameId\":\"" + s.id() + "\",\"thinking\":false}");
    assertThat(s.aiThinking).isFalse();
    ai.resolveNextMove(AiMove.of(41));
    ctx.flush();
    assertThat(s.moves).isEmpty();
    assertThat(ctx.hub.of("game.move")).isEmpty();
    ctx.manager.move(ctx.alice.id(), s.id(), 1, 30);
    ai.resolveNextMove(AiMove.of(31));
    ctx.flush();
    assertThat(s.moves).containsExactly(30, 31);
    assertThat(codeOf(() -> ctx.manager.undo(ctx.bob.id(), s.id()))).isEqualTo("not_player");
    ctx.manager.undo(ctx.alice.id(), s.id());
    assertThat(s.moves).isEmpty();
    assertThat(codeOf(() -> ctx.manager.undo(ctx.alice.id(), s.id()))).isEqualTo("nothing_to_undo");
    ctx.noErrors();
  }

  @Test
  void resignWhileAiThinking() {
    TestAi ai = new TestAi();
    ai.manual = true;
    Ctx ctx = new Ctx(null, ai);
    GameSession s = ctx.manager.startAiGame(ctx.alice.id(), 9, "k10", "black");
    ctx.manager.move(ctx.alice.id(), s.id(), 1, 40);
    ctx.manager.resign(ctx.alice.id(), s.id());
    assertThat(s.result.winner()).isEqualTo(2);
    assertThat(s.result.reason()).isEqualTo("resign");
    ai.resolveNextMove(AiMove.of(41));
    ctx.flush();
    assertThat(s.moves).containsExactly(40);
    assertThat(ctx.hub.of("game.end")).hasSize(1);
    assertThat(ctx.hub.of("game.end").get(0)).doesNotContainKey("stats");
    ctx.noErrors();
  }

  @Test
  void aiPassesAfterHumanPassThenScoring() {
    Ctx ctx = new Ctx(null, new TestAi().dead());
    GameSession s = ctx.manager.startAiGame(ctx.alice.id(), 9, "k10", "black");
    ctx.manager.move(ctx.alice.id(), s.id(), 1, 40);
    ctx.flush();
    ctx.manager.pass(ctx.alice.id(), s.id(), 3);
    assertThat(ctx.ai.chooseMoveCalls.get(ctx.ai.chooseMoveCalls.size() - 1).humanJustPassed()).isTrue();
    ctx.flush();
    assertThat(s.status()).isEqualTo("scoring");
    Map<String, Object> sc = scoringOf(ctx.hub.last("game.scoring", null));
    assertThat(sc.get("pending")).isEqualTo(false);
    assertThat(json(sc.get("accepted"))).isEqualTo("{\"1\":false,\"2\":true}");
    assertThat(sc.get("deadline")).isNull();
    List<String> types = ctx.hub.types(ctx.alice.id());
    assertThat(types.subList(types.size() - 5, types.size()))
        .containsExactly("game.ai", "game.move", "game.ai", "game.scoring", "game.scoring");
    assertThat(codeOf(() -> ctx.manager.toggleDead(ctx.alice.id(), s.id(), 40, null))).isEqualTo("bad_request");
    ctx.manager.acceptScore(ctx.alice.id(), s.id(), 1);
    assertThat(s.status()).isEqualTo("ended");
    assertThat(s.result.reason()).isEqualTo("score");
    assertThat(s.counted).isFalse();
    assertThat(ctx.store.callsOf("stats.applyRanked")).isEmpty();
    ctx.noErrors();
  }

  @Test
  void aiResumeContinuesThinking() {
    Ctx ctx = new Ctx(null, new TestAi().script(-1));
    GameSession s = ctx.manager.startAiGame(ctx.alice.id(), 9, "k10", "black");
    ctx.manager.move(ctx.alice.id(), s.id(), 1, 40);
    ctx.flush();
    ctx.manager.pass(ctx.alice.id(), s.id(), 3);
    ctx.flush();
    assertThat(s.status()).isEqualTo("scoring");
    int calls = ctx.ai.chooseMoveCalls.size();
    ctx.manager.resumeScore(ctx.alice.id(), s.id());
    assertThat(ctx.ai.chooseMoveCalls).hasSize(calls + 1);
    assertThat(ctx.ai.chooseMoveCalls.get(calls).humanJustPassed()).isFalse();
    ctx.flush();
    assertThat(s.status()).isEqualTo("playing");
    assertThat(s.moves).hasSize(4);
    assertThat(s.toPlay()).isEqualTo(1);
  }

  @Test
  void aiUndoInScoringAndManualJudge() {
    TestAi ai = new TestAi();
    ai.judgeFail = true;
    Ctx ctx = new Ctx(null, ai);
    GameSession s = ctx.manager.startAiGame(ctx.alice.id(), 9, "k10", "black");
    ctx.manager.move(ctx.alice.id(), s.id(), 1, 40);
    ctx.flush();
    ctx.manager.pass(ctx.alice.id(), s.id(), 3);
    ctx.flush();
    assertThat(s.status()).isEqualTo("scoring");
    assertThat(s.scoring.source).isEqualTo("manual");
    assertThat(s.scoring.accepted[2]).isTrue();
    ctx.manager.undo(ctx.alice.id(), s.id());
    assertThat(s.status()).isEqualTo("playing");
    assertThat(s.moves).containsExactly(40, 0);
    assertThat(ctx.hub.last("game.undo", null).get("moves")).isEqualTo(List.of(40, 0));
  }

  @Test
  void aiResigns() {
    TestAi ai = new TestAi();
    ai.strategy = "resign";
    Ctx ctx = new Ctx(null, ai);
    GameSession s = ctx.manager.startAiGame(ctx.alice.id(), 9, "k10", "white");
    ctx.flush();
    assertThat(s.status()).isEqualTo("ended");
    assertThat(s.result).isEqualTo(new Result(2, "resign"));
    assertThat(ctx.hub.types(ctx.alice.id())).containsExactly("game.ai", "game.ai", "game.end");
  }

  @Test
  void aiFailureRetriesThenVoids() {
    TestAi ai = new TestAi();
    ai.failMoves = 1;
    Ctx ctx = new Ctx(b -> b.aiRetryDelaysMs(100L, 200L), ai);
    GameSession s = ctx.manager.startAiGame(ctx.alice.id(), 9, "k10", "white");
    ctx.flush();
    assertThat(s.aiThinking).isFalse();
    assertThat(ctx.hub.last("game.ai", null).get("thinking")).isEqualTo(false);
    ctx.loop.advance(100);
    ctx.flush();
    assertThat(s.moves).containsExactly(0);
    assertThat(ai.chooseMoveCalls).hasSize(2);

    TestAi badAi = new TestAi();
    badAi.strategyFn = req -> AiMove.of(999);
    Ctx bad = new Ctx(b -> b.aiRetryDelaysMs(100L, 200L), badAi);
    GameSession t = bad.manager.startAiGame(bad.alice.id(), 9, "k10", "white");
    bad.flush();
    bad.loop.advance(100);
    bad.flush();
    bad.loop.advance(200);
    bad.flush();
    assertThat(badAi.chooseMoveCalls).hasSize(3);
    assertThat(t.status()).isEqualTo("ended");
    assertThat(t.result.reason()).isEqualTo("abort");
    assertThat(bad.log.error).hasSize(1);
  }

  @Test
  void aiTimeoutRetries() {
    TestAi ai = new TestAi();
    ai.manual = true;
    Ctx ctx = new Ctx(b -> b.aiMoveTimeoutMs(5000).aiRetryDelaysMs(100L), ai);
    GameSession s = ctx.manager.startAiGame(ctx.alice.id(), 9, "k10", "white");
    ctx.loop.advance(5000);
    ctx.flush();
    assertThat(s.aiThinking).isFalse();
    ctx.loop.advance(100);
    assertThat(ai.chooseMoveCalls).hasSize(2);
    ai.resolveNextMove(AiMove.of(5)); // 第一次（已超时）的结果：丢弃
    ctx.flush();
    assertThat(s.moves).isEmpty();
    ai.resolveNextMove(AiMove.of(6));
    ctx.flush();
    assertThat(s.moves).containsExactly(6);
  }

  @Test
  void aiIdleExpiry() {
    Ctx ctx = new Ctx();
    GameSession s = ctx.manager.startAiGame(ctx.alice.id(), 9, "k10", "black");
    ctx.loop.advance(86400000L - 1000);
    ctx.manager.move(ctx.alice.id(), s.id(), 1, 40);
    ctx.flush();
    ctx.loop.advance(86400000L - 1);
    assertThat(s.status()).isEqualTo("playing");
    ctx.loop.advance(1);
    assertThat(s.status()).isEqualTo("ended");
    assertThat(s.result.reason()).isEqualTo("abort");
  }

  // ---------------------------------------------------------------- 同步

  @Test
  void syncSnapshots() {
    Ctx ctx = new Ctx();
    GameSession s = ctx.ranked();
    ctx.play(s, 40);
    Map<String, Object> snap = ctx.manager.sync(ctx.bob.id(), s.id());
    assertThat(snap.get("myColor")).isEqualTo(2);
    assertThat(snap.get("moves")).isEqualTo(List.of(40));
    assertThat(json(map(snap.get("players")).get("1")))
        .isEqualTo("{\"userId\":" + ctx.alice.id() + ",\"nickname\":\"Alice\",\"avatarUrl\":\"http://test.local/avatars/a1.png\"}");
    assertThat(json(map(snap.get("players")).get("2"))).isEqualTo("{\"userId\":" + ctx.bob.id() + ",\"nickname\":\"Bob\",\"avatarUrl\":\"\"}");
    assertThat(json(snap.get("presence"))).isEqualTo("{\"1\":true,\"2\":true}");
    assertThat(codeOf(() -> ctx.manager.sync(ctx.carol.id(), s.id()))).isEqualTo("not_player");
    assertThat(codeOf(() -> ctx.manager.sync(ctx.alice.id(), "nonexistent12"))).isEqualTo("not_found");

    GameSession a = ctx.manager.startAiGame(ctx.carol.id(), 9, "d1", "black");
    Map<String, Object> as = ctx.manager.sync(ctx.carol.id(), a.id());
    assertThat(json(map(as.get("players")).get("2"))).isEqualTo("{\"ai\":true,\"level\":\"d1\",\"nickname\":\"AI · 1段\",\"avatarUrl\":\"\"}");
    assertThat(json(as.get("presence"))).isEqualTo("{\"1\":false,\"2\":true}");
    assertThat(as.get("timeControl")).isNull();
    assertThat(as.get("clocks")).isNull();
  }

  @Test
  void syncEndedFromMemoryThenDb() {
    Ctx ctx = new Ctx();
    GameSession s = ctx.ranked();
    ctx.play(s, 40, 41);
    ctx.manager.resign(ctx.alice.id(), s.id());
    Map<String, Object> a = ctx.manager.sync(ctx.alice.id(), s.id());
    assertThat(a.get("status")).isEqualTo("ended");
    assertThat(map(a.get("result")).get("text")).isEqualTo("W+R");
    int findsBefore = ctx.store.callsOf("games.findById").size();
    ctx.loop.advance(GameManager.ENDED_KEEP_MS);
    Map<String, Object> b = ctx.manager.sync(ctx.bob.id(), s.id());
    assertThat(ctx.store.callsOf("games.findById").size()).isGreaterThan(findsBefore);
    assertThat(b.get("status")).isEqualTo("ended");
    assertThat(b.get("moves")).isEqualTo(List.of(40, 41));
    assertThat(map(b.get("result")).get("text")).isEqualTo("W+R");
    assertThat(map(b.get("result")).get("counted")).isEqualTo(true);
    assertThat(codeOf(() -> ctx.manager.sync(ctx.carol.id(), s.id()))).isEqualTo("not_player");
    assertThat(codeOf(() -> ctx.manager.move(ctx.carol.id(), s.id(), 3, 1))).isEqualTo("not_player");
    assertThat(codeOf(() -> ctx.manager.move(ctx.alice.id(), s.id(), 3, 1))).isEqualTo("wrong_phase");
  }

  // ---------------------------------------------------------------- 重启恢复

  @Test
  void restoreFromUnfinished() {
    TestAi ai = new TestAi();
    ai.manual = true;
    ai.manualJudge = true;
    Ctx ctx = new Ctx(null, ai);
    GameSession g1 = ctx.ranked();
    ctx.play(g1, 40, 41, 42);
    GameSession g2 = ctx.manager.createHumanGame("friend", 9, ctx.carol.id(), ctx.bob.id());
    ctx.play(g2, 40, -1, -1);
    GameSession g3 = ctx.manager.startAiGame(ctx.alice.id(), 9, "k10", "black");
    ctx.manager.move(ctx.alice.id(), g3.id(), 1, 40);
    GameClock.Side b1 = g1.clock.side(1);
    GameClock.Side w1 = g1.clock.side(2);
    MemoryStore.Row broken = new MemoryStore.Row();
    broken.id = "broken000001";
    broken.mode = "ranked";
    broken.size = 9;
    broken.komi = 7.5;
    broken.blackId = ctx.alice.id();
    broken.whiteId = ctx.carol.id();
    broken.timeControl = new TimeControl(1000, 0, 0);
    broken.moves = List.of(40, 40);
    broken.createdAt = ctx.loop.now();
    broken.updatedAt = ctx.loop.now();
    ctx.store.putRow(broken);
    ctx.manager.shutdown();

    ctx.loop.advance(3600000);
    ctx.hub.online.clear();
    int judgeBefore = ai.judgeDeadCalls.size();
    int moveBefore = ai.chooseMoveCalls.size();
    GameManager m2 = ctx.makeManager();
    assertThat(m2.restore()).isEqualTo(3);
    assertThat(ctx.store.row("broken000001").status).isEqualTo("ended");
    assertThat(ctx.store.row("broken000001").reason).isEqualTo("abort");
    assertThat(ctx.store.row("broken000001").cause).isEqualTo("broken");
    assertThat(ctx.log.error).hasSize(1);

    GameSession r1 = m2.getSession(g1.id());
    assertThat(r1.moves).containsExactly(40, 41, 42);
    assertThat(r1.clock.side(1)).isEqualTo(b1);
    assertThat(r1.clock.side(2)).isEqualTo(w1);
    assertThat(r1.clock.running()).as("轮到的白方还没重新连上：先不走钟").isEqualTo(0);
    assertThat(r1.online[1]).isFalse();
    assertThat(r1.online[2]).isFalse();
    assertThat(r1.arrival.waiting[1]).isTrue();
    assertThat(r1.arrival.waiting[2]).isTrue();
    assertThat(m2.activeGamesOf(ctx.alice.id()).stream().map(g -> (String) g.get("id")).sorted().toList())
        .isEqualTo(List.of(g1.id(), g3.id()).stream().sorted().toList());

    GameSession r2 = m2.getSession(g2.id());
    assertThat(r2.status()).isEqualTo("scoring");
    assertThat(r2.scoring.pending).isTrue();
    assertThat(ai.judgeDeadCalls).hasSize(judgeBefore + 1);
    ai.resolveNextJudge(); // 停机前的那次（旧管理器已关闭）→ 忽略
    ai.resolveNextJudge();
    ctx.flush();
    assertThat(r2.scoring.pending).isFalse();
    assertThat(r2.scoring.version).isEqualTo(1);

    GameSession r3 = m2.getSession(g3.id());
    assertThat(r3.aiThinking).isTrue();
    assertThat(ai.chooseMoveCalls).hasSize(moveBefore + 1);
    ai.resolveNextMove(AiMove.of(7)); // 旧管理器的请求 → 忽略
    ai.resolveNextMove(AiMove.of(8));
    ctx.flush();
    assertThat(r3.moves).containsExactly(40, 8);

    m2.userOnline(ctx.alice.id());
    ctx.loop.advance(90000);
    assertThat(r1.status()).isEqualTo("playing");
    ctx.loop.advance(210000);
    assertThat(r1.status()).isEqualTo("ended");
    assertThat(r1.result.reason()).isEqualTo("abort");
    m2.shutdown();
  }

  @Test
  void restoreAiIdleFromLastActivity() {
    Ctx ctx = new Ctx();
    GameSession s = ctx.manager.startAiGame(ctx.alice.id(), 9, "k10", "black");
    ctx.manager.shutdown();
    ctx.loop.advance(86400000L + 5);
    GameManager m2 = ctx.makeManager();
    m2.restore();
    ctx.loop.tick();
    assertThat(ctx.store.row(s.id()).reason).isEqualTo("abort");
    assertThat(m2.getSession(s.id())).isNull();
  }

  // ---------------------------------------------------------------- limits.test.js

  @Test
  void stallingLoopBounded() {
    Ctx ctx = new Ctx(null, new TestAi().dead(10));
    GameSession s = ctx.ranked();
    ctx.play(s, WALL);
    int cycles = 0;
    for (int i = 0; i < 50; i++) {
      ctx.play(s, -1, -1);
      ctx.flush();
      try {
        ctx.manager.resumeScore(ctx.bob.id(), s.id());
        cycles += 1;
      } catch (GameError e) {
        assertThat(e.code()).isEqualTo("wrong_phase");
        break;
      }
    }
    assertThat(cycles).isEqualTo(1);
    assertThat(s.status()).isEqualTo("scoring");
    assertThat(ctx.ai.judgeDeadCalls).as("局面没变：第二次数子复用死子判断").hasSize(1);
    assertThat(json(scoringOf(ctx.hub.last("game.scoring", ctx.alice.id())).get("resumesLeft"))).isEqualTo("{\"1\":1,\"2\":0}");
    ctx.loop.advance(180000);
    assertThat(s.status()).isEqualTo("ended");
    assertThat(s.result.winner()).isEqualTo(1);
    assertThat(s.result.reason()).isEqualTo("score");
  }

  @Test
  void resumeGuardAfterAgreedPlayerLeaves() {
    Ctx ctx = new Ctx(tc9(0, 10, 30000), new TestAi().dead(10));
    GameSession s = ctx.ranked();
    ctx.play(s, concat(WALL, -1, -1));
    ctx.flush();
    ctx.manager.acceptScore(ctx.alice.id(), s.id(), 1);
    ctx.manager.userOffline(ctx.alice.id());
    assertThat(codeOf(() -> ctx.manager.resumeScore(ctx.bob.id(), s.id()))).isEqualTo("wrong_phase");
    ctx.manager.userOnline(ctx.alice.id());
    ctx.manager.resumeScore(ctx.bob.id(), s.id());
    ctx.loop.advance(5000);
    ctx.manager.userOffline(ctx.alice.id());
    ctx.hub.clear();
    ctx.loop.advance(90000);
    assertThat(s.status()).isEqualTo("ended");
    assertThat(s.result).isEqualTo(new Result(1, "score", 45.0, 43.5));
    assertThat(ctx.hub.types(ctx.bob.id())).containsExactly("game.scoring", "game.end");
    MemoryStore.Row row = ctx.store.row(s.id());
    assertThat(row.moves).containsExactlyElementsOf(Msg.list(concat(WALL, -1, -1)));
    assertThat(row.reason).isEqualTo("score");
    assertThat(((GameStore.RankedApply) ctx.store.callsOf("stats.applyRanked").get(0).arg()).winnerId()).isEqualTo(ctx.alice.id());
    ctx.noErrors();
  }

  @Test
  void endSaveFailureRetriesAndPushesAgain() {
    Ctx ctx = new Ctx();
    GameSession s = ctx.ranked();
    ctx.play(s, 0, 8, 1, 7, 2, 6, 9, 17, 10, 16, 18, 26);
    ctx.store.failOn("stats.applyRanked", 1, new IllegalStateException("database or disk is full"));
    ctx.manager.resign(ctx.bob.id(), s.id());
    Map<String, Object> end = ctx.hub.of("game.end", ctx.alice.id()).get(0);
    assertThat(resultOf(end).get("counted")).isEqualTo(false);
    assertThat(resultOf(end).get("pending")).isEqualTo(true);
    assertThat(end).doesNotContainKey("stats");
    assertThat(ctx.store.row(s.id()).status).as("事务整体回滚").isEqualTo("playing");
    assertThat(ctx.log.error).hasSize(1);
    assertThat(codeOf(() -> ctx.manager.move(ctx.alice.id(), s.id(), 13, 30))).isEqualTo("wrong_phase");
    assertThat(ctx.manager.sync(ctx.alice.id(), s.id()).get("status")).isEqualTo("ended");
    assertThat(map(ctx.manager.sync(ctx.alice.id(), s.id()).get("result")).get("pending")).isEqualTo(true);
    ctx.loop.advance(1000);
    MemoryStore.Row row = ctx.store.row(s.id());
    assertThat(row.status).isEqualTo("ended");
    assertThat(row.reason).isEqualTo("resign");
    assertThat(row.counted).isTrue();
    assertThat(ctx.store.stats(ctx.alice.id()).wins()).isEqualTo(1);
    assertThat(s.counted).isTrue();
    List<Map<String, Object>> ends = ctx.hub.of("game.end", ctx.alice.id());
    assertThat(ends).as("补写成功后再推送一次").hasSize(2);
    assertThat(resultOf(ends.get(1)).get("pending")).isEqualTo(false);
    assertThat(resultOf(ends.get(1)).get("counted")).isEqualTo(true);
    assertThat(map(map(ends.get(1).get("stats")).get("1")).get("wins")).isEqualTo(1L);
    assertThat(ctx.hub.of("game.end", ctx.bob.id())).hasSize(2);
    assertThat(map(ctx.manager.sync(ctx.bob.id(), s.id()).get("result")).get("counted")).isEqualTo(true);
    ctx.loop.advance(120000);
    assertThat(ctx.store.callsOf("stats.applyRanked")).as("失败 1 次 + 成功 1 次").hasSize(2);
    assertThat(ctx.store.stats(ctx.bob.id()).losses()).isEqualTo(1);
  }

  @Test
  void endSaveKeepsFailingShutdownWritesOnce() {
    Ctx ctx = new Ctx();
    GameSession s = ctx.ranked();
    ctx.play(s, 0, 8, 1, 7, 2, 6, 9, 17, 10, 16, 18, 26);
    ctx.store.failOn("transaction", 4, new IllegalStateException("SQLITE_IOERR"));
    ctx.manager.resign(ctx.bob.id(), s.id());
    ctx.loop.advance(1000 + 5000 + 15000);
    assertThat(ctx.store.row(s.id()).status).isEqualTo("playing");
    ctx.manager.shutdown();
    assertThat(ctx.store.row(s.id()).status).isEqualTo("ended");
    assertThat(ctx.store.row(s.id()).counted).isTrue();
    assertThat(ctx.makeManager().restore()).isEqualTo(0);
  }

  @Test
  void aiSlotsPerUser() {
    TestAi ai = new TestAi();
    ai.manual = true;
    Ctx ctx = new Ctx(b -> b.aiStartBurst(100), ai);
    long uid = ctx.alice.id();
    for (int i = 0; i < 20; i++) {
      GameSession g = ctx.manager.startAiGame(uid, 9, "k10", "white");
      assertThat(g.aiThinking).as("排队中也显示 AI 思考中").isTrue();
    }
    assertThat(ai.chooseMoveCalls).hasSize(2);
    assertThat(ctx.manager.aiInflightOf(uid)).isEqualTo(2);
    assertThat(ctx.manager.aiWaiting).as("只有当前这局在排队").hasSize(1);
    ai.resolveNextMove();
    ctx.flush();
    assertThat(ai.chooseMoveCalls).hasSize(3);
    ai.resolveNextMove();
    ctx.flush();
    GameSession cur = ctx.manager.aiGamesOf(uid).get(0);
    ai.resolveNextMove(AiMove.of(0));
    ctx.flush();
    assertThat(cur.moves).containsExactly(0);
    assertThat(ctx.manager.aiInflightOf(uid)).isEqualTo(0);

    int maxInflight = 0;
    for (int i = 0; i < 30; i++) {
      ctx.manager.move(uid, cur.id(), cur.moves.size() + 1, 40);
      maxInflight = Math.max(maxInflight, ctx.manager.aiInflightOf(uid));
      ctx.manager.undo(uid, cur.id());
    }
    assertThat(maxInflight).isEqualTo(2);
    assertThat(ai.chooseMoveCalls).as("只有 2 个新请求真正发给了 AI").hasSize(3 + 2);
    ctx.loop.advance(60000);
    ctx.flush();
    assertThat(ctx.manager.aiInflightOf(uid)).isEqualTo(0);
  }

  @Test
  void aiSlotsGlobal() {
    TestAi ai = new TestAi();
    ai.manual = true;
    Ctx ctx = new Ctx(b -> b.aiMaxInflight(2), ai);
    List<GameSession> games = new ArrayList<>();
    for (long uid : new long[] {ctx.alice.id(), ctx.bob.id(), ctx.carol.id()}) games.add(ctx.manager.startAiGame(uid, 9, "k10", "white"));
    assertThat(ai.chooseMoveCalls).hasSize(2);
    assertThat(ctx.manager.aiWaiting).containsKey(games.get(2).id());
    ai.resolveNextMove(AiMove.of(0));
    ctx.flush();
    assertThat(ai.chooseMoveCalls).hasSize(3);
    assertThat(games.get(0).moves).containsExactly(0);
    ctx.manager.resign(ctx.carol.id(), games.get(2).id());
    ai.resolveNextMove(AiMove.of(0));
    ai.resolveNextMove(AiMove.of(0));
    ctx.flush();
    assertThat(ctx.manager.aiWaiting).isEmpty();
    assertThat(ctx.manager.aiInflightTotal()).isEqualTo(0);
  }

  @Test
  void endedCacheBoundedAndEmptyAiGamesDeleted() {
    Ctx ctx = new Ctx(b -> b.endedCacheMax(3), null);
    for (int i = 0; i < 6; i++) {
      GameSession g = ctx.manager.startAiGame(ctx.alice.id(), 9, "k10", "black");
      ctx.manager.move(ctx.alice.id(), g.id(), 1, 40 + i);
      ctx.manager.resign(ctx.alice.id(), g.id());
    }
    assertThat(ctx.manager.endedCache).hasSize(3);
    for (int i = 0; i < 10; i++) ctx.manager.startAiGame(ctx.alice.id(), 9, "k10", "black");
    assertThat(ctx.store.games).as("10 个空局只剩当前这一局").hasSize(6 + 1);
    assertThat(ctx.manager.endedCache).hasSize(3);
  }

  // ---------------------------------------------------------------- fairness-manager.test.js

  @Test
  void fs1NoKatagoDisputeVoidsStatsUnchanged() {
    TestAi ai = new TestAi();
    ai.available = false;
    Ctx ctx = new Ctx(null, ai);
    GameSession s = ctx.ranked();
    ctx.play(s, concat(WALL, -1, -1));
    ctx.flush();
    assertThat(s.scoring.source).isEqualTo("manual");
    ctx.offline(ctx.bob);
    ctx.manager.toggleDead(ctx.alice.id(), s.id(), 10, null);
    ctx.manager.acceptScore(ctx.alice.id(), s.id(), s.scoring.version);
    assertThat(codeOf(() -> ctx.manager.resumeScore(ctx.alice.id(), s.id()))).isEqualTo("wrong_phase");
    Map<String, Object> last = scoringOf(ctx.hub.last("game.scoring", ctx.alice.id()));
    assertThat(json(last.get("atDeadline"))).isEqualTo("{\"void\":true,\"cause\":\"score_dispute\"}");
    ctx.loop.advance(10 * 60 * 1000);
    MemoryStore.Row row = ctx.store.row(s.id());
    assertThat(row.reason).isEqualTo("abort");
    assertThat(row.cause).isEqualTo("score_dispute");
    assertThat(row.counted).isFalse();
    assertThat(resultOf(ctx.hub.last("game.end", ctx.alice.id())).get("cause")).isEqualTo("score_dispute");
    assertThat(ctx.store.stats(ctx.bob.id()).wins()).isEqualTo(0);
    assertThat(ctx.store.stats(ctx.alice.id()).losses()).isEqualTo(0);
    ctx.noErrors();
  }

  @Test
  void fs67RestartKeepsResumeCountAndGuard() {
    Ctx ctx = new Ctx(tc9(0, 10, 30000), new TestAi().dead(10));
    GameSession s = ctx.ranked();
    ctx.play(s, concat(WALL, -1, -1));
    ctx.flush();
    ctx.manager.acceptScore(ctx.alice.id(), s.id(), 1);
    ctx.manager.resumeScore(ctx.bob.id(), s.id());
    JsonNodeAssert.state(ctx.store.row(s.id()).state, "{\"1\":0,\"2\":1}", 1);

    ctx.manager.shutdown();
    ctx.hub.online.clear();
    GameManager m2 = ctx.makeManager();
    m2.restore();
    GameSession r = m2.getSession(s.id());
    assertThat(r.resumesLeft(2)).isEqualTo(0);
    assertThat(r.resumeGuard).isNotNull();
    ctx.hub.online.add(ctx.bob.id());
    m2.userOnline(ctx.bob.id());
    assertThat(codeOf(() -> m2.resumeScore(ctx.bob.id(), s.id()))).isEqualTo("wrong_phase");
    ctx.loop.advance(90000);
    MemoryStore.Row row = ctx.store.row(s.id());
    assertThat(row.status).isEqualTo("ended");
    assertThat(row.reason).isEqualTo("score");
    assertThat(row.cause).isEqualTo("resume_undone");
    assertThat(row.resultText).isEqualTo("B+1.5");
    assertThat(row.moves).containsExactlyElementsOf(Msg.list(concat(WALL, -1, -1)));
    assertThat(ctx.store.stats(ctx.alice.id()).wins()).isEqualTo(1);
    m2.shutdown();
  }

  /** games.state 的断言。 */
  static final class JsonNodeAssert {
    static void state(com.fasterxml.jackson.databind.JsonNode st, String resumesUsed, int guardColor) {
      assertThat(st.get("resumesUsed").toString()).isEqualTo(resumesUsed);
      assertThat(st.get("guard").get("color").asInt()).isEqualTo(guardColor);
    }
  }

  @Test
  void fs8OneJudgeInflightPerGameAndReuse() {
    TestAi ai = new TestAi();
    ai.manualJudge = true;
    Ctx ctx = new Ctx(null, ai);
    GameSession s = ctx.manager.startAiGame(ctx.alice.id(), 9, "k10", "black");
    ctx.manager.move(ctx.alice.id(), s.id(), 1, 40);
    ctx.flush();
    for (int i = 0; i < 5; i++) {
      ctx.manager.pass(ctx.alice.id(), s.id(), s.moves.size() + 1);
      ctx.flush();
      assertThat(s.status()).isEqualTo("scoring");
      ctx.manager.undo(ctx.alice.id(), s.id());
      assertThat(s.status()).isEqualTo("playing");
    }
    ctx.manager.pass(ctx.alice.id(), s.id(), s.moves.size() + 1);
    ctx.flush();
    assertThat(ai.judgeDeadCalls).as("同一局面：只请求一次").hasSize(1);
    ai.resolveNextJudge();
    ctx.flush();
    assertThat(s.scoring.pending).isFalse();
    int judged = ai.judgeDeadCalls.size();

    ctx.manager.undo(ctx.alice.id(), s.id());
    ctx.manager.move(ctx.alice.id(), s.id(), s.moves.size() + 1, 30);
    ctx.flush();
    ctx.manager.pass(ctx.alice.id(), s.id(), s.moves.size() + 1);
    ctx.flush();
    assertThat(ai.judgeDeadCalls).hasSize(judged + 1);
    ctx.manager.undo(ctx.alice.id(), s.id());
    ctx.manager.move(ctx.alice.id(), s.id(), s.moves.size() + 1, 50);
    ctx.flush();
    ctx.manager.pass(ctx.alice.id(), s.id(), s.moves.size() + 1);
    ctx.flush();
    assertThat(ai.pendingJudges).as("前一个局面还在判断：新局面排队，不并发").hasSize(1);
    ai.resolveNextJudge();
    ctx.flush();
    assertThat(ai.judgeDeadCalls).as("前一个结束后才请求新局面").hasSize(judged + 2);
    ai.resolveNextJudge();
    ctx.flush();
    assertThat(s.scoring.pending).isFalse();
    ctx.noErrors();
  }

  @Test
  void comp5PairDailyLimit() {
    Ctx ctx = new Ctx();
    List<GameSession> games = new ArrayList<>();
    for (int i = 0; i < 4; i++) {
      GameSession s = ctx.ranked();
      ctx.play(s, TEN);
      ctx.manager.resign(ctx.bob.id(), s.id());
      games.add(s);
    }
    assertThat(games.stream().map(g -> g.counted).toList()).containsExactly(true, true, true, false);
    assertThat(resultOf(ctx.hub.last("game.end", ctx.alice.id())).get("uncounted")).isEqualTo("pair_limit");
    assertThat(ctx.store.stats(ctx.alice.id()).wins()).isEqualTo(3);
    ctx.loop.advance(GameManager.ENDED_KEEP_MS);
    assertThat(map(ctx.manager.sync(ctx.alice.id(), games.get(3).id()).get("result")).get("uncounted")).isEqualTo("pair_limit");
    GameSession other = ctx.manager.createHumanGame("ranked", 9, ctx.carol.id(), ctx.bob.id());
    ctx.hub.online.add(ctx.carol.id());
    ctx.manager.userOnline(ctx.carol.id());
    ctx.play(other, TEN);
    ctx.manager.resign(ctx.bob.id(), other.id());
    assertThat(other.counted).isTrue();
    ctx.loop.advance(86400000L + 1);
    GameSession later = ctx.ranked();
    ctx.play(later, TEN);
    ctx.manager.resign(ctx.bob.id(), later.id());
    assertThat(later.counted).isTrue();

    Ctx unlimited = new Ctx(b -> b.rankedPairDailyMax(0), null);
    for (int i = 0; i < 5; i++) {
      GameSession s = unlimited.ranked();
      unlimited.play(s, TEN);
      unlimited.manager.resign(unlimited.bob.id(), s.id());
      assertThat(s.counted).isTrue();
    }
  }
}
