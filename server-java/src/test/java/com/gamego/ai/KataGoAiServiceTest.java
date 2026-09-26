package com.gamego.ai;

import static com.gamego.ai.FakeAnalysisEngine.mi;
import static com.gamego.ai.TestUtil.code;
import static com.gamego.ai.TestUtil.get;
import static com.gamego.ai.TestUtil.rejects;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.gamego.engine.Coords;
import com.gamego.engine.GameState;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;

/** KataGoAiService 的逻辑测试，用 FakeAnalysisEngine 代替 KataGo（移植自 server/test/ai/service.test.js）。 */
class KataGoAiServiceTest {
  static final int BLACK = 1;
  static final int WHITE = 2;
  static final List<String> RANK_LEVELS = List.of("k18", "k12", "k8", "k4", "k1", "d3");

  static final class Made {
    KataGoAiService ai;
    FakeAnalysisEngine engine;
    CaptureLog log = new CaptureLog();
  }

  static Made makeAi(Consumer<FakeAnalysisEngine> engineOpts) {
    return makeAi(engineOpts, b -> {});
  }

  static Made makeAi(Consumer<FakeAnalysisEngine> engineOpts, Consumer<KataGoAiService.Builder> extra) {
    Made m = new Made();
    m.engine = new FakeAnalysisEngine();
    if (engineOpts != null) engineOpts.accept(m.engine);
    KataGoAiService.Builder b = KataGoAiService.builder(m.engine).log(m.log).minThinkMs(0L).rng(new Mulberry32(7));
    extra.accept(b);
    m.ai = b.build();
    return m;
  }

  /** 一组合法、无提子的着手：偶数行偶数列上黑白交替；不够时补 pass（两次 pass 后服务端会 resume，照样合法）。 */
  static int[] filler(int size, int count) {
    List<Integer> out = new ArrayList<>();
    for (int y = 0; y < size && out.size() < count; y += 2) {
      for (int x = 0; x < size && out.size() < count; x += 2) out.add(y * size + x);
    }
    while (out.size() < count) out.add(-1);
    return out.stream().mapToInt(Integer::intValue).toArray();
  }

  /** 除 hot 外都是很小值的 policy。 */
  static double[] flatPolicy(int size, Map<Integer, Double> hot, double rest, double pass) {
    double[] p = new double[size * size + 1];
    Arrays.fill(p, rest);
    hot.forEach((k, v) -> p[k] = v);
    p[size * size] = pass;
    return p;
  }

  static double[] flatPolicy(int size, Map<Integer, Double> hot) {
    return flatPolicy(size, hot, 1e-4, 1e-5);
  }

  static AiMoveRequest req(int size, int[] moves, int color, String level, boolean hjp) {
    return new AiMoveRequest(size, 7.5, moves, color, level, hjp);
  }

  /** 默认：9 路、黑已下 E5、轮到白、k8。 */
  static AiMoveRequest req() {
    return req(9, new int[] {40}, WHITE, "k8", false);
  }

  static AiMoveRequest req(String level) {
    return req(9, new int[] {40}, WHITE, level, false);
  }

  static ObjectNode json(String s) {
    return (ObjectNode) node(s);
  }

  static JsonNode node(String s) {
    try {
      return AiCommon.JSON.readTree(s);
    } catch (Exception e) {
      throw new RuntimeException(e);
    }
  }

  static int[] gtp(String s) {
    return gtp(s, 9);
  }

  static int[] gtp(String s, int size) {
    return Arrays.stream(s.split(" ")).mapToInt(p -> p.equals("pass") ? -1 : Coords.gtpToIdx(p, size)).toArray();
  }

  static List<Integer> visitsOf(Made m) {
    List<Integer> out = new ArrayList<>();
    for (FakeAnalysisEngine.Rec r : m.engine.queries) out.add(r.query().get("maxVisits").asInt());
    return out;
  }

  static final ObjectNode RULES_NFP =
      json(
          "{\"ko\":\"SIMPLE\",\"scoring\":\"AREA\",\"tax\":\"NONE\",\"suicide\":false,\"hasButton\":false,"
              + "\"whiteHandicapBonus\":\"0\",\"friendlyPassOk\":false}");

  // ---------------------------------------------------------------------------------------------
  // 选点：rank / policy / search

