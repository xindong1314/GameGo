package com.gamego.ai;

import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * AI 服务（设计文档 7.1，对应 Node 版 server/src/ai/service.js 的 AiService）。
 *
 * <p>所有异步方法失败时以 {@link AiException} 异常完成（错误码 bad_request / ai_unavailable / katago_error / timeout），
 * 不会同步抛出。实现：{@link KataGoAiService}、{@link FallbackAiService}、{@link UnavailableAiService}、
 * {@link FakeAiService}（测试替身）。
 */
public interface AiService {
  /** 当前能否接受请求。KataGo 启动中 / 崩溃重启中仍为 true（请求排队）；连续启动失败后为 false，恢复后自动变回 true。 */
  boolean available();

  /** 难度列表（只含 id、name、desc）。未配置 AI 时为空。 */
  List<AiLevel> levels();

  /** 为 req.color 一方选一手棋。winrate / scoreLead 已换算为 AI 视角。 */
  CompletableFuture<AiMove> chooseMove(AiMoveRequest req);

  /** 终局死子判断（完整着手序列，含最后两次 pass）。失败时异常完成。 */
  CompletableFuture<DeadResult> judgeDead(int size, double komi, int[] moves);

  /** 关闭（阻塞到 KataGo 进程退出，最多几秒）。之后 available() 为 false，请求一律失败。可重复调用。 */
  void shutdown();

  /** 实现种类："katago" / "fallback" / "none" / "fake"。 */
  String kind();
}
