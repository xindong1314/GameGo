package com.gamego.ws;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.gamego.config.TimeControl;
import com.gamego.db.GameRow;
import com.gamego.db.NewGame;
import com.gamego.game.GameSettings;
import com.gamego.game.Json;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * 端到端：真实 WebSocket 客户端对真实服务（对应 Node 测试 game/e2e.test.js、ws-limits.test.js 与 integration/*.test.js 的主要用例）。
 */
class WsEndToEndTest extends WsTestBase {

  static String json(Object o) {
    return Json.write(o);
  }

  @Test
  void authRejectionsHelloAndPing() throws Exception {
    assertThatThrownBy(() -> connect(null)).isInstanceOfSatisfying(WsClient.Rejected.class, e -> assertThat(e.status).isEqualTo(401));
    String raw = rawUpgrade("/ws", null);
    assertThat(raw).startsWith("HTTP/1.1 401");
    assertThat(raw).contains("\"code\":\"unauthorized\"");
    assertThatThrownBy(() -> connect("nope")).isInstanceOfSatisfying(WsClient.Rejected.class, e -> assertThat(e.status).isEqualTo(401));
    U u = user("Ann");
    assertThat(rawUpgrade("/other?token=" + u.token(), null)).startsWith("HTTP/1.1 404");
    sessions.revoke(u.token());
    assertThatThrownBy(() -> connect(u.token())).isInstanceOfSatisfying(WsClient.Rejected.class, e -> assertThat(e.status).isEqualTo(401));

    U v = user("Ben");
    WsClient c = connect(v.token());
    assertThat(json(c.req("hello"))).isEqualTo("{\"activeGames\":[],\"room\":null,\"matching\":null}");
    c.send(p("t", "ping", "rid", 99));
    JsonNode pong = c.waitFor("pong");
    assertThat(pong.get("ts").isNumber()).isTrue();
    WsClient.sleep(50);
    assertThat(c.logCopy()).noneMatch(m -> "res".equals(m.path("t").asText()) && m.path("rid").asInt() == 99);
  }

  @Test
  void authorizationHeaderToken() throws Exception {
    U u = user("Ann");
    WsClient c = connectHeader(u.token());
    assertThat(c.req("hello").get("activeGames").size()).isEqualTo(0);
    assertThatThrownBy(() -> connectHeader("0".repeat(64)))
        .isInstanceOfSatisfying(WsClient.Rejected.class, e -> assertThat(e.status).isEqualTo(401));
    // 头与 ?token= 都有时以头为准
    assertThat(rawUpgrade("/ws?token=" + u.token(), "Authorization: Bearer " + "0".repeat(64) + "\r\n")).startsWith("HTTP/1.1 401");
  }