  @Test
  void rankLevelsSendOneVisitPolicyQueryAndPickByKaTrainRules() {
    for (String level : RANK_LEVELS) {
      Made m = makeAi(e -> e.policy(flatPolicy(9, Map.of(20, 0.95))));
      AiMove r = get(m.ai.chooseMove(req(level)));
      assertEquals(new AiMove(20, false, new AiMoveInfo(0.5, 0, 1)), r, level);
      assertEquals(1, m.engine.queries.size());
      FakeAnalysisEngine.Rec rec = m.engine.queries.get(0);
      assertEquals(
          json(
              "{\"boardXSize\":9,\"boardYSize\":9,\"komi\":7.5,\"moves\":[[\"B\",\"E5\"]],\"rules\":\"chinese\","
                  + "\"maxVisits\":1,\"includePolicy\":true,\"priority\":10,"
                  + "\"overrideSettings\":{\"reportAnalysisWinratesAs\":\"BLACK\"}}"),
          rec.query());
      assertEquals(15000, rec.timeoutMs());
    }
  }

  @Test
  void rankLevelsUseSizeAdjustedKyuOnSmallBoards() {
    Object[][] cases = {{9, "k8"}, {13, "k4"}, {19, "k12"}};
    for (Object[] c : cases) {
      int size = (Integer) c[0];
      String level = (String) c[1];
      int[] moves = filler(size, 6);
      Made m = makeAi(null, b -> b.rng(new Mulberry32(42)));
      AiMove r = get(m.ai.chooseMove(req(size, moves, BLACK, level, false)));
      FakeAnalysisEngine.Ctx ctx = m.engine.context(m.engine.queries.get(0).query());
      int expected =
          RankStrategy.pickRankMove(
              m.engine.defaultPolicy(ctx), size, Levels.kyuFor(Levels.get(level), size), new Mulberry32(42));
      assertEquals(expected, r.move(), size + " 路 " + level);
    }
  }

  @Test
  void allLevelsGiveLegalMovesOnRandomPositionsWithDefaultPolicy() {
    List<String> levels = new ArrayList<>(RANK_LEVELS);
    levels.add("d5");
    levels.add("max");
    for (int size : new int[] {9, 13, 19}) {
      for (String level : levels) {
        for (int count : new int[] {0, 1, 7, 20}) {
          int[] moves = filler(size, count);
          int color = count % 2 == 0 ? BLACK : WHITE;
          int seed = count + size;
          Made m = makeAi(null, b -> b.rng(new Mulberry32(seed)));
          AiMove r = get(m.ai.chooseMove(req(size, moves, color, level, false)));
          assertFalse(r.resign());
          GameState state = AiCommon.replayMoves(size, 7.5, moves);
          assertTrue(r.move() == -1 || AiCommon.isLegal(state, color, r.move()), size + " 路 " + level + " " + count + " 手：" + r.move());
        }
      }
    }
  }

  @Test
  void policyLevelPlaysTopMoveAfterOpeningAndRandomisesInOpening() {
    int[] moves = filler(19, 30);
    Map<Integer, Double> hot = Map.of(180, 0.3, 60, 0.25, 300, 0.2);
    Made m = makeAi(e -> e.policy(flatPolicy(19, hot)));
    for (int i = 0; i < 5; i++) assertEquals(180, get(m.ai.chooseMove(req(19, moves, BLACK, "d5", false))).move());
    // 开局：在 policy > 2% 的点里按 policy 加权抽取
    Set<Integer> seen = new TreeSet<>();
    Made m2 = makeAi(e -> e.policy(flatPolicy(19, hot)), b -> b.rng(new Mulberry32(3)));
    for (int i = 0; i < 40; i++) seen.add(get(m2.ai.chooseMove(req(19, new int[0], BLACK, "d5", false))).move());
    assertEquals(new TreeSet<>(List.of(60, 180, 300)), seen);
  }

  @Test
  void maxLevelSearchesWithNoFriendlyPassRulesAndTakesLowestOrder() {
    Made m =
        makeAi(
            e ->
                e.rootInfo(new FakeAnalysisEngine.RootInfo(0.3, -2.5, 301))
                    .moveInfos(mi("C3", "order", 1), mi("G7", "order", 0), mi("pass", "order", 2)));
    AiMove r = get(m.ai.chooseMove(req("max")));
    // G7 = x 6，y = 9 - 7 = 2 → 24；白方视角
    assertEquals(24, r.move());
    assertFalse(r.resign());
    assertEquals(301, r.info().visits());
    assertEquals(0.7, r.info().winrate(), 1e-12);
    assertEquals(2.5, r.info().scoreLead());
    FakeAnalysisEngine.Rec rec = m.engine.queries.get(0);
    assertEquals(RULES_NFP, rec.query().get("rules"));
    assertEquals(KataGoAiService.rulesNoFriendlyPass(), RULES_NFP);
    assertEquals(300, rec.query().get("maxVisits").asInt());
    assertTrue(rec.query().get("includePolicy").asBoolean());
    assertEquals(
        json("{\"maxTime\":8,\"conservativePass\":false,\"wideRootNoise\":0,\"reportAnalysisWinratesAs\":\"BLACK\"}"),
        rec.query().get("overrideSettings"));
    assertEquals(23000, rec.timeoutMs());
    assertEquals(1, m.engine.queries.size());
  }

