package com.gamego.game;

import static com.gamego.engine.Go.PASS;
import static com.gamego.engine.Go.opponent;

import com.gamego.ai.AiException;
import com.gamego.ai.AiLevel;
import com.gamego.ai.AiMove;
import com.gamego.ai.AiMoveRequest;
import com.gamego.ai.AiService;
import com.gamego.ai.DeadResult;
import com.gamego.config.TimeControl;
import com.gamego.db.GameRow;
import com.gamego.db.UnfinishedGame;
import com.gamego.db.User;
import com.gamego.engine.Result;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.function.Consumer;
import java.util.function.IntUnaryOperator;

/**
 * 对局管理器（移植自 Node 版 game/manager.js）：持有进行中的对局（{@link GameSession}），负责
 *
 * <ul>
 *   <li>定时器：读秒超时、首手超时、掉线弃局、数子自动确认、人机闲置作废（每局一个"最近到期"定时器）；
 *   <li>持久化：每一手后 saveProgress，终局 finish + applyRanked（同一事务）；
 *   <li>推送：通过 {@link GamePush} 发给已订阅（game.sync 过）该局的玩家连接；
 *   <li>AI：轮到 AI 时调用 chooseMove，死子判断调用 judgeDead，带超时与过期结果保护；
 *   <li>启动时从 listUnfinished() 恢复对局。
 * </ul>
 *
 * 所有方法只能在游戏循环线程上调用（{@link GameLoop}）。
 */
public class GameManager {

  static final long MAX_TIMER_MS = 2147483647L;
  /** 终局后在内存里保留一会儿，方便断线重连的客户端 game.sync。 */
  public static final long ENDED_KEEP_MS = 10 * 60 * 1000;
  /** 终局写库失败后的重试间隔（最后一个间隔一直重复，直到写成功）。 */
  static final long[] PERSIST_RETRY_MS = {1000, 5000, 15000, 60000};
  /** 死子判断的尝试次数（第一次失败或超时后重试一次，仍失败才改为手动数子）。 */
  static final int JUDGE_ATTEMPTS = 2;

  /** 定时器条目（_later 的返回值）。 */
  static final class Entry {
    GameLoop.Timer handle;
  }

  record Ended(GameSession session, Entry entry) {}

  record Unsaved(GameSession session, boolean counted, Entry entry) {}

  record JudgeReq(String key, int size, double komi, int[] moves) {}

  static final class JudgeJob {
    JudgeReq running;
    JudgeReq queued;

    JudgeJob(JudgeReq running) {
      this.running = running;
    }
  }

  private final GameStore store;
  private final AiService ai;
  private final GameSettings settings;
  private final GameLog logger;
  private final GameLoop loop;
  private final GamePush hub;
  private final IntUnaryOperator randomInt;

  final Map<String, GameSession> sessions = new LinkedHashMap<>();
  final Map<Long, LinkedHashSet<String>> userGames = new HashMap<>();
  final LinkedHashMap<String, Ended> endedCache = new LinkedHashMap<>();
  final Map<String, Entry> deadlineTimers = new HashMap<>();
  final Map<String, int[]> aiFailures = new HashMap<>(); // gameId → { token, count }
  final Map<Long, Integer> aiInflight = new HashMap<>();
  int aiInflightTotal = 0;
  final LinkedHashMap<String, Integer> aiWaiting = new LinkedHashMap<>(); // gameId → token
  final LinkedHashMap<String, Unsaved> unsavedEnds = new LinkedHashMap<>();
  final Map<String, JudgeJob> judgeJobs = new HashMap<>();
  final Set<Entry> pending = new HashSet<>();
  boolean closed = false;

  public GameManager(
      GameStore store, AiService ai, GameSettings settings, GameLog logger, GameLoop loop, GamePush hub, IntUnaryOperator randomInt) {
    if (store == null) throw new IllegalArgumentException("GameManager: 需要 store");
    if (settings == null) throw new IllegalArgumentException("GameManager: 需要 settings");
    if (loop == null) throw new IllegalArgumentException("GameManager: 需要 loop");
    if (hub == null) throw new IllegalArgumentException("GameManager: 需要 hub");
    this.store = store;
    this.ai = ai;
    this.settings = settings;
    this.logger = logger;
    this.loop = loop;
    this.hub = hub;
    this.randomInt = randomInt != null ? randomInt : Players.SECURE_RANDOM_INT;
  }

  private long now() {
    return loop.now();
  }

  // ---------------------------------------------------------------- 查询

  /** [{ id, mode }]（进行中的对局）。 */
  public List<Map<String, Object>> activeGamesOf(long userId) {
    Set<String> ids = userGames.get(userId);
    List<Map<String, Object>> out = new ArrayList<>();
    if (ids == null) return out;
    for (String id : ids) {
      GameSession s = sessions.get(id);
      if (s != null && !s.ended()) out.add(Msg.of("id", s.id, "mode", s.mode));
    }
    return out;
  }

  /** 进行中的真人对局（排位/好友），没有返回 null。 */
  public GameSession humanGameOf(long userId) {
    Set<String> ids = userGames.get(userId);
    if (ids == null) return null;
    for (String id : ids) {
      GameSession s = sessions.get(id);
      if (s != null && !s.ended() && !s.isAiGame()) return s;
    }
    return null;
  }

