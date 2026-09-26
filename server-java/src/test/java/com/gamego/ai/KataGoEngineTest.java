package com.gamego.ai;

import static com.gamego.ai.TestUtil.code;
import static com.gamego.ai.TestUtil.get;
import static com.gamego.ai.TestUtil.rejects;
import static com.gamego.ai.TestUtil.waitFor;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.annotation.JsonAutoDetect;
import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.File;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import java.util.function.IntFunction;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * 用 FakeKataGo（一个说 KataGo 分析协议的 Java 小程序，单独的 JVM 进程）测进程管理（移植自 server/test/ai/katago.test.js）：
 * 就绪、按 id 匹配、warning/中间结果/错误、超时与 terminate、崩溃重启与退避、启动失败、卡死、关闭。
 */
class KataGoEngineTest {
  private final List<KataGoEngine> engines = new ArrayList<>();

  @AfterEach
  void cleanup() throws Exception {
    for (KataGoEngine e : engines) e.shutdown().get(20, TimeUnit.SECONDS);
  }

  static String javaExe() {
    boolean win = System.getProperty("os.name").toLowerCase().contains("win");
    return Path.of(System.getProperty("java.home"), "bin", win ? "java.exe" : "java").toString();
  }

  static List<String> fakePrefix() {
    String cp =
        Stream.of(FakeKataGo.class, ObjectMapper.class, JsonFactory.class, JsonAutoDetect.class)
            .map(
                c -> {
                  try {
                    return Path.of(c.getProtectionDomain().getCodeSource().getLocation().toURI()).toString();
                  } catch (Exception e) {
                    throw new RuntimeException(e);
                  }
                })
            .distinct()
            .collect(Collectors.joining(File.pathSeparator));
    return List.of("-XX:TieredStopAtLevel=1", "-XX:+UseSerialGC", "-Xmx64m", "-cp", cp, FakeKataGo.class.getName());
  }

  static final class Made {
    KataGoEngine eng;
    CaptureLog log = new CaptureLog();
    List<Long> spawnTimes = new CopyOnWriteArrayList<>();
    AtomicInteger starts = new AtomicInteger();
  }

  Made make(Map<String, String> env, IntFunction<Map<String, String>> perStart, Consumer<KataGoEngine.Options> tweak) {
    Made m = new Made();
    KataGoEngine.Options o =
        new KataGoEngine.Options(javaExe(), "fake-model.bin.gz", "fake.cfg")
            .argsPrefix(fakePrefix())
            .env(env == null ? Map.of() : env)
            .log(m.log)
            .starter(
                pb -> {
                  int n = m.starts.incrementAndGet();
                  m.spawnTimes.add(System.currentTimeMillis());
                  if (perStart != null) pb.environment().putAll(perStart.apply(n));
                  return pb.start();
                })
            .backoffInitialMs(40)
            .backoffMaxMs(200)
            .startupTimeoutMs(15000)
            .shutdownGraceMs(1500)
            .killWaitMs(500)
            .slowRetryMs(300);
    if (tweak != null) tweak.accept(o);
    m.eng = new KataGoEngine(o);
    engines.add(m.eng);
    return m;
  }

  Made make() {
    return make(null, null, null);
  }

  static ObjectNode q(String json) {
    try {
      return (ObjectNode) AiCommon.JSON.readTree(json);
    } catch (Exception e) {
      throw new RuntimeException(e);
    }
  }

