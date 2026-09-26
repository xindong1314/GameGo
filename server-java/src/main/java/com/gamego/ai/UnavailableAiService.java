package com.gamego.ai;

import java.util.List;
import java.util.concurrent.CompletableFuture;

/** 未配置 KataGo 且未开启 aiFallback 时的 AiService：available() = false，levels() = []，请求一律 ai_unavailable。 */
public class UnavailableAiService implements AiService {
  private static final String MSG = "未配置 KataGo，AI 不可用";

  @Override
  public boolean available() {
    return false;
  }

  @Override
  public List<AiLevel> levels() {
    return List.of();
  }

  @Override
  public CompletableFuture<AiMove> chooseMove(AiMoveRequest req) {
    return CompletableFuture.failedFuture(AiException.unavailable(MSG));
  }

  @Override
  public CompletableFuture<DeadResult> judgeDead(int size, double komi, int[] moves) {
    return CompletableFuture.failedFuture(AiException.unavailable(MSG));
  }

  @Override
  public void shutdown() {}

  @Override
  public String kind() {
    return "none";
  }
}
