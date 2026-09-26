package com.gamego.game;

import static com.gamego.engine.Go.BLACK;
import static com.gamego.engine.Go.PASS;
import static com.gamego.engine.Go.WHITE;
import static com.gamego.engine.Go.opponent;

import com.fasterxml.jackson.databind.JsonNode;
import com.gamego.config.TimeControl;
import com.gamego.db.GameRow;
import com.gamego.engine.Game;
import com.gamego.engine.GameState;
import com.gamego.engine.Move;
import com.gamego.engine.OpResult;
import com.gamego.engine.Record;
import com.gamego.engine.Result;
import com.gamego.engine.Score;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 一局棋的权威状态（设计文档第 6 节，移植自 Node 版 game/session.js）。纯内存、无 IO：时间由调用方传入，
 * 出错时抛 {@link GameError}，成功时返回描述变化的对象，由 {@link GameManager} 负责持久化、推送、定时器与 AI。
 */
public final class GameSession {

  public static final List<String> MODES = List.of("ranked", "friend", "ai");

  static final Map<String, String> ILLEGAL_MSG =
      Map.of("occupied", "这里已经有棋子了", "ko", "打劫，不能立即提回", "suicide", "禁止自杀");

  /** 同一时刻到期时的处理顺序。 */
  static final List<String> DUE_ORDER = List.of("first_move", "timeout", "abandon", "scoring", "idle");

  /** "继续对局"在 stance 里的记号：不同意当时的数子结果（不会与任何死子集合的键相同）。 */
  static final String STANCE_RESUME = "resume";

  // ---------------------------------------------------------------- 返回值

  /** 落子 / pass 的结果：idx 为 -1 表示 pass；scoring 为真表示双方连续 pass 进入数子阶段。 */
  public record MoveInfo(int n, int idx, int color, int[] captured, boolean scoring) {}

  /** 待到期事件。kind：first_move / timeout / abandon / scoring / idle。 */
  public record Deadline(String kind, long at) {}

  /** 自动确认时限到时的处理：dead（按这组死子计分）或 voidCause（作废）。 */
  public record Outcome(int[] dead, String voidCause) {}

  /** games.insert 的参数。 */
  public record InsertRow(
      String id,
      String mode,
      int size,
      double komi,
      Long blackId,
      Long whiteId,
      String aiLevel,
      TimeControl timeControl,
      String status,
      List<Integer> moves,
      Map<String, Object> clocks,
      long createdAt,
      long updatedAt) {}

  /** games.saveProgress 的参数。 */
  public record Progress(String status, List<Integer> moves, Map<String, Object> clocks, Map<String, Object> state) {}

  /** games.finish 的参数（moves 为 null 表示不写）。 */
  public record FinishFields(
      List<Integer> moves,
      List<Integer> dead,
      int winner,
      String reason,
      Double scoreBlack,
      Double scoreWhite,
      String resultText,
      boolean counted,
      String cause) {}

  /** 两个死子集合都认可过的版本。 */
  record Agreed(String key, int[] dead) {}

  /** 继续对局保护：继续时对方已同意当时的数子建议。 */
  record ResumeGuard(int color, int movesLen, Scoring scoring) {}

  /** 最近一次 KataGo 死子判断：{ key: 局面, dead }。 */
  record JudgeCache(String key, int[] dead) {}

  /** 还没到场的玩家。 */
  static final class Arrival {
    final boolean[] waiting = new boolean[3];
    final long since;

    Arrival(boolean black, boolean white, long since) {
      waiting[1] = black;
      waiting[2] = white;
      this.since = since;
    }
  }

  /** 数子阶段的状态。 */
  static final class Scoring {
    boolean pending;
    String source = "katago";
    int version;
    int[] dead = new int[0];
    int[] owner = new int[0];
    double black;
    double white;
    int winner;
    final boolean[] accepted = new boolean[3];
    Long deadlineAt;
    int judgeSeq;
    /** 最初的建议（KataGo 判断；manual 时为空）。 */
    int[] proposal = new int[0];
    Long readyAt;
    /** 各方认可过的死子集合的键。 */
    List<Set<String>> endorsed = newEndorsed();
    Agreed agreed;
    /** 与原建议不同的棋子 → 最后改动它的一方。 */
    LinkedHashMap<Integer, Integer> marks = new LinkedHashMap<>();
    /** 手动数子时各方最近一次表态。 */
    final String[] stance = new String[3];

    static List<Set<String>> newEndorsed() {
      List<Set<String>> l = new ArrayList<>(3);
      l.add(null);
      l.add(new LinkedHashSet<>());
      l.add(new LinkedHashSet<>());
      return l;
    }
  }

  // ---------------------------------------------------------------- 状态

  final String id;
  final String mode;
  final int size;
  final double komi;
  final GameSettings settings;
  /** players[1] 黑、players[2] 白（AI 一方为 null）。 */
  final Long[] players = new Long[3];
  final int aiColor;
  final String aiLevel;
  final TimeControl timeControl;
  GameClock clock;

  GameState state;
  List<Integer> moves = new ArrayList<>();
  final long createdAt;
  /** 首手计时的起点（重启恢复时为恢复时刻）。 */
  long startedAt;
  long turnStartedAt;
  long lastActivityAt;
  final boolean[] online = new boolean[3];
  final Long[] offlineSince = new Long[3];
  Scoring scoring;
  int judgeSeq;
  Result result;
  boolean counted;
  /** 终局的细分原因（Result.cause，见设计文档 5.4）。 */
  String endCause;
  /** 排位赛、不是作废、却没有计入时的原因：'short' | 'pair_limit'。 */
  String uncounted;
  /** 终局结果写库失败、正在重试（Result.pending）。 */
  boolean savePending;
  Long endedAt;
  boolean aiThinking;
  /** 局面/阶段每变化一次 +1，用来识别过期的 AI 结果。 */
  int version;
  /** 真人对局每方已用的"继续对局"次数（随对局进度保存，重启不清零）。 */
  final int[] resumesUsed = new int[3];
  ResumeGuard resumeGuard;
  JudgeCache judgeCache;
  Arrival arrival;
  boolean resumeUndone;

