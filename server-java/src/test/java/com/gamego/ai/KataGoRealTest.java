package com.gamego.ai;

import static com.gamego.ai.TestUtil.get;
import static com.gamego.ai.TestUtil.rejects;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.gamego.engine.Coords;
import com.gamego.engine.GameState;
import com.gamego.engine.Record;
import com.gamego.engine.Result;
import com.gamego.engine.Score;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.junit.jupiter.api.TestMethodOrder;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

/**
 * 真实 KataGo 的集成测试（移植自 server/test/katago.real.test.js）。只有设置了 KATAGO_PATH、KATAGO_MODEL、KATAGO_CONFIG
 * 三个环境变量时才运行，否则跳过。相对路径按运行目录（server-java/）解析。例（PowerShell）：
 *
 * <pre>
 *   $env:KATAGO_PATH='../server/katago/katago.exe'
 *   $env:KATAGO_MODEL='../server/katago/kata1-b10c128-s1141046784-d204142634.txt.gz'
 *   $env:KATAGO_CONFIG='katago/analysis.cfg'
 *   mvn -q -DbuildDir=target-ai test -Dtest='com.gamego.ai.KataGoRealTest'
 * </pre>
 *
 * 各请求的耗时以 "[katago-real]" 开头打印到标准输出。
 */