  @Test
  void startsReadyPassesArgsAndMatchesOutOfOrderResultsById() {
    Made m = make();
    KataGoEngine eng = m.eng;
    assertEquals("idle", eng.state());
    assertTrue(eng.available());
    get(eng.start());
    assertEquals("ready", eng.state());
    assertTrue(eng.isReady());
    assertTrue(eng.pid() > 0);
    assertTrue(CaptureLog.any(m.log.debug, "Started, ready to begin handling requests"), "stderr 按 debug 记录");
    assertTrue(CaptureLog.any(m.log.debug, "analysis -config fake.cfg -model fake-model.bin.gz"));

    // 慢的先发、快的后发：结果按 id 各归各位
    CompletableFuture<JsonNode> slow = eng.query(q("{\"tag\":\"slow\",\"moves\":[[\"B\",\"D4\"]],\"fake\":{\"delayMs\":300}}"));
    CompletableFuture<JsonNode> fast = eng.query(q("{\"tag\":\"fast\",\"fake\":{\"delayMs\":10}}"));
    JsonNode b = get(fast);
    assertFalse(slow.isDone(), "快的先回来");
    JsonNode a = get(slow);
    assertEquals("slow", a.at("/echo/tag").asText());
    assertEquals(1, a.get("turnNumber").asInt());
    assertEquals("fast", b.at("/echo/tag").asText());
    assertNotEquals(a.get("id"), b.get("id"));
    assertTrue(a.get("id").isTextual(), "id 必须是字符串");
    assertFalse(a.get("echo").has("id"));

    // action 请求也按 id 返回
    assertEquals("fake", get(eng.query(q("{\"action\":\"query_version\"}"))).get("version").asText());
    // start() 在已就绪时直接完成
    get(eng.start());
    assertEquals(1, eng.stats().starts());
  }

  @Test
  void firstQueryStartsLazilyAndQueuesUntilReady() {
    Made m = make(Map.of("FAKE_KATAGO_STARTUP_DELAY_MS", "150"), null, null);
    JsonNode r = get(m.eng.query(q("{\"tag\":\"lazy\"}")));
    assertEquals("lazy", r.at("/echo/tag").asText());
    assertEquals(1, m.eng.stats().starts());
  }

  @Test
  void warningsPartialResultsAndNonJsonAreIgnored() {
    Made m = make();
    get(m.eng.start());
    JsonNode r = get(m.eng.query(q("{\"tag\":\"x\",\"fake\":{\"warning\":true,\"partial\":3,\"garbage\":true}}")));
    assertEquals("x", r.at("/echo/tag").asText());
    assertFalse(r.get("isDuringSearch").asBoolean());
    assertTrue(CaptureLog.any(m.log.debug, "KataGo 警告", "fooBar"));
    assertTrue(CaptureLog.any(m.log.debug, "非 JSON"));
    assertEquals(List.of(), m.log.warn);
  }

  @Test
  void errorWithIdRejectsWithKatagoError() {
    Made m = make();
    get(m.eng.start());
    Throwable t = rejects(m.eng.query(q("{\"fake\":{\"error\":\"Illegal move 1: E5\",\"field\":\"moves\"}}")));
    AiException err = (AiException) t;
    assertEquals("katago_error", err.getCode());
    assertTrue(err.getMessage().contains("Illegal move 1: E5"));
    assertTrue(err.getMessage().contains("moves"));
    assertEquals("Illegal move 1: E5", ((JsonNode) err.getDetail()).get("error").asText());
    // 进程不受影响
    assertEquals("after", get(m.eng.query(q("{\"tag\":\"after\"}"))).at("/echo/tag").asText());
  }

  @Test
  void idlessErrorIsOnlyLoggedAndRequestEndsByTimeoutWithTerminate() {
    Made m = make();
    get(m.eng.start());
    assertEquals("timeout", code(m.eng.query(q("{\"fake\":{\"idless\":true}}"), 300)));
    assertTrue(CaptureLog.any(m.log.warn, "没有 id", "some error without id"));
    JsonNode s = get(m.eng.query(q("{\"fake\":{\"stats\":true}}")));
    long terms = 0;
    for (JsonNode a : s.at("/stats/actions")) if (a.get("action").asText().equals("terminate")) terms++;
    assertEquals(1, terms);
  }

  @Test
  void singleTimeoutSendsTerminateAndDropsLateResultQuietly() {
    Made m = make();
    get(m.eng.start());
    Throwable t = rejects(m.eng.query(q("{\"fake\":{\"hang\":true}}"), 200));
    assertEquals("timeout", ((AiException) t).getCode());
    assertTrue(t.getMessage().contains("超时"));
    JsonNode s = get(m.eng.query(q("{\"fake\":{\"stats\":true}}")));
    List<JsonNode> term = new ArrayList<>();
    for (JsonNode a : s.at("/stats/actions")) if (a.get("action").asText().equals("terminate")) term.add(a);
    assertEquals(1, term.size());
    assertTrue(term.get(0).get("terminateId").asText().matches("q\\d+"));
    // fake 对被 terminate 的请求回了 noResults：只记 debug
    waitFor(() -> CaptureLog.any(m.log.debug, "迟到"), 5000, "迟到结果日志");
    assertFalse(CaptureLog.any(m.log.warn, "报错"));
    assertEquals(1, m.eng.stats().timeouts());
    assertTrue(m.eng.isReady(), "一次超时不会重启进程");
    assertEquals(1, m.eng.stats().starts());
  }

