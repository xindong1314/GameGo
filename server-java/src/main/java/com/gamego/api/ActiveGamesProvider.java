package com.gamego.api;

import java.util.List;
import java.util.Map;

/**
 * 某用户进行中的对局（由对局模块 com.gamego.game 实现，对应 Node 版 realtime.activeGamesOf）。
 *
 * <p>{@code GET /api/me} 用它生成 {@code activeGameIds}；抛出的异常只记日志，不影响接口返回。
 * 没有实现时使用默认实现（返回空列表），见 {@link ApiDefaultsAutoConfiguration}。
 */
public interface ActiveGamesProvider {
  /**
   * @param userId 用户 id
   * @return 每项至少包含 {@code "id"}（String，对局 id）与 {@code "mode"}（"ranked" | "friend" | "ai"）
   */
  List<Map<String, Object>> activeGamesOf(long userId);
}