  @Test
  void maxLevelPassesWhenTopMoveIsPassWithoutExtraEndCheck() {
    Made m = makeAi(e -> e.moveInfos("pass", "E5"));
    AiMove r = get(m.ai.chooseMove(req(9, new int[] {40, 41, -1}, WHITE, "max", true)));
    assertEquals(-1, r.move());
    assertFalse(r.resign());
    assertEquals(1, m.engine.queries.size());
    assertEquals(300, m.engine.queries.get(0).query().get("maxVisits").asInt());
  }

  @Test
  void maxLevelSkipsIllegalCandidates() {
    Made m = makeAi(e -> e.moveInfos("E5", "D4")); // E5 已有子
    assertEquals(5 * 9 + 3, get(m.ai.chooseMove(req("max"))).move());
    assertTrue(CaptureLog.any(m.log.debug, "不合法"));
    // 所有选点都不合法 → policy 最高的合法点
    Made m2 = makeAi(e -> e.moveInfos("E5").policy(flatPolicy(9, Map.of(40, 0.9, 70, 0.05))));
    assertEquals(70, get(m2.ai.chooseMove(req("max"))).move());
  }

  // ---------------------------------------------------------------------------------------------
  // pass

  @Test
  void rankLevelPassesWhenPassIsTopPolicy() {
    Made m = makeAi(e -> e.policy(flatPolicy(9, Map.of(20, 0.1), 1e-4, 0.8)));
    AiMove r = get(m.ai.chooseMove(req("k12")));
    assertEquals(-1, r.move());
    assertFalse(r.resign());
  }

  @Test
  void humanPassedTriggersEndCheckAndAiPassesWhenTopMoveIsPass() {
    Made m =
        makeAi(
            e ->
                e.rootInfo(new FakeAnalysisEngine.RootInfo(0.9, 6))
                    .respond(
                        (q, ctx) ->
                            q.get("maxVisits").asInt() == 100
                                ? json(
                                    "{\"rootInfo\":{\"winrate\":0.9,\"scoreLead\":6,\"visits\":100},"
                                        + "\"moveInfos\":[{\"move\":\"pass\",\"order\":0},{\"move\":\"A1\",\"order\":1}]}")
                                : null)
                    .policy(flatPolicy(9, Map.of(20, 0.95))));
    AiMove r = get(m.ai.chooseMove(req(9, new int[] {40, 41, -1}, WHITE, "k18", true)));
    assertEquals(-1, r.move());
    assertFalse(r.resign());
    assertEquals(new AiMoveInfo(1 - 0.9, -6, 100), r.info());
    assertEquals(1, m.engine.queries.size(), "终局检查已决定 pass，不再发 policy 请求");
    FakeAnalysisEngine.Rec rec = m.engine.queries.get(0);
    assertEquals(100, rec.query().get("maxVisits").asInt());
    assertEquals(RULES_NFP, rec.query().get("rules"));
    assertEquals(
        json("{\"maxTime\":5,\"conservativePass\":false,\"wideRootNoise\":0,\"reportAnalysisWinratesAs\":\"BLACK\"}"),
        rec.query().get("overrideSettings"));
    JsonNode mv = rec.query().get("moves");
    assertEquals("pass", mv.get(mv.size() - 1).get(1).asText());
    assertEquals(20000, rec.timeoutMs());
  }

  @Test
  void humanPassedButGameNotSettledPlaysNormally() {
    // 盘上只有黑 E5：现在就数子黑得 81 − 7.5 = 73.5 目；第一选点 C3 预期黑领先 80 目，比现在数子多 → 未定，继续下
    Made m = makeAi(e -> e.moveInfos(mi("C3", "scoreLead", 80), "pass").policy(flatPolicy(9, Map.of(20, 0.95))));
    AiMove r = get(m.ai.chooseMove(req(9, new int[] {40, -1}, BLACK, "k8", true)));
    assertEquals(20, r.move());
    assertEquals(List.of(100, 1), visitsOf(m));
    // 人没有 pass 时不做终局检查
    Made m2 = makeAi(e -> e.policy(flatPolicy(9, Map.of(20, 0.95))));
    get(m2.ai.chooseMove(req(9, new int[] {40, -1}, BLACK, "k8", false)));
    assertEquals(List.of(1), visitsOf(m2));
  }

  // 局面（黑方视角的归属：A~E 列 +1，F~J 列 −1）：黑 E 列墙 + 白地里的死子 H5；白 F 列墙 + 黑地里的死子 B5；黑（人）刚 pass，轮到白（AI）。
  // 现在数子（B5、H5 判死）：黑 45，白 36 + 7.5 → 白方视角 −1.5。
  static final int[] SETTLED_MOVES = gtp("E1 F1 E2 F2 E3 F3 E4 F4 E5 F5 E6 F6 E7 F7 E8 F8 E9 F9 H5 B5 pass");
  static final double[] SETTLED_OWNERSHIP = new double[81];