  public GameSession(
      String id,
      String mode,
      int size,
      double komi,
      Long blackId,
      Long whiteId,
      String aiLevel,
      TimeControl timeControl,
      GameSettings settings,
      long now,
      Long createdAt) {
    if (id == null || id.isEmpty()) throw new IllegalArgumentException("GameSession: id 必须是非空字符串");
    if (!MODES.contains(mode)) throw new IllegalArgumentException("GameSession: 未知模式 " + mode);
    if (size < 2 || size > 19) throw new IllegalArgumentException("GameSession: 路数不合法 " + size);
    if (!Double.isFinite(komi)) throw new IllegalArgumentException("GameSession: komi 必须是数字");
    if (settings == null) throw new IllegalArgumentException("GameSession: 需要 settings");
    this.id = id;
    this.mode = mode;
    this.size = size;
    this.komi = komi;
    this.settings = settings;
    players[BLACK] = blackId;
    players[WHITE] = whiteId;
    if (mode.equals("ai")) {
      if ((blackId == null) == (whiteId == null)) throw new IllegalArgumentException("GameSession: 人机对局必须恰好一方为 AI");
      Long human = blackId == null ? whiteId : blackId;
      if (!isUserId(human)) throw new IllegalArgumentException("GameSession: 玩家 id 不合法");
      if (aiLevel == null || aiLevel.isEmpty()) throw new IllegalArgumentException("GameSession: 人机对局需要 aiLevel");
      this.aiColor = blackId == null ? BLACK : WHITE;
      this.aiLevel = aiLevel;
    } else {
      if (!isUserId(blackId) || !isUserId(whiteId) || blackId.equals(whiteId)) {
        throw new IllegalArgumentException("GameSession: 真人对局需要两个不同的玩家 id");
      }
      this.aiColor = 0;
      this.aiLevel = null;
    }
    // 人机对局不计时
    this.timeControl = !mode.equals("ai") && timeControl != null ? GameClock.normalizeTimeControl(timeControl) : null;
    this.clock = this.timeControl != null ? new GameClock(this.timeControl) : null;

    this.state = Game.createGame(size, komi, false);
    this.createdAt = createdAt != null ? createdAt : now;
    this.startedAt = now;
    this.turnStartedAt = now;
    this.lastActivityAt = now;
    online[BLACK] = aiColor == BLACK;
    online[WHITE] = aiColor == WHITE;
    offlineSince[BLACK] = aiColor == BLACK ? null : now;
    offlineSince[WHITE] = aiColor == WHITE ? null : now;
    if (clock != null) clock.start(BLACK, now);
  }

  static boolean isUserId(Long v) {
    return v != null && v > 0;
  }

  // ---------------------------------------------------------------- 查询

  public String id() {
    return id;
  }

  public String mode() {
    return mode;
  }

  public int size() {
    return size;
  }

  public double komi() {
    return komi;
  }

  public String status() {
    return state.status;
  }

  public int toPlay() {
    return state.toPlay;
  }

  public boolean isAiGame() {
    return mode.equals("ai");
  }

  public int aiColor() {
    return aiColor;
  }

  public String aiLevel() {
    return aiLevel;
  }

  public int humanColor() {
    return aiColor != 0 ? opponent(aiColor) : 0;
  }

  public boolean ended() {
    return GameState.ENDED.equals(state.status);
  }

  public Long player(int color) {
    return players[color];
  }

  public List<Integer> moves() {
    return List.copyOf(moves);
  }

  public GameClock clock() {
    return clock;
  }

  public Result result() {
    return result;
  }

  public boolean counted() {
    return counted;
  }

  public boolean isOnline(int color) {
    return online[color];
  }

  public boolean aiThinking() {
    return aiThinking;
  }

  public int version() {
    return version;
  }

  public TimeControl timeControl() {
    return timeControl;
  }

  public int colorOf(Long userId) {
    if (userId == null) return 0;
    if (userId.equals(players[BLACK])) return BLACK;
    if (userId.equals(players[WHITE])) return WHITE;
    return 0;
  }

  public List<Long> userIds() {
    List<Long> out = new ArrayList<>(2);
    if (players[BLACK] != null) out.add(players[BLACK]);
    if (players[WHITE] != null) out.add(players[WHITE]);
    return out;
  }

  /** 人机对局：最后一手是玩家的 pass（"继续对局"后连续 pass 计数清零，不算）。 */
  public boolean humanJustPassed() {
    List<Move> h = state.history;
    if (h.isEmpty()) return false;
    Move last = h.get(h.size() - 1);
    return last.idx() == null && last.color() == humanColor() && state.consecutivePasses >= 1;
  }

  public void touch(long now) {
    lastActivityAt = now;
  }

  /** 返回在线状态是否有变化。 */
  public boolean setOnline(int color, boolean val, long now) {
    if (color != BLACK && color != WHITE) return false;
    if (color == aiColor) return false;
    if (online[color] == val) return false;
    online[color] = val;
    offlineSince[color] = val ? null : now;
    if (val) arrive(color, now);
    return true;
  }

  // ---------------------------------------------------------------- 到场
  // 开局时不在线的玩家（好友房房主切到了后台）与服务端重启后恢复的对局里的玩家，在"到场"（上线）之前：
  // 不走他的钟、首手计时不开始、轮到他时也不按掉线弃局判负；超过 arrivalGraceMs 仍未到场则对局作废。

  public void expectArrival(long now) {
    if (isAiGame() || ended()) return;
    boolean wb = !online[BLACK];
    boolean ww = !online[WHITE];
    if (!wb && !ww) {
      arrival = null;
      return;
    }
    arrival = new Arrival(wb, ww, now);
    if (clock != null && clock.running() != 0 && arrival.waiting[clock.running()]) clock.stop(now);
  }

  public boolean awaitingArrival(int color) {
    return arrival != null && color >= 1 && color <= 2 && arrival.waiting[color];
  }

  private void arrive(int color, long now) {
    Arrival a = arrival;
    if (a == null || !a.waiting[color]) return;
    a.waiting[color] = false;
    if (!a.waiting[BLACK] && !a.waiting[WHITE]) arrival = null;
    if (!GameState.PLAYING.equals(state.status) || state.toPlay != color) return;
    if (moves.isEmpty()) startedAt = now; // 首手计时从黑方到场算起
    turnStartedAt = now;
    if (clock != null && clock.running() == 0) clock.start(color, now);
  }