@EnabledIfEnvironmentVariable(named = "KATAGO_PATH", matches = ".+")
@EnabledIfEnvironmentVariable(named = "KATAGO_MODEL", matches = ".+")
@EnabledIfEnvironmentVariable(named = "KATAGO_CONFIG", matches = ".+")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class KataGoRealTest {
  static final int BLACK = 1;
  static final int WHITE = 2;

  KataGoAiService ai;
  KataGoEngine engine;
  CaptureLog log;
  final List<String> timings = new CopyOnWriteArrayList<>();

  static String resolve(String p) {
    return Path.of(System.getProperty("user.dir")).resolve(p).toAbsolutePath().normalize().toString();
  }

  static int[] g(List<String> pts, int size) {
    return pts.stream().mapToInt(p -> p.equals("pass") ? -1 : Coords.gtpToIdx(p, size)).toArray();
  }

  static int[] g(String pts, int size) {
    return g(Arrays.asList(pts.split(" ")), size);
  }

  static List<String> col(char c) {
    List<String> out = new ArrayList<>();
    for (int r = 1; r <= 9; r++) out.add(c + String.valueOf(r));
    return out;
  }

  static List<String> interleave(List<String> a, List<String> b) {
    List<String> out = new ArrayList<>();
    for (int i = 0; i < a.size(); i++) {
      out.add(a.get(i));
      out.add(b.get(i));
    }
    return out;
  }

  static int[] concat(int[] a, int... b) {
    int[] out = Arrays.copyOf(a, a.length + b.length);
    System.arraycopy(b, 0, out, a.length, b.length);
    return out;
  }

  static String resultText(GameState state, double komi, int[] dead) {
    Score.ScoreResult s = Score.scoreArea(state.board, komi, dead);
    return Record.resultText(new Result(s.winner(), "score", s.black(), s.white()));
  }

  static ObjectNode q(String s) {
    return KataGoEngineTest.q(s);
  }

  @BeforeAll
  void setUp() {
    log = new CaptureLog();
    AiServiceFactory.Settings s =
        new AiServiceFactory.Settings(
            resolve(System.getenv("KATAGO_PATH")),
            resolve(System.getenv("KATAGO_MODEL")),
            resolve(System.getenv("KATAGO_CONFIG")),
            false,
            0L,
            null);
    AiService svc = AiServiceFactory.create(s, log);
    assertEquals("katago", svc.kind());
    ai = (KataGoAiService) svc;
    engine = (KataGoEngine) ai.engine();
    assertTrue(ai.available(), "启动中也视为可用");
    long t0 = System.currentTimeMillis();
    get(engine.start());
    timings.add("KataGo 启动到就绪：" + (System.currentTimeMillis() - t0) + "ms（从本测试调用 start() 起算）");
    assertTrue(engine.isReady());
  }

  @AfterAll
  void tearDown() {
    if (ai == null) return;
    long t0 = System.currentTimeMillis();
    ai.shutdown();
    timings.add("shutdown：" + (System.currentTimeMillis() - t0) + "ms");
    assertNull(engine.pid(), "KataGo 进程已退出");
    assertFalse(ai.available());
    for (String t : timings) System.out.println("[katago-real] " + t);
  }

  <T> T timed(String label, CompletableFuture<T> f) {
    long t0 = System.currentTimeMillis();
    T v = get(f);
    timings.add(label + "：" + (System.currentTimeMillis() - t0) + "ms");
    return v;
  }

  @Test
  @Order(1)
  void protocolVersionErrorsWithAndWithoutId() {
    JsonNode v = get(engine.query(q("{\"action\":\"query_version\"}")));
    assertTrue(v.get("version").asText().matches("^\\d+\\.\\d+.*"), v.toString());
    timings.add("KataGo 版本：" + v.get("version").asText());
    Throwable e1 =
        rejects(
            engine.query(
                q(
                    "{\"boardXSize\":9,\"boardYSize\":9,\"rules\":\"chinese\",\"komi\":7.5,"
                        + "\"moves\":[[\"B\",\"E5\"],[\"W\",\"E5\"]],\"maxVisits\":1}")));
    assertEquals("katago_error", ((AiException) e1).getCode());
    assertTrue(e1.getMessage().contains("Illegal move"), e1.getMessage());
    Throwable e2 = rejects(engine.query(q("{\"action\":\"no_such_action\"}"), 1500));
    assertEquals("timeout", ((AiException) e2).getCode());
    assertTrue(CaptureLog.any(log.warn, "没有 id"));
    // 引擎仍然正常
    JsonNode r =
        timed(
            "1 次评估（9 路空盘，直接 query）",
            engine.query(
                q(
                    "{\"boardXSize\":9,\"boardYSize\":9,\"rules\":\"chinese\",\"komi\":7.5,\"moves\":[],"
                        + "\"maxVisits\":1,\"includePolicy\":true}")));
    assertEquals(82, r.get("policy").size());
  }

  @Test
  @Order(2)
  void busyQueuedTimeoutsAreNotTreatedAsHang() {
    // 回归：10 个 1 秒的搜索同时发出，分析线程只有几个，其余在 KataGo 内部排队、1.5 秒时一起超时。
    // 期间先到的请求照常出结果，所以这不是卡死；不能把正在搜索的进程杀掉重启。
    Long pid = engine.pid();
    KataGoEngine.Stats before = engine.stats();
    ObjectNode query =
        q(
            "{\"boardXSize\":19,\"boardYSize\":19,\"rules\":\"chinese\",\"komi\":7.5,"
                + "\"moves\":[[\"B\",\"Q16\"],[\"W\",\"D4\"]],\"maxVisits\":100000,\"overrideSettings\":{\"maxTime\":1}}");
    List<CompletableFuture<JsonNode>> fs = new ArrayList<>();
    for (int i = 0; i < 10; i++) fs.add(engine.query(query, 1500));
    int ok = 0;
    int timedOut = 0;
    List<String> other = new ArrayList<>();
    for (CompletableFuture<JsonNode> f : fs) {
      try {
        f.join();
        ok++;
      } catch (Exception e) {
        Throwable c = AiException.unwrap(e);
        if (c instanceof AiException ae && ae.getCode().equals("timeout")) timedOut++;
        else other.add(String.valueOf(c));
      }
    }
    assertEquals(10, ok + timedOut, other.toString());
    assertTrue(ok >= 1, "先发出的请求应当正常返回");
    timings.add("10 个 1 秒搜索同时发出、1.5 秒超时：完成 " + ok + " 个，超时 " + timedOut + " 个");
    assertEquals(before.hangs(), engine.stats().hangs(), "不应判定为卡死（超时 " + timedOut + " 个）");
    assertEquals(before.crashes(), engine.stats().crashes());
    assertEquals(pid, engine.pid(), "还是原来的进程");
    JsonNode r =
        get(
            engine.query(
                q(
                    "{\"boardXSize\":9,\"boardYSize\":9,\"rules\":\"chinese\",\"komi\":7.5,\"moves\":[],"
                        + "\"maxVisits\":1,\"includePolicy\":true}")));
    assertEquals(82, r.get("policy").size());
    assertEquals(pid, engine.pid());
  }

  @Test
  @Order(3)
  void everyLevelGivesLegalMovesOn9x13x19() {
    Object[][] positions = {
      {9, g("E5 C4 G4", 9)}, {9, g("E5 C4", 9)}, {13, g("D4 K10 D10 K4", 13)}, {19, g("Q16 D4 Q4", 19)},
    };
    for (Object[] pos : positions) {
      int size = (Integer) pos[0];
      int[] moves = (int[]) pos[1];
      int color = moves.length % 2 == 0 ? BLACK : WHITE;
      GameState state = AiCommon.replayMoves(size, 7.5, moves);
      for (Levels.Level level : Levels.LEVELS) {
        long t0 = System.currentTimeMillis();
        AiMove r = get(ai.chooseMove(new AiMoveRequest(size, 7.5, moves, color, level.id(), false)));
        long ms = System.currentTimeMillis() - t0;
        String label = size + " 路 " + moves.length + " 手 " + level.id() + "：" + r + "（" + ms + "ms）";
        timings.add("chooseMove " + label);
        assertFalse(r.resign(), label);
        assertNotEquals(-1, r.move(), "开局不应 pass：" + label);
        assertTrue(AiCommon.isLegal(state, color, r.move()), label);
        assertNotNull(r.info(), label);
        assertTrue(r.info().winrate() >= 0 && r.info().winrate() <= 1 && r.info().visits() >= 1, label);
        assertTrue(ms < 20000, label);
      }
    }
  }

  @Test
  @Order(4)
  void settledPositionAfterHumanPassAllLevelsPass() {
    // 白墙 E 列、黑墙 F 列：白 45 目 + 7.5，黑 36 目；黑（人）刚 pass，轮到白（AI）
    int[] moves = concat(g(interleave(col('F'), col('E')), 9), -1);
    assertEquals(19, moves.length);
    for (String level : List.of("max", "k18", "d5")) {
      AiMove r = timed("终局检查（局面已定）" + level, ai.chooseMove(new AiMoveRequest(9, 7.5, moves, WHITE, level, true)));
      assertEquals(-1, r.move(), level + "：" + r);
      assertFalse(r.resign(), level + "：" + r);
      assertTrue(r.info().winrate() > 0.9, "白方大优：" + r.info());
      assertTrue(r.info().scoreLead() > 5, "白方大优：" + r.info());
    }
  }

  @Test
  @Order(5)
  void settledWithDeadStonesInAiAreaAllLevelsPassWithoutCapturingFirst() {
    // 黑墙 E 列 + 白地里的黑死子 H5；白墙 F 列 + 黑地里的白死子 B5。数子（提掉死子）黑 45、白 36 + 7.5 → 黑胜 1.5。
    List<String> black = new ArrayList<>(col('E'));
    black.add("H5");
    List<String> white = new ArrayList<>(col('F'));
    white.add("B5");
    int[] moves = concat(g(interleave(black, white), 9), -1);
    assertEquals(21, moves.length);
    for (String level : List.of("k18", "k8", "d5", "max")) {
      AiMove r = timed("终局检查（死子未提）" + level, ai.chooseMove(new AiMoveRequest(9, 7.5, moves, WHITE, level, true)));
      assertEquals(-1, r.move(), level + "：" + r);
      assertFalse(r.resign(), level + "：" + r);
    }
    int[] end = concat(moves, -1);
    DeadResult d = get(ai.judgeDead(9, 7.5, end));
    int[] expected = g("H5 B5", 9);
    Arrays.sort(expected);
    assertEquals(Arrays.toString(expected), Arrays.toString(d.dead()));
    assertEquals("B+1.5", resultText(AiCommon.replayMoves(9, 7.5, end), 7.5, d.dead()));
  }

  @Test
  @Order(6)
  void judgeDeadFindsObviousDeadStones9x9() {
    // 黑：C、D 两列墙 + 白地里的死子 J5；白：E、G 两列墙 + 黑地里的死子 B5；然后双方 pass
    List<String> black = new ArrayList<>(col('D'));
    black.addAll(col('C'));
    black.add("J5");
    List<String> white = new ArrayList<>(col('E'));
    white.addAll(col('G'));
    white.add("B5");
    int[] moves = concat(g(interleave(black, white), 9), -1, -1);
    GameState state = AiCommon.replayMoves(9, 7.5, moves);
    assertEquals(GameState.SCORING, state.status);
    DeadResult r = timed("judgeDead 9 路", ai.judgeDead(9, 7.5, moves));
    assertEquals("katago", r.source());
    int[] expected = g("B5 J5", 9);
    Arrays.sort(expected);
    assertEquals(Arrays.toString(expected), Arrays.toString(r.dead()));
    Score.ScoreResult s = Score.scoreArea(state.board, 7.5, r.dead());
    // 黑：A~D 四列 36；白：E~J 五列 45 + 贴目 7.5 → 白胜 16.5
    assertEquals(36, s.black());
    assertEquals(52.5, s.white());
    assertEquals(WHITE, s.winner());
    assertEquals("W+16.5", resultText(state, 7.5, r.dead()));
  }

  @Test
  @Order(7)
  void judgeDeadNoDeadStonesBlackWinsByHalfPlusOne() {
    int[] moves = concat(g(interleave(col('E'), col('F')), 9), -1, -1);
    GameState state = AiCommon.replayMoves(9, 7.5, moves);
    DeadResult r = get(ai.judgeDead(9, 7.5, moves));
    assertEquals(new DeadResult(new int[0], "katago"), r);
    Score.ScoreResult s = Score.scoreArea(state.board, 7.5, r.dead());
    assertEquals(45, s.black());
    assertEquals(43.5, s.white());
    assertEquals(BLACK, s.winner());
  }

  // 终局局面：黑白两串棋子交替落下（少的一方用 pass 补齐），最后双方 pass。
  static int[] finished(int size, List<String> black, List<String> white) {
    int n = Math.max(black.size(), white.size());
    List<String> seq = new ArrayList<>();
    for (int i = 0; i < n; i++) {
      seq.add(i < black.size() ? black.get(i) : "pass");
      seq.add(i < white.size() ? white.get(i) : "pass");
    }
    while (seq.size() >= 2 && seq.get(seq.size() - 1).equals("pass") && seq.get(seq.size() - 2).equals("pass")) {
      seq.remove(seq.size() - 1);
      seq.remove(seq.size() - 1);
    }
    seq.add("pass");
    seq.add("pass");
    if (seq.get(seq.size() - 3).equals("pass")) seq.remove(seq.size() - 1); // 已有一次 pass 在前，补一次即可
    return g(seq, size);
  }

  static List<String> cols(String letters, int size, String... extra) {
    List<String> out = new ArrayList<>();
    for (char c : letters.toCharArray()) for (int i = 1; i <= size; i++) out.add(c + String.valueOf(i));
    out.addAll(Arrays.asList(extra));
    return out;
  }

  static List<String> list(String... s) {
    return new ArrayList<>(Arrays.asList(s));
  }

  record JudgeCase(String name, int size, List<String> black, List<String> white, String dead, String result) {}

  static List<String> plus(List<String> a, List<String> b) {
    List<String> out = new ArrayList<>(a);
    out.addAll(b);
    return out;
  }

  @Test
  @Order(8)
  void judgeDeadCases() {
    List<JudgeCase> cases =
        List.of(
            new JudgeCase(
                "9 路：黑白双方的多子死块", 9, cols("CDE", 9, "H3", "H2", "J7"), cols("FG", 9, "B7", "B6", "A2"),
                "A2 B6 B7 H2 H3 J7", "B+1.5"),
            new JudgeCase("9 路：中间一列单官未收，没有死子", 9, cols("D", 9), cols("F", 9), "", "W+7.5"),
            new JudgeCase(
                "9 路：左上角双活（各有一只眼、共用一口气），双活的子不判死",
                9,
                plus(list("B9", "C9", "J9", "A8", "B8", "C8", "D8", "J8", "E7", "F7", "G7", "H7", "J7"), cols("E", 6)),
                plus(list("E9", "F9", "H9", "E8", "F8", "G8", "H8", "A7", "B7", "C7", "D7"), cols("D", 6)),
                "",
                "B+0.5"),
            new JudgeCase(
                "13 路：黑白双方的死子", 13, cols("CDL", 13, "G9", "H9", "G8", "H3"), cols("EFJK", 13, "B10", "B11", "N4"),
                "B10 B11 G8 G9 H3 H9 N4", "B+5.5"),
            new JudgeCase(
                "19 路：黑白双方的死子", 19, cols("CDLMP", 19, "G10", "H10", "G9", "S3", "T17"),
                cols("EFJKQR", 19, "B16", "B15", "O5"), "B15 B16 G10 G9 H10 O5 S3 T17", "W+26.5"));
    for (JudgeCase c : cases) {
      int[] moves = finished(c.size(), c.black(), c.white());
      GameState state = AiCommon.replayMoves(c.size(), 7.5, moves);
      assertEquals(GameState.SCORING, state.status, c.name() + "：构造的局面应以两次 pass 结束");
      DeadResult r = timed("judgeDead " + c.name(), ai.judgeDead(c.size(), 7.5, moves));
      List<String> got = new ArrayList<>();
      for (int i : r.dead()) got.add(Coords.idxToGtp(i, c.size()));
      got.sort(null);
      List<String> want = c.dead().isEmpty() ? new ArrayList<>() : list(c.dead().split(" "));
      want.sort(null);
      assertEquals(want, got, c.name());
      assertEquals(c.result(), resultText(state, 7.5, r.dead()), c.name());
    }
  }

  @Test
  @Order(9)
  void weakLevelDoesNotResignOnOneEvaluationWhenSearchDisagrees() {
    // 19 路自对弈中 k8（白）在第 164 手认输的局面：1 次评估判白胜率 1.1%、落后 26 目，400 次搜索却是胜率 17%、落后 11.5 目。
    int[] moves =
        g(
            "C17 R16 Q4 C4 F4 P16 C6 D5 E7 E3 K17 M17 D11 E6 B4 R3 R4 Q3 P4 C15 D16 B3 P3 F6 K15 D13 E4 D9 C9 C16 E16 B17 H5 H3 "
                + "G4 S6 C18 C10 C11 J5 J7 B10 F7 G7 F10 B11 E2 H4 D7 B5 S3 H7 G2 G5 C3 D10 D3 G9 R11 E14 L6 G16 R14 R9 P10 S5 F15 H11 "
                + "H12 J16 F5 H6 G11 S2 A4 C5 S4 K16 R7 Q8 F14 J11 O16 Q6 N17 L17 R10 O15 P8 O7 P7 N2 M3 O5 F9 E11 M9 N16 O17 G12 N3 "
                + "N14 H17 Q9 S9 S8 Q7 J9 R18 F13 G17 P17 B2 N10 D6 J17 E5 O8 P9 A5 B6 F16 J12 F17 H16 H18 E15 B18 D14 F12 M16 H15 H14 "
                + "L11 G14 M13 F18 G18 P18 A2 L12 Q14 C14 Q18 B15 S10 N15 Q19 S11 S7 T9 E18 B1 B16 J14 K12 K13 M11 Q17 M15 B14 G6 B19",
            19);
    assertEquals(163, moves.length);
    GameState state = AiCommon.replayMoves(19, 7.5, moves);
    int checked = 0;
    for (int i = 0; i < 6; i++) {
      get(engine.query(q("{\"action\":\"clear_cache\"}")));
      int before = log.info.size();
      AiMove r = timed("k8 认输回归第 " + (i + 1) + " 次", ai.chooseMove(new AiMoveRequest(19, 7.5, moves, WHITE, "k8", false)));
      assertFalse(r.resign(), "第 " + (i + 1) + " 次：" + r);
      assertTrue(AiCommon.isLegal(state, WHITE, r.move()), "第 " + (i + 1) + " 次：" + r);
      if (CaptureLog.any(log.info.subList(before, log.info.size()), "搜索不支持")) checked++;
    }
    timings.add("认输回归：6 次里 " + checked + " 次触发了核实搜索");
  }

  @Test
  @Order(100) // 放在最后：会让 KataGo 重启一次
  void killedProcessFailsInFlightRequestAndRestarts() throws Exception {
    long pid = engine.pid();
    int[] moves = g("Q16 D4 Q4 D16", 19);
    CompletableFuture<AiMove> inFlight = ai.chooseMove(new AiMoveRequest(19, 7.5, moves, BLACK, "max", false));
    Thread.sleep(300);
    ProcessHandle.of(pid).ifPresent(ProcessHandle::destroyForcibly);
    long t0 = System.currentTimeMillis();
    Throwable err = rejects(inFlight);
    assertEquals("katago_error", ((AiException) err).getCode(), String.valueOf(err));
    assertTrue(System.currentTimeMillis() - t0 < 5000, "不用等到超时");
    assertTrue(ai.available(), "重启期间仍视为可用");
    long t1 = System.currentTimeMillis();
    AiMove r = get(ai.chooseMove(new AiMoveRequest(19, 7.5, moves, BLACK, "d3", false)));
    timings.add("进程被杀后第一步（含重启等待）：" + (System.currentTimeMillis() - t1) + "ms");
    assertTrue(AiCommon.isLegal(AiCommon.replayMoves(19, 7.5, moves), BLACK, r.move()));
    assertNotEquals(pid, engine.pid());
    assertEquals(1, engine.stats().crashes());
  }
}