  public List<GameSession> aiGamesOf(long userId) {
    Set<String> ids = userGames.get(userId);
    List<GameSession> out = new ArrayList<>();
    if (ids == null) return out;
    for (String id : ids) {
      GameSession s = sessions.get(id);
      if (s != null && !s.ended() && s.isAiGame()) out.add(s);
    }
    return out;
  }

  public GameSession getSession(String gameId) {
    return sessions.get(gameId);
  }

  /** 刚结束、还在内存里的对局（包括终局结果还没写进数据库的）。 */
  GameSession endedSession(String gameId) {
    Unsaved u = unsavedEnds.get(gameId);
    if (u != null) return u.session();
    Ended e = endedCache.get(gameId);
    return e != null ? e.session() : null;
  }

  // ---------------------------------------------------------------- 建局

  public GameSession createHumanGame(String mode, int size, long blackId, long whiteId) {
    if (!"ranked".equals(mode) && !"friend".equals(mode)) throw new IllegalArgumentException("createHumanGame: 模式不对 " + mode);
    TimeControl tc = settings.timeControls.get(size);
    if (tc == null) throw new GameError("bad_request", "不支持 " + size + " 路");
    long now = now();
    GameSession session =
        new GameSession(newGameId(), mode, size, settings.komi, blackId, whiteId, null, tc, settings, now, null);
    for (int c = 1; c <= 2; c++) session.setOnline(c, hub.isOnline(session.players[c]), now);
    session.expectArrival(now); // 开局时不在线的一方（如切到后台的好友房房主）到场前不走钟、不判弃局
    store.insert(session.insertRow(now));
    register(session);
    arm(session);
    logger.info("对局 " + session.id + " 开始：" + mode + " " + size + " 路，黑 " + blackId + " 白 " + whiteId);
    return session;
  }

  /** color：'black' | 'white' | 'random'（玩家执子）。 */
  public GameSession startAiGame(long userId, int size, String level, String color) {
    if (!aiAvailable()) throw new GameError("ai_unavailable", "AI 暂时不可用");
    if (settings.timeControls.get(size) == null) throw new GameError("bad_request", "不支持 " + size + " 路");
    boolean known = false;
    for (AiLevel l : aiLevels()) if (l != null && level != null && level.equals(l.id())) known = true;
    if (!known) throw new GameError("bad_request", "没有这个难度");
    long now = now();
    // 同一玩家只保留一局人机对局：旧的作废；玩家还没下过子的直接删除，不留记录
    for (GameSession old : aiGamesOf(userId)) {
      boolean played = old.hasHumanMove();
      old.abort(now, "replaced");
      if (played) end(old, now);
      else discard(old);
    }
    int humanColor = "black".equals(color) ? 1 : "white".equals(color) ? 2 : randomInt.applyAsInt(2) + 1;
    GameSession session =
        new GameSession(
            newGameId(),
            "ai",
            size,
            settings.komi,
            humanColor == 1 ? userId : null,
            humanColor == 2 ? userId : null,
            level,
            null,
            settings,
            now,
            null);
    session.setOnline(humanColor, hub.isOnline(userId), now);
    store.insert(session.insertRow(now));
    register(session);
    arm(session);
    logger.info(
        "人机对局 " + session.id + " 开始：" + size + " 路，玩家 " + userId + " 执" + (humanColor == 1 ? "黑" : "白") + "，难度 " + level);
    maybeAi(session);
    return session;
  }

  private String newGameId() {
    for (int i = 0; i < 10; i++) {
      String id = Players.randomGameId(randomInt);
      if (sessions.containsKey(id) || endedCache.containsKey(id)) continue;
      if (store.findById(id) == null) return id;
    }
    throw new IllegalStateException("无法生成对局 id");
  }

  private void register(GameSession session) {
    sessions.put(session.id, session);
    for (long uid : session.userIds()) userGames.computeIfAbsent(uid, k -> new LinkedHashSet<>()).add(session.id);
  }

  private void unregister(GameSession session) {
    disarm(session.id);
    sessions.remove(session.id);
    aiFailures.remove(session.id);
    aiWaiting.remove(session.id);
    for (long uid : session.userIds()) {
      Set<String> set = userGames.get(uid);
      if (set == null) continue;
      set.remove(session.id);
      if (set.isEmpty()) userGames.remove(uid);
    }
  }

  // ---------------------------------------------------------------- 客户端请求

  /** 完整快照（进行中、刚结束或库里已结束的对局都可以）。 */
  public Map<String, Object> sync(long userId, String gameId) {
    long now = now();
    GameSession active = sessions.get(gameId);
    if (active != null) {
      int color = active.colorOf(userId);
      if (color == 0) throw new GameError("not_player", "你不是这局棋的对局者");
      runDue(active, now);
      return active.snapshot(color, now, playersOf(active));
    }
    GameSession cached = endedSession(gameId);
    if (cached != null) {
      int color = cached.colorOf(userId);
      if (color == 0) throw new GameError("not_player", "你不是这局棋的对局者");
      return cached.snapshot(color, now, playersOf(cached));
    }
    GameRow row = store.findById(gameId);
    if (row == null) throw new GameError("not_found", "对局不存在");
    GameSession session = GameSession.fromRow(row, settings, now);
    int color = session.colorOf(userId);
    if (color == 0) throw new GameError("not_player", "你不是这局棋的对局者");
    return session.snapshot(color, now, playersOf(session));
  }