  @Test
  void crashRejectsInFlightRequestsAndRestartsAutomatically() {
    Made m = make();
    get(m.eng.start());
    long pid1 = m.eng.pid();
    CompletableFuture<JsonNode> waiting = m.eng.query(q("{\"fake\":{\"hang\":true}}"), 10000);
    CompletableFuture<JsonNode> crash = m.eng.query(q("{\"fake\":{\"crash\":3}}"), 10000);
    Throwable e1 = rejects(waiting);
    Throwable e2 = rejects(crash);
    assertEquals("katago_error", ((AiException) e1).getCode());
    assertTrue(e1.getMessage().contains("进程已退出（退出码 3）"), e1.getMessage());
    assertEquals("katago_error", ((AiException) e2).getCode());
    assertTrue(m.eng.available(), "重启期间仍视为可用");
    assertTrue(CaptureLog.any(m.log.warn, "意外退出"));

    // 重启期间发的请求排队，就绪后照常完成
    JsonNode r = get(m.eng.query(q("{\"tag\":\"after-crash\"}")));
    assertEquals("after-crash", r.at("/echo/tag").asText());
    assertNotEquals(pid1, m.eng.pid());
    assertEquals(1, m.eng.stats().crashes());
    assertEquals(2, m.eng.stats().starts());
  }

  @Test
  void repeatedCrashesBackOffExponentiallyWithCap() {
    Made m = make(null, null, o -> o.backoffInitialMs(60).backoffMaxMs(240));
    List<Long> delays = new CopyOnWriteArrayList<>();
    m.eng.addListener(
        new KataGoEngine.Listener() {
          @Override
          public void onExit(Integer code, boolean ready, Long restartInMs) {
            delays.add(restartInMs);
          }
        });
    get(m.eng.start());
    for (int i = 0; i < 4; i++) {
      rejects(m.eng.query(q("{\"fake\":{\"crash\":1}}"), 10000));
      int round = i + 1;
      waitFor(() -> m.eng.isReady() && m.eng.stats().readies() == round + 1, 20000, "第 " + round + " 次重启");
    }
    waitFor(() -> delays.size() == 4, 5000, "exit 事件");
    assertEquals(List.of(60L, 120L, 240L, 240L), delays);
    // 实际间隔不小于退避值
    for (int i = 1; i < m.spawnTimes.size(); i++) {
      assertTrue(m.spawnTimes.get(i) - m.spawnTimes.get(i - 1) >= delays.get(i - 1) - 5);
    }
  }

  @Test
  void repeatedStartupFailuresMarkUnavailableThenSlowRetryRecovers() {
    // 前 3 次启动失败，第 4 次成功；上限 2 次
    Made m =
        make(
            null,
            n -> Map.of("FAKE_KATAGO_FAIL_START", n <= 3 ? "1" : "0"),
            o -> o.maxStartupFailures(2).slowRetryMs(250));
    List<Long> unavailableEvents = new CopyOnWriteArrayList<>();
    m.eng.addListener(
        new KataGoEngine.Listener() {
          @Override
          public void onUnavailable() {
            unavailableEvents.add(System.currentTimeMillis());
          }
        });

    AiException first = (AiException) rejects(m.eng.start());
    assertEquals("ai_unavailable", first.getCode());
    assertTrue(first.getMessage().contains("启动失败"));
    @SuppressWarnings("unchecked")
    List<String> stderr = (List<String>) first.getDetail();
    assertTrue(CaptureLog.any(stderr, "fake startup failure"), "错误里带 stderr 末尾");
    assertTrue(m.eng.available(), "第 1 次失败后仍在重试，视为可用");

    // 排队中的请求在标记不可用时立即失败
    assertEquals("ai_unavailable", code(m.eng.query(q("{\"tag\":\"queued\"}"), 20000)));
    assertFalse(m.eng.available());
    waitFor(() -> unavailableEvents.size() == 1, 5000, "unavailable 事件");
    assertTrue(CaptureLog.any(m.log.error, "标记为不可用"));

    // 不可用期间的新请求直接失败
    assertEquals("ai_unavailable", code(m.eng.query(q("{\"tag\":\"x\"}"))));

    // 慢速重试：第 3 次仍失败，第 4 次成功 → 恢复可用
    waitFor(m.eng::isReady, 20000, "慢速重试后就绪");
    assertTrue(m.eng.available());
    assertEquals(3, m.eng.stats().startupFailures());
    assertEquals(4, m.eng.stats().starts());
    assertTrue(CaptureLog.any(m.log.info, "恢复可用"));
    assertEquals("back", get(m.eng.query(q("{\"tag\":\"back\"}"))).at("/echo/tag").asText());
  }

