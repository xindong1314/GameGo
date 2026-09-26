package com.gamego.game;

import com.gamego.config.GameGoProperties;
import com.gamego.db.DbTransactions;
import com.gamego.db.GameRepository;
import com.gamego.db.StatsRepository;
import com.gamego.db.UserRepository;
import java.time.Clock;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;

/** 对局模块的 Spring 配置：游戏循环、对局设置、持久化。 */
@Configuration
public class GameConfig {

  @Bean(destroyMethod = "shutdown")
  public ExecutorGameLoop gameLoop(Clock clock) {
    return new ExecutorGameLoop(clock);
  }

  @Bean
  public GameSettings gameSettings(GameGoProperties props, Environment env) {
    return GameSettings.from(props, env);
  }

  @Bean
  public GameStore gameStore(GameRepository games, StatsRepository stats, UserRepository users, DbTransactions db) {
    return new DbGameStore(games, stats, users, db);
  }
}