  public void move(long userId, String gameId, int n, int idx) {
    act(userId, gameId, (s, color, now) -> {
      GameSession.MoveInfo info = s.play(color, n, idx, now);
      s.touch(now);
      afterPlay(s, info, now, null);
    });
  }

  public void pass(long userId, String gameId, int n) {
    act(userId, gameId, (s, color, now) -> {
      GameSession.MoveInfo info = s.pass(color, n, now);
      s.touch(now);
      afterPlay(s, info, now, null);
    });
  }

  public void resign(long userId, String gameId) {
    act(userId, gameId, (s, color, now) -> {
      s.touch(now);
      s.resign(color, now);
      end(s, now);
    });
  }

  public void undo(long userId, String gameId) {
    act(userId, gameId, (s, color, now) -> {
      boolean wasThinking = s.aiThinking;
      List<Integer> moves = s.undo(color, now);
      s.touch(now);
      save(s, now);
      push(s, Msg.of("t", "game.undo", "gameId", s.id, "moves", moves));
      if (wasThinking) push(s, Msg.of("t", "game.ai", "gameId", s.id, "thinking", false));
      arm(s);
    });
  }

  /** version 可选：客户端点选时看到的数子版本，不一致 → stale。 */
  public void toggleDead(long userId, String gameId, int idx, Integer version) {
    act(userId, gameId, (s, color, now) -> {
      boolean changed = s.toggleDead(color, idx, now, version);
      if (changed) {
        pushScoring(s, now);
        arm(s); // 自动确认时限可能顺延了
      }
    });
  }

  public void acceptScore(long userId, String gameId, int version) {
    act(userId, gameId, (s, color, now) -> {
      s.touch(now);
      boolean done = s.accept(color, version, now);
      pushScoring(s, now);
      if (done) {
        s.finishByScore(now);
        end(s, now);
      }
    });
  }

  public void resumeScore(long userId, String gameId) {
    act(userId, gameId, (s, color, now) -> {
      s.touch(now);
      int toPlay = s.resume(color, now);
      save(s, now);
      push(s, Msg.of("t", "game.resumed", "gameId", s.id, "toPlay", toPlay, "clocks", s.clocksView(now)));
      maybeAi(s);
      arm(s);
    });
  }

  @FunctionalInterface
  interface Action {
    void run(GameSession s, int color, long now);
  }

  /** 找到进行中的对局并确认身份；先处理已到期的事件（超时等），再执行动作。 */
  private void act(long userId, String gameId, Action fn) {
    GameSession session = sessions.get(gameId);
    if (session == null) throwInactive(userId, gameId);
    int color = session.colorOf(userId);
    if (color == 0) throw new GameError("not_player", "你不是这局棋的对局者");
    long now = now();
    if (runDue(session, now)) throw new GameError("wrong_phase", "对局已结束");
    fn.run(session, color, now);
  }

  /** 对局不在内存里：区分"不存在""不是你的对局""已结束"。 */
  private void throwInactive(long userId, String gameId) {
    GameSession cached = endedSession(gameId);
    if (cached != null) {
      if (cached.colorOf(userId) == 0) throw new GameError("not_player", "你不是这局棋的对局者");
      throw new GameError("wrong_phase", "对局已结束");
    }
    GameRow row = store.findById(gameId);
    if (row == null) throw new GameError("not_found", "对局不存在");
    Long uid = userId;
    if (!uid.equals(row.blackId()) && !uid.equals(row.whiteId())) throw new GameError("not_player", "你不是这局棋的对局者");
    throw new GameError("wrong_phase", "对局已结束");
  }

  // ---------------------------------------------------------------- 在线状态

  public void userOnline(long userId) {
    setPresence(userId, true);
  }

  public void userOffline(long userId) {
    setPresence(userId, false);
  }

  private void setPresence(long userId, boolean online) {
    Set<String> ids = userGames.get(userId);
    if (ids == null) return;
    long now = now();
    for (String id : new ArrayList<>(ids)) {
      GameSession s = sessions.get(id);
      if (s == null) continue;
      int color = s.colorOf(userId);
      if (!s.setOnline(color, online, now)) continue;
      Long opp = s.players[opponent(color)];
      if (opp != null) {
        // 附上读秒：到场的一方上线时才开始走他的钟（见 GameSession.arrive），对手据此更新显示（FS-9）
        Map<String, Object> msg = Msg.of("t", "game.presence", "gameId", s.id, "color", color, "online", online);
        if (s.clock != null) msg.put("clocks", s.clocksView(now));
        hub.sendGame(opp, s.id, msg);
      }
      arm(s);
    }
  }

  // ---------------------------------------------------------------- 内部：落子之后

