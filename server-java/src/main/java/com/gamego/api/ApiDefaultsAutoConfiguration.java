package com.gamego.api;

import java.util.List;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;

/**
 * 共享接口的默认实现：对局模块、AI 模块提供了自己的 Bean 时，这里的默认 Bean 不会注册。
 * 注册为自动配置（见 META-INF/spring/...AutoConfiguration.imports），保证在所有业务 Bean 之后判断。
 */
@AutoConfiguration
public class ApiDefaultsAutoConfiguration {

  /** 默认：没有进行中的对局。 */
  @Bean
  @ConditionalOnMissingBean(ActiveGamesProvider.class)
  public ActiveGamesProvider defaultActiveGamesProvider() {
    return userId -> List.of();
  }

  /** 默认：AI 不可用，难度表为空。 */
  @Bean
  @ConditionalOnMissingBean(AiLevelsProvider.class)
  public AiLevelsProvider defaultAiLevelsProvider() {
    return new AiLevelsProvider() {
      @Override
      public boolean available() {
        return false;
      }

      @Override
      public List<java.util.Map<String, Object>> levels() {
        return List.of();
      }
    };
  }
}
