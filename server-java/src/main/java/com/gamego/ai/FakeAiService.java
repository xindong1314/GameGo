package com.gamego.ai;

import static com.gamego.ai.AiCommon.EMPTY;
import static com.gamego.ai.AiCommon.PASS;

import com.gamego.engine.GameState;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.function.BiFunction;

/**
 * 测试替身（设计文档 7.2，移植自 server/src/ai/fake.js 的 createFakeAiService）：与 AiService 同接口、确定性、
 * 不需要 KataGo，给其他模块（对局管理、WebSocket 等）的测试用。
 *
 * <ul>
 *   <li>默认落子：第一个合法且不填己方单点眼的点；humanJustPassed 时 pass（{@link #passWhenHumanPassed}）；
 *   <li>参数校验与真实服务一致（非法参数以 AiException(bad_request) 失败）；
 *   <li>调用记录：{@link #chooseMoveCalls()} / {@link #judgeDeadCalls()}；各 setter 随时修改行为。
 * </ul>
 *
 * 所有 setter 返回 this，便于链式配置：{@code new FakeAiService().resign(true).delayMs(50)}。
 */
public class FakeAiService implements AiService {
  /** judgeDead 的一次调用记录。 */
  public record JudgeCall(int size, double komi, int[] moves) {}

  private volatile boolean available = true;
  private volatile List<AiLevel> levels = Levels.publicLevels();
  private volatile BiFunction<AiMoveRequest, GameState, AiMove> move;
  private volatile boolean resign;
  private volatile boolean passWhenHumanPassed = true;
  private volatile BiFunction<JudgeCall, GameState, int[]> dead = (c, s) -> new int[0];
  private volatile boolean judgeFail;
  private volatile long delayMs;
  private volatile boolean closed;
  private final List<AiMoveRequest> chooseMoveCalls = new CopyOnWriteArrayList<>();
  private final List<JudgeCall> judgeDeadCalls = new CopyOnWriteArrayList<>();

  // ---------- 配置 ----------

  /** available() 的返回值（默认 true）；false 时请求以 ai_unavailable 失败。 */
  public FakeAiService available(boolean v) {
    available = v;
    return this;
  }

  /** 难度表（默认与真实难度表相同）；chooseMove 只接受这些 id。 */
  public FakeAiService levels(List<AiLevel> v) {
    levels = List.copyOf(v);
    return this;
  }

  /** 自定义落子：(请求, 重放后的局面) → AiMove；null 恢复默认。 */
  public FakeAiService move(BiFunction<AiMoveRequest, GameState, AiMove> v) {
    move = v;
    return this;
  }

  /** chooseMove 一律认输。 */
  public FakeAiService resign(boolean v) {
    resign = v;
    return this;
  }

  /** humanJustPassed 时 pass（默认 true）。 */
  public FakeAiService passWhenHumanPassed(boolean v) {
    passWhenHumanPassed = v;
    return this;
  }

  /** judgeDead 的固定结果（默认空）。 */
  public FakeAiService dead(int... v) {
    int[] copy = v.clone();
    dead = (c, s) -> copy.clone();
    return this;
  }

  /** judgeDead 的结果按调用计算。 */
  public FakeAiService deadFn(BiFunction<JudgeCall, GameState, int[]> v) {
    dead = v;
    return this;
  }

  /** judgeDead 以 katago_error 失败。 */
  public FakeAiService judgeFail(boolean v) {
    judgeFail = v;
    return this;
  }

  /** 每次调用前等待的毫秒数（异步，不阻塞调用线程）。 */
  public FakeAiService delayMs(long v) {
    delayMs = v;
    return this;
  }

  public List<AiMoveRequest> chooseMoveCalls() {
    return Collections.unmodifiableList(chooseMoveCalls);
  }

  public List<JudgeCall> judgeDeadCalls() {
    return Collections.unmodifiableList(judgeDeadCalls);
  }

  // ---------- AiService ----------

  @Override
  public String kind() {
    return "fake";
  }

  @Override
  public boolean available() {
    return !closed && available;
  }

  @Override
  public List<AiLevel> levels() {
    return new ArrayList<>(levels);
  }

  /** 第一个合法、且不填己方单点眼的点；没有就 pass。 */
  public static int firstReasonableMove(GameState state, int color) {
    int n = state.board.n;
    for (int idx = 0; idx < n * n; idx++) {
      if (state.board.get(idx) != EMPTY) continue;
      if (FallbackAiService.isOwnEye(state.board, idx, color)) continue;
      if (AiCommon.isLegal(state, color, idx)) return idx;
    }
    return PASS;
  }

  private <T> CompletableFuture<T> delayed(java.util.concurrent.Callable<T> work) {
    long d = delayMs;
    java.util.concurrent.Executor ex =
        d > 0 ? CompletableFuture.delayedExecutor(d, TimeUnit.MILLISECONDS) : Runnable::run;
    return AiCommon.async(ex, work);
  }

  @Override
  public CompletableFuture<AiMove> chooseMove(AiMoveRequest req) {
    if (req != null) chooseMoveCalls.add(new AiMoveRequest(req.size(), req.komi(), req.moves() == null ? null : req.moves().clone(), req.color(), req.level(), req.humanJustPassed()));
    AiCommon.Parsed p;
    try {
      Set<String> ids = new LinkedHashSet<>();
      for (AiLevel l : levels) ids.add(l.id());
      p = AiCommon.parseMoveRequest(req, ids);
      if (!available()) throw AiException.unavailable(null);
    } catch (AiException e) {
      return CompletableFuture.failedFuture(e);
    }
    return delayed(
        () -> {
          BiFunction<AiMoveRequest, GameState, AiMove> custom = move;
          if (custom != null) return custom.apply(req, p.state());
          if (resign) return AiMove.resignMove();
          if (passWhenHumanPassed && p.humanJustPassed()) return AiMove.pass();
          return new AiMove(firstReasonableMove(p.state(), p.color()), false, new AiMoveInfo(0.5, 0, 1));
        });
  }

  @Override
  public CompletableFuture<DeadResult> judgeDead(int size, double komi, int[] moves) {
    JudgeCall call = new JudgeCall(size, komi, moves == null ? null : moves.clone());
    judgeDeadCalls.add(call);
    AiCommon.Position p;
    try {
      p = AiCommon.parseBoardRequest(size, komi, moves);
      if (!available()) throw AiException.unavailable(null);
    } catch (AiException e) {
      return CompletableFuture.failedFuture(e);
    }
    return delayed(
        () -> {
          if (judgeFail) throw new AiException(AiException.KATAGO_ERROR, "fake-ai：模拟死子判断失败");
          return new DeadResult(dead.apply(call, p.state()), DeadResult.SOURCE_KATAGO);
        });
  }

  @Override
  public void shutdown() {
    closed = true;
  }
}