  private void afterPlay(GameSession session, GameSession.MoveInfo info, long now, List<Map<String, Object>> extra) {
    save(session, now);
    push(
        session,
        Msg.of(
            "t", "game.move",
            "gameId", session.id,
            "n", info.n(),
            "idx", info.idx(),
            "color", info.color(),
            "captured", Msg.list(info.captured()),
            "clocks", session.clocksView(now)));
    if (extra != null) for (Map<String, Object> m : extra) push(session, m);
    if (info.scoring()) beginScoring(session, now);
    else maybeAi(session);
    arm(session);
  }

  private void save(GameSession session, long now) {
    try {
      store.saveProgress(session.id, session.progress(), now);
    } catch (RuntimeException err) {
      logger.error("对局 " + session.id + " 保存进度失败", err);
    }
  }

  private void push(GameSession session, Map<String, Object> msg) {
    for (long uid : session.userIds()) hub.sendGame(uid, session.id, msg);
  }

  private void pushScoring(GameSession session, long now) {
    push(session, Msg.of("t", "game.scoring", "gameId", session.id, "scoring", session.scoringView(now)));
  }

  // ---------------------------------------------------------------- 数子阶段

  /** 已进入 scoring（pending）：推送后请求死子建议；失败或 AI 不可用时为 manual、无死子。 */
  private void beginScoring(GameSession session, long now) {
    pushScoring(session, now);
    Integer seq = session.judgeToken();
    String gameId = session.id;
    // 局面和上次 KataGo 判断时一样：直接复用
    int[] cached = session.cachedJudge();
    if (cached != null) {
      onJudge(gameId, seq, cached);
      return;
    }
    if (!aiAvailable()) {
      onJudge(gameId, seq, null);
      return;
    }
    requestJudge(session);
  }

  /**
   * 死子判断任务：每局同时最多一个在途的请求（FS-8）。同一局面已经在判断 → 等它的结果；
   * 另一个局面在判断 → 排在它后面（只保留最新的局面）；结果都按请求时的局面记进 judgeCache；失败或超时重试一次。
   */
  private void requestJudge(GameSession session) {
    String gameId = session.id;
    JudgeReq req = new JudgeReq(session.boardKey(), session.size, session.komi, Msg.ints(session.moves));
    JudgeJob job = judgeJobs.get(gameId);
    if (job != null) {
      job.queued = job.running.key().equals(req.key()) ? null : req;
      return;
    }
    JudgeJob fresh = new JudgeJob(req);
    judgeJobs.put(gameId, fresh);
    runJudge(gameId, fresh);
  }

  private void runJudge(String gameId, JudgeJob job) {
    JudgeReq req = job.running;
    judgeWithRetry(gameId, req, 1, dead -> safe(() -> {
      if (closed) return;
      judgeArrived(gameId, req.key(), dead);
      JudgeReq next = job.queued;
      job.queued = null;
      GameSession s = sessions.get(gameId);
      if (next != null && s != null && judgeWanted(s, next.key())) {
        int[] cached = s.cachedJudge();
        if (cached == null) {
          job.running = next;
          runJudge(gameId, job);
          return;
        }
        onJudge(gameId, s.judgeToken(), cached);
      }
      if (judgeJobs.get(gameId) == job) judgeJobs.remove(gameId);
    }));
  }

  /** 该局还在等这个局面的死子判断。 */
  private boolean judgeWanted(GameSession session, String key) {
    return session != null && !session.ended() && session.judgeToken() != null && session.boardKey().equals(key);
  }

  /** done(dead[] | null)（null：两次都失败），不会抛错。 */
  private void judgeWithRetry(String gameId, JudgeReq req, int attempt, Consumer<int[]> done) {
    CompletableFuture<DeadResult> raw;
    try {
      raw = ai.judgeDead(req.size(), req.komi(), req.moves().clone());
      if (raw == null) raw = CompletableFuture.failedFuture(new IllegalStateException("judgeDead 没有返回结果"));
    } catch (RuntimeException err) {
      raw = CompletableFuture.failedFuture(err);
    }
    boolean[] settled = {false};
    CompletableFuture<DeadResult> rawF = raw;
    // 超时之后才到的结果：照样记进缓存，局面还在等它就直接用上
    Runnable late = () -> {
      DeadResult res = rawF.isCompletedExceptionally() ? null : rawF.getNow(null);
      if (settled[0] && !closed && res != null && res.dead() != null) safe(() -> judgeArrived(gameId, req.key(), res.dead()));
    };
    Runnable next = () -> {
      if (attempt >= JUDGE_ATTEMPTS || closed || !aiAvailable() || !judgeWanted(sessions.get(gameId), req.key())) {
        if (attempt >= JUDGE_ATTEMPTS) logger.warn("对局 " + gameId + " 死子判断重试后仍失败，改为手动数子");
        done.accept(null);
        return;
      }
      judgeWithRetry(gameId, req, attempt + 1, done);
    };
    withTimeout(
        raw,
        settings.judgeTimeoutMs,
        "judgeDead",
        late,
        res -> {
          settled[0] = true;
          if (res != null && res.dead() != null) {
            done.accept(res.dead());
            return;
          }
          logger.warn("对局 " + gameId + " 死子判断返回格式不对（第 " + attempt + " 次）");
          next.run();
        },
        err -> {
          settled[0] = true;
          logger.warn("对局 " + gameId + " 死子判断失败（第 " + attempt + " 次）：" + message(err));
          next.run();
        });
  }

