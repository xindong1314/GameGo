package com.gamego.ai;

import static com.gamego.ai.TestUtil.code;
import static com.gamego.ai.TestUtil.get;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.List;
import org.junit.jupiter.api.Test;

/** 移植自 server/test/ai/fake.test.js（FakeAiService 与测试用的 FakeAnalysisEngine）。 */
class FakeAiServiceTest {
  static AiMoveRequest req(int[] moves, int color, String level, boolean hjp) {
    return new AiMoveRequest(9, 7.5, moves, color, level, hjp);
  }

  @Test
  void sameInterfaceAndDeterministic() {
    FakeAiService ai = new FakeAiService();
    assertTrue(ai.available());
    assertEquals(Levels.publicLevels(), ai.levels());
    assertEquals("fake", ai.kind());
    AiMove a = get(ai.chooseMove(req(new int[0], 1, "k8", false)));
    AiMove b = get(ai.chooseMove(req(new int[0], 1, "k8", false)));
    assertEquals(a, b);
    assertEquals(new AiMove(0, false, new AiMoveInfo(0.5, 0, 1)), a);
    // 第一个合法点被占 → 下一个
    assertEquals(1, get(ai.chooseMove(req(new int[] {0}, 2, "k8", false))).move());
    // 人刚 pass → pass
    assertEquals(new AiMove(-1, false, null), get(ai.chooseMove(req(new int[] {0, 1, -1}, 2, "k8", true))));
    assertEquals(4, ai.chooseMoveCalls().size());
    assertEquals(new DeadResult(new int[0], "katago"), get(ai.judgeDead(9, 7.5, new int[] {-1, -1})));
    assertEquals(1, ai.judgeDeadCalls().size());
  }

  @Test
  void doesNotFillOwnEye() {
    // 黑 1、9 围住角 0：黑不下 0
    FakeAiService ai = new FakeAiService();
    assertEquals(2, get(ai.chooseMove(req(new int[] {1, 80, 9, 79}, 1, "k8", false))).move());
  }

  @Test
  void configurableMoveResignDeadFailureAndAvailability() {
    FakeAiService ai =
        new FakeAiService()
            .move((r, state) -> r.moves().length == 0 ? AiMove.of(40) : new AiMove(41, false, new AiMoveInfo(0.2, -3, 5)));
    assertEquals(new AiMove(40, false, null), get(ai.chooseMove(req(new int[0], 1, "d5", false))));
    assertEquals(new AiMove(41, false, new AiMoveInfo(0.2, -3, 5)), get(ai.chooseMove(req(new int[] {40}, 2, "d5", false))));
    ai.move(null).resign(true).deadFn((c, state) -> new int[] {c.moves()[0]});
    assertEquals(new AiMove(-1, true, null), get(ai.chooseMove(req(new int[] {40}, 2, "max", false))));
    assertEquals(new DeadResult(new int[] {40}, "katago"), get(ai.judgeDead(9, 7.5, new int[] {40, -1, -1})));
    ai.judgeFail(true);
    assertEquals("katago_error", code(ai.judgeDead(9, 7.5, new int[0])));
    ai.available(false);
    assertFalse(ai.available());
    assertEquals("ai_unavailable", code(ai.chooseMove(req(new int[0], 1, "k8", false))));
    FakeAiService custom = new FakeAiService().levels(List.of(new AiLevel("x", "X", "")));
    assertEquals(List.of(new AiLevel("x", "X", "")), custom.levels());
    assertEquals("bad_request", code(custom.chooseMove(req(new int[0], 1, "k8", false))));
    custom.shutdown();
    assertFalse(custom.available());
    // 固定死子与延迟
    FakeAiService d = new FakeAiService().dead(3, 1).delayMs(50);
    long t0 = System.currentTimeMillis();
    assertEquals(new DeadResult(new int[] {3, 1}, "katago"), get(d.judgeDead(9, 7.5, new int[0])));
    assertTrue(System.currentTimeMillis() - t0 >= 45);
  }

  @Test
  void validationMatchesRealService() {
    FakeAiService ai = new FakeAiService();
    for (AiMoveRequest r :
        List.of(
            req(new int[0], 2, "k8", false),
            req(new int[] {40, 40}, 1, "k8", false),
            new AiMoveRequest(11, 7.5, new int[0], 1, "k8", false),
            req(new int[0], 1, "nope", false))) {
      assertEquals("bad_request", code(ai.chooseMove(r)), String.valueOf(r));
    }
    assertEquals("bad_request", code(ai.judgeDead(9, 7.5, new int[] {100})));
  }

  static ObjectNode q(String s) {
    return KataGoEngineTest.q(s);
  }