  /** 轮到 color：开始计时（还没到场的一方先不走钟）。 */
  private void runClockFor(int color, long now) {
    if (clock == null) return;
    if (awaitingArrival(color)) clock.stop(now);
    else clock.start(color, now);
  }

  // ---------------------------------------------------------------- 对局中

  private void requirePlaying() {
    String st = state.status;
    if (GameState.PLAYING.equals(st)) return;
    throw new GameError("wrong_phase", GameState.SCORING.equals(st) ? "正在数子，不能落子" : "对局已结束");
  }

  private void checkTurn(int color, int n, long now) {
    int expected = moves.size() + 1;
    if (n != expected) throw new GameError("stale", "局面已变化，当前应为第 " + expected + " 手", Msg.of("expected", expected));
    if (color != state.toPlay) throw new GameError("not_your_turn", "还没轮到你");
    if (clock != null && clock.running() == color && clock.isTimedOut(now)) throw new GameError("wrong_phase", "已超时");
  }

  private void nextTurn(long now) {
    runClockFor(state.toPlay, now); // start/stop 都会先结算刚落子的一方
    turnStartedAt = now;
    version += 1;
  }

  /** color 走了一手：继续对局的保护到此为止（他已经回到对局里了）。 */
  private void moved(int color) {
    if (resumeGuard != null && resumeGuard.color() == color) resumeGuard = null;
  }

  /** color 落子于 idx，n 为这一手的序号。 */
  public MoveInfo play(int color, int n, int idx, long now) {
    requirePlaying();
    checkTurn(color, n, now);
    if (idx < 0 || idx >= size * size) throw new GameError("bad_request", "坐标超出棋盘");
    OpResult r = Game.play(state, idx);
    if (!r.ok()) {
      String msg = ILLEGAL_MSG.getOrDefault(r.reason(), "非法着手：" + r.reason());
      throw new GameError("illegal", msg, Msg.of("reason", r.reason()));
    }
    Move last = state.history.get(state.history.size() - 1);
    moves.add(idx);
    moved(color);
    nextTurn(now);
    return new MoveInfo(moves.size(), idx, color, last.captured().clone(), false);
  }

  public MoveInfo pass(int color, int n, long now) {
    requirePlaying();
    checkTurn(color, n, now);
    OpResult r = Game.pass(state);
    if (!r.ok()) throw new GameError("wrong_phase", "当前不能停一手");
    moves.add(PASS);
    moved(color);
    boolean sc = GameState.SCORING.equals(state.status);
    if (sc) enterScoring(now);
    else nextTurn(now);
    return new MoveInfo(moves.size(), PASS, color, new int[0], sc);
  }

  // ---------------------------------------------------------------- 数子阶段

  void enterScoring(long now) {
    if (clock != null) clock.stop(now);
    judgeSeq += 1;
    resumeGuard = null;
    Score.ScoreResult s = Score.scoreArea(state.board, komi, new int[0]);
    Scoring sc = new Scoring();
    sc.pending = true;
    sc.source = "katago";
    sc.version = 0;
    sc.dead = new int[0];
    sc.owner = s.owner();
    sc.black = s.black();
    sc.white = s.white();
    sc.winner = s.winner();
    sc.deadlineAt = null;
    sc.judgeSeq = judgeSeq;
    scoring = sc;
    version += 1;
  }

  /** 正在等死子判断时的序号，否则 null。 */
  public Integer judgeToken() {
    return scoring != null && scoring.pending ? scoring.judgeSeq : null;
  }

  /** 当前局面的键（数子阶段复用死子判断用）。 */
  public String boardKey() {
    byte[] cells = state.board.cells;
    char[] c = new char[cells.length];
    for (int i = 0; i < c.length; i++) c[i] = (char) ('0' + cells[i]);
    return new String(c);
  }

  /** 局面与上次 KataGo 判断时相同 → 上次的死子；否则 null。 */
  public int[] cachedJudge() {
    JudgeCache c = judgeCache;
    return c != null && c.key().equals(boardKey()) ? c.dead().clone() : null;
  }

  /**
   * 死子建议到达（dead 为数组）或判定失败（dead 为 null → manual、无死子）。
   * 结果已过期（局面变了/不在等待中）时返回 false，不做任何修改。
   */
  public boolean applyJudge(int seq, int[] dead, long now) {
    Scoring sc = scoring;
    if (!GameState.SCORING.equals(state.status) || sc == null || !sc.pending || sc.judgeSeq != seq) return false;
    int[] list = dead != null ? dead : new int[0];
    Score.ScoreResult s = Score.scoreArea(state.board, komi, list);
    sc.pending = false;
    sc.source = dead != null ? "katago" : "manual";
    sc.version = 1;
    setDead(s);
    sc.proposal = s.dead().clone();
    sc.readyAt = now;
    sc.endorsed = Scoring.newEndorsed();
    sc.agreed = null;
    sc.marks = new LinkedHashMap<>();
    sc.stance[1] = null;
    sc.stance[2] = null;
    sc.accepted[1] = false;
    sc.accepted[2] = false;
    // 人机对局：AI 一方自动确认，也没有自动确认时限
    if (aiColor != 0) sc.accepted[aiColor] = true;
    sc.deadlineAt = aiColor != 0 ? null : now + settings.scoringTimeoutMs;
    if (sc.source.equals("katago")) judgeCache = new JudgeCache(boardKey(), s.dead().clone());
    version += 1;
    return true;
  }

  private void setDead(Score.ScoreResult s) {
    Scoring sc = scoring;
    sc.dead = s.dead();
    sc.owner = s.owner();
    sc.black = s.black();
    sc.white = s.white();
    sc.winner = s.winner();
  }

  private void requireScoringReady() {
    if (!GameState.SCORING.equals(state.status) || scoring == null) {
      throw new GameError("wrong_phase", GameState.ENDED.equals(state.status) ? "对局已结束" : "当前不在数子阶段");
    }
    if (scoring.pending) throw new GameError("wrong_phase", "正在判断死子，请稍候");
  }