  /** 某局面的死子判断到了（dead 为 null 表示失败）：记进缓存；该局正在等这个局面的判断就用上。 */
  private void judgeArrived(String gameId, String key, int[] dead) {
    GameSession s = sessions.get(gameId);
    if (s == null) return;
    if (dead != null) s.judgeCache = new GameSession.JudgeCache(key, dead.clone());
    if (judgeWanted(s, key)) onJudge(gameId, s.judgeToken(), dead);
  }

  private void onJudge(String gameId, Integer seq, int[] dead) {
    if (closed) return;
    GameSession s = sessions.get(gameId);
    if (s == null) return;
    long now = now();
    if (seq == null || !s.applyJudge(seq, dead, now)) {
      logger.debug("对局 " + gameId + " 丢弃过期的死子判断");
      return;
    }
    pushScoring(s, now);
    arm(s);
  }

  // ---------------------------------------------------------------- AI

  private boolean aiAvailable() {
    try {
      return ai != null && ai.available();
    } catch (RuntimeException err) {
      logger.error("ai.available() 出错", err);
      return false;
    }
  }

  private List<AiLevel> aiLevels() {
    try {
      List<AiLevel> levels = ai != null ? ai.levels() : null;
      return levels != null ? levels : List.of();
    } catch (RuntimeException err) {
      logger.error("ai.levels() 出错", err);
      return List.of();
    }
  }

  /** 轮到 AI 且没在思考 → 请求落子（名额不够时排队，见 dispatchAi）。 */
  private void maybeAi(GameSession session) {
    if (closed || !session.isAiGame() || !"playing".equals(session.status())) return;
    if (session.toPlay() != session.aiColor || session.aiThinking) return;
    session.aiThinking = true;
    push(session, Msg.of("t", "game.ai", "gameId", session.id, "thinking", true));
    dispatchAi(session, session.version);
  }

  private long aiOwner(GameSession session) {
    return session.players[session.humanColor()];
  }

  /**
   * AI 请求名额：每个玩家最多 aiMaxPerUser 个、全服最多 aiMaxInflight 个在途请求。
   * 被悔棋、认输、新开一局作废的请求 AI 还会算完，名额在它真正结束（或超时）时才释放。
   */
  private boolean aiSlotFree(long userId) {
    return aiInflight.getOrDefault(userId, 0) < settings.aiMaxPerUser && aiInflightTotal < settings.aiMaxInflight;
  }

  private void dispatchAi(GameSession session, int token) {
    long userId = aiOwner(session);
    if (!aiSlotFree(userId)) {
      aiWaiting.remove(session.id); // 重新排到队尾
      aiWaiting.put(session.id, token);
      return;
    }
    String gameId = session.id;
    AiMoveRequest req =
        new AiMoveRequest(
            session.size, session.komi, Msg.ints(session.moves), session.aiColor, session.aiLevel, session.humanJustPassed());
    aiInflight.merge(userId, 1, Integer::sum);
    aiInflightTotal += 1;
    boolean[] released = {false};
    Runnable release = () -> {
      if (released[0]) return;
      released[0] = true;
      int n = aiInflight.getOrDefault(userId, 1) - 1;
      if (n > 0) aiInflight.put(userId, n);
      else aiInflight.remove(userId);
      aiInflightTotal = Math.max(0, aiInflightTotal - 1);
      safe(this::drainAiWaiting);
    };
    CompletableFuture<AiMove> raw;
    try {
      raw = ai.chooseMove(req);
      if (raw == null) raw = CompletableFuture.failedFuture(new IllegalStateException("chooseMove 没有返回结果"));
    } catch (RuntimeException err) {
      raw = CompletableFuture.failedFuture(err);
    }
    // AI 真正结束时释放名额；AI 迟迟不结束（超过 aiMoveTimeoutMs）也释放，避免名额泄漏
    withTimeout(
        raw,
        settings.aiMoveTimeoutMs,
        "chooseMove",
        release,
        res -> safe(() -> onAiMove(gameId, token, res)),
        err -> safe(() -> {
          release.run();
          onAiError(gameId, token, err);
        }));
  }

  /** 有名额空出来：按排队顺序派发仍然有效的请求。 */
  private void drainAiWaiting() {
    if (closed) return;
    for (Map.Entry<String, Integer> e : new ArrayList<>(aiWaiting.entrySet())) {
      String gameId = e.getKey();
      int token = e.getValue();
      if (!aiWaiting.containsKey(gameId)) continue;
      GameSession s = sessions.get(gameId);
      if (s == null || s.ended() || s.version != token || !s.aiThinking) {
        aiWaiting.remove(gameId); // 已作废（悔棋、认输、对局结束）
        continue;
      }
      if (!aiSlotFree(aiOwner(s))) continue;
      aiWaiting.remove(gameId);
      dispatchAi(s, token);
    }
  }

