package com.gamego.game;

import com.gamego.config.GameGoProperties;
import com.gamego.config.TimeControl;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.core.env.Environment;

/**
 * 对局相关设置（对应 Node 版 game/settings.js 的 buildSettings）。缺省项用默认值，给了但不合法直接抛错（启动即失败）。
 *
 * <p>Config 契约里的项（komi、timeControls、minMovesRanked、rankedPairDailyMax、firstMoveTimeoutMs、abandonMs、
 * scoringTimeoutMs、judgeTimeoutMs、aiIdleTimeoutMs、roomTtlMs）取自 {@link GameGoProperties}；
 * 其余项不在契约里，可用 {@code gamego.game.*} 属性覆盖（如 {@code gamego.game.arrival-grace-ms}），主要给测试用。
 */
public final class GameSettings {

  public static final List<Integer> SIZES = List.of(9, 13, 19);

  public final List<Integer> sizes = SIZES;
  public final double komi;
  public final Map<Integer, TimeControl> timeControls;
  public final String publicBaseUrl;
  public final int minMovesRanked;
  /** 同一对手 24 小时内最多计入排行的局数（0 = 不限）。实际判断由 {@link GameStore#pairLimitReached} 完成。 */
  public final int rankedPairDailyMax;
  public final long firstMoveTimeoutMs;
  public final long abandonMs;
  public final long scoringTimeoutMs;
  public final long judgeTimeoutMs;
  public final long aiIdleTimeoutMs;
  public final long roomTtlMs;
  /** 单次 AI 落子请求的兜底超时。 */
  public final long aiMoveTimeoutMs;
  /** AI 落子失败后的重试间隔；全部失败则对局作废。 */
  public final List<Long> aiRetryDelaysMs;
  /** 真人对局每方每局最多"继续对局"几次（0 = 不允许）。 */
  public final int resumeLimit;
  /** 有人点选死子后，自动确认时限至少顺延到这么久之后。 */
  public final long scoringGraceMs;
  /** 开局时不在线、或重启恢复后还没回来的玩家最多等多久（超时作废）。 */
  public final long arrivalGraceMs;
  /** 每个玩家同时在途的 AI 落子请求上限（被悔棋等作废但 AI 还在算的也算），超出的排队。 */
  public final int aiMaxPerUser;
  /** 全服同时在途的 AI 落子请求上限，超出的排队。 */
  public final int aiMaxInflight;
  public final int aiStartBurst;
  public final long aiStartRefillMs;
  public final int roomMissBurst;
  public final long roomMissRefillMs;
  /** 内存里保留的刚结束对局最多多少局。 */
  public final int endedCacheMax;

  private GameSettings(Builder b) {
    if (!Double.isFinite(b.komi)) throw new IllegalArgumentException("komi 必须是数字");
    this.komi = b.komi;
    Map<Integer, TimeControl> tcs = new LinkedHashMap<>();
    for (int size : SIZES) {
      TimeControl tc = b.timeControls.get(size);
      tcs.put(size, GameClock.normalizeTimeControl(tc == null ? GameGoProperties.DEFAULT_TIME_CONTROLS.get(size) : tc));
    }
    this.timeControls = Collections.unmodifiableMap(tcs);
    this.publicBaseUrl = b.publicBaseUrl == null ? "" : b.publicBaseUrl.replaceAll("/+$", "");
    this.minMovesRanked = (int) nonNeg("minMovesRanked", b.minMovesRanked);
    this.rankedPairDailyMax = (int) nonNeg("rankedPairDailyMax", b.rankedPairDailyMax);
    this.firstMoveTimeoutMs = positive("firstMoveTimeoutMs", b.firstMoveTimeoutMs);
    this.abandonMs = positive("abandonMs", b.abandonMs);
    this.scoringTimeoutMs = positive("scoringTimeoutMs", b.scoringTimeoutMs);
    this.judgeTimeoutMs = positive("judgeTimeoutMs", b.judgeTimeoutMs);
    this.aiIdleTimeoutMs = positive("aiIdleTimeoutMs", b.aiIdleTimeoutMs);
    this.roomTtlMs = positive("roomTtlMs", b.roomTtlMs);
    this.aiMoveTimeoutMs = positive("aiMoveTimeoutMs", b.aiMoveTimeoutMs);
    for (Long d : b.aiRetryDelaysMs) {
      if (d == null || d < 0) throw new IllegalArgumentException("aiRetryDelaysMs 必须是非负整数数组");
    }
    this.aiRetryDelaysMs = List.copyOf(b.aiRetryDelaysMs);
    this.resumeLimit = (int) nonNeg("resumeLimit", b.resumeLimit);
    this.scoringGraceMs = positive("scoringGraceMs", b.scoringGraceMs);
    this.arrivalGraceMs = positive("arrivalGraceMs", b.arrivalGraceMs);
    this.aiMaxPerUser = (int) positive("aiMaxPerUser", b.aiMaxPerUser);
    this.aiMaxInflight = (int) positive("aiMaxInflight", b.aiMaxInflight);
    this.aiStartBurst = (int) positive("aiStartBurst", b.aiStartBurst);
    this.aiStartRefillMs = positive("aiStartRefillMs", b.aiStartRefillMs);
    this.roomMissBurst = (int) positive("roomMissBurst", b.roomMissBurst);
    this.roomMissRefillMs = positive("roomMissRefillMs", b.roomMissRefillMs);
    this.endedCacheMax = (int) positive("endedCacheMax", b.endedCacheMax);
  }

