package com.gamego.testsupport;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.gamego.api.ActiveGamesProvider;
import com.gamego.api.AiLevelsProvider;
import com.gamego.auth.WechatClient;
import com.gamego.auth.WxSecurityService;
import com.gamego.config.GameGoProperties;
import com.gamego.db.DbTransactions;
import com.gamego.db.GameRepository;
import com.gamego.db.NewGame;
import com.gamego.db.SessionRepository;
import com.gamego.db.StatsRepository;
import com.gamego.db.UserRepository;
import com.gamego.config.TimeControl;
import com.gamego.web.RateLimits;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.net.Socket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpHeaders;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterAll;
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
 * 集成测试基类：真实 HTTP（随机端口）+ H2 内存库（MySQL 模式）+ 可推进的时钟 + 本地假微信接口。
 * 所有继承它的测试共用一个 Spring 上下文；每个测试开始前清空数据、恢复配置（对应 Node 测试的 startHttp）。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
@Import(IntegrationTestBase.TestBeans.class)
public abstract class IntegrationTestBase {

  public static final long T0 = MutableClock.T0;
  public static final long DAY = MutableClock.DAY;

  static final Path DATA_DIR;
  static final FakeWx FAKE_WX;

  static {
    try {
      DATA_DIR = Files.createTempDirectory("gamego-core-");
      FAKE_WX = new FakeWx();
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  @DynamicPropertySource
  static void props(DynamicPropertyRegistry r) {
    r.add("gamego.data-dir", DATA_DIR::toString);
    r.add("gamego.wx.api-base", FAKE_WX::base);
  }

  @AfterAll
  static void cleanupAll() {
    // 上下文在测试类之间复用，这里不关闭假微信接口与数据目录（JVM 退出时一并清理）
  }

  /** 测试用 Bean：可推进的时钟、可替换的进行中对局与 AI 难度表。 */
  @TestConfiguration
  public static class TestBeans {
    @Bean
    @Primary
    public MutableClock mutableClock() {
      return new MutableClock();
    }

    @Bean
    @Primary
    public MutableActiveGames mutableActiveGames() {
      return new MutableActiveGames();
    }

    @Bean
    @Primary
    public MutableAiLevels mutableAiLevels() {
      return new MutableAiLevels();
    }
  }

  /** 进行中的对局（测试里随意设置）。 */
  public static class MutableActiveGames implements ActiveGamesProvider {
    public volatile Function<Long, List<Map<String, Object>>> fn = uid -> List.of();

    @Override
    public List<Map<String, Object>> activeGamesOf(long userId) {
      return fn.apply(userId);
    }
  }

  /** AI 难度表（测试里随意设置）。 */
  public static class MutableAiLevels implements AiLevelsProvider {
    public volatile boolean available = true;
    public volatile java.util.function.Supplier<List<Map<String, Object>>> levels = MutableAiLevels::defaults;

    static List<Map<String, Object>> defaults() {
      return List.of(Map.of("id", "k5", "name", "5级", "desc", ""));
    }

    @Override
    public boolean available() {
      return available;
    }

    @Override
    public List<Map<String, Object>> levels() {
      return levels.get();
    }
  }

  @LocalServerPort protected int port;
  @Autowired protected MutableClock clock;
  @Autowired protected MutableActiveGames activeGames;
  @Autowired protected MutableAiLevels aiLevels;
  @Autowired protected GameGoProperties props;
  @Autowired protected RateLimits limits;
  @Autowired protected WxSecurityService security;
  @Autowired protected WechatClient wechat;
  @Autowired protected JdbcTemplate jdbc;
  @Autowired protected UserRepository users;
  @Autowired protected SessionRepository sessions;
  @Autowired protected GameRepository games;
  @Autowired protected StatsRepository stats;
  @Autowired protected DbTransactions db;
  @Autowired protected ObjectMapper mapper;

  protected final FakeWx wx = FAKE_WX;
  protected final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();

  @BeforeEach
  void resetAll() throws IOException {
    for (String t : List.of("sessions", "user_stats", "games", "users")) jdbc.update("DELETE FROM " + t);
    try {
      jdbc.execute("ALTER TABLE users ALTER COLUMN id RESTART WITH 1"); // H2
    } catch (org.springframework.dao.DataAccessException e) {
      jdbc.execute("ALTER TABLE users AUTO_INCREMENT = 1"); // MySQL（用 -Dspring.datasource.url=jdbc:mysql://... 跑同一套测试时）
    }
    clock.set(T0);
    props.setDevLogin(false);
    props.getWx().setAppId("");
    props.getWx().setSecret("");
    props.getWx().setApiBase(FAKE_WX.base());
    props.setSecCheck("on");
    props.setMinGamesWinrate(10);
    props.setRankedPairDailyMax(3);
    props.setPublicBaseUrl("https://go.example.com");
    props.getLimits().reset();
    limits.reset();
    security.reset();
    wechat.setTimeoutMs(WechatClient.DEFAULT_TIMEOUT_MS);
    activeGames.fn = uid -> List.of();
    aiLevels.available = true;
    aiLevels.levels = MutableAiLevels::defaults;
    wx.reset();
    Path avatars = Path.of(props.getAvatarDir());
    if (Files.exists(avatars)) {
      try (Stream<Path> s = Files.walk(avatars)) {
        s.sorted(Comparator.reverseOrder()).filter(p -> !p.equals(avatars)).forEach(p -> p.toFile().delete());
      }
    }
    Files.createDirectories(avatars);
    try (Stream<Path> s = Files.list(DATA_DIR)) {
      s.filter(p -> !p.equals(avatars)).forEach(p -> p.toFile().delete());
    }
  }

  // ---------------------------------------------------------------- 数据

  private static final AtomicInteger GAME_SEQ = new AtomicInteger();

  public static String gameId() {
    return String.format("g%011d", GAME_SEQ.incrementAndGet());
  }

  /** 插入一局排位赛并返回 id。 */
  protected String insertRanked(long blackId, long whiteId, long createdAt) {
    String id = gameId();
    games.insert(new NewGame().id(id).mode("ranked").size(9).komi(7.5).blackId(blackId).whiteId(whiteId)
        .timeControl(new TimeControl(180000, 3, 20000)).status("playing").moves(List.of()).createdAt(createdAt));
    return id;
  }

  // ---------------------------------------------------------------- HTTP

  /** 一次 HTTP 响应。 */
  public record Resp(int status, HttpHeaders headers, JsonNode json, String text) {
    public String header(String name) {
      return headers.firstValue(name).orElse(null);
    }

    public String errorCode() {
      return json == null ? null : json.path("error").path("code").asText(null);
    }

    public String errorMsg() {
      return json == null ? null : json.path("error").path("msg").asText(null);
    }
  }

  protected String base() {
    return "http://127.0.0.1:" + port;
  }

  protected Resp send(HttpRequest req) {
    try {
      HttpResponse<byte[]> res = http.send(req, HttpResponse.BodyHandlers.ofByteArray());
      String text = new String(res.body(), StandardCharsets.UTF_8);
      JsonNode json = null;
      try {
        json = text.isEmpty() ? null : mapper.readTree(text);
      } catch (IOException ignored) {
        json = null;
      }
      return new Resp(res.statusCode(), res.headers(), json, text);
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException(e);
    }
  }

  /** 发送请求：body 为 null 表示没有请求体；String 原样发送（需自行指定 content-type）；其他对象按 JSON 发送。 */
  protected Resp api(String method, String path, String token, Object body, Map<String, String> headers) {
    HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(base() + path)).timeout(Duration.ofSeconds(30));
    Map<String, String> h = new HashMap<>(headers == null ? Map.of() : headers);
    if (token != null) h.put("Authorization", "Bearer " + token);
    HttpRequest.BodyPublisher pub;
    if (body == null) {
      pub = HttpRequest.BodyPublishers.noBody();
    } else if (body instanceof String s) {
      pub = HttpRequest.BodyPublishers.ofString(s);
    } else if (body instanceof byte[] bytes) {
      pub = HttpRequest.BodyPublishers.ofByteArray(bytes);
    } else {
      try {
        pub = HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(body));
      } catch (IOException e) {
        throw new UncheckedIOException(e);
      }
      h.putIfAbsent("Content-Type", "application/json");
    }
    h.forEach(b::header);
    b.method(method, pub);
    return send(b.build());
  }