  /** 结果回来时局面已变（悔棋/认输/作废）则丢弃。 */
  private boolean isCurrentAiRequest(GameSession s, int token) {
    return !closed && s != null && !s.ended() && s.version == token && s.aiThinking;
  }

  private void onAiMove(String gameId, int token, AiMove res) {
    GameSession s = sessions.get(gameId);
    if (!isCurrentAiRequest(s, token)) {
      logger.debug("对局 " + gameId + " 丢弃过期的 AI 着手");
      return;
    }
    if (res == null) {
      onAiError(gameId, token, new IllegalStateException("AI 返回格式不对"));
      return;
    }
    long now = now();
    if (runDue(s, now)) return;
    if (res.resign()) {
      s.aiThinking = false;
      aiFailures.remove(gameId);
      push(s, Msg.of("t", "game.ai", "gameId", gameId, "thinking", false));
      s.resign(s.aiColor, now);
      end(s, now);
      return;
    }
    int move = res.move();
    GameSession.MoveInfo info;
    try {
      if (move == PASS) info = s.pass(s.aiColor, s.moves.size() + 1, now);
      else info = s.play(s.aiColor, s.moves.size() + 1, move, now);
    } catch (RuntimeException err) {
      onAiError(gameId, token, err);
      return;
    }
    s.aiThinking = false;
    aiFailures.remove(gameId);
    afterPlay(s, info, now, List.of(Msg.of("t", "game.ai", "gameId", gameId, "thinking", false)));
  }

  /** AI 落子失败：按 aiRetryDelaysMs 重试，全部失败则对局作废。 */
  private void onAiError(String gameId, int token, Throwable err) {
    GameSession s = sessions.get(gameId);
    if (!isCurrentAiRequest(s, token)) {
      logger.debug("对局 " + gameId + " 忽略过期的 AI 错误");
      return;
    }
    s.aiThinking = false;
    int[] prev = aiFailures.get(gameId);
    int count = (prev != null && prev[0] == token ? prev[1] : 0) + 1;
    aiFailures.put(gameId, new int[] {token, count});
    push(s, Msg.of("t", "game.ai", "gameId", gameId, "thinking", false));
    List<Long> delays = settings.aiRetryDelaysMs;
    if (count > delays.size()) {
      logger.error("对局 " + gameId + " AI 连续 " + count + " 次落子失败，对局作废", AiException.unwrap(err));
      long now = now();
      s.abort(now, "ai_error");
      end(s, now);
      return;
    }
    long delay = delays.get(count - 1);
    logger.warn("对局 " + gameId + " AI 落子失败（第 " + count + " 次），" + delay + "ms 后重试：" + message(err));
    later(() -> {
      GameSession cur = sessions.get(gameId);
      if (cur != null && cur.version == token) maybeAi(cur);
    }, delay);
  }

  // ---------------------------------------------------------------- 终局

  /**
   * 会话已处于 ended：持久化、更新排位统计（同一事务）、推送 game.end、清理。
   * 写库失败时推送里的 counted 为 false、pending 为 true、不附统计，之后按 PERSIST_RETRY_MS 重试直到写成功；
   * 成功后内存里的 counted 恢复，并再推送一次 game.end；关机时再试一次。
   */
  private void end(GameSession s, long now) {
    applyPairLimit(s, now);
    boolean intended = s.counted;
    boolean saved = persistEnd(s, intended, now);
    if (!saved) {
      s.counted = false;
      s.savePending = true;
      retryPersist(s, intended, 0);
    }
    unregister(s);
    keepEnded(s);
    Map<String, Object> msg = pushEnd(s);
    String cause = s.endCause != null ? "，" + s.endCause : "";
    @SuppressWarnings("unchecked")
    Map<String, Object> rv = (Map<String, Object>) msg.get("result");
    logger.info("对局 " + s.id + " 结束：" + rv.get("text") + "（" + s.result.reason() + cause + (intended ? "，计入排行" : "") + "）");
  }

  /** 推送 game.end（排位赛、结果已写进数据库时附双方最新统计）。返回推送的消息。 */
  private Map<String, Object> pushEnd(GameSession s) {
    Map<String, Object> stats = null;
    if (s.mode.equals("ranked") && !s.savePending) {
      try {
        stats = Msg.byColor(
            Players.rankedStatsView(store.stats(s.players[1])), Players.rankedStatsView(store.stats(s.players[2])));
      } catch (RuntimeException err) {
        logger.error("对局 " + s.id + " 读取排位统计失败", err);
      }
    }
    Map<String, Object> msg = Msg.of("t", "game.end", "gameId", s.id, "result", s.resultView());
    if (stats != null) msg.put("stats", stats);
    push(s, msg);
    return msg;
  }

  /** 同一对手 24 小时内计入排行的局数有上限（rankedPairDailyMax，0 = 不限）：防止两个账号反复匹配互刷连胜（COMP-5）。 */
  private void applyPairLimit(GameSession s, long now) {
    if (!s.counted || !s.mode.equals("ranked")) return;
    boolean reached;
    try {
      reached = store.pairLimitReached(s.players[1], s.players[2], now);
    } catch (RuntimeException err) {
      logger.error("对局 " + s.id + " 查询同一对手的计入局数失败，按计入处理", err);
      return;
    }
    if (reached) {
      s.counted = false;
      s.uncounted = "pair_limit";
      logger.info("对局 " + s.id + "：这两位玩家 24 小时内计入的局数已满，本局不计入排行");
    }
  }