  static {
    for (int i = 0; i < 81; i++) SETTLED_OWNERSHIP[i] = i % 9 <= 4 ? 1 : -1;
  }

  @Test
  void humanPassedSettledWithDeadStonesInAiAreaAllLevelsPassWithoutCapturing() {
    for (String level : List.of("k18", "k8", "d5")) {
      // 终局检查的第一选点是去提 H5（白地里的黑死子），预期目差（白方视角）−1.5，与现在数子相同 → 已定
      Made m =
          makeAi(
              e ->
                  e.rootInfo(new FakeAnalysisEngine.RootInfo(0.7, 1.5))
                      .moveInfos(mi("H4", "scoreLead", 1.5), "pass")
                      .ownership(SETTLED_OWNERSHIP));
      AiMove r = get(m.ai.chooseMove(new AiMoveRequest(9, 7.5, SETTLED_MOVES, WHITE, level, true)));
      assertEquals(-1, r.move(), level);
      assertFalse(r.resign(), level);
      assertEquals(1, m.engine.queries.size(), "终局检查已决定 pass");
      assertTrue(m.engine.queries.get(0).query().get("includeOwnership").asBoolean());
      assertEquals(100, m.engine.queries.get(0).query().get("maxVisits").asInt());
    }
  }

  @Test
  void humanPassedButContinuingGainsMoreThanOnePointIsNotSettled() {
    // 第一选点预期白方视角 +3（比现在数子的 −1.5 多 4.5 目）→ 继续下
    Made m =
        makeAi(
            e ->
                e.rootInfo(new FakeAnalysisEngine.RootInfo(0.4, -3))
                    .moveInfos(mi("H4", "scoreLead", -3), "pass")
                    .ownership(SETTLED_OWNERSHIP)
                    .policy(flatPolicy(9, Map.of(70, 0.95))));
    AiMove r = get(m.ai.chooseMove(new AiMoveRequest(9, 7.5, SETTLED_MOVES, WHITE, "k8", true)));
    assertEquals(70, r.move());
    assertEquals(List.of(100, 1), visitsOf(m));
    // 差 1 目以内仍算已定（KataGo 的目差估计有误差）
    Made edge =
        makeAi(
            e -> e.moveInfos(mi("H4", "scoreLead", 0.6)).ownership(SETTLED_OWNERSHIP).policy(flatPolicy(9, Map.of(70, 0.95))));
    AiMove r2 = get(edge.ai.chooseMove(new AiMoveRequest(9, 7.5, SETTLED_MOVES, WHITE, "k8", true)));
    assertEquals(-1, r2.move(), "预期 −0.6，现在数子 −1.5，差 0.9 目");
    // 归属不可用（格式不对）→ 不判定为已定
    Made bad =
        makeAi(
            e ->
                e.moveInfos(mi("H4", "scoreLead", 1.5))
                    .ownership(new double[] {1, 2, 3})
                    .policy(flatPolicy(9, Map.of(70, 0.95))));
    AiMove r3 = get(bad.ai.chooseMove(new AiMoveRequest(9, 7.5, SETTLED_MOVES, WHITE, "k8", true)));
    assertEquals(70, r3.move());
  }

  @Test
  void maxLevelPassesWhenSettledAfterHumanPassOtherwisePlaysTopMove() {
    Consumer<FakeAnalysisEngine> opts =
        e ->
            e.rootInfo(new FakeAnalysisEngine.RootInfo(0.7, 1.5))
                .moveInfos(mi("H4", "scoreLead", 1.5), "pass")
                .ownership(SETTLED_OWNERSHIP);
    Made m = makeAi(opts);
    AiMove r = get(m.ai.chooseMove(new AiMoveRequest(9, 7.5, SETTLED_MOVES, WHITE, "max", true)));
    assertEquals(-1, r.move());
    assertFalse(r.resign());
    assertEquals(1, m.engine.queries.size());
    assertTrue(m.engine.queries.get(0).query().get("includeOwnership").asBoolean());
    assertEquals(300, m.engine.queries.get(0).query().get("maxVisits").asInt());
    Made other = makeAi(opts);
    AiMove r2 = get(other.ai.chooseMove(new AiMoveRequest(9, 7.5, SETTLED_MOVES, WHITE, "max", false)));
    assertEquals(gtp("H4")[0], r2.move());
    assertNull(other.engine.queries.get(0).query().get("includeOwnership"));
  }