  @Test
  void rankedFullFlow() {
    ai.dead(10);
    P a = player("Ann");
    P b = player("Ben");
    assertThat(json(a.c().req("match.join", p("size", 9)))).isEqualTo("{\"size\":9}");
    assertThat(json(a.c().req("hello").get("matching"))).isEqualTo("{\"size\":9}");
    JsonNode res = b.c().request("match.join", p("size", 9));
    assertThat(json(res.get("data"))).isEqualTo("{\"size\":9}");
    String gameId = a.c().waitFor("match.found").get("gameId").asText();
    assertThat(b.c().waitFor("match.found").get("gameId").asText()).isEqualTo(gameId);
    // res 先于它引起的推送
    List<JsonNode> log = b.c().logCopy();
    int resAt = -1;
    int foundAt = -1;
    for (int i = 0; i < log.size(); i++) {
      if (log.get(i) == res) resAt = i;
      if (foundAt < 0 && "match.found".equals(log.get(i).path("t").asText())) foundAt = i;
    }
    assertThat(resAt).isLessThan(foundAt);
    assertThat(json(realtime.activeGamesOf(a.id()))).isEqualTo("[{\"id\":\"" + gameId + "\",\"mode\":\"ranked\"}]");
    assertThat(json(a.c().req("hello").get("activeGames"))).isEqualTo("[{\"id\":\"" + gameId + "\",\"mode\":\"ranked\"}]");

    Pair g = syncBoth(a, b, gameId);
    assertThat(g.snap().get("mode").asText()).isEqualTo("ranked");
    assertThat(g.snap().get("status").asText()).isEqualTo("playing");
    assertThat(g.snap().get("timeControl").toString()).isEqualTo("{\"mainMs\":180000,\"periods\":3,\"periodMs\":20000}");
    assertThat(g.snap().get("clocks").get("running").asInt()).isEqualTo(1);
    assertThat(g.snap().get("presence").toString()).isEqualTo("{\"1\":true,\"2\":true}");
    assertThat(g.snap().get("players").get("1").get("userId").asLong()).isEqualTo(g.black().id());
    assertThat(g.snap().get("players").get("2").get("nickname").asText()).isEqualTo(g.white().user().nickname());

    assertThat(g.white().c().errCode("game.move", p("gameId", gameId, "n", 1, "idx", 0))).isEqualTo("not_your_turn");
    assertThat(g.black().c().errCode("game.move", p("gameId", gameId, "n", 2, "idx", 0))).isEqualTo("stale");
    assertThat(a.c().errCode("match.join", p("size", 13))).isEqualTo("in_game");

    int n = playMoves(g, 1, WALL);
    JsonNode illegal = g.black().c().request("game.move", p("gameId", gameId, "n", n, "idx", 4));
    assertThat(illegal.get("err").get("code").asText()).isEqualTo("illegal");
    assertThat(illegal.get("err").get("reason").asText()).isEqualTo("occupied");
    n = playMoves(g, n, -1, -1);

    JsonNode pending = g.black().c().waitFor("game.scoring", m -> m.get("scoring").get("pending").asBoolean());
    assertThat(pending.get("scoring").get("version").asInt()).isEqualTo(0);
    JsonNode prop = g.white().c().waitFor("game.scoring", m -> !m.get("scoring").get("pending").asBoolean());
    assertThat(prop.get("scoring").get("source").asText()).isEqualTo("katago");
    assertThat(prop.get("scoring").get("dead").toString()).isEqualTo("[10]");
    assertThat(prop.get("scoring").get("winner").asInt()).isEqualTo(1);
    long deadline = prop.get("scoring").get("deadline").asLong();
    assertThat(deadline).isGreaterThan(170000).isLessThanOrEqualTo(180000);
    assertThat(prop.get("scoring").get("owner").size()).isEqualTo(81);
    assertThat(prop.get("scoring").get("resumesLeft").toString()).isEqualTo("{\"1\":1,\"2\":1}");
    assertThat(prop.get("scoring").get("atDeadline").get("void").asBoolean()).isFalse();
    g.black().c().drain("game.scoring");
    g.white().c().drain("game.scoring");

    assertThat(g.black().c().errCode("game.move", p("gameId", gameId, "n", n, "idx", 0))).isEqualTo("wrong_phase");
    g.white().c().req("game.score.toggle", p("gameId", gameId, "idx", 10));
    JsonNode t2 = g.black().c().waitFor("game.scoring");
    assertThat(t2.get("scoring").get("version").asInt()).isEqualTo(2);
    assertThat(t2.get("scoring").get("dead").toString()).isEqualTo("[]");
    assertThat(t2.get("scoring").get("winner").asInt()).isEqualTo(2);
    assertThat(g.black().c().errCode("game.score.accept", p("gameId", gameId, "version", 1))).isEqualTo("stale");
    g.black().c().req("game.score.toggle", p("gameId", gameId, "idx", 10, "version", 2));
    JsonNode t3 = g.white().c().waitFor("game.scoring", m -> m.get("scoring").get("version").asInt() == 3);
    assertThat(t3.get("scoring").get("dead").toString()).isEqualTo("[10]");
    g.black().c().req("game.score.accept", p("gameId", gameId, "version", 3));
    JsonNode acc = g.white().c().waitFor("game.scoring", m -> m.get("scoring").get("accepted").get("1").asBoolean());
    assertThat(acc.get("scoring").get("accepted").toString()).isEqualTo("{\"1\":true,\"2\":false}");
    g.white().c().req("game.score.accept", p("gameId", gameId, "version", 3));

    for (int c = 1; c <= 2; c++) {
      JsonNode end = g.of(c).c().waitFor("game.end");
      assertThat(end.get("result").toString())
          .isEqualTo("{\"winner\":1,\"reason\":\"score\",\"black\":45,\"white\":43.5,\"text\":\"B+1.5\",\"label\":\"黑胜 1.5 目\","
              + "\"counted\":true,\"cause\":\"agreed\",\"uncounted\":null,\"pending\":false}");
      assertThat(end.get("stats").get("1").toString())
          .isEqualTo("{\"games\":1,\"wins\":1,\"losses\":0,\"draws\":0,\"winrate\":1,\"curStreak\":1,\"maxStreak\":1}");
      assertThat(end.get("stats").get("2").toString())
          .isEqualTo("{\"games\":1,\"wins\":0,\"losses\":1,\"draws\":0,\"winrate\":0,\"curStreak\":0,\"maxStreak\":0}");
    }
    GameRow row = games.findById(gameId);
    assertThat(row.status()).isEqualTo("ended");
    assertThat(row.resultText()).isEqualTo("B+1.5");
    assertThat(row.dead()).containsExactly(10);
    assertThat(row.counted()).isTrue();
    assertThat(row.cause()).isEqualTo("agreed");
    assertThat(stats.get(g.black().id()).wins()).isEqualTo(1);
    assertThat(a.c().req("hello").get("activeGames").size()).isEqualTo(0);
    JsonNode after = g.white().c().req("game.sync", p("gameId", gameId)).get("game");
    assertThat(after.get("status").asText()).isEqualTo("ended");
    assertThat(after.get("result").get("text").asText()).isEqualTo("B+1.5");
    assertThat(g.white().c().errCode("game.resign", p("gameId", gameId))).isEqualTo("wrong_phase");
  }

