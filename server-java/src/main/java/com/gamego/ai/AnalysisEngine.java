package com.gamego.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.concurrent.CompletableFuture;

/**
 * KataGo 分析引擎的抽象（{@link KataGoEngine} 为真实实现；测试里用模拟响应的替身）。
 * 所有 future 失败时以 {@link AiException} 完成。
 */
public interface AnalysisEngine {
  /** 未关闭且没有因为反复启动失败而放弃。启动中 / 重启退避中也算可用。 */
  boolean available();

  /** 提前启动（已就绪时立即完成）。失败只说明这次启动失败，之后仍会自动重试。 */
  CompletableFuture<Void> start();

  /**
   * 发一个请求（分析请求或 action）。id 由引擎分配，request 本身不会被修改。
   *
   * @param timeoutMs 超时（毫秒，含排队等待就绪的时间）；&lt;= 0 时用默认值
   */
  CompletableFuture<JsonNode> query(ObjectNode request, long timeoutMs);

  /** 关闭；可重复调用（返回同一个 future）。 */
  CompletableFuture<Void> shutdown();
}