  /** 终局结果与排位统计写进同一个事务。成功返回 true。 */
  private boolean persistEnd(GameSession s, boolean counted, long now) {
    GameSession.FinishFields fields = s.finishFields();
    GameStore.RankedApply ranked = null;
    if (counted) {
      Result r = s.result;
      boolean draw = r.winner() == 0;
      ranked =
          new GameStore.RankedApply(
              s.id,
              draw ? null : s.players[r.winner()],
              draw ? null : s.players[opponent(r.winner())],
              draw,
              List.of(s.players[1], s.players[2]));
    }
    try {
      store.finish(s.id, fields, ranked, now);
      return true;
    } catch (RuntimeException err) {
      logger.error("对局 " + s.id + " 终局保存失败，稍后重试", err);
      return false;
    }
  }

  private void retryPersist(GameSession s, boolean counted, int attempt) {
    Unsaved prev = unsavedEnds.get(s.id);
    if (prev != null) cancel(prev.entry());
    long delay = PERSIST_RETRY_MS[Math.min(attempt, PERSIST_RETRY_MS.length - 1)];
    Entry entry = later(() -> {
      if (persistEnd(s, counted, s.endedAt != null ? s.endedAt : now())) {
        unsavedEnds.remove(s.id);
        s.counted = counted;
        s.savePending = false;
        logger.info("对局 " + s.id + " 的终局结果已补写入数据库" + (counted ? "（已计入排行）" : ""));
        // 再推送一次终局：pending 为 false、counted 为实际值，排位赛附最新统计（FS-10）
        pushEnd(s);
      } else {
        retryPersist(s, counted, attempt + 1);
      }
    }, delay);
    unsavedEnds.put(s.id, new Unsaved(s, counted, entry));
  }

  /** 玩家还没下过子的人机对局被新开的对局顶替：直接删除记录，不进终局缓存（不留大量空对局）。 */
  private void discard(GameSession s) {
    try {
      store.discard(s.id);
    } catch (RuntimeException err) {
      logger.error("删除对局 " + s.id + " 失败，改为按作废保存", err);
      end(s, s.endedAt != null ? s.endedAt : now());
      return;
    }
    unregister(s);
    push(s, Msg.of("t", "game.end", "gameId", s.id, "result", s.resultView()));
  }

  private void keepEnded(GameSession session) {
    Ended prev = endedCache.remove(session.id);
    if (prev != null) cancel(prev.entry());
    // 有上限：超出时丢掉最早结束的（之后的 game.sync 从数据库读）
    while (endedCache.size() >= settings.endedCacheMax) {
      Iterator<Map.Entry<String, Ended>> it = endedCache.entrySet().iterator();
      Map.Entry<String, Ended> oldest = it.next();
      cancel(oldest.getValue().entry());
      it.remove();
    }
    Entry entry = later(() -> endedCache.remove(session.id), ENDED_KEEP_MS);
    endedCache.put(session.id, new Ended(session, entry));
  }

  // ---------------------------------------------------------------- 定时

  void arm(GameSession session) {
    disarm(session.id);
    if (closed || session.ended() || !sessions.containsKey(session.id)) return;
    Long at = session.nextDeadline();
    if (at == null) return;
    Entry[] self = new Entry[1];
    self[0] = later(() -> {
      if (deadlineTimers.get(session.id) == self[0]) deadlineTimers.remove(session.id);
      onDeadline(session.id);
    }, at - now());
    deadlineTimers.put(session.id, self[0]);
  }

  void disarm(String gameId) {
    Entry entry = deadlineTimers.remove(gameId);
    if (entry != null) cancel(entry);
  }

  void onDeadline(String gameId) {
    GameSession s = sessions.get(gameId);
    if (s == null || closed) return;
    if (!runDue(s, now())) arm(s); // 定时器提前触发或延时被截断：按当前时间重新安排
  }

  /** 有到期事件就执行并终局，返回是否已终局。 */
  private boolean runDue(GameSession session, long now) {
    String kind = session.dueAction(now);
    if (kind == null) return false;
    logger.info("对局 " + session.id + " 到期事件：" + kind);
    session.applyDue(kind, now);
    if (session.resumeUndone) {
      logger.info("对局 " + session.id + " 已同意数子结果的一方在继续对局后没有走下一手（掉线或读秒用完），撤销继续对局");
    }
    // 按数子终局：先推送最终采用的死子（自动确认可能回退到双方认可的版本），再推送 game.end
    if (session.result != null && "score".equals(session.result.reason())) pushScoring(session, now);
    end(session, now);
    return true;
  }

  private Entry later(Runnable fn, long ms) {
    long delay = Math.min(Math.max(0, ms), MAX_TIMER_MS);
    Entry entry = new Entry();
    entry.handle = loop.schedule(() -> {
      pending.remove(entry);
      safe(fn);
    }, delay);
    pending.add(entry);
    return entry;
  }