  static String deadKey(int[] list) {
    StringBuilder sb = new StringBuilder();
    for (int i = 0; i < list.length; i++) {
      if (i > 0) sb.append(',');
      sb.append(list[i]);
    }
    return sb.toString();
  }

  static String deadKey(List<Integer> list) {
    return deadKey(Msg.ints(list));
  }

  /** color 认可当前的死子集合（确认，或者点选出来的集合与原建议的差别全是他自己改的）。 */
  private void endorse(int color) {
    Scoring sc = scoring;
    String key = deadKey(sc.dead);
    sc.endorsed.get(color).add(key);
    if (sc.endorsed.get(opponent(color)).contains(key)) sc.agreed = new Agreed(key, sc.dead.clone());
  }

  /**
   * 切换 idx 所在整块的死活。返回是否有变化（点在空点上不变）。
   * version（可选）：客户端点选时看到的版本，不是当前版本 → stale。
   * 真人对局：自动确认时限顺延，保证对方至少还有 scoringGraceMs 可以回应（总时长不超过 2 × scoringTimeoutMs）。
   * 人机对局：只有死子判断失败（manual）时才允许点选，AI 一方保持已确认。
   */
  public boolean toggleDead(int color, int idx, long now, Integer ver) {
    requireScoringReady();
    Scoring sc = scoring;
    if (isAiGame() && !sc.source.equals("manual")) throw new GameError("bad_request", "人机对局由 AI 判断死子，不能修改");
    if (idx < 0 || idx >= size * size) throw new GameError("bad_request", "坐标超出棋盘");
    if (ver != null && ver != sc.version) {
      throw new GameError("stale", "死子已被修改，请看清最新结果再点选", Msg.of("version", sc.version));
    }
    int[] next = Score.toggleDead(state.board, sc.dead, idx);
    if (Arrays.equals(next, sc.dead)) return false;
    // 记下与原建议不同的棋子是谁改的
    Set<Integer> before = toSet(sc.dead);
    Set<Integer> after = toSet(next);
    Set<Integer> proposal = toSet(sc.proposal);
    List<Integer> all = new ArrayList<>(Msg.list(sc.dead));
    all.addAll(Msg.list(next));
    for (int i : all) {
      if (before.contains(i) == after.contains(i)) continue;
      if (after.contains(i) == proposal.contains(i)) sc.marks.remove(i);
      else sc.marks.put(i, color);
    }
    setDead(Score.scoreArea(state.board, komi, next));
    sc.version += 1;
    sc.accepted[1] = false;
    sc.accepted[2] = false;
    if (aiColor != 0) sc.accepted[aiColor] = true;
    // 点选出来的集合只有在"与原建议的差别全是自己改的"时才算认可（FS-2）
    boolean allMine = true;
    for (int c : sc.marks.values()) if (c != color) allMine = false;
    if (allMine) endorse(color);
    sc.stance[color] = deadKey(sc.dead);
    if (sc.deadlineAt != null) {
      long grace = Math.min(settings.scoringGraceMs, settings.scoringTimeoutMs);
      long cap = sc.readyAt + 2 * settings.scoringTimeoutMs;
      sc.deadlineAt = Math.max(sc.deadlineAt, Math.min(now + grace, cap));
    }
    version += 1;
    return true;
  }

  private static Set<Integer> toSet(int[] a) {
    Set<Integer> s = new HashSet<>();
    for (int v : a) s.add(v);
    return s;
  }

  /** 确认当前版本的数子结果。返回双方是否都确认了。 */
  public boolean accept(int color, int ver, long now) {
    requireScoringReady();
    Scoring sc = scoring;
    if (ver != sc.version) throw new GameError("stale", "死子已被修改，请确认最新结果", Msg.of("version", sc.version));
    sc.accepted[color] = true;
    endorse(color);
    sc.stance[color] = deadKey(sc.dead);
    return sc.accepted[BLACK] && sc.accepted[WHITE];
  }

  /** 还能"继续对局"几次；人机对局不限（null）。 */
  public Integer resumesLeft(int color) {
    if (isAiGame()) return null;
    return Math.max(0, settings.resumeLimit - resumesUsed[color]);
  }

  /**
   * 不同意数子结果，回到对局：轮到最先 pass 的一方，重新计时。返回轮到的一方。
   * 真人对局：每方每局最多 resumeLimit 次；对手不在线时不能继续（交给自动确认按规则计分）。
   */
  public int resume(int color, long now) {
    if (!GameState.SCORING.equals(state.status)) {
      throw new GameError("wrong_phase", GameState.ENDED.equals(state.status) ? "对局已结束" : "当前不在数子阶段");
    }
    int opp = opponent(color);
    if (!isAiGame()) {
      if (resumesLeft(color) <= 0) {
        throw new GameError("wrong_phase", "你已经用过\"继续对局\"了，请确认数子结果或等待自动计分");
      }
      if (!online[opp]) throw new GameError("wrong_phase", "对手不在线，不能继续对局，请等待自动计分");
    }
    Scoring sc = scoring;
    OpResult r = Game.resume(state);
    if (!r.ok()) throw new GameError("wrong_phase", "当前不在数子阶段");
    if (!isAiGame()) {
      resumesUsed[color] += 1;
      if (sc != null && !sc.pending && sc.accepted[opp]) {
        // 继续对局 = 不同意当时的结果（手动数子撤销继续对局时，这算一次异议，见 deadlineOutcome）
        sc.stance[color] = STANCE_RESUME;
        resumeGuard = new ResumeGuard(opp, moves.size(), sc);
      } else {
        resumeGuard = null;
      }
    }
    scoring = null;
    judgeSeq += 1; // 让还在路上的死子判断结果作废
    runClockFor(state.toPlay, now);
    turnStartedAt = now;
    version += 1;
    return state.toPlay;
  }

  /** 按当前死子计分终局。cause：Result.cause（默认 agreed）。 */
  public Result finishByScore(long now, String cause) {
    requireScoringReady();
    Score.ScoreResult s = Score.scoreArea(state.board, komi, scoring.dead);
    return end(new Result(s.winner(), "score", s.black(), s.white()), now, cause);
  }

  public Result finishByScore(long now) {
    return finishByScore(now, "agreed");
  }

