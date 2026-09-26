package com.gamego.config;

import java.time.Clock;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;

/**
 * 默认时钟。所有"现在几点"（令牌过期、限流、统计时间）都通过 {@link Clock#millis()} 取得，
 * 测试里换成可以手动推进的时钟即可（对应 Node 版注入的 now()）。
 *
 * <p>注册为自动配置（见 META-INF/spring/...AutoConfiguration.imports），保证 {@code @ConditionalOnMissingBean}
 * 在所有业务 Bean 注册之后才判断。
 */
@AutoConfiguration
public class ClockAutoConfiguration {
  @Bean
  @ConditionalOnMissingBean(Clock.class)
  public Clock gameGoClock() {
    return Clock.systemUTC();
  }
}