  @Test
  void resumeThenResignManualScoring() {
    ai.available(false);
    P a = player("Ann");
    P b = player("Ben");
    Pair g = matchPair(a, b, 9);
    int n = playMoves(g, 1, 40, -1, -1);
    JsonNode manual = g.black().c().waitFor("game.scoring", m -> !m.get("scoring").get("pending").asBoolean());
    assertThat(manual.get("scoring").get("source").asText()).isEqualTo("manual");
    g.black().c().req("game.score.resume", p("gameId", g.gameId()));
    for (int c = 1; c <= 2; c++) {
      JsonNode r = g.of(c).c().waitFor("game.resumed");
      assertThat(r.get("toPlay").asInt()).isEqualTo(2);
      assertThat(r.get("clocks").get("running").asInt()).isEqualTo(2);
    }
    playMoves(g, n, 41);
    g.black().c().req("game.resign", p("gameId", g.gameId()));
    JsonNode end = g.white().c().waitFor("game.end");
    assertThat(end.get("result").get("winner").asInt()).isEqualTo(2);
    assertThat(end.get("result").get("reason").asText()).isEqualTo("resign");
    assertThat(end.get("result").get("counted").asBoolean()).isTrue();
    assertThat(stats.get(g.white().id()).wins()).isEqualTo(1);
  }

  @Test
  void friendRoomCreateGetJoinLeaveExpire() {
    restart(settings().roomTtlMs(300).build(), null);
    P owner = player("Owner");
    P guest = player("Guest");
    P other = player("Other");
    JsonNode room = owner.c().req("room.create", p("size", 13, "color", "black")).get("room");
    String code = room.get("code").asText();
    assertThat(code).matches("^\\d{6}$");
    assertThat(room.get("status").asText()).isEqualTo("waiting");
    assertThat(room.get("owner").toString()).isEqualTo("{\"userId\":" + owner.id() + ",\"nickname\":\"Owner\",\"avatarUrl\":\"\"}");
    assertThat(owner.c().req("hello").get("room").get("code").asText()).isEqualTo(code);
    assertThat(guest.c().req("room.get", p("code", code)).get("room").get("code").asText()).isEqualTo(code);
    other.c().req("room.get", p("code", code));
    assertThat(guest.c().errCode("room.get", p("code", code.equals("000000") ? "000001" : "000000"))).isEqualTo("room_not_found");
    assertThat(owner.c().errCode("room.join", p("code", code))).isEqualTo("own_room");
    String gameId = guest.c().req("room.join", p("code", code)).get("gameId").asText();
    for (WsClient c : List.of(owner.c(), guest.c())) {
      assertThat(c.waitFor("game.start").toString()).isEqualTo("{\"t\":\"game.start\",\"gameId\":\"" + gameId + "\",\"mode\":\"friend\"}");
    }
    assertThat(other.c().waitFor("room.update").get("room").get("status").asText()).isEqualTo("closed");
    JsonNode snap = owner.c().req("game.sync", p("gameId", gameId)).get("game");
    assertThat(snap.get("mode").asText()).isEqualTo("friend");
    assertThat(snap.get("size").asInt()).isEqualTo(13);
    assertThat(snap.get("myColor").asInt()).isEqualTo(1);
    assertThat(snap.get("timeControl").toString()).isEqualTo("{\"mainMs\":360000,\"periods\":3,\"periodMs\":30000}");
    assertThat(other.c().errCode("room.join", p("code", code))).isEqualTo("room_not_found");

    String r2 = other.c().req("room.create", p("size", 9, "color", "random")).get("room").get("code").asText();
    other.c().req("room.leave");
    assertThat(guest.c().errCode("room.get", p("code", r2))).isEqualTo("room_not_found");
    other.c().req("room.leave");

    String r3 = other.c().req("room.create", p("size", 19, "color", "white")).get("room").get("code").asText();
    JsonNode exp = other.c().waitFor("room.update", null, 3000);
    assertThat(exp.get("room").get("code").asText()).isEqualTo(r3);
    assertThat(exp.get("room").get("status").asText()).isEqualTo("closed");
    assertThat(exp.get("room").get("expiresIn").asLong()).isEqualTo(0);
    assertThat(other.c().req("hello").get("room").isNull()).isTrue();
  }