  @Test
  void fakeEngineSynthesizesKataGoShapedResponses() {
    FakeAnalysisEngine eng = new FakeAnalysisEngine().rootInfo(new FakeAnalysisEngine.RootInfo(0.8, 4));
    get(eng.start());
    assertTrue(eng.available());
    JsonNode r =
        get(
            eng.query(
                q(
                    "{\"boardXSize\":9,\"boardYSize\":9,\"komi\":7.5,\"moves\":[[\"B\",\"E5\"],[\"W\",\"pass\"]],"
                        + "\"rules\":\"chinese\",\"maxVisits\":50,\"includePolicy\":true,\"includeOwnership\":true,"
                        + "\"overrideSettings\":{\"reportAnalysisWinratesAs\":\"BLACK\"}}"),
                0));
    assertEquals(82, r.get("policy").size());
    assertEquals(-1, r.get("policy").get(40).asDouble(), "已有子的点为 -1");
    assertTrue(r.get("policy").get(0).asDouble() > 0 && r.get("policy").get(81).asDouble() > 0);
    double sum = 0;
    for (JsonNode v : r.get("policy")) if (v.asDouble() > 0) sum += v.asDouble();
    assertEquals(1, sum, 1e-9);
    assertEquals(81, r.get("ownership").size());
    assertEquals(1, r.get("ownership").get(40).asDouble());
    assertEquals(q("{\"currentPlayer\":\"B\",\"visits\":50,\"winrate\":0.8,\"scoreLead\":4.0}"), r.get("rootInfo"));
    assertTrue(r.get("moveInfos").size() > 1);
    for (int i = 0; i < r.get("moveInfos").size(); i++) assertEquals(i, r.get("moveInfos").get(i).get("order").asInt());
    assertEquals(2, r.get("turnNumber").asInt());

    // 视角：SIDETOMOVE
    JsonNode w =
        get(
            eng.query(
                q(
                    "{\"boardXSize\":9,\"boardYSize\":9,\"komi\":7.5,\"moves\":[[\"B\",\"E5\"]],\"maxVisits\":1,"
                        + "\"includeOwnership\":true,\"overrideSettings\":{\"reportAnalysisWinratesAs\":\"SIDETOMOVE\"}}"),
                0));
    assertEquals("W", w.at("/rootInfo/currentPlayer").asText());
    assertEquals(0.2, w.at("/rootInfo/winrate").asDouble(), 1e-12);
    assertEquals(-4, w.at("/rootInfo/scoreLead").asDouble());
    assertEquals(-1, w.get("ownership").get(40).asDouble());
    assertEquals(0, w.get("moveInfos").size(), "maxVisits 1 时 moveInfos 为空（与 KataGo 一致）");
    assertFalse(w.has("policy"), "没要 policy 就不给");

    // searchMove 指定第一选点
    eng.searchMove(-1);
    JsonNode s = get(eng.query(q("{\"boardXSize\":9,\"boardYSize\":9,\"komi\":7.5,\"moves\":[],\"maxVisits\":10}"), 0));
    assertEquals("pass", s.get("moveInfos").get(0).get("move").asText());
    assertEquals(3, eng.queries.size());
    assertEquals(10, eng.lastQuery().get("maxVisits").asInt());
  }

  @Test
  void fakeEngineErrorsAvailabilityAndShutdown() {
    FakeAnalysisEngine eng = new FakeAnalysisEngine();
    assertEquals("katago_error", code(eng.query(q("{\"boardXSize\":9,\"boardYSize\":9,\"komi\":7.5,\"moves\":[[\"B\",\"E5\"],[\"W\",\"E5\"]]}"), 0)));
    assertEquals("katago_error", code(eng.query(q("{\"boardXSize\":9,\"boardYSize\":9,\"komi\":7.5,\"moves\":[[\"B\",\"Z9\"]]}"), 0)));
    assertEquals("katago_error", code(eng.query(q("{\"boardXSize\":9,\"boardYSize\":9,\"komi\":7.5,\"moves\":[[\"W\",\"E5\"]]}"), 0)));
    eng.available(false);
    assertFalse(eng.available());
    assertEquals("ai_unavailable", code(eng.query(q("{\"boardXSize\":9,\"boardYSize\":9,\"komi\":7.5,\"moves\":[]}"), 0)));
    eng.available(true);
    get(eng.shutdown());
    assertFalse(eng.available());
    assertEquals("ai_unavailable", code(eng.query(q("{\"boardXSize\":9,\"boardYSize\":9,\"komi\":7.5,\"moves\":[]}"), 0)));
  }
}
