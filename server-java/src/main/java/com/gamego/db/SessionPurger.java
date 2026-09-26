package com.gamego.db;

import com.gamego.config.GameGoProperties;
import java.time.Clock;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;

/** 定时清理过期令牌：启动时先清一次，之后每小时一次（gamego.session-purge-interval-ms，0 = 不定时清理）。 */
@Component
public class SessionPurger implements SmartLifecycle {

  private static final Logger log = LoggerFactory.getLogger(SessionPurger.class);

  private final SessionRepository sessions;
  private final GameGoProperties props;
  private final Clock clock;
  private ScheduledExecutorService executor;
  private volatile boolean running;

  public SessionPurger(SessionRepository sessions, GameGoProperties props, Clock clock) {
    this.sessions = sessions;
    this.props = props;
    this.clock = clock;
  }

  /** 清理一次，返回删除条数（出错只记日志）。 */
  public int purgeNow() {
    try {
      int n = sessions.purgeExpired(clock.millis());
      if (n > 0) log.info("清理了 {} 个过期令牌", n);
      return n;
    } catch (RuntimeException e) {
      log.error("清理过期令牌失败：", e);
      return 0;
    }
  }

  @Override
  public void start() {
    running = true;
    long interval = props.getSessionPurgeIntervalMs();
    if (interval <= 0) return;
    purgeNow();
    executor = Executors.newSingleThreadScheduledExecutor(r -> {
      Thread t = new Thread(r, "gamego-session-purge");
      t.setDaemon(true);
      return t;
    });
    executor.scheduleWithFixedDelay(this::purgeNow, interval, interval, TimeUnit.MILLISECONDS);
  }

  @Override
  public void stop() {
    running = false;
    if (executor != null) executor.shutdownNow();
    executor = null;
  }

  @Override
  public boolean isRunning() {
    return running;
  }
}