  @Test
  void aiGameMoveUndoPassScoreAccept() {
    P a = player("Ann");
    assertThat(a.c().errCode("ai.start", p("size", 9, "level", "nope", "color", "black"))).isEqualTo("bad_request");
    String gameId = a.c().req("ai.start", p("size", 9, "level", "k5", "color", "black")).get("gameId").asText();
    JsonNode snap = a.c().req("game.sync", p("gameId", gameId)).get("game");
    assertThat(snap.get("mode").asText()).isEqualTo("ai");
    assertThat(snap.get("myColor").asInt()).isEqualTo(1);
    assertThat(snap.get("players").get("2").toString()).isEqualTo("{\"ai\":true,\"level\":\"k5\",\"nickname\":\"AI · 5级\",\"avatarUrl\":\"\"}");
    assertThat(snap.get("timeControl").isNull()).isTrue();
    assertThat(snap.get("canUndo").asBoolean()).isFalse();
    assertThat(snap.get("presence").toString()).isEqualTo("{\"1\":true,\"2\":true}");

    a.c().req("game.move", p("gameId", gameId, "n", 1, "idx", 40));
    a.c().waitFor("game.move", m -> m.get("n").asInt() == 1);
    assertThat(a.c().waitFor("game.ai").get("thinking").asBoolean()).isTrue();
    JsonNode aiMove = a.c().waitFor("game.move", m -> m.get("n").asInt() == 2);
    assertThat(aiMove.get("color").asInt()).isEqualTo(2);
    assertThat(aiMove.get("clocks").isNull()).isTrue();
    assertThat(a.c().waitFor("game.ai").get("thinking").asBoolean()).isFalse();
    assertThat(a.c().req("game.sync", p("gameId", gameId)).get("game").get("canUndo").asBoolean()).isTrue();

    a.c().req("game.undo", p("gameId", gameId));
    assertThat(a.c().waitFor("game.undo").get("moves").toString()).isEqualTo("[]");
    assertThat(a.c().errCode("game.undo", p("gameId", gameId))).isEqualTo("nothing_to_undo");

    a.c().req("game.move", p("gameId", gameId, "n", 1, "idx", 30));
    a.c().waitFor("game.move", m -> m.get("n").asInt() == 2);
    a.c().req("game.pass", p("gameId", gameId, "n", 3));
    JsonNode aiPass = a.c().waitFor("game.move", m -> m.get("n").asInt() == 4);
    assertThat(aiPass.get("idx").asInt()).isEqualTo(-1);
    JsonNode sc = a.c().waitFor("game.scoring", m -> !m.get("scoring").get("pending").asBoolean());
    assertThat(sc.get("scoring").get("accepted").toString()).isEqualTo("{\"1\":false,\"2\":true}");
    assertThat(sc.get("scoring").get("deadline").isNull()).isTrue();
    assertThat(sc.get("scoring").get("resumesLeft").isNull()).isTrue();
    assertThat(a.c().errCode("game.score.toggle", p("gameId", gameId, "idx", 30))).isEqualTo("bad_request");
    a.c().req("game.score.accept", p("gameId", gameId, "version", sc.get("scoring").get("version").asInt()));
    JsonNode end = a.c().waitFor("game.end");
    assertThat(end.get("result").get("reason").asText()).isEqualTo("score");
    assertThat(end.get("result").get("counted").asBoolean()).isFalse();
    assertThat(end.has("stats")).isFalse();
  }

  @Test
  void newAiGameVoidsOldAndUnavailable() {
    P a = player("Ann");
    String g1 = a.c().req("ai.start", p("size", 9, "level", "k10", "color", "white")).get("gameId").asText();
    a.c().req("game.sync", p("gameId", g1));
    String g2 = a.c().req("ai.start", p("size", 13, "level", "k10", "color", "random")).get("gameId").asText();
    JsonNode end = a.c().waitFor("game.end", m -> m.get("gameId").asText().equals(g1));
    assertThat(end.get("result").get("reason").asText()).isEqualTo("abort");
    assertThat(end.get("result").get("cause").asText()).isEqualTo("replaced");
    assertThat(a.c().req("hello").get("activeGames").toString()).isEqualTo("[{\"id\":\"" + g2 + "\",\"mode\":\"ai\"}]");
    ai.available(false);
    assertThat(a.c().errCode("ai.start", p("size", 9, "level", "k10", "color", "black"))).isEqualTo("ai_unavailable");
  }