  @Test
  void continuingAfterScoringPhaseWorks() {
    Made m = makeAi(e -> e.policy(flatPolicy(9, Map.of(20, 0.95))));
    AiMove r = get(m.ai.chooseMove(req(9, new int[] {40, -1, -1}, WHITE, "k4", true)));
    assertEquals(20, r.move());
    assertEquals(node("[[\"B\",\"E5\"],[\"W\",\"pass\"],[\"B\",\"pass\"]]"), m.engine.queries.get(0).query().get("moves"));
  }

  // ---------------------------------------------------------------------------------------------
  // 合法性校验与重选

  @Test
  void illegalPickByOurEngineKoIsRepicked() {
    // 黑 11 提掉白 10，白不能立即回提 10
    int[] moves = {1, 2, 9, 10, 19, 12, 80, 20, 11};
    GameState state = AiCommon.replayMoves(9, 7.5, moves);
    assertEquals(10, state.ko);
    assertFalse(AiCommon.isLegal(state, WHITE, 10));
    // 假装 KataGo 认为回提合法且是第一选点
    Made m = makeAi(e -> e.policy(flatPolicy(9, Map.of(10, 0.95, 30, 0.9))));
    AiMove r = get(m.ai.chooseMove(req(9, moves, WHITE, "k18", false)));
    assertEquals(30, r.move());
    assertTrue(CaptureLog.any(m.log.debug, "着手 10 不合法"));
  }

  @Test
  void repeatedIllegalPicksFallBackToBestLegalPolicyMove() {
    int[] moves = {0, 1, 2, 3, 4, 5, 6, 7}; // 第一行已被占满 8 个点
    Map<Integer, Double> hot =
        Map.of(0, 0.9, 1, 0.89, 2, 0.88, 3, 0.87, 4, 0.86, 5, 0.85, 6, 0.84, 7, 0.83, 50, 0.05);
    Made m = makeAi(e -> e.policy(flatPolicy(9, hot)));
    AiMove r = get(m.ai.chooseMove(req(9, moves, BLACK, "k1", false)));
    assertEquals(50, r.move());
    assertEquals(6, CaptureLog.count(m.log.debug, "不合法"), "首选 + 5 次重选");
  }

  // ---------------------------------------------------------------------------------------------
  // 认输与视角

  @Test
  void winrateAndLeadAreConvertedToAiPerspective() {
    FakeAnalysisEngine.RootInfo ri = new FakeAnalysisEngine.RootInfo(0.7, 3.5, 1);
    AiMove black = get(makeAi(e -> e.rootInfo(ri)).ai.chooseMove(req(9, new int[0], BLACK, "k8", false)));
    assertEquals(new AiMoveInfo(0.7, 3.5, 1), black.info());
    AiMove white = get(makeAi(e -> e.rootInfo(ri)).ai.chooseMove(req(9, new int[] {40}, WHITE, "k8", false)));
    assertEquals(0.3, white.info().winrate(), 1e-12);
    assertEquals(-3.5, white.info().scoreLead());
    assertEquals(1, white.info().visits());
  }

  @Test
  void resignRules() {
    Object[][] cases = {
      // size, moveCount, AI 颜色, 黑方视角 winrate, scoreLead, 应认输
      {9, 34, BLACK, 0.01, -9.0, true},
      {9, 33, WHITE, 0.99, 9.0, true},
      {9, 32, BLACK, 0.01, -9.0, false}, // 手数不够（需 > 32.4）
      {9, 34, BLACK, 0.01, -8.0, false}, // 落后没超过 8 目
      {9, 34, BLACK, 0.02, -30.0, false}, // 胜率不低于 2%
      {9, 33, WHITE, 0.01, -30.0, false}, // 白方其实大优
      {13, 68, BLACK, 0.001, -15.5, true},
      {13, 68, BLACK, 0.001, -15.0, false},
      {13, 66, BLACK, 0.001, -40.0, false}, // 需 > 67.6 手
      {19, 146, BLACK, 0.001, -25.5, true},
      {19, 144, BLACK, 0.001, -60.0, false},
      {19, 146, BLACK, 0.001, -24.0, false},
    };
    for (Object[] c : cases) {
      int size = (Integer) c[0];
      int count = (Integer) c[1];
      int color = (Integer) c[2];
      FakeAnalysisEngine.RootInfo ri = new FakeAnalysisEngine.RootInfo((Double) c[3], (Double) c[4]);
      boolean expected = (Boolean) c[5];
      for (String level : List.of("k8", "max")) {
        int[] moves = filler(size, count);
        assertEquals(color, moves.length % 2 == 0 ? BLACK : WHITE, "测试数据：颜色与手数对应");
        Made m = makeAi(e -> e.rootInfo(ri).moveInfos("pass"));
        AiMove r = get(m.ai.chooseMove(req(size, moves, color, level, false)));
        assertEquals(expected, r.resign(), size + " 路 " + count + " 手 " + level + " " + ri);
        if (expected) {
          assertEquals(-1, r.move());
          assertTrue(r.info().winrate() < 0.02 && r.info().scoreLead() < 0);
        }
      }
    }
  }

