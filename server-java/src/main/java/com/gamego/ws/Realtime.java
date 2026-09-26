package com.gamego.ws;

import com.gamego.ai.AiService;
import com.gamego.api.ActiveGamesProvider;
import com.gamego.game.GameLog;
import com.gamego.game.GameLoop;
import com.gamego.game.GameManager;
import com.gamego.game.GameSettings;
import com.gamego.game.GameStore;
import com.gamego.game.Lobby;
import com.gamego.game.Matchmaker;
import com.gamego.game.RoomRegistry;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.IntUnaryOperator;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.SmartLifecycle;
import org.springframework.context.event.EventListener;

/**
 * 实时服务（设计文档 2.5，移植自 Node 版 realtime.js）：组装 WebSocket 连接管理（{@link Hub}）、匹配队列、好友房、
 * 对局管理器与消息路由，应用就绪（ApplicationReadyEvent）时恢复未结束的对局，关机时以 1001 关闭所有连接。
 *
 * <p>也实现 {@link ActiveGamesProvider}（GET /api/me 的 activeGameIds）。所有状态在游戏循环线程上读写。
 */
public class Realtime implements ActiveGamesProvider, SmartLifecycle {

  static final long LOBBY_PRUNE_MS = 60000;
  static final long SHUTDOWN_GRACE_MS = 1000;

  /** 一套运行中的实时服务（restart 时整体替换）。 */
  public record Stack(
      Hub hub,
      GameManager manager,
      Lobby lobby,
      RoomRegistry rooms,
      Matchmaker matchmaker,
      Router router,
      GameSettings settings,
      GameLoop.Timer[] pruneTimer) {}

  private final GameLoop loop;
  private final GameStore store;
  private final AiService ai;
  private final GameSettings settings;
  private final IntUnaryOperator randomInt;
  private volatile Hub.Limits limits;
  private final ExecutorService sender;
  private volatile Stack stack;
  private volatile boolean running = false;

  public Realtime(GameLoop loop, GameStore store, AiService ai, GameSettings settings, IntUnaryOperator randomInt) {
    this.loop = loop;
    this.store = store;
    this.ai = ai;
    this.settings = settings;
    this.randomInt = randomInt;
    this.limits = Hub.Limits.DEFAULT;
    AtomicInteger n = new AtomicInteger();
    this.sender =
        Executors.newCachedThreadPool(
            r -> {
              Thread t = new Thread(r, "ws-send-" + n.incrementAndGet());
              t.setDaemon(true);
              return t;
            });
  }

  /** WebSocket 发送线程池。 */
  public ExecutorService sender() {
    return sender;
  }

  public GameLoop loop() {
    return loop;
  }

  /** 当前的连接管理（还没启动为 null）。 */
  public Hub hub() {
    Stack s = stack;
    return s == null ? null : s.hub();
  }

  /** 当前的一套服务（测试与排障用）。 */
  public Stack stack() {
    return stack;
  }

  private Stack build(GameSettings st) {
    Hub hub = new Hub(loop, GameLog.slf4j(Hub.class), limits);
    GameManager manager = new GameManager(store, ai, st, GameLog.slf4j(GameManager.class), loop, hub, randomInt);
    Matchmaker matchmaker = new Matchmaker(st.sizes, loop::now);
    Lobby[] lobbyRef = new Lobby[1];
    GameLog lobbyLog = GameLog.slf4j(Lobby.class);
    RoomRegistry rooms =
        new RoomRegistry(st.roomTtlMs, loop, randomInt, room -> hub.batch(() -> lobbyRef[0].onRoomExpired(room)), lobbyLog);
    Lobby lobby = new Lobby(manager, matchmaker, rooms, store, hub, st, lobbyLog, loop, randomInt);
    lobbyRef[0] = lobby;
    Router router = new Router(hub, lobby, manager, GameLog.slf4j(Router.class), loop);
    hub.setHandlers(
        new Hub.Handlers() {
          @Override
          public void onOpen(Connection conn) {
            manager.userOnline(conn.userId);
          }

          @Override
          public void onReplace(Connection conn) {
            lobby.userReplaced(conn.userId);
          }

          @Override
          public void onClose(Connection conn) {
            lobby.userOffline(conn.userId);
            manager.userOffline(conn.userId);
          }

          @Override
          public void onMessage(Connection conn, Protocol.Parsed msg) {
            router.handle(conn, msg);
          }
        });
    return new Stack(hub, manager, lobby, rooms, matchmaker, router, st, new GameLoop.Timer[1]);
  }

