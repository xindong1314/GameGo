package com.gamego.ws;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.gamego.ai.AiLevel;
import com.gamego.ai.FakeAiService;
import com.gamego.db.GameRepository;
import com.gamego.db.SessionRepository;
import com.gamego.db.StatsRepository;
import com.gamego.db.User;
import com.gamego.db.UserRepository;
import com.gamego.game.GameSettings;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * WebSocket 端到端测试基类：真实 HTTP + WebSocket（随机端口）+ H2 内存库 + 假 AI（{@code @Primary FakeAiService}）+ 系统时钟。
 * 每个测试开始前清空数据，并用 {@link #configure} 给出的设置重新启动实时服务（相当于 Node 测试里每个用例新建一个服务器）。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
@Import(WsTestBase.Beans.class)
public abstract class WsTestBase {

  public static final List<AiLevel> LEVELS =
      List.of(new AiLevel("k10", "10级", "入门"), new AiLevel("k5", "5级", "初级"), new AiLevel("d1", "1段", "中级"));

  /** 9 路：黑墙 x=4，白墙 x=5，黑地里一颗白死子（10）。标记 10 为死子 → B+1.5。 */
  public static final int[] WALL = {4, 5, 13, 14, 22, 23, 31, 32, 40, 41, 49, 50, 58, 59, 67, 68, 76, 77, 72, 10};

  @TestConfiguration
  public static class Beans {
    @Bean
    @Primary
    public FakeAiService fakeAiService() {
      return new FakeAiService().levels(LEVELS);
    }
  }

  static final java.nio.file.Path DATA_DIR;

  static {
    try {
      DATA_DIR = java.nio.file.Files.createTempDirectory("gamego-ws-");
    } catch (IOException e) {
      throw new java.io.UncheckedIOException(e);
    }
  }

  /** 数据目录（头像）放在临时目录，不在工作目录下留下 ./data。 */
  @DynamicPropertySource
  static void props(DynamicPropertyRegistry r) {
    r.add("gamego.data-dir", DATA_DIR::toString);
  }

  @LocalServerPort protected int port;
  @Autowired protected Realtime realtime;
  @Autowired protected FakeAiService ai;
  @Autowired protected UserRepository users;
  @Autowired protected SessionRepository sessions;
  @Autowired protected GameRepository games;
  @Autowired protected StatsRepository stats;
  @Autowired protected JdbcTemplate jdbc;

  protected final List<WsClient> clients = new ArrayList<>();
  private static final AtomicInteger SEQ = new AtomicInteger();

  /** 每个测试的对局设置（子类可覆盖某个测试用的设置：在测试里调用 {@link #restart}）。 */
  protected GameSettings.Builder settings() {
    return GameSettings.builder().publicBaseUrl("https://go.example.com");
  }

  protected void configure(GameSettings.Builder b) {}

  @BeforeEach
  void resetAll() {
    for (String t : List.of("sessions", "user_stats", "games", "users")) jdbc.update("DELETE FROM " + t);
    ai.available(true).levels(LEVELS).move(null).resign(false).passWhenHumanPassed(true).dead().judgeFail(false).delayMs(0);
    GameSettings.Builder b = settings();
    configure(b);
    realtime.restart(b.build(), null);
  }

  @AfterEach
  void closeClients() {
    for (WsClient c : clients) {
      try {
        c.abort();
      } catch (RuntimeException ignored) {
        // 已关闭
      }
    }
    clients.clear();
  }

  /** 用新的设置 / 限制重新启动实时服务。 */
  protected void restart(GameSettings settings, Hub.Limits limits) {
    realtime.restart(settings, limits);
  }

  protected String wsUrl() {
    return "ws://127.0.0.1:" + port + "/ws";
  }

  /** 一个用户与它的令牌。 */
  public record U(User user, long id, String token) {}

  /** 用户 + 连接（已 hello）。 */
  public record P(User user, long id, String token, WsClient c) {}

  protected U user(String nickname) {
    long now = System.currentTimeMillis();
    User u = users.create("dev:" + nickname + SEQ.incrementAndGet(), nickname, "", now);
    return new U(u, u.id(), sessions.create(u.id(), now));
  }

  protected WsClient connect(String token) {
    WsClient c = WsClient.connect(wsUrl(), token);
    clients.add(c);
    return c;
  }

  protected WsClient connectHeader(String token) {
    WsClient c = WsClient.connect(wsUrl(), token, true);
    clients.add(c);
    return c;
  }

  protected P player(String nickname) {
    U u = user(nickname);
    WsClient c = connect(u.token());
    c.req("hello");
    return new P(u.user(), u.id(), u.token(), c);
  }

  protected static Map<String, Object> p(Object... kv) {
    return com.gamego.game.Msg.of(kv);
  }

  /** 双方 game.sync，按执子颜色返回 [null, 黑, 白] 与黑方的快照。 */
  protected record Pair(String gameId, P black, P white, JsonNode snap) {
    P of(int color) {
      return color == 1 ? black : white;
    }
  }

  protected Pair syncBoth(P a, P b, String gameId) {
    JsonNode ga = a.c().req("game.sync", p("gameId", gameId)).get("game");
    JsonNode gb = b.c().req("game.sync", p("gameId", gameId)).get("game");
    assertThat(ga.get("myColor").asInt() + gb.get("myColor").asInt()).isEqualTo(3);
    return ga.get("myColor").asInt() == 1 ? new Pair(gameId, a, b, ga) : new Pair(gameId, b, a, gb);
  }

  /** 两人快速匹配 → 双方 game.sync。 */
  protected Pair matchPair(P a, P b, int size) {
    assertThat(a.c().req("match.join", p("size", size)).get("size").asInt()).isEqualTo(size);
    assertThat(b.c().req("match.join", p("size", size)).get("size").asInt()).isEqualTo(size);
    String ga = a.c().waitFor("match.found").get("gameId").asText();
    String gb = b.c().waitFor("match.found").get("gameId").asText();
    assertThat(ga).isEqualTo(gb);
    return syncBoth(a, b, ga);
  }

  /** 按手数轮流下（-1 为 pass）；双方都要收到 game.move 推送。返回下一手的序号。 */
  protected int playMovesPaced(Pair g, int startN, long pace, int... moves) {
    int n = startN;
    for (int idx : moves) {
      if (pace > 0) WsClient.sleep(pace);
      int color = n % 2 == 1 ? 1 : 2;
      P pl = g.of(color);
      if (idx == -1) pl.c().req("game.pass", p("gameId", g.gameId(), "n", n));
      else pl.c().req("game.move", p("gameId", g.gameId(), "n", n, "idx", idx));
      for (int c = 1; c <= 2; c++) {
        int nn = n;
        JsonNode m = g.of(c).c().waitFor("game.move", x -> x.path("gameId").asText().equals(g.gameId()) && x.path("n").asInt() == nn);
        assertThat(m.get("idx").asInt()).isEqualTo(idx);
        assertThat(m.get("color").asInt()).isEqualTo(color);
      }
      n += 1;
    }
    return n;
  }

  protected int playMoves(Pair g, int startN, int... moves) {
    return playMovesPaced(g, startN, 40, moves);
  }

  /** 原始 HTTP 请求（用于检查握手被拒时的状态码与 JSON 体）。 */
  protected String rawUpgrade(String path, String extraHeaders) throws IOException {
    try (Socket s = new Socket("127.0.0.1", port)) {
      s.setSoTimeout(5000);
      OutputStream out = s.getOutputStream();
      String req = "GET " + path + " HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
          + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n" + (extraHeaders == null ? "" : extraHeaders)
          + "\r\n";
      out.write(req.getBytes(StandardCharsets.ISO_8859_1));
      out.flush();
      s.setSoTimeout(1500);
      InputStream in = s.getInputStream();
      java.io.ByteArrayOutputStream got = new java.io.ByteArrayOutputStream();
      byte[] buf = new byte[4096];
      try {
        for (int r; (r = in.read(buf)) > 0; ) got.write(buf, 0, r);
      } catch (java.net.SocketTimeoutException e) {
        // 连接保持打开（keep-alive）：返回已读到的内容
      }
      return got.toString(StandardCharsets.UTF_8);
    }
  }
}