  private void cancel(Entry entry) {
    if (entry == null) return;
    if (entry.handle != null) entry.handle.cancel();
    pending.remove(entry);
  }

  /**
   * raw 在 ms 毫秒内完成则 onOk / onErr，否则按超时 onErr；回调都在循环线程上执行，只调用一次。
   * onDone（可为 null）：raw 真正完成时（不论是否已超时）先执行。
   */
  private <T> void withTimeout(
      CompletableFuture<T> raw, long ms, String label, Runnable onDone, Consumer<T> onOk, Consumer<Throwable> onErr) {
    boolean[] settled = {false};
    Entry entry = later(() -> {
      if (settled[0]) return;
      settled[0] = true;
      onErr.accept(new IllegalStateException(label + " 超时（" + ms + "ms）"));
    }, ms);
    raw.whenComplete((v, e) -> loop.execute(() -> {
      if (onDone != null) safe(onDone);
      if (settled[0]) return;
      settled[0] = true;
      cancel(entry);
      if (e == null) onOk.accept(v);
      else onErr.accept(AiException.unwrap(e));
    }));
  }

  private void safe(Runnable fn) {
    try {
      fn.run();
    } catch (RuntimeException err) {
      logger.error("对局管理器内部错误", err);
    }
  }

  private static String message(Throwable err) {
    Throwable e = AiException.unwrap(err);
    return e == null ? "null" : e.getMessage();
  }

  // ---------------------------------------------------------------- 玩家信息

  private Map<String, Object> playersOf(GameSession session) {
    Map<String, Object> out = new LinkedHashMap<>();
    for (int c = 1; c <= 2; c++) {
      if (c == session.aiColor) {
        out.put(String.valueOf(c), Players.aiPlayerInfo(session.aiLevel, aiLevels()));
        continue;
      }
      Long id = session.players[c];
      User user = null;
      try {
        user = store.findUser(id);
      } catch (RuntimeException err) {
        logger.error("读取用户 " + id + " 失败", err);
      }
      out.put(String.valueOf(c), Players.playerInfo(user, settings.publicBaseUrl, id));
    }
    return out;
  }

  // ---------------------------------------------------------------- 启动恢复

  public int restore() {
    List<UnfinishedGame> rows = store.listUnfinished();
    long now = now();
    int restored = 0;
    for (UnfinishedGame row : rows) {
      GameSession s;
      try {
        // 仓储读不出来的行（JSON 损坏等）以 broken 返回
        if (row.broken()) throw new IllegalStateException(row.error() != null ? row.error() : "对局记录损坏");
        s = GameSession.fromRow(row.game(), settings, now);
      } catch (RuntimeException err) {
        logger.error("对局 " + row.id() + " 无法恢复，按作废处理", err);
        voidBroken(row.id(), now);
        continue;
      }
      if (s.ended() || sessions.containsKey(s.id)) continue;
      for (int c = 1; c <= 2; c++) {
        Long uid = s.players[c];
        if (uid != null) s.setOnline(c, hub.isOnline(uid), now);
      }
      // 停机不是玩家的错：还没重新连上的玩家到场前不走钟、不判弃局，超过 arrivalGraceMs 未回来则作废
      s.expectArrival(now);
      register(s);
      restored += 1;
      if ("scoring".equals(s.status())) beginScoring(s, now);
      else maybeAi(s);
      arm(s);
    }
    if (!rows.isEmpty()) logger.info("恢复了 " + restored + "/" + rows.size() + " 局未结束的对局");
    return restored;
  }

  /** 记录损坏（无法重放）的对局直接作废，避免每次启动都失败。 */
  private void voidBroken(String id, long now) {
    if (id == null) return;
    try {
      store.finish(id, new GameSession.FinishFields(null, null, 0, "abort", null, null, "Void", false, "broken"), null, now);
    } catch (RuntimeException err) {
      logger.error("对局 " + id + " 作废失败", err);
    }
  }

  public void shutdown() {
    // 终局结果还没写进数据库的：关机前再试一次，否则重启后会被当成进行中的对局恢复
    for (Map.Entry<String, Unsaved> e : new ArrayList<>(unsavedEnds.entrySet())) {
      Unsaved u = e.getValue();
      if (persistEnd(u.session(), u.counted(), u.session().endedAt != null ? u.session().endedAt : now())) {
        unsavedEnds.remove(e.getKey());
      } else {
        logger.error("对局 " + e.getKey() + " 的终局结果在关机前仍未能写入数据库");
      }
    }
    closed = true;
    for (Entry entry : pending) if (entry.handle != null) entry.handle.cancel();
    pending.clear();
    deadlineTimers.clear();
    endedCache.clear();
    unsavedEnds.clear();
    aiWaiting.clear();
    judgeJobs.clear();
  }

  // ---------------------------------------------------------------- 测试与排障

  public GameSettings settings() {
    return settings;
  }

  public int aiInflightOf(long userId) {
    return aiInflight.getOrDefault(userId, 0);
  }

  public int aiInflightTotal() {
    return aiInflightTotal;
  }
}
