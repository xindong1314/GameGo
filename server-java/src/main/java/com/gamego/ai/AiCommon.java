package com.gamego.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.gamego.engine.Board;
import com.gamego.engine.Coords;
import com.gamego.engine.Game;
import com.gamego.engine.GameState;
import com.gamego.engine.Go;
import com.gamego.engine.OpResult;
import com.gamego.engine.Rules;
import com.gamego.engine.Score;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * AI 模块内部共用（移植自 server/src/ai/common.js）：参数校验、按着手序列重建局面、坐标换算、视角换算、按块判死。
 * 规则一律以本项目引擎（com.gamego.engine）为准（KataGo 对传入的 moves 很宽容，合法性只能由我们保证）。
 */
public final class AiCommon {
  private AiCommon() {}

  public static final int BLACK = Go.BLACK;
  public static final int WHITE = Go.WHITE;
  public static final int EMPTY = Go.EMPTY;
  public static final int PASS = Go.PASS;

  public static final List<Integer> SIZES = List.of(9, 13, 19);
  /** 远超任何正常对局；只是防止异常请求。 */
  public static final int MAX_MOVES = 2000;

  public static final double MAX_ABS_KOMI = 150;
  public static final long DEFAULT_MIN_THINK_MS = 600;

  /** 全模块共用的 Jackson ObjectMapper（线程安全）。 */
  public static final ObjectMapper JSON = new ObjectMapper();

  /** 校验并重放后的局面。state 为本项目引擎的对局状态（board、ko、toPlay、status）。 */
  public record Position(int size, double komi, int[] moves, GameState state) {}

  /** 校验后的 chooseMove 参数。 */
  public record Parsed(
      int size, double komi, int[] moves, GameState state, int color, String level, boolean humanJustPassed) {
    public Board board() {
      return state.board;
    }
  }

  static void checkSize(int size) {
    if (!SIZES.contains(size)) throw AiException.badRequest("不支持的路数：" + size + "（只支持 9/13/19）");
  }

  /** KataGo 只接受整数或半整数贴目。 */
  static void checkKomi(double komi) {
    if (!Double.isFinite(komi) || Math.abs(komi) > MAX_ABS_KOMI || komi * 2 != Math.rint(komi * 2)) {
      throw AiException.badRequest("贴目不合法：" + fmt(komi));
    }
  }

  static void checkMovesShape(int[] moves, int size) {
    if (moves == null) throw AiException.badRequest("moves 必须是数组");
    if (moves.length > MAX_MOVES) throw AiException.badRequest("着手过多（" + moves.length + "）");
    int total = size * size;
    for (int i = 0; i < moves.length; i++) {
      int mv = moves[i];
      if (mv < PASS || mv >= total) throw AiException.badRequest("第 " + (i + 1) + " 手不是合法的坐标：" + mv);
    }
  }

  /**
   * 按着手序列重建局面。与服务端对局一致：两次 pass 进入数子阶段后若还有着手（继续对局），先 resume。
   * 非法着手抛 bad_request（"第 N 手非法：reason"）。
   */
  public static GameState replayMoves(int size, double komi, int[] moves) {
    GameState state = Game.createGame(size, komi, false);
    for (int i = 0; i < moves.length; i++) {
      if (GameState.SCORING.equals(state.status)) Game.resume(state);
      int mv = moves[i];
      OpResult r = mv == PASS ? Game.pass(state) : Game.play(state, mv);
      if (!r.ok()) throw AiException.badRequest("第 " + (i + 1) + " 手非法：" + r.reason());
    }
    return state;
  }

  /** 黑先、轮流：已下 k 手时轮到的一方。 */
  public static int colorToMove(int moveCount) {
    return moveCount % 2 == 0 ? BLACK : WHITE;
  }

  /** 校验 { size, komi, moves } 并重放。 */
  public static Position parseBoardRequest(int size, double komi, int[] moves) {
    checkSize(size);
    checkKomi(komi);
    checkMovesShape(moves, size);
    int[] copy = moves.clone();
    GameState state = replayMoves(size, komi, copy);
    return new Position(size, komi, copy, state);
  }