  /**
   * 自动确认时限到了、双方还没对当前版本达成一致时怎么终局。
   * KataGo 的建议（中立）：当前版本就是原建议，或双方都认可过当前版本 → 当前版本；否则最近一个双方都认可过的版本；再没有就用原建议。
   * 手动数子：双方都认可过的版本照用；否则有人还没到场 → 作废（arrival）；谁都没有异议 → 无死子；有异议 → 作废（score_dispute）。
   */
  public Outcome deadlineOutcome() {
    Scoring sc = scoring;
    String cur = deadKey(sc.dead);
    String pk = deadKey(sc.proposal);
    boolean bothCur = sc.endorsed.get(BLACK).contains(cur) && sc.endorsed.get(WHITE).contains(cur);
    if (!sc.source.equals("manual")) {
      if (cur.equals(pk) || bothCur) return new Outcome(sc.dead.clone(), null);
      if (sc.agreed != null) return new Outcome(sc.agreed.dead().clone(), null);
      return new Outcome(sc.proposal.clone(), null);
    }
    if (bothCur) return new Outcome(sc.dead.clone(), null);
    if (sc.agreed != null) return new Outcome(sc.agreed.dead().clone(), null);
    if (!isAiGame() && (awaitingArrival(BLACK) || awaitingArrival(WHITE))) return new Outcome(null, "arrival");
    boolean quiet = true;
    for (int c = 1; c <= 2; c++) {
      if (sc.stance[c] != null && !sc.stance[c].equals(pk)) quiet = false;
    }
    if (quiet) return new Outcome(sc.proposal.clone(), null);
    return new Outcome(null, "score_dispute");
  }

  /** 自动确认时限到：按 deadlineOutcome() 计分终局（死子集合有变化时 version +1）或作废。 */
  public Result finishAtDeadline(long now, String cause) {
    requireScoringReady();
    Scoring sc = scoring;
    Outcome out = deadlineOutcome();
    if (out.voidCause() != null) return end(new Result(0, "abort"), now, out.voidCause());
    if (!Arrays.equals(out.dead(), sc.dead)) {
      setDead(Score.scoreArea(state.board, komi, out.dead()));
      sc.version += 1;
    }
    return finishByScore(now, cause);
  }

  /**
   * 继续对局后，此前已同意数子结果的一方还没走下一手就掉线弃局/超时：撤销这次继续对局
   * （之后的着手作废），回到当时的数子阶段并按自动确认的规则终局。
   */
  private Result undoResume(long now) {
    ResumeGuard g = resumeGuard;
    resumeGuard = null;
    List<Integer> kept = new ArrayList<>(moves.subList(0, g.movesLen()));
    state = replayMoves(size, komi, kept);
    moves = kept;
    scoring = g.scoring();
    // 按撤销后的局面重算（从数据库恢复的保护只存了死子集合）
    setDead(Score.scoreArea(state.board, komi, scoring.dead));
    resumeUndone = true;
    return finishAtDeadline(now, "resume_undone");
  }

  // ---------------------------------------------------------------- 终局

  public Result resign(int color, long now) {
    String st = state.status;
    if (!GameState.PLAYING.equals(st) && !GameState.SCORING.equals(st)) throw new GameError("wrong_phase", "对局已结束");
    return end(new Result(opponent(color), "resign"), now, null);
  }

  /** cause：作废的原因（Result.cause），如 'replaced'（新开了人机对局）、'ai_error'。 */
  public Result abort(long now, String cause) {
    if (ended()) throw new GameError("wrong_phase", "对局已结束");
    return end(new Result(0, "abort"), now, cause);
  }

  /** cause：'clock'（读秒用完）| 'abandon'（轮到时掉线太久）。 */
  public Result timeoutLoss(int loser, long now, String cause) {
    if (ended()) throw new GameError("wrong_phase", "对局已结束");
    return end(new Result(opponent(loser), "timeout"), now, cause);
  }

  private Result end(Result r, long now, String cause) {
    if (clock != null) clock.stop(now);
    if (scoring != null && scoring.pending) scoring = null;
    if (scoring != null) scoring.deadlineAt = null;
    OpResult ok = Game.finish(state, r);
    if (!ok.ok()) throw new GameError("wrong_phase", "对局已结束");
    result = state.result;
    endedAt = now;
    endCause = cause;
    counted = computeCounted();
    uncounted = mode.equals("ranked") && !r.reason().equals("abort") && !counted ? "short" : null;
    aiThinking = false;
    version += 1;
    return result;
  }

  /** 落子数（不含 pass）。 */
  public int stoneMoves() {
    int n = 0;
    for (int mv : moves) if (mv != PASS) n += 1;
    return n;
  }

  /**
   * 计入排行的条件（设计文档 6.6）。作废的不计；认输 / 超时：总手数 ≥ 2 就计入；数子：落子数 ≥ minMovesRanked。
   * 同一对手 24 小时内计入的局数上限由管理器检查。
   */
  boolean computeCounted() {
    Result r = result;
    if (!mode.equals("ranked") || r == null || r.reason().equals("abort")) return false;
    if (r.reason().equals("score")) return stoneMoves() >= settings.minMovesRanked;
    return moves.size() >= 2;
  }

  // ---------------------------------------------------------------- 人机悔棋

  public boolean canUndo() {
    if (!isAiGame() || ended()) return false;
    return hasHumanMove();
  }

  /** 人机对局里玩家下过（或 pass 过）至少一手。 */
  public boolean hasHumanMove() {
    int human = humanColor();
    if (human == 0) return false;
    for (Move m : state.history) if (m.color() == human) return true;
    return false;
  }

  /** 撤回玩家最近一手及其后的 AI 应手（数子阶段 = 撤回 pass 回到对局）。返回撤回后的着手序列。 */
  public List<Integer> undo(int color, long now) {
    if (!isAiGame()) throw new GameError("bad_request", "只有人机对局可以悔棋");
    if (ended()) throw new GameError("wrong_phase", "对局已结束");
    if (!canUndo()) throw new GameError("nothing_to_undo", "没有可以悔的棋");
    int human = humanColor();
    for (;;) {
      Move last = state.history.get(state.history.size() - 1);
      Game.undo(state);
      moves.remove(moves.size() - 1);
      if (last.color() == human) break;
    }
    scoring = null;
    judgeSeq += 1;
    aiThinking = false;
    turnStartedAt = now;
    version += 1;
    return new ArrayList<>(moves);
  }

