package com.gamego.ws;

import com.fasterxml.jackson.databind.JsonNode;
import com.gamego.game.GameLog;
import com.gamego.game.GameLoop;
import com.gamego.game.GamePush;
import com.gamego.game.Json;
import com.gamego.game.Msg;
import com.gamego.web.RateLimiter;
import java.io.IOException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * WebSocket 连接管理（设计文档第 5 节，移植自 Node 版 ws/hub.js）：
 *
 * <ul>
 *   <li>令牌校验与建连限流在握手阶段完成（见 {@link WsHandshakeInterceptor}，失败回 401 / 429）；
 *   <li>每个用户只保留一条连接：新连接建立后旧连接收到 { t: 'kicked', reason: 'replaced' } 并以 4001 关闭；
 *   <li>每 25 秒发 WebSocket ping，连续两次没有 pong 就断开；
 *   <li>单条消息 ≤ 16KB（超出由容器以 1009 关闭）；每个用户每秒 ≤ 20 条（按用户计，重连不清零），超出以 4008 关闭；
 *   <li>对方不读数据、发送积压超过 1MB 的连接直接断开；
 *   <li>推送：send(userId) 发给用户当前连接，sendGame(userId, gameId) 只发给订阅了该局的连接；
 *       batch(fn) 期间的推送先排队，fn 结束后再发，保证请求的 res 先于它引起的推送到达。
 * </ul>
 *
 * 连接表、订阅、batch 队列只在游戏循环线程上读写；限流与 JSON 解析在 WebSocket 处理线程上完成。
 */
public class Hub implements GamePush {

  public static final long PING_INTERVAL_MS = 25000;
  public static final int MAX_MISSED_PONGS = 2;
  public static final int MAX_PAYLOAD = 16 * 1024;
  public static final int RATE_LIMIT = 20;
  public static final long RATE_WINDOW_MS = 1000;
  public static final int MAX_SUBSCRIPTIONS = 32;
  public static final int CLOSE_REPLACED = 4001;
  public static final int CLOSE_RATE_LIMITED = 4008;
  public static final int CLOSE_SHUTDOWN = 1001;
  public static final long MAX_BUFFERED_BYTES = 1024 * 1024;
  public static final int UPGRADE_BURST = 10;
  public static final long UPGRADE_REFILL_MS = 6000;

  /** 可调的限制（测试用）。 */
  public record Limits(long maxBufferedBytes, int upgradeBurst, long upgradeRefillMs) {
    public static final Limits DEFAULT = new Limits(MAX_BUFFERED_BYTES, UPGRADE_BURST, UPGRADE_REFILL_MS);
  }

  /** 连接事件回调（都在游戏循环线程上调用）。 */
  public interface Handlers {
    void onOpen(Connection conn);

    void onReplace(Connection conn);

    void onClose(Connection conn);

    void onMessage(Connection conn, Protocol.Parsed msg);
  }

  private record Item(long userId, String gameId, Map<String, Object> msg) {}

  final GameLoop loop;
  final GameLog logger;
  final long maxBufferedBytes;
  private Handlers handlers;
  private final Map<Long, Connection> conns = new HashMap<>();
  private final Set<Connection> all = new LinkedHashSet<>();
  private final AtomicLong seq = new AtomicLong();
  private List<Item> outbox = null;
  private volatile boolean closed = false;
  private volatile boolean started = false;
  private GameLoop.Timer pingTimer = null;
  /** userId → 最近的消息时刻（按用户限流，换连接不清零）。 */
  private final ConcurrentHashMap<Long, ArrayDeque<Long>> msgTimes = new ConcurrentHashMap<>();
  private final RateLimiter upgradeLimit;

  public Hub(GameLoop loop, GameLog logger, Limits limits) {
    Limits l = limits != null ? limits : Limits.DEFAULT;
    this.loop = loop;
    this.logger = logger;
    this.maxBufferedBytes = l.maxBufferedBytes();
    this.upgradeLimit = new RateLimiter(l.upgradeBurst(), 1000.0 / l.upgradeRefillMs(), loop::now);
  }

  public void setHandlers(Handlers handlers) {
    this.handlers = handlers;
  }

  /** 开始接受连接并启动心跳（循环线程）。 */
  public void start() {
    started = true;
    pingTimer = loop.every(this::heartbeat, PING_INTERVAL_MS);
  }

  public boolean isStarted() {
    return started;
  }

  public boolean isClosed() {
    return closed;
  }

  // ---------------------------------------------------------------- 查询（循环线程）

  @Override
  public boolean isOnline(long userId) {
    return conns.containsKey(userId);
  }

  public Connection connectionOf(long userId) {
    return conns.get(userId);
  }

  public int connectionCount() {
    return conns.size();
  }

  // ---------------------------------------------------------------- 推送（循环线程）

  @Override
  public void send(long userId, Map<String, Object> msg) {
    enqueue(new Item(userId, null, msg));
  }

  @Override
  public void sendGame(long userId, String gameId, Map<String, Object> msg) {
    enqueue(new Item(userId, gameId, msg));
  }

  private void enqueue(Item item) {
    if (outbox != null) outbox.add(item);
    else deliver(item);
  }

  private void deliver(Item item) {
    Connection conn = conns.get(item.userId());
    if (conn == null || conn.closing) return;
    if (item.gameId() != null && !conn.isSubscribed(item.gameId())) return;
    conn.sendNow(item.msg());
  }