  protected Resp api(String method, String path) {
    return api(method, path, null, null, null);
  }

  protected Resp api(String method, String path, String token) {
    return api(method, path, token, null, null);
  }

  protected Resp api(String method, String path, String token, Object body) {
    return api(method, path, token, body, null);
  }

  /** 开发登录，返回 {token, user, needProfile}。 */
  protected JsonNode devLogin(String deviceId) {
    Resp r = api("POST", "/api/auth/dev-login", null, Map.of("deviceId", deviceId));
    if (r.status() != 200) throw new AssertionError("dev-login 失败 " + r.status() + " " + r.text());
    return r.json();
  }

  protected static String tokenOf(JsonNode login) {
    return login.get("token").asText();
  }

  protected static long userIdOf(JsonNode login) {
    return login.get("user").get("id").asLong();
  }

  /** 构造 multipart/form-data 请求体。 */
  public static byte[] multipart(String boundary, String field, String filename, String type, byte[] data) {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    out.writeBytes(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + field + "\"; filename=\"" + filename
        + "\"\r\nContent-Type: " + type + "\r\n\r\n").getBytes(StandardCharsets.UTF_8));
    out.writeBytes(data);
    out.writeBytes(("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
    return out.toByteArray();
  }

  protected Resp uploadAvatar(String token, byte[] bytes) {
    return uploadAvatar(token, bytes, "file", "a.png", "image/png");
  }

  protected Resp uploadAvatar(String token, byte[] bytes, String field, String filename, String type) {
    String boundary = "----FormBoundary" + System.nanoTime();
    Map<String, String> h = new HashMap<>();
    h.put("Content-Type", "multipart/form-data; boundary=" + boundary);
    return api("POST", "/api/me/avatar", token, multipart(boundary, field, filename, type, bytes), h);
  }

  /** 原始 HTTP 请求（路径原样发送，不做任何规范化；测路径穿越用）。 */
  public record RawResp(int status, String head, byte[] body) {}

  protected RawResp raw(String method, String rawPath) {
    try (Socket s = new Socket("127.0.0.1", port)) {
      s.setSoTimeout(10000);
      OutputStream out = s.getOutputStream();
      out.write((method + " " + rawPath + " HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
          .getBytes(StandardCharsets.ISO_8859_1));
      out.flush();
      InputStream in = s.getInputStream();
      byte[] all = in.readAllBytes();
      String text = new String(all, StandardCharsets.ISO_8859_1);
      int headEnd = text.indexOf("\r\n\r\n");
      String head = headEnd < 0 ? text : text.substring(0, headEnd);
      byte[] body = headEnd < 0 ? new byte[0] : java.util.Arrays.copyOfRange(all, headEnd + 4, all.length);
      String[] first = head.split("\r\n")[0].split(" ");
      int status = first.length > 1 ? Integer.parseInt(first[1]) : -1;
      return new RawResp(status, head, body);
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  protected static List<Long> ids(JsonNode arr, String field) {
    List<Long> out = new ArrayList<>();
    arr.forEach(n -> out.add(n.get(field).asLong()));
    return out;
  }
}