  /** 在循环线程上：建一套服务、恢复未结束的对局、开始接受连接。 */
  private void boot(GameSettings st) {
    loop.call(
        () -> {
          Stack s = build(st);
          s.manager().restore();
          s.hub().start();
          GameLog log = GameLog.slf4j(Realtime.class);
          // 大厅的限流表（ai.start、猜房号）定期清掉补满的桶，内存占用有界
          s.pruneTimer()[0] =
              loop.every(
                  () -> {
                    try {
                      s.lobby().prune();
                    } catch (RuntimeException err) {
                      log.error("清理限流记录失败", err);
                    }
                  },
                  LOBBY_PRUNE_MS);
          stack = s;
          return null;
        });
  }

  /** 应用就绪：恢复对局并开始接受 WebSocket 连接（对应 Node 版 createRealtime 里的 manager.restore(); hub.start()）。 */
  @EventListener(ApplicationReadyEvent.class)
  public synchronized void onReady() {
    if (stack == null && running) boot(settings);
  }

  /**
   * 关闭当前这套服务并用新设置重新启动（测试与运维用：相当于在同一个数据库上重启实时服务）。
   * settings 为 null 时沿用启动时的设置；limits 为 null 时用默认限制。
   */
  public synchronized void restart(GameSettings st, Hub.Limits hubLimits) {
    shutdownStack();
    this.limits = hubLimits != null ? hubLimits : Hub.Limits.DEFAULT;
    boot(st != null ? st : settings);
  }

  /** 关闭当前这套服务：终局补写、清定时器、以 1001 关闭所有连接（最多等 1 秒，之后强制断开）。 */
  private void shutdownStack() {
    Stack s = stack;
    if (s == null) return;
    List<Connection> closing =
        loop.call(
            () -> {
              if (s.pruneTimer()[0] != null) s.pruneTimer()[0].cancel();
              s.manager().shutdown();
              s.rooms().clear();
              s.matchmaker().clear();
              return s.hub().close();
            });
    stack = null;
    long deadline = System.currentTimeMillis() + SHUTDOWN_GRACE_MS;
    while (System.currentTimeMillis() < deadline && closing.stream().anyMatch(c -> c.transport.isConnected())) {
      try {
        Thread.sleep(20);
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        break;
      }
    }
    // 客户端不回应关闭握手时强制断开
    for (Connection c : closing) {
      if (c.transport.isConnected()) c.transport.terminate();
    }
  }

  // ---------------------------------------------------------------- ActiveGamesProvider

  @Override
  public List<Map<String, Object>> activeGamesOf(long userId) {
    Stack s = stack;
    if (s == null) return List.of();
    return loop.call(() -> s.manager().activeGamesOf(userId));
  }

  // ---------------------------------------------------------------- SmartLifecycle

  @Override
  public synchronized void start() {
    running = true;
  }

  @Override
  public synchronized void stop() {
    running = false;
    shutdownStack();
    sender.shutdown();
  }

  @Override
  public boolean isRunning() {
    return running;
  }

  /** 最先停止（早于 Web 服务器的优雅关闭），先关掉 WebSocket 连接。 */
  @Override
  public int getPhase() {
    return SmartLifecycle.DEFAULT_PHASE;
  }
}
