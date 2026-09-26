package com.gamego.ai;

import com.gamego.api.AiLevelsProvider;
import com.gamego.config.GameGoProperties;
import com.gamego.config.KataGoSettings;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;

/**
 * AI 模块的 Spring 配置：按 {@link GameGoProperties} 选择实现（KataGo 已配置 → KataGo；否则 AI_FALLBACK → 内置练习 AI；
 * 否则不可用），并以 {@link AiLevelsProvider} 的形式提供给 REST 层（{@code GET /api/ai/levels}）。
 *
 * <p>可选属性 {@code gamego.ai-min-think-ms}（环境变量 GAMEGO_AI_MIN_THINK_MS）：AI 落子的最短间隔，默认 600ms，测试可设 0。
 *
 * <p>其他模块的测试需要确定性的 AI 时，提供一个 {@code @Primary} 的 {@link FakeAiService} Bean 即可。
 */
@Configuration
public class AiConfig {
  public static final String MIN_THINK_PROPERTY = "gamego.ai-min-think-ms";

  @Bean(destroyMethod = "shutdown")
  public AiService aiService(GameGoProperties props, Environment env) {
    KataGoSettings k = props.getKatago();
    AiServiceFactory.Settings s =
        new AiServiceFactory.Settings(
            k == null ? null : k.path(),
            k == null ? null : k.model(),
            k == null ? null : k.config(),
            props.isAiFallback(),
            env.getProperty(MIN_THINK_PROPERTY, Long.class),
            props.getJudgeTimeoutMs());
    return AiServiceFactory.create(s, AiLog.slf4j(AiService.class));
  }

  @Bean
  public AiLevelsProvider aiLevelsProvider(AiService ai) {
    return levelsProvider(ai);
  }

  /** AiService → AiLevelsProvider 适配（levels 每项为 {id, name, desc}）。 */
  public static AiLevelsProvider levelsProvider(AiService ai) {
    return new AiLevelsProvider() {
      @Override
      public boolean available() {
        return ai.available();
      }

      @Override
      public List<Map<String, Object>> levels() {
        return ai.levels().stream()
            .map(
                l -> {
                  Map<String, Object> m = new LinkedHashMap<>();
                  m.put("id", l.id());
                  m.put("name", l.name() == null ? l.id() : l.name());
                  m.put("desc", l.desc() == null ? "" : l.desc());
                  return m;
                })
            .toList();
      }
    };
  }
}