  @Test
  void startupTimeoutKillsProcessAndCountsAsFailure() {
    Made m =
        make(
            Map.of("FAKE_KATAGO_NEVER_READY", "1"),
            null,
            o -> o.startupTimeoutMs(1500).maxStartupFailures(1).slowRetryMs(60000));
    List<Boolean> exits = new CopyOnWriteArrayList<>();
    m.eng.addListener(
        new KataGoEngine.Listener() {
          @Override
          public void onExit(Integer code, boolean ready, Long restartInMs) {
            exits.add(ready);
          }
        });
    Throwable err = rejects(m.eng.start());
    assertTrue(err.getMessage().contains("1500ms 内没有就绪"), err.getMessage());
    assertFalse(m.eng.available());
    waitFor(() -> exits.size() == 1, 5000, "exit 事件");
    assertEquals(List.of(false), exits);
    assertNull(m.eng.pid(), "进程已被杀掉");
  }

  @Test
  void missingExecutableMarksUnavailableImmediatelyWithoutThrowing() {
    CaptureLog log = new CaptureLog();
    KataGoEngine eng =
        new KataGoEngine(
            new KataGoEngine.Options("fixtures/no-such-katago.exe", "m", "c").log(log).slowRetryMs(60000));
    engines.add(eng);
    assertEquals("ai_unavailable", code(eng.start()));
    assertFalse(eng.available());
    assertEquals("ai_unavailable", code(eng.query(q("{}"))));
    assertTrue(CaptureLog.any(log.error, "标记为不可用"));
  }

  @Test
  void frozenProcessIsKilledAndRestartedAfterConsecutiveSilentTimeouts() {
    Made m = make(null, null, o -> o.hangTimeouts(2));
    get(m.eng.start());
    long pid1 = m.eng.pid();
    CompletableFuture<JsonNode> first = m.eng.query(q("{\"fake\":{\"freeze\":true}}"), 200);
    CompletableFuture<JsonNode> second = m.eng.query(q("{\"tag\":\"never answered\"}"), 300);
    assertEquals("timeout", code(first));
    assertEquals("timeout", code(second));
    assertTrue(CaptureLog.any(m.log.warn, "判定为卡死"));
    waitFor(() -> m.eng.isReady() && m.eng.pid() != null && m.eng.pid() != pid1, 20000, "卡死后重启");
    assertEquals(1, m.eng.stats().hangs());
    assertEquals("ok", get(m.eng.query(q("{\"tag\":\"ok\"}"))).at("/echo/tag").asText());
  }

