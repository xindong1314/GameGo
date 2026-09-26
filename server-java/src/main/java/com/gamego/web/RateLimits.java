package com.gamego.web;

import com.gamego.config.GameGoProperties;
import jakarta.annotation.PreDestroy;
import java.time.Clock;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.springframework.stereotype.Component;

/**
 * REST 应用层限流（设计文档第 4 节，nginx 的 limit_req 之外再兜一层）：
 * 登录接口按 IP、需要令牌的接口按用户、头像上传按用户，另有登录与上传的并发上限。参数见 gamego.limits.*。
 */
@Component
public class RateLimits {

  private final GameGoProperties props;
  private final Clock clock;
  private volatile RateLimiter login;
  private volatile RateLimiter api;
  private volatile RateLimiter avatar;
  private volatile ConcurrencyLimit loginSlots;
  private volatile ConcurrencyLimit uploadSlots;
  private final ScheduledExecutorService pruner;

  public RateLimits(GameGoProperties props, Clock clock) {
    this.props = props;
    this.clock = clock;
    reset();
    pruner = Executors.newSingleThreadScheduledExecutor(r -> {
      Thread t = new Thread(r, "gamego-rate-limit-prune");
      t.setDaemon(true);
      return t;
    });
    // 限流表里已经补满的条目定期清掉
    pruner.scheduleWithFixedDelay(() -> {
      login.prune();
      api.prune();
      avatar.prune();
    }, 60, 60, TimeUnit.SECONDS);
  }

  /** 按当前配置重建全部限流器（测试修改 gamego.limits 后调用）。 */
  public synchronized void reset() {
    GameGoProperties.Limits l = props.getLimits();
    login = new RateLimiter(l.getLoginBurst(), l.getLoginPerSec(), clock::millis);
    api = new RateLimiter(l.getApiBurst(), l.getApiPerSec(), clock::millis);
    avatar = new RateLimiter(l.getAvatarBurst(), l.getAvatarPerSec(), clock::millis);
    loginSlots = new ConcurrencyLimit(l.getLoginConcurrent());
    uploadSlots = new ConcurrencyLimit(l.getUploadConcurrent());
  }

  @PreDestroy
  void shutdown() {
    pruner.shutdownNow();
  }

  /** 登录接口：每个 IP。 */
  public RateLimiter login() {
    return login;
  }

  /** 需要令牌的接口：每个用户。 */
  public RateLimiter api() {
    return api;
  }

  /** 头像上传：每个用户。 */
  public RateLimiter avatar() {
    return avatar;
  }

  /** 同时在请求微信 code2Session 的登录数。 */
  public ConcurrencyLimit loginSlots() {
    return loginSlots;
  }

  /** 同时在处理的头像上传。 */
  public ConcurrencyLimit uploadSlots() {
    return uploadSlots;
  }

  /** 429 rate_limited + Retry-After（秒，至少 1）。 */
  public static ApiException limited(RateLimiter limiter, Object key, String msg) {
    long secs = Math.max(1, (long) Math.ceil(limiter.retryAfterMs(key) / 1000.0));
    return ApiException.rateLimited(msg, secs);
  }
}