  private static long positive(String name, long v) {
    if (v <= 0) throw new IllegalArgumentException("config." + name + " 必须是正整数，当前为 " + v);
    return v;
  }

  private static long nonNeg(String name, long v) {
    if (v < 0) throw new IllegalArgumentException("config." + name + " 必须是非负整数，当前为 " + v);
    return v;
  }

  public static Builder builder() {
    return new Builder();
  }

  /** 全部默认值。 */
  public static GameSettings defaults() {
    return builder().build();
  }

  /** 以当前设置为基础修改。 */
  public Builder toBuilder() {
    Builder b = new Builder();
    b.komi = komi;
    b.timeControls = new LinkedHashMap<>(timeControls);
    b.publicBaseUrl = publicBaseUrl;
    b.minMovesRanked = minMovesRanked;
    b.rankedPairDailyMax = rankedPairDailyMax;
    b.firstMoveTimeoutMs = firstMoveTimeoutMs;
    b.abandonMs = abandonMs;
    b.scoringTimeoutMs = scoringTimeoutMs;
    b.judgeTimeoutMs = judgeTimeoutMs;
    b.aiIdleTimeoutMs = aiIdleTimeoutMs;
    b.roomTtlMs = roomTtlMs;
    b.aiMoveTimeoutMs = aiMoveTimeoutMs;
    b.aiRetryDelaysMs = aiRetryDelaysMs;
    b.resumeLimit = resumeLimit;
    b.scoringGraceMs = scoringGraceMs;
    b.arrivalGraceMs = arrivalGraceMs;
    b.aiMaxPerUser = aiMaxPerUser;
    b.aiMaxInflight = aiMaxInflight;
    b.aiStartBurst = aiStartBurst;
    b.aiStartRefillMs = aiStartRefillMs;
    b.roomMissBurst = roomMissBurst;
    b.roomMissRefillMs = roomMissRefillMs;
    b.endedCacheMax = endedCacheMax;
    return b;
  }

  /** 从配置构建：契约项取自 props，其余项可由 {@code gamego.game.*} 覆盖（env 可为 null）。 */
  public static GameSettings from(GameGoProperties props, Environment env) {
    Builder b = builder();
    b.komi = props.getKomi();
    b.timeControls = new LinkedHashMap<>(props.getTimeControls());
    b.publicBaseUrl = props.getPublicBaseUrl();
    b.minMovesRanked = props.getMinMovesRanked();
    b.rankedPairDailyMax = props.getRankedPairDailyMax();
    b.firstMoveTimeoutMs = props.getFirstMoveTimeoutMs();
    b.abandonMs = props.getAbandonMs();
    b.scoringTimeoutMs = props.getScoringTimeoutMs();
    b.judgeTimeoutMs = props.getJudgeTimeoutMs();
    b.aiIdleTimeoutMs = props.getAiIdleTimeoutMs();
    b.roomTtlMs = props.getRoomTtlMs();
    if (env != null) {
      b.aiMoveTimeoutMs = env.getProperty("gamego.game.ai-move-timeout-ms", Long.class, b.aiMoveTimeoutMs);
      String delays = env.getProperty("gamego.game.ai-retry-delays-ms");
      if (delays != null && !delays.isBlank()) {
        b.aiRetryDelaysMs =
            java.util.Arrays.stream(delays.split(",")).map(String::trim).filter(s -> !s.isEmpty()).map(Long::valueOf).toList();
      }
      b.resumeLimit = env.getProperty("gamego.game.resume-limit", Long.class, b.resumeLimit);
      b.scoringGraceMs = env.getProperty("gamego.game.scoring-grace-ms", Long.class, b.scoringGraceMs);
      b.arrivalGraceMs = env.getProperty("gamego.game.arrival-grace-ms", Long.class, b.arrivalGraceMs);
      b.aiMaxPerUser = env.getProperty("gamego.game.ai-max-per-user", Long.class, b.aiMaxPerUser);
      b.aiMaxInflight = env.getProperty("gamego.game.ai-max-inflight", Long.class, b.aiMaxInflight);
      b.aiStartBurst = env.getProperty("gamego.game.ai-start-burst", Long.class, b.aiStartBurst);
      b.aiStartRefillMs = env.getProperty("gamego.game.ai-start-refill-ms", Long.class, b.aiStartRefillMs);
      b.roomMissBurst = env.getProperty("gamego.game.room-miss-burst", Long.class, b.roomMissBurst);
      b.roomMissRefillMs = env.getProperty("gamego.game.room-miss-refill-ms", Long.class, b.roomMissRefillMs);
      b.endedCacheMax = env.getProperty("gamego.game.ended-cache-max", Long.class, b.endedCacheMax);
    }
    return b.build();
  }