  @Test
  void rankLevelsVerifyResignWithSearchAndContinueWhenNotSupported() {
    int[] moves = filler(9, 34); // 轮到黑，手数够
    // 黑方视角：1 次评估说黑必败，搜索说黑领先
    FakeAnalysisEngine.Val<FakeAnalysisEngine.RootInfo> ri =
        (q, c) ->
            q.get("maxVisits").asInt() == 1
                ? new FakeAnalysisEngine.RootInfo(0.01, -30)
                : new FakeAnalysisEngine.RootInfo(0.8, 6);
    for (String level : List.of("k18", "k1", "d5")) {
      Made m = makeAi(e -> e.rootInfoFn(ri).moveInfos("E5"));
      AiMove r = get(m.ai.chooseMove(req(9, moves, BLACK, level, false)));
      assertFalse(r.resign(), level);
      assertNotEquals(-1, r.move(), level);
      assertEquals(new AiMoveInfo(0.8, 6, 100), r.info(), "返回搜索的判断");
      assertEquals(2, m.engine.queries.size());
      assertEquals(1, m.engine.queries.get(0).query().get("maxVisits").asInt());
      assertEquals("chinese", m.engine.queries.get(0).query().get("rules").asText());
      assertEquals(100, m.engine.queries.get(1).query().get("maxVisits").asInt());
      assertEquals(RULES_NFP, m.engine.queries.get(1).query().get("rules"));
      assertTrue(CaptureLog.any(m.log.info, "搜索不支持"));
    }
  }

  @Test
  void rankLevelsResignOnlyWhenBothEvaluationAndSearchAgree() {
    int[] moves = filler(9, 34);
    Made m =
        makeAi(
            e ->
                e.rootInfoFn(
                    (q, c) ->
                        q.get("maxVisits").asInt() == 1
                            ? new FakeAnalysisEngine.RootInfo(0.01, -30)
                            : new FakeAnalysisEngine.RootInfo(0.005, -25)));
    AiMove r = get(m.ai.chooseMove(req(9, moves, BLACK, "k8", false)));
    assertEquals(-1, r.move());
    assertTrue(r.resign());
    assertEquals(new AiMoveInfo(0.005, -25, 100), r.info());
    assertEquals(2, m.engine.queries.size());
    // 1 次评估不满足条件时不做核实搜索
    Made calm = makeAi(e -> e.rootInfo(new FakeAnalysisEngine.RootInfo(0.3, -30)));
    get(calm.ai.chooseMove(req(9, moves, BLACK, "k8", false)));
    assertEquals(1, calm.engine.queries.size());
  }

  @Test
  void resignVerificationReusesEndCheckAfterHumanPass() {
    int[] moves = filler(9, 35); // 轮到白（AI），人（黑）刚 pass
    moves[34] = -1;
    // 黑方视角：1 次评估说白必败，终局检查说白领先
    Made m =
        makeAi(
            e ->
                e.rootInfoFn(
                        (q, c) ->
                            q.get("maxVisits").asInt() == 1
                                ? new FakeAnalysisEngine.RootInfo(0.99, 30)
                                : new FakeAnalysisEngine.RootInfo(0.3, -20))
                    .moveInfos("E5"));
    AiMove r = get(m.ai.chooseMove(req(9, moves, WHITE, "k4", true)));
    assertFalse(r.resign());
    assertNotEquals(-1, r.move());
    assertEquals(0.7, r.info().winrate(), 1e-12);
    assertEquals(20, r.info().scoreLead());
    assertEquals(List.of(100, 1), visitsOf(m));
  }

  @Test
  void failedResignVerificationDoesNotResign() {
    int[] moves = filler(9, 34);
    Made m =
        makeAi(
            e ->
                e.rootInfo(new FakeAnalysisEngine.RootInfo(0.01, -30))
                    .respond(
                        (q, c) -> {
                          if (q.get("maxVisits").asInt() == 100) throw new AiException("timeout", "fake timeout");
                          return null;
                        }));
    AiMove r = get(m.ai.chooseMove(req(9, moves, BLACK, "k12", false)));
    assertFalse(r.resign());
    assertNotEquals(-1, r.move());
    assertEquals(new AiMoveInfo(0.01, -30, 1), r.info());
    assertTrue(CaptureLog.any(m.log.warn, "核实搜索失败"));
  }