  /** 校验 chooseMove 的参数；levelIds 为允许的难度 id 集合。 */
  public static Parsed parseMoveRequest(AiMoveRequest req, Set<String> levelIds) {
    if (req == null) throw AiException.badRequest("请求必须是对象");
    Position b = parseBoardRequest(req.size(), req.komi(), req.moves());
    if (req.level() == null || !levelIds.contains(req.level())) {
      throw AiException.badRequest("未知的难度：" + req.level());
    }
    if (req.color() != BLACK && req.color() != WHITE) {
      throw AiException.badRequest("color 必须是 1（黑）或 2（白）：" + req.color());
    }
    int toMove = colorToMove(b.moves().length);
    if (req.color() != toMove) {
      throw AiException.badRequest(
          "现在轮到" + (toMove == BLACK ? "黑" : "白") + "方，不是 AI（color=" + req.color() + "）");
    }
    return new Parsed(b.size(), b.komi(), b.moves(), b.state(), req.color(), req.level(), req.humanJustPassed());
  }

  /** 着手序列 → KataGo 的 moves：[["B","Q16"],["W","pass"],...]（必须黑白交替，pass 也要写）。 */
  public static ArrayNode toKataMoves(int[] moves, int size) {
    ArrayNode arr = JSON.createArrayNode();
    for (int i = 0; i < moves.length; i++) {
      arr.addArray().add(i % 2 == 0 ? "B" : "W").add(Coords.idxToGtp(moves[i], size));
    }
    return arr;
  }

  /** KataGo 返回的坐标（"Q16" / "pass"）→ idx / PASS；无法解析返回 null。 */
  public static Integer parseKataMove(String str, int size) {
    if (str == null) return null;
    try {
      return Coords.gtpToIdx(str, size);
    } catch (RuntimeException e) {
      return null;
    }
  }

  public static boolean isLegal(GameState state, int color, int idx) {
    int n = state.board.n;
    if (idx < 0 || idx >= n * n) return false;
    return Rules.canPlay(state.board, color, state.ko, idx).ok();
  }

  /** JSON 里的有限数值；不是数值（或 NaN / 无穷）时返回 NaN。 */
  static double num(JsonNode node) {
    if (node == null || !node.isNumber()) return Double.NaN;
    double v = node.asDouble();
    return Double.isFinite(v) ? v : Double.NaN;
  }

  /** rootInfo（reportAnalysisWinratesAs = BLACK，黑方视角）→ AI 视角的评估；格式不对返回 null。 */
  public static AiMoveInfo infoForColor(JsonNode rootInfo, int color) {
    if (rootInfo == null || !rootInfo.isObject()) return null;
    double wr = num(rootInfo.get("winrate"));
    double lead = num(rootInfo.get("scoreLead"));
    if (Double.isNaN(wr) || Double.isNaN(lead)) return null;
    boolean black = color == BLACK;
    double visits = num(rootInfo.get("visits"));
    return new AiMoveInfo(
        black ? wr : 1 - wr, black ? lead : 0.0 - lead, Double.isNaN(visits) ? 0 : (int) visits); // 0.0 - x 不会产生 -0
  }

  /** ownership 是否为长 n 的有限数值数组；是则返回 double[]，否则 null。 */
  public static double[] validOwnership(JsonNode own, int n) {
    if (own == null || !own.isArray() || own.size() != n) return null;
    double[] out = new double[n];
    for (int i = 0; i < n; i++) {
      double v = num(own.get(i));
      if (Double.isNaN(v)) return null;
      out[i] = v;
    }
    return out;
  }

