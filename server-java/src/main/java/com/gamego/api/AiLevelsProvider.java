package com.gamego.api;

import java.util.List;
import java.util.Map;

/**
 * AI 是否可用与难度表（由 AI 模块 com.gamego.ai 实现，对应 Node 版 AiService.available()/levels()）。
 *
 * <p>用于 {@code GET /api/ai/levels} 与棋谱里 AI 难度的显示名（GameSummary.opponent.levelName、
 * PlayerInfo.nickname）。没有实现时使用默认实现（不可用、空列表），见 {@link ApiDefaultsAutoConfiguration}。
 */
public interface AiLevelsProvider {
  /** AI 当前是否可用。 */
  boolean available();

  /**
   * 难度表，每项包含 {@code "id"}、{@code "name"}、{@code "desc"}（都按字符串输出；name 缺省为 id，desc 缺省为空串）。
   */
  List<Map<String, Object>> levels();
}