  // ---------------------------------------------------------------- 定时事件

  /** 当前所有待到期事件。 */
  public List<Deadline> deadlines() {
    List<Deadline> out = new ArrayList<>();
    String st = state.status;
    if (GameState.ENDED.equals(st)) return out;
    boolean human = !isAiGame();
    GameSettings set = settings;
    if (GameState.PLAYING.equals(st)) {
      if (human && moves.isEmpty() && !awaitingArrival(BLACK)) {
        out.add(new Deadline("first_move", startedAt + set.firstMoveTimeoutMs));
      }
      if (clock != null && clock.running() != 0) out.add(new Deadline("timeout", clock.timeoutAt()));
      int toPlay = state.toPlay;
      if (human && !online[toPlay]) {
        // 继续对局保护下的一方（已同意数子结果）不回来：撤销继续对局、按当时的数子结果终局（FS-11），abandonMs 后就处理
        boolean guarded = resumeGuard != null && resumeGuard.color() == toPlay;
        if (awaitingArrival(toPlay)) {
          long since = Math.max(arrival.since, turnStartedAt);
          out.add(new Deadline("abandon", since + (guarded ? set.abandonMs : set.arrivalGraceMs)));
        } else {
          // 掉线：至少等 abandonMs；基本时间还没用完就等到用完为止（掉线期间照常走钟，但不给读秒）
          long since = Math.max(offlineSince[toPlay] != null ? offlineSince[toPlay] : turnStartedAt, turnStartedAt);
          long at = since + set.abandonMs;
          if (!guarded && clock != null && clock.running() == toPlay) at = Math.max(at, clock.mainOutAt());
          out.add(new Deadline("abandon", at));
        }
      }
    } else if (GameState.SCORING.equals(st)) {
      Scoring sc = scoring;
      if (human && sc != null && !sc.pending && sc.deadlineAt != null) out.add(new Deadline("scoring", sc.deadlineAt));
    }
    if (!human) out.add(new Deadline("idle", lastActivityAt + set.aiIdleTimeoutMs));
    return out;
  }

  public Long nextDeadline() {
    Long min = null;
    for (Deadline d : deadlines()) if (min == null || d.at() < min) min = d.at();
    return min;
  }

  /** 已到期的事件（没有返回 null）。还没下第一手就超时/弃局的一律按作废处理。 */
  public String dueAction(long now) {
    List<Deadline> due = new ArrayList<>();
    for (Deadline d : deadlines()) if (d.at() <= now) due.add(d);
    if (due.isEmpty()) return null;
    due.sort(Comparator.comparingLong(Deadline::at).thenComparingInt(d -> DUE_ORDER.indexOf(d.kind())));
    String kind = due.get(0).kind();
    if ((kind.equals("timeout") || kind.equals("abandon")) && moves.isEmpty()) return "first_move";
    return kind;
  }

  /** 执行到期事件，返回终局结果。 */
  public Result applyDue(String kind, long now) {
    switch (kind) {
      case "first_move":
        // 还没下第一手：黑方没到场（开局时不在线、重启后没回来）超过宽限 → 'arrival'，否则 'first_move'
        return abort(now, awaitingArrival(state.toPlay) ? "arrival" : "first_move");
      case "idle":
        return abort(now, "idle");
      case "timeout":
        {
          int loser = clock.running();
          // 继续对局保护下的一方在走下一手之前读秒用完：不论是否在线，都撤销继续对局（FS-3）
          if (resumeGuard != null && resumeGuard.color() == loser) return undoResume(now);
          return timeoutLoss(loser, now, "clock");
        }
      case "abandon":
        {
          // 轮到的一方掉线太久：判其超时负；还没到场过、或总手数 < 2 则作废
          int loser = state.toPlay;
          if (resumeGuard != null && resumeGuard.color() == loser) return undoResume(now);
          if (awaitingArrival(loser)) return abort(now, "arrival");
          if (moves.size() < 2) return abort(now, "abandon");
          return timeoutLoss(loser, now, "abandon");
        }
      case "scoring":
        return finishAtDeadline(now, "deadline");
      default:
        throw new IllegalStateException("未知的到期事件 " + kind);
    }
  }

  // ---------------------------------------------------------------- 视图

  public Map<String, Object> clocksView(long now) {
    return clock != null ? clock.snapshot(now) : null;
  }

  public Map<String, Object> scoringView(long now) {
    Scoring sc = scoring;
    if (sc == null) return null;
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("pending", sc.pending);
    m.put("source", sc.source);
    m.put("version", sc.version);
    m.put("dead", Msg.list(sc.dead));
    m.put("owner", Msg.list(sc.owner));
    m.put("black", sc.black);
    m.put("white", sc.white);
    m.put("winner", sc.winner);
    m.put("accepted", Msg.byColor(sc.accepted[BLACK], sc.accepted[WHITE]));
    m.put("deadline", sc.deadlineAt == null || ended() ? null : Math.max(0, sc.deadlineAt - now));
    m.put("resumesLeft", isAiGame() ? null : Msg.byColor(resumesLeft(BLACK), resumesLeft(WHITE)));
    m.put("atDeadline", atDeadlineView());
    return m;
  }

  /** 时限到时会怎么终局（Scoring.atDeadline）。没有自动确认时限（人机、正在判断、已终局）为 null。 */
  private Map<String, Object> atDeadlineView() {
    Scoring sc = scoring;
    if (sc == null || sc.pending || sc.deadlineAt == null || ended() || !GameState.SCORING.equals(state.status)) return null;
    Outcome out = deadlineOutcome();
    if (out.voidCause() != null) return Msg.of("void", true, "cause", out.voidCause());
    Score.ScoreResult s = Score.scoreArea(state.board, komi, out.dead());
    return Msg.of(
        "void", false,
        "dead", Msg.list(s.dead()),
        "black", s.black(),
        "white", s.white(),
        "winner", s.winner(),
        "same", Arrays.equals(s.dead(), sc.dead));
  }