  @Test
  void reconnectPresenceAndSyncGating() {
    P a = player("Ann");
    P b = player("Ben");
    Pair g = matchPair(a, b, 9);
    playMoves(g, 1, 40, 41, 42);
    g.white().c().close();
    JsonNode off = g.black().c().waitFor("game.presence");
    assertThat(off.get("color").asInt()).isEqualTo(2);
    assertThat(off.get("online").asBoolean()).isFalse();
    assertThat(off.get("clocks").get("running").asInt()).as("presence 附带读秒").isEqualTo(2);
    WsClient c2 = connect(g.white().token());
    JsonNode on = g.black().c().waitFor("game.presence");
    assertThat(on.get("online").asBoolean()).isTrue();
    assertThat(c2.req("hello").get("activeGames").toString()).isEqualTo("[{\"id\":\"" + g.gameId() + "\",\"mode\":\"ranked\"}]");
    g.black().c().req("game.resign", p("gameId", g.gameId()));
    assertThat(g.black().c().waitFor("game.end").get("result").get("winner").asInt()).isEqualTo(2);
    c2.expectNone("game.end", 150);
  }

  @Test
  void reconnectSyncContinues() {
    P a = player("Ann");
    P b = player("Ben");
    Pair g = matchPair(a, b, 9);
    playMoves(g, 1, 40, 41);
    g.black().c().abort();
    g.white().c().waitFor("game.presence", m -> !m.get("online").asBoolean());
    WsClient c1 = connect(g.black().token());
    JsonNode snap = c1.req("game.sync", p("gameId", g.gameId())).get("game");
    assertThat(snap.get("moves").toString()).isEqualTo("[40,41]");
    assertThat(snap.get("myColor").asInt()).isEqualTo(1);
    assertThat(snap.get("toPlay").asInt()).isEqualTo(1);
    assertThat(snap.get("presence").toString()).isEqualTo("{\"1\":true,\"2\":true}");
    Pair q = new Pair(g.gameId(), new P(g.black().user(), g.black().id(), g.black().token(), c1), g.white(), snap);
    playMoves(q, 3, 42, 43);
  }

  @Test
  void secondConnectionReplacesFirst() {
    P a = player("Ann");
    P b = player("Ben");
    Pair g = matchPair(a, b, 9);
    WsClient a2 = connect(a.token());
    assertThat(a.c().waitFor("kicked").toString()).isEqualTo("{\"t\":\"kicked\",\"reason\":\"replaced\"}");
    assertThat(a.c().awaitClose().code()).isEqualTo(4001);
    b.c().expectNone("game.presence", 150);
    assertThat(a2.req("hello").get("activeGames").toString()).isEqualTo("[{\"id\":\"" + g.gameId() + "\",\"mode\":\"ranked\"}]");
    JsonNode snap = a2.req("game.sync", p("gameId", g.gameId())).get("game");
    assertThat(snap.get("presence").get(String.valueOf(snap.get("myColor").asInt())).asBoolean()).isTrue();
  }

  @Test
  void replacedConnectionLeavesMatchQueue() {
    P a = player("Ann");
    P b = player("Ben");
    a.c().req("match.join", p("size", 9));
    WsClient a2 = connect(a.token());
    assertThat(a.c().awaitClose().code()).isEqualTo(4001);
    assertThat(a2.req("hello").get("matching").isNull()).isTrue();
    b.c().req("match.join", p("size", 9));
    a2.expectNone("match.found", 150);
    assertThat(b.c().req("hello").get("matching").toString()).isEqualTo("{\"size\":9}");
  }

  @Test
  void nonPlayerCannotSeeOrAct() {
    P a = player("Ann");
    P b = player("Ben");
    P x = player("Eve");
    Pair g = matchPair(a, b, 9);
    List<Object[]> cases =
        List.of(
            new Object[] {"game.sync", p()},
            new Object[] {"game.move", p("n", 1, "idx", 40)},
            new Object[] {"game.pass", p("n", 1)},
            new Object[] {"game.resign", p()},
            new Object[] {"game.undo", p()},
            new Object[] {"game.score.toggle", p("idx", 1)},
            new Object[] {"game.score.accept", p("version", 1)},
            new Object[] {"game.score.resume", p()});
    for (Object[] cs : cases) {
      @SuppressWarnings("unchecked")
      Map<String, Object> params = new java.util.LinkedHashMap<>((Map<String, Object>) cs[1]);
      params.put("gameId", g.gameId());
      assertThat(x.c().errCode((String) cs[0], params)).as((String) cs[0]).isEqualTo("not_player");
    }
    assertThat(x.c().errCode("game.sync", p("gameId", "aaaaaaaaaaaa"))).isEqualTo("not_found");
    playMoves(g, 1, 40);
    x.c().expectNone("game.move", 150);
  }

