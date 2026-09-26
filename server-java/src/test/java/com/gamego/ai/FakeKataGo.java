package com.gamego.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.BufferedReader;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * 模拟 {@code katago analysis} 进程的小程序，给 KataGoEngineTest 测进程管理用（移植自 server/test/ai/fixtures/fake-katago.js）。
 * 用法：java -cp ... com.gamego.ai.FakeKataGo analysis -config x -model y 。
 * 与真实 KataGo 一样：stderr 打日志并在就绪时打印 "Started, ready to begin handling requests"，
 * stdin 每行一个 JSON 请求，stdout 每行一个 JSON 响应。
 *
 * <p>环境变量：FAKE_KATAGO_FAIL_START=1（就绪前以退出码 2 退出）、FAKE_KATAGO_NEVER_READY=1（永不就绪，进程不退出）、
 * FAKE_KATAGO_STARTUP_DELAY_MS（就绪前等待的毫秒数）、FAKE_KATAGO_IGNORE_STDIN_END=1（stdin 关闭后也不退出）。
 *
 * <p>请求里的 fake 字段控制这个请求的行为（含义同 JS 版）：hang（不回结果，被 terminate 时回 noResults）、crash: code、
 * delayMs、error + field（带 id 的错误）、idless（没有 id 的错误）、warning、partial: n（中间结果）、garbage（非 JSON 行）、
 * freeze（之后不再处理任何输入）、stats（回收到的 action 列表）。
 * 默认结果：{ id, isDuringSearch: false, turnNumber, echo: 请求（去掉 id）, pid }。
 */
public final class FakeKataGo {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final PrintStream OUT =
      new PrintStream(new FileOutputStream(FileDescriptor.out), false, StandardCharsets.UTF_8);
  private static final long PID = ProcessHandle.current().pid();
  private static final ArrayNode ACTIONS = JSON.createArrayNode();
  private static final Set<String> HANGING = new LinkedHashSet<>();
  private static final ScheduledExecutorService TIMER =
      Executors.newSingleThreadScheduledExecutor(
          r -> {
            Thread t = new Thread(r);
            t.setDaemon(true);
            return t;
          });
  private static boolean frozen;

  private FakeKataGo() {}

  private static synchronized void out(Object obj) {
    try {
      OUT.print((obj instanceof String s ? s : JSON.writeValueAsString(obj)) + "\n");
      OUT.flush();
    } catch (Exception e) {
      throw new RuntimeException(e);
    }
  }

  private static void log(String line) {
    System.err.print("2026-09-25 00:00:00+0800: " + line + "\n");
    System.err.flush();
  }

  private static void forever() throws InterruptedException {
    while (true) Thread.sleep(1000);
  }

  public static void main(String[] args) throws Exception {
    if (!Arrays.asList(args).contains("analysis")) System.exit(0);
    log("Running with following config:");
    log("fake katago pid " + PID);
    if ("1".equals(System.getenv("FAKE_KATAGO_FAIL_START"))) {
      log("ERROR: fake startup failure");
      Thread.sleep(20);
      System.exit(2);
    } else if ("1".equals(System.getenv("FAKE_KATAGO_NEVER_READY"))) {
      log("Loading model (forever)...");
      forever();
    } else {
      String d = System.getenv("FAKE_KATAGO_STARTUP_DELAY_MS");
      if (d != null && !d.isEmpty()) Thread.sleep(Long.parseLong(d));
      log("Started, ready to begin handling requests");
      serve();
    }
  }

  private static ObjectNode obj() {
    return JSON.createObjectNode();
  }

  private static ObjectNode noResults(String id) {
    return obj().put("id", id).put("isDuringSearch", false).put("noResults", true).put("turnNumber", 0);
  }

  private static void finish(ObjectNode q) {
    ObjectNode echo = q.deepCopy();
    echo.remove("id");
    ObjectNode r = obj();
    r.put("id", q.get("id").asText());
    r.put("isDuringSearch", false);
    r.put("turnNumber", q.has("moves") ? q.get("moves").size() : 0);
    r.set("echo", echo);
    r.put("pid", PID);
    out(r);
  }

  private static synchronized void handle(String line) {
    JsonNode parsed;
    try {
      parsed = JSON.readTree(line);
    } catch (Exception e) {
      out(obj().put("error", "could not parse input line as json request: " + line));
      return;
    }
    if (!(parsed instanceof ObjectNode q) || !q.path("id").isTextual()) {
      out(obj().put("error", "Request must have a string \"id\" field"));
      return;
    }
    String id = q.get("id").asText();
    if (q.has("action")) {
      String action = q.get("action").asText();
      ObjectNode a = obj().put("action", action);
      if (q.has("terminateId")) a.put("terminateId", q.get("terminateId").asText());
      ACTIONS.add(a);
      switch (action) {
        case "terminate" -> {
          String tid = q.path("terminateId").asText();
          out(obj().put("action", "terminate").put("id", id).put("terminateId", tid));
          if (HANGING.remove(tid)) out(noResults(tid));
        }
        case "terminate_all" -> {
          out(obj().put("action", "terminate_all").put("id", id));
          for (String h : HANGING) out(noResults(h));
          HANGING.clear();
        }
        case "query_version" -> out(
            obj().put("action", "query_version").put("id", id).put("version", "fake").put("git_hash", "0"));
        default -> out(
            obj()
                .put(
                    "error",
                    "'action' field must be 'query_version' or 'query_models' or 'clear_cache' or 'terminate' or"
                        + " 'terminate_all'"));
      }
      return;
    }
    JsonNode f = q.path("fake");
    if (f.path("freeze").asBoolean(false)) {
      frozen = true;
      return;
    }
    if (f.has("crash")) System.exit(f.get("crash").asInt());
    if (f.path("stats").asBoolean(false)) {
      ObjectNode r = obj().put("id", id).put("isDuringSearch", false).put("turnNumber", 0);
      ObjectNode stats = r.putObject("stats");
      stats.put("pid", PID);
      stats.set("actions", ACTIONS.deepCopy());
      out(r);
      return;
    }
    if (f.path("garbage").asBoolean(false)) out("this is not json");
    if (f.has("error")) {
      out(obj().put("error", f.get("error").asText()).put("field", f.path("field").asText("moves")).put("id", id));
      return;
    }
    if (f.path("idless").asBoolean(false)) {
      out(obj().put("error", "some error without id"));
      return;
    }
    if (f.path("warning").asBoolean(false)) {
      out(obj().put("id", id).put("field", "fooBar").put("warning", "Unexpected or unused field, do you have a typo?"));
    }
    if (f.path("hang").asBoolean(false)) {
      HANGING.add(id);
      return;
    }
    int partial = f.path("partial").asInt(0);
    for (int i = 0; i < partial; i++) {
      ObjectNode r = obj().put("id", id).put("isDuringSearch", true).put("turnNumber", 0);
      r.putObject("rootInfo").put("visits", i + 1);
      out(r);
    }
    long delay = f.path("delayMs").asLong(0);
    if (delay > 0) TIMER.schedule(() -> finish(q), delay, TimeUnit.MILLISECONDS);
    else finish(q);
  }

  private static void serve() throws Exception {
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    String line;
    while ((line = in.readLine()) != null) {
      if (!frozen && !line.trim().isEmpty()) handle(line);
    }
    if ("1".equals(System.getenv("FAKE_KATAGO_IGNORE_STDIN_END"))) forever();
    Thread.sleep(10);
    System.exit(0);
  }
}