  /** 按"块"（同色连通块）取归属平均值：本方视角 &lt;= -threshold 的整块判死（设计文档 7.3）。返回升序 idx。 */
  public static int[] deadFromOwnership(Board board, double[] ownership, double threshold) {
    int total = board.n * board.n;
    boolean[] seen = new boolean[total];
    List<Integer> dead = new ArrayList<>();
    for (int i = 0; i < total; i++) {
      int c = board.get(i);
      if (c == EMPTY || seen[i]) continue;
      Board.Group g = board.group(i);
      double sum = 0;
      for (int s : g.stones()) {
        seen[s] = true;
        sum += ownership[s];
      }
      double avg = sum / g.stones().length;
      double own = c == BLACK ? avg : -avg;
      if (own <= -threshold) for (int s : g.stones()) dead.add(s);
    }
    int[] out = dead.stream().mapToInt(Integer::intValue).toArray();
    Arrays.sort(out);
    return out;
  }

  public static int[] deadFromOwnership(Board board, double[] ownership) {
    return deadFromOwnership(board, ownership, 0.5);
  }

  /** 假设现在就终局：死子按归属判定（与 judgeDead 同一规则），按数子法计分，返回 color 一方视角的目差（已含贴目）。 */
  public static double areaMarginIfEnded(Board board, double komi, double[] ownership, int color) {
    int[] dead = deadFromOwnership(board, ownership);
    Score.ScoreResult s = Score.scoreArea(board, komi, dead);
    return color == BLACK ? s.black() - s.white() : s.white() - s.black();
  }

  public static long resolveMinThinkMs(Long v) {
    if (v == null) return DEFAULT_MIN_THINK_MS;
    if (v < 0) throw new IllegalArgumentException("aiMinThinkMs 必须是非负数：" + v);
    return v;
  }

  /** 异步等待（可注入，测试里记录而不真的等）。 */
  @FunctionalInterface
  public interface Sleeper {
    CompletableFuture<Void> sleep(long ms);

    Sleeper REAL =
        ms -> CompletableFuture.runAsync(() -> {}, CompletableFuture.delayedExecutor(ms, TimeUnit.MILLISECONDS));
  }

  /** 让 AI 至少"想" minMs 毫秒再落子，避免秒下（阻塞调用线程）。 */
  static void waitMinThink(long startedAt, long minMs, java.util.function.LongSupplier now, Sleeper sleeper) {
    long left = minMs - (now.getAsLong() - startedAt);
    if (left > 0) sleeper.sleep(left).join();
  }

  /** 在 executor 上执行 work；future 以 work 抛出的异常（已解包）完成，不包 CompletionException。 */
  static <T> CompletableFuture<T> async(Executor executor, Callable<T> work) {
    CompletableFuture<T> f = new CompletableFuture<>();
    try {
      executor.execute(
          () -> {
            try {
              f.complete(work.call());
            } catch (Throwable t) {
              f.completeExceptionally(AiException.unwrap(t));
            }
          });
    } catch (RejectedExecutionException e) {
      f.completeExceptionally(AiException.unavailable("AI 已关闭"));
    }
    return f;
  }

  /** 阻塞等待 future，把异常解包后原样抛出（RuntimeException）。 */
  static <T> T await(CompletableFuture<T> f) {
    try {
      return f.join();
    } catch (java.util.concurrent.CompletionException | java.util.concurrent.CancellationException e) {
      Throwable c = AiException.unwrap(e);
      if (c instanceof RuntimeException re) throw re;
      throw new AiException(AiException.KATAGO_ERROR, String.valueOf(c.getMessage()));
    }
  }

  static <T> CompletableFuture<T> failed(Throwable t) {
    return CompletableFuture.failedFuture(t);
  }

  /** 守护线程的缓存线程池（空闲 60 秒回收）。 */
  static ExecutorService daemonPool(String prefix) {
    AtomicInteger seq = new AtomicInteger();
    ThreadFactory tf =
        r -> {
          Thread t = new Thread(r, prefix + seq.incrementAndGet());
          t.setDaemon(true);
          return t;
        };
    return Executors.newCachedThreadPool(tf);
  }

  static String fmt(double v) {
    if (v == Math.rint(v) && Math.abs(v) < 1e15) return String.valueOf((long) v);
    return String.valueOf(v);
  }
}