  @Test
  void malformedMessagesAndOversize() {
    P a = player("Ann");
    a.c().sendRaw("{not json");
    a.c().sendBinary(new byte[] {1, 2, 3});
    a.c().sendRaw("[1,2,3]");
    a.c().send(p("t", "game.move", "gameId", "x"));
    assertThat(json(a.c().req("hello"))).isEqualTo("{\"activeGames\":[],\"room\":null,\"matching\":null}");
    assertThat(a.c().request("game.teleport").get("err").get("code").asText()).isEqualTo("bad_request");
    JsonNode r2 = a.c().request("match.join", p("size", "9"));
    assertThat(r2.get("err").get("code").asText()).isEqualTo("bad_request");
    assertThat(r2.get("err").get("field").asText()).isEqualTo("size");
    a.c().send(p("t", "hello", "rid", "abc"));
    WsClient.sleep(100);
    JsonNode echoed = a.c().logCopy().stream().filter(m -> "res".equals(m.path("t").asText()) && "abc".equals(m.path("rid").asText())).findFirst().orElseThrow();
    assertThat(echoed.get("ok").asBoolean()).isFalse();
    a.c().sendRaw(json(p("t", "hello", "pad", "x".repeat(17 * 1024))));
    assertThat(a.c().awaitClose().code()).isEqualTo(1009);
  }

  @Test
  void messageRateLimitPerUserSurvivesReconnect() {
    U u = user("Ann");
    WsClient c = connect(u.token());
    for (int i = 0; i < 25; i++) c.send(p("t", "ping"));
    assertThat(c.awaitClose().code()).isEqualTo(4008);
    assertThat(c.logCopy().stream().filter(m -> "pong".equals(m.path("t").asText())).count()).isEqualTo(20);
    WsClient c2 = connect(u.token());
    c2.send(p("t", "ping"));
    assertThat(c2.awaitClose().code()).isEqualTo(4008);
    WsClient.sleep(1100);
    WsClient c3 = connect(u.token());
    c3.req("hello");
  }

  @Test
  void upgradeRateLimit() {
    U u = user("Ann");
    U other = user("Ben");
    for (int i = 0; i < 10; i++) {
      WsClient c = connect(u.token());
      c.req("hello");
    }
    assertThatThrownBy(() -> connect(u.token())).isInstanceOfSatisfying(WsClient.Rejected.class, e -> assertThat(e.status).isEqualTo(429));
    connect(other.token()).req("hello");
  }

  @Test
  void shortClockTimeoutCountsAndShortGameNot() {
    restart(settings().timeControl(13, new TimeControl(1200, 1, 600)).build(), null);
    P a = player("Tia");
    P b = player("Tib");
    Pair g = matchPair(a, b, 13);
    assertThat(g.snap().get("timeControl").toString()).isEqualTo("{\"mainMs\":1200,\"periods\":1,\"periodMs\":600}");
    assertThat(g.snap().get("clocks").get("2").toString()).isEqualTo("{\"mainMs\":1200,\"periodsLeft\":1,\"periodMs\":600}");
    playMovesPaced(g, 1, 20, 40, 41, 30, 31, 20, 21, 10, 11, 0, 1);
    JsonNode end = g.white().c().waitFor("game.end", null, 5000);
    assertThat(end.get("result").get("reason").asText()).isEqualTo("timeout");
    assertThat(end.get("result").get("winner").asInt()).isEqualTo(2);
    assertThat(end.get("result").get("text").asText()).isEqualTo("W+T");
    assertThat(end.get("result").get("counted").asBoolean()).isTrue();
    assertThat(end.get("stats").get("2").get("wins").asInt()).isEqualTo(1);
    g.black().c().waitFor("game.end");
    assertThat(g.black().c().errCode("game.move", p("gameId", g.gameId(), "n", 11, "idx", 50))).isEqualTo("wrong_phase");

    Pair g2 = matchPair(a, b, 13);
    playMovesPaced(g2, 1, 20, 40);
    JsonNode e2 = g2.black().c().waitFor("game.end", null, 5000);
    assertThat(e2.get("result").get("reason").asText()).isEqualTo("timeout");
    assertThat(e2.get("result").get("winner").asInt()).isEqualTo(1);
    assertThat(e2.get("result").get("cause").asText()).isEqualTo("clock");
    assertThat(e2.get("result").get("counted").asBoolean()).isFalse();
    assertThat(e2.get("result").get("uncounted").asText()).isEqualTo("short");
    assertThat(games.findById(g2.gameId()).counted()).isFalse();
  }