  /** fn 执行期间的推送先排队，结束后按顺序发出（可嵌套）。 */
  public void batch(Runnable fn) {
    if (outbox != null) {
      fn.run();
      return;
    }
    outbox = new ArrayList<>();
    try {
      fn.run();
    } finally {
      List<Item> box = outbox;
      outbox = null;
      for (Item item : box) deliver(item);
    }
  }

  private void safe(Runnable fn) {
    try {
      fn.run();
    } catch (RuntimeException err) {
      logger.error("WebSocket 处理出错", err);
    }
  }

  // ---------------------------------------------------------------- 握手（WebSocket 处理线程）

  /** 建连频率限制（每个用户突发 10 次、之后每 6 秒 1 次）；返回是否允许。线程安全。 */
  public boolean takeUpgrade(long userId) {
    return upgradeLimit.take(userId);
  }

  /** 握手成功后创建连接对象，并在循环线程上登记。 */
  public Connection open(Transport transport, long userId) {
    Connection conn = new Connection(this, transport, userId, seq.incrementAndGet());
    loop.execute(() -> accept(conn));
    return conn;
  }

  void accept(Connection conn) {
    if (closed) {
      conn.close(CLOSE_SHUTDOWN, "server_shutdown");
      return;
    }
    long userId = conn.userId;
    Connection old = conns.get(userId);
    conns.put(userId, conn);
    all.add(conn);
    if (old != null) {
      old.replaced = true;
      old.sendNow(Msg.of("t", "kicked", "reason", "replaced"));
      old.close(CLOSE_REPLACED, "replaced");
      logger.info("用户 " + userId + " 的新连接顶替了旧连接");
      safe(() -> handlers.onReplace(conn));
    } else {
      logger.debug("用户 " + userId + " 已连接");
      safe(() -> handlers.onOpen(conn));
    }
  }

  // ---------------------------------------------------------------- 收消息（WebSocket 处理线程）

  /** 按用户计数的消息限流；返回是否允许。 */
  private boolean rateOk(long userId) {
    long t = loop.now();
    ArrayDeque<Long> times = msgTimes.computeIfAbsent(userId, k -> new ArrayDeque<>());
    synchronized (times) {
      if (times.size() >= RATE_LIMIT && t - times.peekFirst() < RATE_WINDOW_MS) return false;
      times.addLast(t);
      if (times.size() > RATE_LIMIT) times.pollFirst();
      return true;
    }
  }

  /** 收到一条消息（文本或二进制）：限流；返回是否继续处理。 */
  private boolean admit(Connection conn) {
    if (conn.closing || conn.replaced || conn.rateClosed) return false;
    conn.missedPongs = 0; // 任何消息都说明连接还活着（慢读客户端由发送积压上限处理）
    if (!rateOk(conn.userId)) {
      logger.warn("用户 " + conn.userId + " 发送过快，断开连接");
      conn.rateClosed = true;
      loop.execute(() -> conn.close(CLOSE_RATE_LIMITED, "rate_limited"));
      return false;
    }
    return true;
  }

  public void onText(Connection conn, String text) {
    if (!admit(conn)) return;
    JsonNode msg;
    try {
      msg = Json.parse(text);
    } catch (IOException | RuntimeException e) {
      logger.debug("用户 " + conn.userId + " 发来无法解析的消息，忽略");
      return;
    }
    Protocol.Parsed parsed = Protocol.parse(msg);
    loop.execute(() -> {
      if (conn.closing || conn.replaced) return;
      safe(() -> handlers.onMessage(conn, parsed));
    });
  }

  public void onBinary(Connection conn) {
    if (!admit(conn)) return;
    logger.debug("用户 " + conn.userId + " 发来二进制消息，忽略");
  }

  public void onPong(Connection conn) {
    conn.missedPongs = 0;
  }

  /** 连接已关闭（WebSocket 处理线程调用）。 */
  public void closed(Connection conn) {
    conn.closing = true;
    loop.execute(() -> onClose(conn));
  }

  void onClose(Connection conn) {
    conn.closing = true;
    all.remove(conn);
    if (conns.get(conn.userId) == conn) {
      conns.remove(conn.userId);
      logger.debug("用户 " + conn.userId + " 已断开");
      safe(() -> handlers.onClose(conn));
    }
  }

  // ---------------------------------------------------------------- 心跳（循环线程）

  void heartbeat() {
    // 清理早已过了限流窗口的记录
    long t = loop.now();
    msgTimes.entrySet().removeIf(e -> {
      ArrayDeque<Long> times = e.getValue();
      synchronized (times) {
        return times.isEmpty() || t - times.peekLast() >= RATE_WINDOW_MS;
      }
    });
    upgradeLimit.prune();
    for (Connection conn : new ArrayList<>(all)) {
      if (conn.missedPongs >= MAX_MISSED_PONGS) {
        logger.info("用户 " + conn.userId + " 的连接无响应，断开");
        conn.terminate();
        continue;
      }
      conn.missedPongs += 1;
      try {
        conn.transport.ping();
      } catch (RuntimeException err) {
        logger.debug("发送 ping 失败：" + err.getMessage());
      }
    }
  }

  // ---------------------------------------------------------------- 关闭（循环线程）

  /** 以 1001 关闭所有连接，之后拒绝新连接。返回关闭中的连接（调用方等待它们断开）。 */
  public List<Connection> close() {
    closed = true;
    if (pingTimer != null) pingTimer.cancel();
    pingTimer = null;
    List<Connection> list = new ArrayList<>(all);
    for (Connection conn : list) conn.close(CLOSE_SHUTDOWN, "server_shutdown");
    return list;
  }

  /** 标记为关闭（不再接受新连接），不关闭现有连接。 */
  void markClosed() {
    closed = true;
  }
}