  @Test
  void endCheckAfterHumanPassAlsoAppliesResignRule() {
    int[] moves = filler(9, 35);
    Made m = makeAi(e -> e.rootInfo(new FakeAnalysisEngine.RootInfo(0.995, 20)).moveInfos("pass"));
    AiMove r = get(m.ai.chooseMove(req(9, moves, WHITE, "k18", true)));
    assertEquals(-1, r.move());
    assertTrue(r.resign());
  }

  // ---------------------------------------------------------------------------------------------
  // 死子判定

  @Test
  void judgeDeadAveragesOwnershipPerGroup() {
    // 黑 {0,1} 一块、白 {79,80} 一块、黑 40、白 44；终局两次 pass
    int[] moves = {0, 79, 1, 80, 40, 44, -1, -1};
    double[] own = new double[81];
    own[0] = -0.9; // 黑块平均 -0.55 → 死
    own[1] = -0.2;
    own[79] = 0.6; // 白块平均 +0.45 → 活（尽管 79 单点 > 0.5）
    own[80] = 0.3;
    own[40] = -0.5; // 正好 -0.5 → 死
    own[44] = 0.49; // 白方视角 -0.49 → 活
    Made m = makeAi(e -> e.ownership(own));
    DeadResult r = get(m.ai.judgeDead(9, 7.5, moves));
    assertEquals(new DeadResult(new int[] {0, 1, 40}, "katago"), r);
    FakeAnalysisEngine.Rec rec = m.engine.queries.get(0);
    assertEquals(200, rec.query().get("maxVisits").asInt());
    assertTrue(rec.query().get("includeOwnership").asBoolean());
    assertEquals("chinese", rec.query().get("rules").asText());
    assertEquals("BLACK", rec.query().at("/overrideSettings/reportAnalysisWinratesAs").asText());
    JsonNode mv = rec.query().get("moves");
    assertEquals(8, mv.size());
    assertEquals(node("[\"B\",\"pass\"]"), mv.get(6));
    assertEquals(node("[\"W\",\"pass\"]"), mv.get(7));
    assertEquals(14000, rec.timeoutMs());
  }

  @Test
  void judgeDeadTimeoutFollowsJudgeTimeoutMs() {
    Made m = makeAi(null, b -> b.judgeTimeoutMs(8000L));
    get(m.ai.judgeDead(9, 7.5, new int[] {40, -1, -1}));
    assertEquals(7000, m.engine.queries.get(0).timeoutMs());
  }

  @Test
  void judgeDeadFailures() {
    Made fail =
        makeAi(
            e ->
                e.respond(
                    (q, c) -> {
                      throw new AiException("timeout", "KataGo 请求超时（14000ms）");
                    }));
    assertEquals("timeout", code(fail.ai.judgeDead(9, 7.5, new int[0])));
    Made bad = makeAi(e -> e.ownership(new double[] {0, 0, 0}));
    assertEquals("katago_error", code(bad.ai.judgeDead(9, 7.5, new int[0])));
    double[] nans = new double[81];
    Arrays.fill(nans, Double.NaN);
    Made nan = makeAi(e -> e.ownership(nans));
    assertEquals("katago_error", code(nan.ai.judgeDead(9, 7.5, new int[0])));
    Made off = makeAi(e -> e.available(false));
    assertEquals("ai_unavailable", code(off.ai.judgeDead(9, 7.5, new int[0])));
    assertEquals(0, off.engine.queries.size());
  }

  // ---------------------------------------------------------------------------------------------
  // 参数校验

  @Test
  void invalidArgumentsRejectWithBadRequestWithoutQueryingKataGo() {
    List<AiMoveRequest> bad =
        Arrays.asList(
            null,
            new AiMoveRequest(10, 7.5, new int[] {40}, WHITE, "k8", false),
            new AiMoveRequest(9, 7.3, new int[] {40}, WHITE, "k8", false),
            new AiMoveRequest(9, Double.NaN, new int[] {40}, WHITE, "k8", false),
            new AiMoveRequest(9, 200, new int[] {40}, WHITE, "k8", false),
            new AiMoveRequest(9, 7.5, null, WHITE, "k8", false),
            req(9, new int[] {81}, WHITE, "k8", false),
            req(9, new int[] {-2}, WHITE, "k8", false),
            req(9, new int[] {40, 40}, BLACK, "k8", false), // 占用
            req("k99"),
            req(null),
            req("basic"),
            req(9, new int[] {40}, BLACK, "k8", false), // 轮到白
            req(9, new int[] {40}, 3, "k8", false),
            req(9, new int[0], WHITE, "k8", false),
            req(9, new int[2001], BLACK, "k8", false));
    Made m = makeAi(null);
    for (AiMoveRequest r : bad) assertEquals("bad_request", code(m.ai.chooseMove(r)), String.valueOf(r));
    // 自杀
    Throwable suicide = rejects(m.ai.chooseMove(req(9, new int[] {1, 2, 9, 0}, BLACK, "k8", false)));
    assertEquals("bad_request", ((AiException) suicide).getCode());
    assertTrue(suicide.getMessage().contains("第 4 手非法：suicide"), suicide.getMessage());
    assertEquals("bad_request", code(m.ai.judgeDead(7, 7.5, new int[0])));
    assertEquals("bad_request", code(m.ai.judgeDead(9, 7.5, new int[] {40, 40})));
    assertEquals("bad_request", code(m.ai.judgeDead(9, 7.5, null)));
    assertEquals(0, m.engine.queries.size());
  }