  @Test
  void firstMoveAbortAndAbandon() {
    restart(settings().firstMoveTimeoutMs(400).abandonMs(400).timeControl(9, new TimeControl(300, 5, 3000)).build(), null);
    P a = player("Aba");
    P b = player("Abb");
    Pair g = matchPair(a, b, 9);
    JsonNode end = g.black().c().waitFor("game.end", null, 3000);
    assertThat(end.get("result").get("reason").asText()).isEqualTo("abort");
    assertThat(end.get("result").get("text").asText()).isEqualTo("Void");
    assertThat(end.get("result").get("cause").asText()).isEqualTo("first_move");
    assertThat(end.has("stats")).isTrue();
    g.white().c().waitFor("game.end");

    Pair g2 = matchPair(a, b, 9);
    playMovesPaced(g2, 1, 20, 40, 41, 30, 31, 20, 21, 10, 11, 0, 1);
    g2.black().c().abort();
    JsonNode pres = g2.white().c().waitFor("game.presence");
    assertThat(pres.get("online").asBoolean()).isFalse();
    JsonNode e2 = g2.white().c().waitFor("game.end", null, 3000);
    assertThat(e2.get("result").get("reason").asText()).isEqualTo("timeout");
    assertThat(e2.get("result").get("cause").asText()).isEqualTo("abandon");
    assertThat(e2.get("result").get("winner").asInt()).isEqualTo(2);
    assertThat(e2.get("result").get("counted").asBoolean()).isTrue();
  }

  @Test
  void restartRestoresGameAndClosesWith1001() {
    ai.dead(10);
    P a = player("Ria");
    P b = player("Rib");
    Pair g = matchPair(a, b, 9);
    playMoves(g, 1, 4, 5, 13, 14, 22, 23, 31, 32, 40, 41, 49, 50);
    JsonNode saved = g.black().c().req("game.sync", p("gameId", g.gameId())).get("game").get("clocks");

    realtime.restart(null, null);
    assertThat(a.c().awaitClose().code()).as("关机以 1001 关闭连接").isEqualTo(1001);
    assertThat(b.c().awaitClose().code()).isEqualTo(1001);
    WsClient a2 = connect(a.token());
    WsClient b2 = connect(b.token());
    assertThat(a2.req("hello").get("activeGames").toString()).isEqualTo("[{\"id\":\"" + g.gameId() + "\",\"mode\":\"ranked\"}]");
    assertThat(b2.req("hello").get("activeGames").toString()).isEqualTo("[{\"id\":\"" + g.gameId() + "\",\"mode\":\"ranked\"}]");
    Pair g2 = syncBoth(new P(a.user(), a.id(), a.token(), a2), new P(b.user(), b.id(), b.token(), b2), g.gameId());
    assertThat(g2.black().id()).as("执子颜色不变").isEqualTo(g.black().id());
    JsonNode snap = g2.snap();
    assertThat(snap.get("status").asText()).isEqualTo("playing");
    assertThat(snap.get("moves").size()).isEqualTo(12);
    assertThat(snap.get("toPlay").asInt()).isEqualTo(1);
    assertThat(snap.get("clocks").get("running").asInt()).isEqualTo(1);
    assertThat(snap.get("clocks").get("2").toString()).isEqualTo(saved.get("2").toString());
    assertThat(snap.get("presence").toString()).isEqualTo("{\"1\":true,\"2\":true}");
    assertThat(g2.black().c().errCode("game.move", p("gameId", g.gameId(), "n", 12, "idx", 60))).isEqualTo("stale");

    int n = playMoves(g2, 13, 58, 59, 67, 68, 76, 77, 72, 10, -1, -1);
    JsonNode prop = g2.black().c().waitFor("game.scoring", m -> !m.get("scoring").get("pending").asBoolean());
    assertThat(prop.get("scoring").get("dead").toString()).isEqualTo("[10]");
    g2.black().c().req("game.score.accept", p("gameId", g.gameId(), "version", 1));

    // 数子阶段再重启：确认清零，重新请求死子建议
    realtime.restart(null, null);
    WsClient a3 = connect(a.token());
    WsClient b3 = connect(b.token());
    Pair g3 = syncBoth(new P(a.user(), a.id(), a.token(), a3), new P(b.user(), b.id(), b.token(), b3), g.gameId());
    assertThat(g3.snap().get("status").asText()).isEqualTo("scoring");
    assertThat(g3.snap().get("clocks").get("running").isNull()).isTrue();
    JsonNode sc = g3.snap().get("scoring").get("pending").asBoolean()
        ? g3.black().c().waitFor("game.scoring", m -> !m.get("scoring").get("pending").asBoolean()).get("scoring")
        : g3.snap().get("scoring");
    assertThat(sc.get("version").asInt()).isEqualTo(1);
    assertThat(sc.get("dead").toString()).isEqualTo("[10]");
    assertThat(sc.get("accepted").toString()).isEqualTo("{\"1\":false,\"2\":false}");
    g3.black().c().req("game.score.accept", p("gameId", g.gameId(), "version", 1));
    g3.white().c().req("game.score.accept", p("gameId", g.gameId(), "version", 1));
    JsonNode end = g3.black().c().waitFor("game.end");
    assertThat(end.get("result").get("text").asText()).isEqualTo("B+1.5");
    assertThat(end.get("result").get("counted").asBoolean()).isTrue();
    assertThat(end.get("stats").get("1").get("wins").asInt()).isEqualTo(1);
    assertThat(n).isEqualTo(23);

    // 再重启：已结束的对局不再恢复，统计不变
    var before = stats.get(g.black().id());
    realtime.restart(null, null);
    assertThat(stats.get(g.black().id())).isEqualTo(before);
    assertThat(games.listUnfinished()).isEmpty();
  }