  @Test
  void busyTimeoutsWithOtherOutputAreNotTreatedAsHang() {
    // 回归：负载高时几个同时发出的请求在 KataGo 内部排队、一起超时，但期间别的请求照常出结果——不能杀进程。
    Made m = make(null, null, o -> o.hangTimeouts(2));
    get(m.eng.start());
    long pid1 = m.eng.pid();
    CompletableFuture<JsonNode> busy = m.eng.query(q("{\"fake\":{\"delayMs\":30}}"), 10000); // 发出 30ms 后有结果
    List<CompletableFuture<JsonNode>> hung = new ArrayList<>();
    for (int i = 0; i < 3; i++) hung.add(m.eng.query(q("{\"fake\":{\"hang\":true}}"), 300));
    assertEquals(pid1, get(busy).get("pid").asLong());
    for (CompletableFuture<JsonNode> h : hung) assertEquals("timeout", code(h));
    TestUtil.sleep(150);
    assertEquals(3, m.eng.stats().timeouts());
    assertEquals(0, m.eng.stats().hangs());
    assertFalse(CaptureLog.any(m.log.warn, "判定为卡死"));
    assertEquals(pid1, m.eng.pid());
    assertEquals(pid1, get(m.eng.query(q("{\"tag\":\"still alive\"}"))).get("pid").asLong(), "还是原来的进程");
    assertEquals(1, m.eng.stats().starts());
  }

  @Test
  void shutdownClosesStdinWaitsForExitAndRejectsEverything() throws Exception {
    Made m = make();
    get(m.eng.start());
    CompletableFuture<JsonNode> pending = m.eng.query(q("{\"fake\":{\"hang\":true}}"), 10000);
    CompletableFuture<Integer> exited = new CompletableFuture<>();
    m.eng.addListener(
        new KataGoEngine.Listener() {
          @Override
          public void onExit(Integer code, boolean ready, Long restartInMs) {
            exited.complete(code);
          }
        });
    long t0 = System.currentTimeMillis();
    CompletableFuture<Void> p1 = m.eng.shutdown();
    CompletableFuture<Void> p2 = m.eng.shutdown();
    assertSame(p1, p2);
    assertEquals("ai_unavailable", code(pending));
    p1.get(10, TimeUnit.SECONDS);
    assertEquals(0, exited.get(5, TimeUnit.SECONDS), "stdin 关闭后正常退出，不需要 kill");
    assertTrue(System.currentTimeMillis() - t0 < 1500, "不必等到强制结束");
    assertFalse(CaptureLog.any(m.log.warn, "强制结束"));
    assertFalse(m.eng.available());
    assertEquals("stopped", m.eng.state());
    assertEquals("ai_unavailable", code(m.eng.query(q("{}"))));
    assertEquals("ai_unavailable", code(m.eng.start()));
  }

  @Test
  void shutdownKillsProcessThatIgnoresStdinCloseAfterGracePeriod() throws Exception {
    Made m = make(Map.of("FAKE_KATAGO_IGNORE_STDIN_END", "1"), null, o -> o.shutdownGraceMs(300));
    get(m.eng.start());
    long t0 = System.currentTimeMillis();
    m.eng.shutdown().get(10, TimeUnit.SECONDS);
    long took = System.currentTimeMillis() - t0;
    assertTrue(took >= 290, "应等待宽限时间（" + took + "ms）");
    assertTrue(took < 3000, "kill 后很快结束（" + took + "ms）");
    assertTrue(CaptureLog.any(m.log.warn, "强制结束"));
    assertNull(m.eng.pid());
  }

  @Test
  void shutdownWhileStartingAlsoFinishes() throws Exception {
    Made m = make(Map.of("FAKE_KATAGO_NEVER_READY", "1"), null, o -> o.shutdownGraceMs(100));
    CompletableFuture<Void> started = m.eng.start();
    CompletableFuture<JsonNode> queued = m.eng.query(q("{\"tag\":\"queued\"}"));
    waitFor(() -> m.eng.pid() != null, 5000, "进程启动");
    m.eng.shutdown().get(10, TimeUnit.SECONDS);
    assertEquals("ai_unavailable", code(started));
    assertEquals("ai_unavailable", code(queued));
    assertNull(m.eng.pid());
  }

  @Test
  void constructorValidation() {
    IllegalArgumentException e1 =
        assertThrows(IllegalArgumentException.class, () -> new KataGoEngine(new KataGoEngine.Options(null, "m", "c")));
    assertTrue(e1.getMessage().contains("path"));
    IllegalArgumentException e2 =
        assertThrows(
            IllegalArgumentException.class, () -> new KataGoEngine.Options("k", "m", "c").backoffInitialMs(-1));
    assertTrue(e2.getMessage().contains("backoffInitialMs"));
  }
}
