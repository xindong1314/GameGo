package com.gamego.game;

import com.gamego.ai.AiCommon;
import com.gamego.ai.AiException;
import com.gamego.ai.AiLevel;
import com.gamego.ai.AiMove;
import com.gamego.ai.AiMoveRequest;
import com.gamego.ai.AiService;
import com.gamego.ai.DeadResult;
import com.gamego.ai.FakeAiService;
import com.gamego.engine.GameState;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.function.Function;

/**
 * 管理器测试用的 AiService（对应 Node 测试的 helpers/fake-ai.js）：确定性、可以挂起请求由测试手动完成。
 *
 * <ul>
 *   <li>script：依次返回的着手（-1 为 pass），用完后按 strategy；
 *   <li>strategy："first-legal"（默认）/ "pass" / "resign" / 自定义函数；
 *   <li>manual：chooseMove 不自动完成，放进 pendingMoves 由测试 resolve/reject；failMoves：接下来这么多次直接失败；
 *   <li>dead / deadFn：judgeDead 的结果；manualJudge：放进 pendingJudges；judgeFail：失败。
 * </ul>
 */
public class TestAi implements AiService {

  public static final List<AiLevel> DEFAULT_LEVELS =
      List.of(new AiLevel("k10", "10级", "入门"), new AiLevel("k5", "5级", "初级"), new AiLevel("d1", "1段", "中级"));

  public record Pending<T>(Object req, CompletableFuture<T> future) {}

  public record JudgeCall(int size, double komi, List<Integer> moves) {}

  public boolean available = true;
  public List<AiLevel> levels = DEFAULT_LEVELS;
  public final Deque<Integer> script = new ArrayDeque<>();
  public String strategy = "first-legal";
  public Function<AiMoveRequest, AiMove> strategyFn = null;
  public boolean passWhenHumanPassed = true;
  public boolean manual = false;
  public int failMoves = 0;
  public Function<JudgeCall, int[]> dead = c -> new int[0];
  /** judgeDead 返回 null 结果（格式不对）。 */
  public boolean badJudge = false;
  public boolean manualJudge = false;
  public boolean judgeFail = false;

  public final List<AiMoveRequest> chooseMoveCalls = new ArrayList<>();
  public final List<JudgeCall> judgeDeadCalls = new ArrayList<>();
  public final List<Pending<AiMove>> pendingMoves = new ArrayList<>();
  public final List<Pending<DeadResult>> pendingJudges = new ArrayList<>();

  public TestAi dead(int... d) {
    int[] copy = d.clone();
    dead = c -> copy.clone();
    return this;
  }

  public TestAi script(int... moves) {
    script.clear();
    for (int m : moves) script.add(m);
    return this;
  }

  AiMove compute(AiMoveRequest req) {
    if (!script.isEmpty()) return AiMove.of(script.poll());
    if (strategyFn != null) return strategyFn.apply(req);
    if (strategy.equals("resign")) return AiMove.resignMove();
    if (passWhenHumanPassed && req.humanJustPassed()) return AiMove.pass();
    if (strategy.equals("pass")) return AiMove.pass();
    GameState s = AiCommon.replayMoves(req.size(), req.komi(), req.moves());
    return AiMove.of(FakeAiService.firstReasonableMove(s, req.color()));
  }

  @Override
  public boolean available() {
    return available;
  }

  @Override
  public List<AiLevel> levels() {
    return new ArrayList<>(levels);
  }

  @Override
  public CompletableFuture<AiMove> chooseMove(AiMoveRequest req) {
    chooseMoveCalls.add(req);
    if (manual) {
      CompletableFuture<AiMove> f = new CompletableFuture<>();
      pendingMoves.add(new Pending<>(req, f));
      return f;
    }
    if (failMoves > 0) {
      failMoves -= 1;
      return CompletableFuture.failedFuture(new AiException(AiException.KATAGO_ERROR, "fake-ai: 模拟落子失败"));
    }
    try {
      return CompletableFuture.completedFuture(compute(req));
    } catch (RuntimeException e) {
      return CompletableFuture.failedFuture(e);
    }
  }

  @Override
  public CompletableFuture<DeadResult> judgeDead(int size, double komi, int[] moves) {
    JudgeCall call = new JudgeCall(size, komi, Msg.list(moves));
    judgeDeadCalls.add(call);
    if (manualJudge) {
      CompletableFuture<DeadResult> f = new CompletableFuture<>();
      pendingJudges.add(new Pending<>(call, f));
      return f;
    }
    if (judgeFail) return CompletableFuture.failedFuture(new AiException(AiException.KATAGO_ERROR, "fake-ai: 模拟死子判断失败"));
    if (badJudge) return CompletableFuture.completedFuture(new DeadResult(null, "katago"));
    return CompletableFuture.completedFuture(new DeadResult(dead.apply(call), DeadResult.SOURCE_KATAGO));
  }

  @Override
  public void shutdown() {}

  @Override
  public String kind() {
    return "test";
  }

  /** 完成最早一个挂起的 chooseMove（result 为 null 时按 strategy 计算）。 */
  public void resolveNextMove(AiMove result) {
    if (pendingMoves.isEmpty()) throw new AssertionError("fake-ai: 没有挂起的 chooseMove");
    Pending<AiMove> p = pendingMoves.remove(0);
    p.future().complete(result != null ? result : compute((AiMoveRequest) p.req()));
  }

  public void resolveNextMove() {
    resolveNextMove(null);
  }

  public void rejectNextMove() {
    if (pendingMoves.isEmpty()) throw new AssertionError("fake-ai: 没有挂起的 chooseMove");
    pendingMoves.remove(0).future().completeExceptionally(new AiException(AiException.KATAGO_ERROR, "fake-ai: 模拟落子失败"));
  }

  public void resolveNextJudge(int... dead) {
    if (pendingJudges.isEmpty()) throw new AssertionError("fake-ai: 没有挂起的 judgeDead");
    pendingJudges.remove(0).future().complete(new DeadResult(dead.clone(), DeadResult.SOURCE_KATAGO));
  }

  public void rejectNextJudge() {
    if (pendingJudges.isEmpty()) throw new AssertionError("fake-ai: 没有挂起的 judgeDead");
    pendingJudges.remove(0).future().completeExceptionally(new AiException(AiException.KATAGO_ERROR, "fake-ai: 模拟死子判断失败"));
  }
}
