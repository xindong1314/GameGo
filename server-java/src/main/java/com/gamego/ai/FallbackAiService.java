package com.gamego.ai;

import static com.gamego.ai.AiCommon.EMPTY;
import static com.gamego.ai.AiCommon.PASS;

import com.gamego.engine.Board;
import com.gamego.engine.Game;
import com.gamego.engine.GameState;
import com.gamego.engine.Rules;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ThreadLocalRandom;
import java.util.function.DoubleSupplier;
import java.util.function.LongSupplier;

/**
 * 内置练习 AI（aiFallback 开启且未配置 KataGo 时使用，只供开发联调；移植自 server/src/ai/fallback.js）：
 *
 * <ul>
 *   <li>能提子就提（提得最多的优先）；
 *   <li>否则在"合理"的点里随机落子：合法、不填自己的单点眼、不自己送吃（落子后只剩一口气且没提子）；
 *   <li>不下会让棋盘回到之前出现过的局面的着手（规则只禁简单劫，但这样可以避免在多劫循环里无休止地来回提）；
 *   <li>没有合理的点，或者对方刚 pass 且没有可提的子 → pass；
 *   <li>从不认输；judgeDead 直接失败（数子阶段走手动）。
 * </ul>
 */
public class FallbackAiService implements AiService {
  public static final AiLevel BASIC_LEVEL =
      new AiLevel("basic", "内置练习 AI", "服务器未配置 KataGo 时的内置 AI：随机落子，只会提子和不填眼，仅供开发测试");

  /** 也接受 KataGo 难度的 id：去掉 KataGo 配置后，之前开的人机对局仍能继续。 */
  static final Set<String> ACCEPTED_LEVELS;

  static {
    Set<String> s = new LinkedHashSet<>();
    s.add(BASIC_LEVEL.id());
    s.addAll(Levels.LEVEL_IDS);
    ACCEPTED_LEVELS = java.util.Collections.unmodifiableSet(s);
  }

  private final DoubleSupplier rng;
  private final AiCommon.Sleeper sleeper;
  private final LongSupplier now;
  private final long minThinkMs;
  private final ExecutorService executor = AiCommon.daemonPool("ai-fallback-");
  private volatile boolean closed;

  public FallbackAiService(Long minThinkMs, AiLog log) {
    this(minThinkMs, log, () -> ThreadLocalRandom.current().nextDouble(), AiCommon.Sleeper.REAL, System::currentTimeMillis);
  }

  public FallbackAiService(
      Long minThinkMs, AiLog log, DoubleSupplier rng, AiCommon.Sleeper sleeper, LongSupplier now) {
    this.minThinkMs = AiCommon.resolveMinThinkMs(minThinkMs);
    this.rng = rng;
    this.sleeper = sleeper;
    this.now = now;
    (log == null ? AiLog.SILENT : log).info("使用内置练习 AI（aiFallback），仅供开发测试");
  }

  static boolean isOwnEye(Board board, int idx, int color) {
    for (int nb : board.neighbors(idx)) if (board.get(nb) != color) return false;
    return true;
  }

  static String positionKey(Board board) {
    char[] c = new char[board.cells.length];
    for (int i = 0; i < c.length; i++) c[i] = (char) ('0' + board.cells[i]);
    return new String(c);
  }

  /** 按着手序列重放，记下每一手之后的局面（含开局空盘）。 */
  static Set<String> positionHistory(int size, double komi, int[] moves) {
    GameState state = Game.createGame(size, komi, false);
    Set<String> seen = new HashSet<>();
    seen.add(positionKey(state.board));
    for (int mv : moves) {
      if (GameState.SCORING.equals(state.status)) Game.resume(state);
      if (mv == PASS) Game.pass(state);
      else Game.play(state, mv);
      seen.add(positionKey(state.board));
    }
    return seen;
  }

  /** 返回 idx 或 PASS。seen：之前出现过的局面（positionKey），可为 null。 */
  static int chooseFallbackMove(
      Board board, int color, Integer ko, boolean humanJustPassed, DoubleSupplier rng, Set<String> seen) {
    int total = board.n * board.n;
    List<int[]> captures = new ArrayList<>(); // {idx, count}
    List<Integer> normal = new ArrayList<>();
    for (int idx = 0; idx < total; idx++) {
      if (board.get(idx) != EMPTY || isOwnEye(board, idx, color)) continue;
      Board b = board.copy();
      Rules.PlayResult r = Rules.tryPlay(b, color, ko, idx);
      if (!r.ok()) continue;
      if (seen != null && seen.contains(positionKey(b))) continue; // 回到以前的局面
      if (r.captured().length > 0) {
        captures.add(new int[] {idx, r.captured().length});
        continue;
      }
      if (b.group(idx).liberties().length <= 1) continue; // 自己送吃
      normal.add(idx);
    }
    if (!captures.isEmpty()) {
      int most = 0;
      for (int[] c : captures) most = Math.max(most, c[1]);
      List<Integer> best = new ArrayList<>();
      for (int[] c : captures) if (c[1] == most) best.add(c[0]);
      return best.get((int) Math.floor(rng.getAsDouble() * best.size()));
    }
    if (humanJustPassed || normal.isEmpty()) return PASS;
    return normal.get((int) Math.floor(rng.getAsDouble() * normal.size()));
  }

  @Override
  public String kind() {
    return "fallback";
  }

  @Override
  public boolean available() {
    return !closed;
  }

  @Override
  public List<AiLevel> levels() {
    return List.of(BASIC_LEVEL);
  }

  @Override
  public CompletableFuture<AiMove> chooseMove(AiMoveRequest req) {
    return AiCommon.async(
        executor,
        () -> {
          long startedAt = now.getAsLong();
          AiCommon.Parsed p = AiCommon.parseMoveRequest(req, ACCEPTED_LEVELS);
          if (closed) throw AiException.unavailable("AI 已关闭");
          Set<String> seen = positionHistory(p.size(), p.komi(), p.moves());
          int move = chooseFallbackMove(p.board(), p.color(), p.state().ko, p.humanJustPassed(), rng, seen);
          AiCommon.waitMinThink(startedAt, minThinkMs, now, sleeper);
          return new AiMove(move, false, null);
        });
  }

  @Override
  public CompletableFuture<DeadResult> judgeDead(int size, double komi, int[] moves) {
    return CompletableFuture.failedFuture(AiException.unavailable("内置练习 AI 不能判断死子"));
  }

  @Override
  public void shutdown() {
    closed = true;
    executor.shutdown();
  }
}
