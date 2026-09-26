package com.gamego.game;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.fail;

import com.gamego.config.TimeControl;
import com.gamego.db.User;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.function.Consumer;
import java.util.function.IntUnaryOperator;

/**
 * 管理器单测的公共装置（对应 Node 测试的 setupManager）：假时间 + 内存仓储 + 假推送 + 假 AI + 两个在线玩家（alice、bob）与 carol。
 */
public class Ctx {

  /** 9 路：黑墙 x=4，白墙 x=5，黑地里一颗白死子（10）。标记 10 为死子 → B+1.5；不标 → W+34.5。 */
  public static final int[] WALL = {4, 5, 13, 14, 22, 23, 31, 32, 40, 41, 49, 50, 58, 59, 67, 68, 76, 77, 72, 10};
  /** 10 手无提子的着手。 */
  public static final int[] TEN = {0, 8, 1, 7, 2, 6, 9, 17, 10, 16};

  public final ManualLoop loop = new ManualLoop();
  public final MemoryStore store;
  public final FakeHub hub = new FakeHub();
  public final TestAi ai;
  public final GameSettings settings;
  public final RecordingLog log = new RecordingLog();
  public final IntUnaryOperator randomInt;
  public GameManager manager;
  public final User alice;
  public final User bob;
  public final User carol;

  public Ctx() {
    this(null, null, true, null);
  }

  public Ctx(Consumer<GameSettings.Builder> config, TestAi ai) {
    this(config, ai, true, null);
  }

  public Ctx(Consumer<GameSettings.Builder> config, TestAi ai, boolean online, int[] randomSeq) {
    this.store = new MemoryStore();
    this.ai = ai != null ? ai : new TestAi();
    GameSettings.Builder b = GameSettings.builder().publicBaseUrl("http://test.local/");
    if (config != null) config.accept(b);
    this.settings = b.build();
    store.rankedPairDailyMax = settings.rankedPairDailyMax;
    Deque<Integer> seq = new ArrayDeque<>();
    if (randomSeq != null) for (int v : randomSeq) seq.add(v);
    Random rnd = new Random(42);
    this.randomInt = bound -> !seq.isEmpty() ? seq.poll() : rnd.nextInt(bound);
    long now = loop.now();
    alice = store.createUser("dev:alice", "Alice", "a1.png", now);
    bob = store.createUser("dev:bob", "Bob", null, now);
    carol = store.createUser("dev:carol", "Carol", null, now);
    if (online) {
      hub.online.add(alice.id());
      hub.online.add(bob.id());
    }
    manager = makeManager();
  }

  public GameManager makeManager() {
    return new GameManager(store, ai, settings, log, loop, hub, randomInt);
  }

  public static Consumer<GameSettings.Builder> tc9(long mainMs, int periods, long periodMs) {
    return b -> b.timeControl(9, new TimeControl(mainMs, periods, periodMs));
  }

  public GameSession ranked() {
    return manager.createHumanGame("ranked", 9, alice.id(), bob.id());
  }

  /** 轮到谁就用谁的身份下（-1 为 pass）。 */
  public void play(GameSession s, int... moves) {
    for (int idx : moves) {
      long uid = s.players[s.toPlay()];
      if (idx == -1) manager.pass(uid, s.id(), s.moves.size() + 1);
      else manager.move(uid, s.id(), s.moves.size() + 1, idx);
    }
  }

  public static int[] concat(int[] a, int... b) {
    int[] out = new int[a.length + b.length];
    System.arraycopy(a, 0, out, 0, a.length);
    System.arraycopy(b, 0, out, a.length, b.length);
    return out;
  }

  public void offline(User u) {
    hub.online.remove(u.id());
    manager.userOffline(u.id());
  }

  public void flush() {
    loop.flush();
  }

  public void noErrors() {
    assertThat(log.error).as("不应有 error 日志").isEmpty();
  }

  /** 执行 fn，期望抛出 GameError，返回错误码。 */
  public static String codeOf(Runnable fn) {
    try {
      fn.run();
    } catch (GameError e) {
      return e.code();
    }
    fail("应当抛错");
    return null;
  }

  @SuppressWarnings("unchecked")
  public static Map<String, Object> map(Object o) {
    return (Map<String, Object>) o;
  }

  @SuppressWarnings("unchecked")
  public static List<Object> list(Object o) {
    return (List<Object>) o;
  }
}
