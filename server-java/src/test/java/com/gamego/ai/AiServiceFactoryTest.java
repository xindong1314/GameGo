package com.gamego.ai;

import static com.gamego.ai.TestUtil.code;
import static com.gamego.ai.TestUtil.waitFor;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.gamego.api.AiLevelsProvider;
import com.gamego.config.GameGoProperties;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

/** 按配置选择实现（移植自 service.test.js 的 "createAiService 按配置选择实现"）与 Spring 配置 / AiLevelsProvider 适配。 */
class AiServiceFactoryTest {
  static AiMoveRequest req() {
    return new AiMoveRequest(9, 7.5, new int[] {40}, 2, "k8", false);
  }

  @Test
  void picksImplementationByConfig() {
    AiService none = AiServiceFactory.create(new AiServiceFactory.Settings(null, null, null, false, null, null), AiLog.SILENT);
    assertEquals("none", none.kind());
    assertFalse(none.available());
    assertEquals(List.of(), none.levels());
    assertEquals("ai_unavailable", code(none.chooseMove(req())));
    assertEquals("ai_unavailable", code(none.judgeDead(9, 7.5, new int[0])));
    none.shutdown();

    AiService fb = AiServiceFactory.create(new AiServiceFactory.Settings("", "m", "c", true, 0L, null), AiLog.SILENT);
    assertEquals("fallback", fb.kind(), "KataGo 三项不全 → 不算配置了 KataGo");
    assertTrue(fb.available());
    assertEquals(List.of("basic"), fb.levels().stream().map(AiLevel::id).toList());
    fb.shutdown();

    // 配置了 KataGo 但可执行文件不存在：不抛错、不崩溃，很快变为不可用；难度表照常列出
    CaptureLog log = new CaptureLog();
    AiService kg =
        AiServiceFactory.create(
            new AiServiceFactory.Settings("fixtures/missing-katago.exe", "m.bin.gz", "a.cfg", true, 0L, null), log);
    try {
      assertEquals("katago", kg.kind());
      assertEquals(8, kg.levels().size());
      waitFor(() -> !kg.available(), 5000, "KataGo 标记为不可用");
      assertEquals("ai_unavailable", code(kg.chooseMove(req())));
      waitFor(() -> CaptureLog.any(log.warn, "KataGo 首次启动失败"), 5000, "首次启动失败日志");
    } finally {
      kg.shutdown();
    }
    assertFalse(kg.available());

    assertThrows(
        IllegalArgumentException.class,
        () -> AiServiceFactory.create(new AiServiceFactory.Settings(null, null, null, true, -1L, null), AiLog.SILENT));
  }

  @Test
  void springConfigBuildsFromPropertiesAndExposesLevelsProvider() {
    AiConfig cfg = new AiConfig();
    GameGoProperties props = new GameGoProperties();
    MockEnvironment env = new MockEnvironment().withProperty(AiConfig.MIN_THINK_PROPERTY, "0");
    AiService none = cfg.aiService(props, env);
    assertEquals("none", none.kind());
    AiLevelsProvider p0 = cfg.aiLevelsProvider(none);
    assertFalse(p0.available());
    assertEquals(List.of(), p0.levels());

    props.setAiFallback(true);
    AiService fb = cfg.aiService(props, env);
    assertEquals("fallback", fb.kind());
    fb.shutdown();

    AiLevelsProvider p = AiConfig.levelsProvider(new FakeAiService());
    assertTrue(p.available());
    List<Map<String, Object>> levels = p.levels();
    assertEquals(8, levels.size());
    assertEquals(List.of("id", "name", "desc"), List.copyOf(levels.get(0).keySet()));
    assertEquals("k18", levels.get(0).get("id"));
    assertEquals("入门", levels.get(0).get("name"));
  }
}