  @Test
  void kataGoFailuresOrMalformedResponsesReject() {
    AiException err = new AiException("katago_error", "KataGo 拒绝请求：boom");
    Made m =
        makeAi(
            e ->
                e.respond(
                    (q, c) -> {
                      throw err;
                    }));
    assertSame(err, rejects(m.ai.chooseMove(req())));
    Made m2 = makeAi(e -> e.policy(new double[] {0.5, 0.5}));
    assertEquals("katago_error", code(m2.ai.chooseMove(req())));
  }

  // ---------------------------------------------------------------------------------------------
  // 可用性、最短思考时间

  @Test
  void unavailableOrClosedEngineRejects() {
    Made m = makeAi(e -> e.available(false));
    assertFalse(m.ai.available());
    assertEquals(Levels.publicLevels(), m.ai.levels(), "不可用时仍列出难度");
    assertEquals("ai_unavailable", code(m.ai.chooseMove(req())));
    m.engine.available(true);
    assertTrue(m.ai.available());
    get(m.ai.chooseMove(req()));
    m.ai.shutdown();
    assertTrue(m.engine.stopped);
    assertFalse(m.ai.available());
    assertEquals("ai_unavailable", code(m.ai.chooseMove(req())));
    assertEquals("katago", m.ai.kind());
  }

  @Test
  void minimumThinkTime() {
    // 默认值：注入时钟与 sleep
    List<Long> sleeps = new ArrayList<>();
    long[] clock = {1000};
    KataGoAiService ai =
        KataGoAiService.builder(new FakeAnalysisEngine())
            .log(AiLog.SILENT)
            .clock(() -> clock[0])
            .sleeper(
                ms -> {
                  sleeps.add(ms);
                  clock[0] += ms;
                  return java.util.concurrent.CompletableFuture.completedFuture(null);
                })
            .build();
    get(ai.chooseMove(req()));
    assertEquals(List.of(600L), sleeps);

    // 已经想了 450ms → 只再等 150ms
    List<Long> sleeps2 = new ArrayList<>();
    long[] t = {0};
    FakeAnalysisEngine e2 =
        new FakeAnalysisEngine()
            .respond(
                (q, c) -> {
                  t[0] += 450;
                  return null;
                });
    KataGoAiService ai2 =
        KataGoAiService.builder(e2)
            .minThinkMs(600L)
            .clock(() -> t[0])
            .sleeper(
                ms -> {
                  sleeps2.add(ms);
                  return java.util.concurrent.CompletableFuture.completedFuture(null);
                })
            .build();
    get(ai2.chooseMove(req()));
    assertEquals(List.of(150L), sleeps2);

    // 设为 0 → 不等待
    List<Long> sleeps3 = new ArrayList<>();
    KataGoAiService ai3 =
        KataGoAiService.builder(new FakeAnalysisEngine())
            .minThinkMs(0L)
            .sleeper(
                ms -> {
                  sleeps3.add(ms);
                  return java.util.concurrent.CompletableFuture.completedFuture(null);
                })
            .build();
    get(ai3.chooseMove(req()));
    assertEquals(List.of(), sleeps3);

    // 真实计时
    KataGoAiService ai4 = KataGoAiService.builder(new FakeAnalysisEngine()).minThinkMs(120L).build();
    long t0 = System.currentTimeMillis();
    get(ai4.chooseMove(req()));
    assertTrue(System.currentTimeMillis() - t0 >= 110);

    assertThrows(
        IllegalArgumentException.class, () -> KataGoAiService.builder(new FakeAnalysisEngine()).minThinkMs(-1L).build());
  }

  @Test
  void shouldResignThresholds() {
    assertTrue(KataGoAiService.shouldResign(new AiMoveInfo(0.01, -9, 1), 9, 33));
    assertFalse(KataGoAiService.shouldResign(null, 9, 100));
    assertEquals(new HashSet<>(List.of(8.0, 15.0, 25.0)), new HashSet<>(List.of(KataGoAiService.resignLead(9), KataGoAiService.resignLead(13), KataGoAiService.resignLead(19))));
  }
}