  @Test
  void restoreOnStartupFromDatabase() {
    ai.available(false);
    U u = user("A");
    U v = user("B");
    long now = System.currentTimeMillis();
    games.insert(new NewGame().id("restored0001").mode("friend").size(9).komi(7.5).blackId(u.id()).whiteId(v.id())
        .timeControl(new TimeControl(180000, 3, 20000)).status("playing").moves(List.of(40, 41))
        .clocks(Map.of("running", 1, "1", Map.of("mainMs", 170000, "periodsLeft", 3, "periodMs", 20000),
            "2", Map.of("mainMs", 175000, "periodsLeft", 3, "periodMs", 20000)))
        .createdAt(now));
    games.insert(new NewGame().id("broken000001").mode("ranked").size(9).komi(7.5).blackId(u.id()).whiteId(v.id())
        .timeControl(new TimeControl(1000, 0, 0)).status("playing").moves(List.of(40, 40)).createdAt(now));
    realtime.restart(null, null);
    assertThat(json(realtime.activeGamesOf(u.id()))).isEqualTo("[{\"id\":\"restored0001\",\"mode\":\"friend\"}]");
    GameRow broken = games.findById("broken000001");
    assertThat(broken.status()).isEqualTo("ended");
    assertThat(broken.reason()).isEqualTo("abort");
    assertThat(broken.cause()).isEqualTo("broken");
    assertThat(broken.resultText()).isEqualTo("Void");
    WsClient c = connect(u.token());
    JsonNode snap = c.req("game.sync", p("gameId", "restored0001")).get("game");
    assertThat(snap.get("moves").toString()).isEqualTo("[40,41]");
    assertThat(snap.get("clocks").get("1").get("mainMs").asLong()).isLessThanOrEqualTo(170000);
    assertThat(snap.get("clocks").get("2").get("mainMs").asLong()).isEqualTo(175000);
    assertThat(c.errCode("ai.start", p("size", 9, "level", "k10", "color", "black"))).isEqualTo("in_game");
    c.req("game.resign", p("gameId", "restored0001"));
    assertThat(c.errCode("ai.start", p("size", 9, "level", "k10", "color", "black"))).isEqualTo("ai_unavailable");
  }

  @Test
  void activeGamesInRestMe() throws Exception {
    P a = player("Ann");
    String gameId = a.c().req("ai.start", p("size", 9, "level", "k10", "color", "black")).get("gameId").asText();
    var http = java.net.http.HttpClient.newHttpClient();
    var res = http.send(
        java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://127.0.0.1:" + port + "/api/me"))
            .header("Authorization", "Bearer " + a.token()).build(),
        java.net.http.HttpResponse.BodyHandlers.ofString());
    assertThat(res.statusCode()).isEqualTo(200);
    assertThat(Json.parse(res.body()).get("activeGameIds").toString()).isEqualTo("[\"" + gameId + "\"]");
  }

  @Test
  void settingsFromPropertiesAreDefaults() {
    GameSettings s = realtime.stack().settings();
    assertThat(s.timeControls.get(9)).isEqualTo(new TimeControl(180000, 3, 20000));
  }
}