  /** 设置构建器（默认值与 Node 版 DEFAULTS 相同）。 */
  public static final class Builder {
    double komi = 7.5;
    Map<Integer, TimeControl> timeControls = new LinkedHashMap<>(GameGoProperties.DEFAULT_TIME_CONTROLS);
    String publicBaseUrl = "";
    long minMovesRanked = 10;
    long rankedPairDailyMax = 3;
    long firstMoveTimeoutMs = 60000;
    long abandonMs = 90000;
    long scoringTimeoutMs = 180000;
    long judgeTimeoutMs = 15000;
    long aiIdleTimeoutMs = 86400000;
    long roomTtlMs = 1800000;
    long aiMoveTimeoutMs = 60000;
    List<Long> aiRetryDelaysMs = List.of(2000L, 5000L, 10000L, 20000L);
    long resumeLimit = 1;
    long scoringGraceMs = 60000;
    long arrivalGraceMs = 300000;
    long aiMaxPerUser = 2;
    long aiMaxInflight = 16;
    long aiStartBurst = 5;
    long aiStartRefillMs = 10000;
    long roomMissBurst = 10;
    long roomMissRefillMs = 6000;
    long endedCacheMax = 2000;

    public Builder komi(double v) {
      komi = v;
      return this;
    }

    public Builder timeControl(int size, TimeControl tc) {
      timeControls.put(size, tc);
      return this;
    }

    public Builder publicBaseUrl(String v) {
      publicBaseUrl = v;
      return this;
    }

    public Builder minMovesRanked(long v) {
      minMovesRanked = v;
      return this;
    }

    public Builder rankedPairDailyMax(long v) {
      rankedPairDailyMax = v;
      return this;
    }

    public Builder firstMoveTimeoutMs(long v) {
      firstMoveTimeoutMs = v;
      return this;
    }

    public Builder abandonMs(long v) {
      abandonMs = v;
      return this;
    }

    public Builder scoringTimeoutMs(long v) {
      scoringTimeoutMs = v;
      return this;
    }

    public Builder judgeTimeoutMs(long v) {
      judgeTimeoutMs = v;
      return this;
    }

    public Builder aiIdleTimeoutMs(long v) {
      aiIdleTimeoutMs = v;
      return this;
    }

    public Builder roomTtlMs(long v) {
      roomTtlMs = v;
      return this;
    }

    public Builder aiMoveTimeoutMs(long v) {
      aiMoveTimeoutMs = v;
      return this;
    }

    public Builder aiRetryDelaysMs(Long... v) {
      aiRetryDelaysMs = java.util.Arrays.asList(v);
      return this;
    }

    public Builder resumeLimit(long v) {
      resumeLimit = v;
      return this;
    }

    public Builder scoringGraceMs(long v) {
      scoringGraceMs = v;
      return this;
    }

    public Builder arrivalGraceMs(long v) {
      arrivalGraceMs = v;
      return this;
    }

    public Builder aiMaxPerUser(long v) {
      aiMaxPerUser = v;
      return this;
    }

    public Builder aiMaxInflight(long v) {
      aiMaxInflight = v;
      return this;
    }

    public Builder aiStartBurst(long v) {
      aiStartBurst = v;
      return this;
    }

    public Builder aiStartRefillMs(long v) {
      aiStartRefillMs = v;
      return this;
    }

    public Builder roomMissBurst(long v) {
      roomMissBurst = v;
      return this;
    }

    public Builder roomMissRefillMs(long v) {
      roomMissRefillMs = v;
      return this;
    }

    public Builder endedCacheMax(long v) {
      endedCacheMax = v;
      return this;
    }

    public GameSettings build() {
      return new GameSettings(this);
    }
  }
}