  public Map<String, Object> resultView() {
    Result r = result;
    if (r == null) return null;
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("winner", r.winner());
    m.put("reason", r.reason());
    m.put("black", r.black());
    m.put("white", r.white());
    m.put("text", Record.resultText(r));
    m.put("label", Record.resultLabel(r));
    m.put("counted", counted);
    m.put("cause", endCause);
    m.put("uncounted", counted ? null : uncounted);
    m.put("pending", savePending);
    return m;
  }

  /** players：{ "1": PlayerInfo, "2": PlayerInfo }（由管理器查用户表生成）。 */
  public Map<String, Object> snapshot(int viewerColor, long now, Map<String, Object> playersInfo) {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("id", id);
    m.put("mode", mode);
    m.put("size", size);
    m.put("komi", komi);
    m.put("players", playersInfo);
    m.put("myColor", viewerColor);
    m.put("moves", new ArrayList<>(moves));
    m.put("status", state.status);
    m.put("toPlay", state.toPlay);
    m.put("timeControl", timeControl == null ? null : tcJson(timeControl));
    m.put("clocks", clocksView(now));
    m.put("scoring", scoringView(now));
    m.put("result", resultView());
    m.put("presence", Msg.byColor(online[BLACK], online[WHITE]));
    m.put("aiThinking", aiThinking);
    m.put("canUndo", canUndo());
    return m;
  }

  static Map<String, Object> tcJson(TimeControl tc) {
    return Msg.of("mainMs", tc.mainMs(), "periods", tc.periods(), "periodMs", tc.periodMs());
  }

  // ---------------------------------------------------------------- 持久化

  public InsertRow insertRow(long now) {
    return new InsertRow(
        id,
        mode,
        size,
        komi,
        players[BLACK],
        players[WHITE],
        aiLevel,
        timeControl,
        state.status,
        new ArrayList<>(moves),
        clock != null ? clock.toJson() : null,
        createdAt,
        now);
  }

  public Progress progress() {
    return new Progress(state.status, new ArrayList<>(moves), clock != null ? clock.toJson() : null, persistState());
  }

  /** 重启后还要保留的会话状态（games.state 列）：已用的"继续对局"次数与继续对局保护。人机对局为 null。 */
  public Map<String, Object> persistState() {
    if (isAiGame()) return null;
    ResumeGuard g = resumeGuard;
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("resumesUsed", Msg.byColor(resumesUsed[BLACK], resumesUsed[WHITE]));
    m.put("guard", g == null ? null : Msg.of("color", g.color(), "movesLen", g.movesLen(), "scoring", serializeScoring(g.scoring())));
    return m;
  }

  static Map<String, Object> serializeScoring(Scoring sc) {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("source", sc.source);
    m.put("version", sc.version);
    m.put("dead", Msg.list(sc.dead));
    m.put("proposal", Msg.list(sc.proposal));
    m.put("accepted", Msg.byColor(sc.accepted[BLACK], sc.accepted[WHITE]));
    m.put("endorsed", Msg.byColor(new ArrayList<>(sc.endorsed.get(BLACK)), new ArrayList<>(sc.endorsed.get(WHITE))));
    m.put("agreed", sc.agreed != null ? Msg.list(sc.agreed.dead()) : null);
    List<List<Integer>> marks = new ArrayList<>();
    for (Map.Entry<Integer, Integer> e : sc.marks.entrySet()) marks.add(List.of(e.getKey(), e.getValue()));
    m.put("marks", marks);
    m.put("stance", Msg.byColor(sc.stance[BLACK], sc.stance[WHITE]));
    return m;
  }

  private static int[] idxList(JsonNode v) {
    if (v == null || !v.isArray()) return null;
    int[] out = new int[v.size()];
    for (int i = 0; i < out.length; i++) {
      Long n = Json.safeInt(v.get(i));
      if (n == null || n < 0 || n > Integer.MAX_VALUE) return null;
      out[i] = (int) (long) n;
    }
    return out;
  }

  /** 解析失败返回 null（坏数据只让保护失效，不影响恢复对局）。owner/点数由调用方按局面重算。 */
  static Scoring deserializeScoring(JsonNode o) {
    if (o == null || !o.isObject()) return null;
    int[] dead = idxList(o.get("dead"));
    int[] proposal = idxList(o.get("proposal"));
    Long ver = Json.safeInt(o.get("version"));
    if (dead == null || proposal == null || ver == null || ver > Integer.MAX_VALUE || ver < Integer.MIN_VALUE) return null;
    JsonNode endorsed = o.get("endorsed") != null && o.get("endorsed").isObject() ? o.get("endorsed") : null;
    JsonNode accepted = o.get("accepted") != null && o.get("accepted").isObject() ? o.get("accepted") : null;
    JsonNode stance = o.get("stance") != null && o.get("stance").isObject() ? o.get("stance") : null;
    Scoring sc = new Scoring();
    sc.pending = false;
    sc.source = "manual".equals(o.path("source").asText(null)) && o.get("source").isTextual() ? "manual" : "katago";
    sc.version = (int) (long) ver;
    sc.dead = dead;
    sc.proposal = proposal;
    for (int c = 1; c <= 2; c++) {
      String k = String.valueOf(c);
      sc.accepted[c] = accepted != null && accepted.get(k) != null && accepted.get(k).isBoolean() && accepted.get(k).booleanValue();
      JsonNode keys = endorsed == null ? null : endorsed.get(k);
      if (keys != null && keys.isArray()) {
        for (JsonNode kk : keys) if (kk.isTextual()) sc.endorsed.get(c).add(kk.textValue());
      }
      JsonNode st = stance == null ? null : stance.get(k);
      sc.stance[c] = st != null && st.isTextual() ? st.textValue() : null;
    }
    JsonNode marks = o.get("marks");
    if (marks != null && marks.isArray()) {
      for (JsonNode mk : marks) {
        if (!mk.isArray()) continue;
        Long i = Json.safeInt(mk.get(0));
        Long c = Json.safeInt(mk.get(1));
        if (i != null && i >= 0 && i <= Integer.MAX_VALUE && c != null && (c == BLACK || c == WHITE)) {
          sc.marks.put((int) (long) i, (int) (long) c);
        }
      }
    }
    int[] agreed = idxList(o.get("agreed"));
    sc.agreed = agreed != null ? new Agreed(deadKey(agreed), agreed) : null;
    return sc;
  }

  /** 从 games.state 恢复（坏数据忽略：最多是少了保护，不影响恢复对局）。 */
  void restoreState(JsonNode st) {
    if (isAiGame() || st == null || !st.isObject()) return;
    JsonNode used = st.get("resumesUsed");
    if (used != null && used.isObject()) {
      for (int c = 1; c <= 2; c++) {
        Long n = Json.safeInt(used.get(String.valueOf(c)));
        if (n != null && n >= 0 && n <= Integer.MAX_VALUE) resumesUsed[c] = (int) (long) n;
      }
    }
    JsonNode g = st.get("guard");
    if (g == null || !g.isObject() || !GameState.PLAYING.equals(state.status)) return;
    Long color = Json.safeInt(g.get("color"));
    if (color == null || (color != BLACK && color != WHITE)) return;
    Long len = Json.safeInt(g.get("movesLen"));
    // 保护点必须是这局棋里某次"双方 pass"之后
    if (len == null || len < 2 || len > moves.size()) return;
    int l = (int) (long) len;
    if (moves.get(l - 1) != PASS || moves.get(l - 2) != PASS) return;
    Scoring sc = deserializeScoring(g.get("scoring"));
    if (sc != null) resumeGuard = new ResumeGuard((int) (long) color, l, sc);
  }

  public FinishFields finishFields() {
    Result r = result;
    List<Integer> dead = r != null && r.reason().equals("score") && scoring != null ? Msg.list(scoring.dead) : null;
    return new FinishFields(
        new ArrayList<>(moves),
        dead,
        r.winner(),
        r.reason(),
        r.black(),
        r.white(),
        Record.resultText(r),
        counted,
        endCause);
  }

  // ---------------------------------------------------------------- 重放与恢复

  /**
   * 从着手序列重建局面。两次 pass 之后还有着手，说明双方曾"继续对局"，先 resume 再下。
   * （Record.replay 遇到这种序列会报错，所以这里自己实现）
   */
  public static GameState replayMoves(int size, double komi, List<Integer> moves) {
    if (moves == null) throw new IllegalArgumentException("着手序列必须是数组");
    int total = size * size;
    GameState st = Game.createGame(size, komi, false);
    for (int i = 0; i < moves.size(); i++) {
      Integer mv = moves.get(i);
      if (mv == null || mv < PASS || mv >= total) {
        throw new ReplayException("第 " + (i + 1) + " 手坐标非法：" + mv, i, null);
      }
      if (GameState.SCORING.equals(st.status)) Game.resume(st);
      OpResult r = mv == PASS ? Game.pass(st) : Game.play(st, mv);
      if (!r.ok()) throw new ReplayException("第 " + (i + 1) + " 手非法：" + r.reason(), i, r.reason());
    }
    return st;
  }

  /** 着手序列非法。 */
  public static final class ReplayException extends IllegalArgumentException {
    public final int moveIndex;
    public final String reason;

    ReplayException(String msg, int moveIndex, String reason) {
      super(msg);
      this.moveIndex = moveIndex;
      this.reason = reason;
    }
  }

  /** 从数据库记录恢复（重启后恢复未结束的对局，或为已结束的对局生成快照）。 */
  public static GameSession fromRow(GameRow row, GameSettings settings, long now) {
    if (row == null) throw new IllegalArgumentException("对局记录为空");
    boolean ai = "ai".equals(row.mode());
    GameSession s =
        new GameSession(
            row.id(),
            row.mode(),
            row.size(),
            row.komi(),
            row.blackId(),
            row.whiteId(),
            row.aiLevel(),
            ai ? null : row.timeControl(),
            settings,
            now,
            row.createdAt());
    List<Integer> mv = row.moves() == null ? List.of() : row.moves();
    s.state = replayMoves(row.size(), row.komi(), mv);
    s.moves = new ArrayList<>(mv);
    if (s.timeControl != null) s.clock = new GameClock(s.timeControl, row.clocks());

    if ("ended".equals(row.status())) {
      int winner = row.winner() != null && (row.winner() == 1 || row.winner() == 2) ? row.winner() : 0;
      String reason = row.reason() != null && !row.reason().isEmpty() ? row.reason() : "abort";
      Result result = new Result(winner, reason, row.scoreBlack(), row.scoreWhite());
      if (reason.equals("score")) {
        Score.ScoreResult sr = Score.scoreArea(s.state.board, s.komi, row.dead() != null ? Msg.ints(row.dead()) : new int[0]);
        Scoring sc = new Scoring();
        sc.pending = false;
        sc.source = "manual";
        sc.version = 1;
        sc.dead = sr.dead();
        sc.owner = sr.owner();
        sc.black = sr.black();
        sc.white = sr.white();
        sc.winner = sr.winner();
        sc.accepted[1] = true;
        sc.accepted[2] = true;
        sc.deadlineAt = null;
        sc.judgeSeq = 0;
        s.scoring = sc;
      }
      Game.finish(s.state, result);
      s.result = result;
      s.counted = row.counted();
      s.endCause = row.cause() != null && !row.cause().isEmpty() ? row.cause() : null;
      // 排位赛没计入的原因：按规则本该计入却没计入的，只能是同一对手的局数上限
      if (s.mode.equals("ranked") && !reason.equals("abort") && !row.counted()) {
        s.uncounted = s.computeCounted() ? "pair_limit" : "short";
      }
      s.endedAt = row.endedAt() != null ? row.endedAt() : row.updatedAt();
      return s;
    }

    // 未结束：两次 pass 之后如果库里是 playing，说明已"继续对局"
    if (GameState.SCORING.equals(s.state.status) && !"scoring".equals(row.status())) Game.resume(s.state);
    s.restoreState(row.state());
    s.lastActivityAt = Math.min(row.updatedAt(), now);
    s.startedAt = now;
    s.turnStartedAt = now;
    if (GameState.PLAYING.equals(s.state.status)) {
      if (s.clock != null) s.clock.start(s.state.toPlay, now); // 停机时间不计入
    } else {
      s.enterScoring(now); // 数子阶段重新请求死子建议
    }
    return s;
  }
}
