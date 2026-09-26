package com.gamego.db;

import com.gamego.api.PublicUsers;
import com.gamego.config.GameGoProperties;
import com.gamego.db.mapper.DbRows.GameDbRow;
import com.gamego.db.mapper.DbRows.LeaderRow;
import com.gamego.db.mapper.DbRows.StatsRow;
import com.gamego.db.mapper.GameMapper;
import com.gamego.db.mapper.StatsMapper;
import com.gamego.db.mapper.UserMapper;
import java.util.ArrayList;
import java.util.List;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * 排位统计与排行榜（设计文档 3.2 / 3.3 / 6.6）。
 */
@Repository
public class StatsRepository {

  public static final List<String> LEADERBOARD_TYPES = List.of("streak", "maxStreak", "winrate");
  static final int MAX_LEADERBOARD_LIMIT = 200;
  static final long DAY_MS = 86400000L;

  private final StatsMapper mapper;
  private final GameMapper gameMapper;
  private final UserMapper userMapper;
  private final GameRepository games;
  private final GameGoProperties props;

  public StatsRepository(
      StatsMapper mapper, GameMapper gameMapper, UserMapper userMapper, GameRepository games, GameGoProperties props) {
    this.mapper = mapper;
    this.gameMapper = gameMapper;
    this.userMapper = userMapper;
    this.games = games;
    this.props = props;
  }

  static RankedStats toStats(StatsRow r) {
    if (r == null) return RankedStats.empty();
    long g = r.games;
    long w = r.wins;
    return new RankedStats(
        g, w, r.losses, r.draws, g > 0 ? (double) w / g : 0, r.curStreak, r.maxStreak, r.curStreakAt, r.maxStreakAt);
  }

  /** 不存在时返回全 0；含 winrate（0~1）与 curStreakAt / maxStreakAt。 */
  public RankedStats get(long userId) {
    if (userId <= 0) return RankedStats.empty();
    return toStats(mapper.get(userId));
  }

  // ---------------------------------------------------------------- 计入统计

  /** 胜负：winnerId 胜 loserId。见 {@link #applyRanked(String, Long, Long, boolean, List, long)}。 */
  @Transactional(propagation = Propagation.NESTED)
  public boolean applyWin(String gameId, long winnerId, long loserId, long now) {
    return applyRanked(gameId, winnerId, loserId, false, null, now);
  }

  /** 和棋。见 {@link #applyRanked(String, Long, Long, boolean, List, long)}。 */
  @Transactional(propagation = Propagation.NESTED)
  public boolean applyDraw(String gameId, long a, long b, long now) {
    return applyRanked(gameId, null, null, true, List.of(a, b), now);
  }

  /**
   * 排位赛计入统计（设计文档 3.2），与 Node 版 applyRanked({ gameId, winnerId, loserId, draw, userIds }, now) 相同。
   *
   * <p>同一事务内：{@code UPDATE games SET counted=1 WHERE id=? AND counted=0} 防重守卫 + 更新双方统计。
   * 胜者 games+1、wins+1、连胜+1（超过最高连胜时更新最高连胜及其时间）；负者 games+1、losses+1、连胜清零；
   * 和棋双方 games+1、draws+1，连胜不变。和棋时 userIds 给出双方（也可以只给 winnerId/loserId 表示双方）。
   *
   * @return true 表示本次已计入，false 表示此前已计入（未做任何修改）
   * @throws IllegalArgumentException 参数不合法
   * @throws IllegalStateException 对局不存在、不是排位赛、玩家与对局不符
   */
  @Transactional(propagation = Propagation.NESTED)
  public boolean applyRanked(String gameId, Long winnerId, Long loserId, boolean draw, List<Long> userIds, long now) {
    String fn = "stats.applyRanked";
    if (gameId == null || gameId.isEmpty()) {
      throw new IllegalArgumentException(fn + ": 需要 gameId（用于 counted 防重，见设计文档 3.2）");
    }
    List<Long> players = new ArrayList<>();
    if (draw && userIds != null && !userIds.isEmpty()) players.addAll(userIds);
    else {
      players.add(winnerId);
      players.add(loserId);
    }
    if (players.size() != 2) throw new IllegalArgumentException(fn + ": 需要恰好两名玩家");
    for (int i = 0; i < 2; i++) {
      String name = draw ? "userIds[" + i + "]" : i == 0 ? "winnerId" : "loserId";
      Checks.userId(players.get(i), fn, name);
    }
    if (players.get(0).equals(players.get(1))) throw new IllegalArgumentException(fn + ": 双方不能是同一人");

    GameDbRow game = gameMapper.findById(gameId);
    if (game == null) throw new IllegalStateException(fn + ": 对局 " + gameId + " 不存在");
    if (!"ranked".equals(game.mode)) {
      throw new IllegalStateException(fn + ": 对局 " + gameId + " 不是排位赛（" + game.mode + "）");
    }
    if (!players.stream().allMatch(p -> p.equals(game.blackId) || p.equals(game.whiteId))) {
      throw new IllegalStateException(
          fn + ": 玩家 " + players.get(0) + "," + players.get(1) + " 与对局 " + gameId + " 的双方 " + game.blackId + ","
              + game.whiteId + " 不符");
    }
    // 锁住双方的用户行（按 id 升序，避免死锁）：同一用户的多局同时终局时统计的读改写串行执行
    userMapper.lockUsers(players.stream().sorted().toList());
    if (gameMapper.markCounted(gameId) == 0) return false; // 已计入过

    if (draw) {
      for (Long uid : players) {
        StatsRow row = mapper.get(uid);
        RankedStats s = toStats(row);
        save(uid, row != null, s.games() + 1, s.wins(), s.losses(), s.draws() + 1, s.curStreak(), s.maxStreak(),
            s.curStreakAt(), s.maxStreakAt(), now);
      }
      return true;
    }

    StatsRow wr = mapper.get(winnerId);
    RankedStats w = toStats(wr);
    long cur = w.curStreak() + 1;
    long max = w.maxStreak();
    Long maxAt = w.maxStreakAt();
    if (cur > max) {
      max = cur;
      maxAt = now;
    }
    save(winnerId, wr != null, w.games() + 1, w.wins() + 1, w.losses(), w.draws(), cur, max, now, maxAt, now);

    StatsRow lr = mapper.get(loserId);
    RankedStats l = toStats(lr);
    save(loserId, lr != null, l.games() + 1, l.wins(), l.losses() + 1, l.draws(), 0, l.maxStreak(), null,
        l.maxStreakAt(), now);
    return true;
  }

  private void save(long userId, boolean exists, long games, long wins, long losses, long draws, long cur, long max,
      Long curAt, Long maxAt, long now) {
    StatsRow r = new StatsRow();
    r.userId = userId;
    r.games = games;
    r.wins = wins;
    r.losses = losses;
    r.draws = draws;
    r.curStreak = cur;
    r.maxStreak = max;
    r.curStreakAt = curAt;
    r.maxStreakAt = maxAt;
    r.updatedAt = now;
    if (exists) mapper.update(r);
    else mapper.insert(r);
  }

  /**
   * 同一对手每日计入上限（6.6）：两人之间 24 小时内（按开局时间，created_at >= now - 24h）已计入排行的排位赛
   * 局数是否已达到 RANKED_PAIR_DAILY_MAX（0 = 不限，永远返回 false）。达到时本局不计入（uncounted: 'pair_limit'）。
   * 与 Node 版 manager._applyPairLimit 的判断相同。
   */
  public boolean pairLimitReached(long a, long b, long now) {
    int max = props.getRankedPairDailyMax();
    if (max <= 0) return false;
    return games.countCountedBetween(a, b, now - DAY_MS) >= max;
  }

  // ---------------------------------------------------------------- 排行榜

  private int resolveMinGames(Integer minGames) {
    int m = minGames != null ? minGames : props.getMinGamesWinrate();
    if (m < 1) throw new IllegalArgumentException("minGames 必须是正整数");
    return m;
  }

  private static void checkType(String type, String fn) {
    if (!LEADERBOARD_TYPES.contains(type)) {
      throw new IllegalArgumentException(fn + ": type 必须是 " + String.join("/", LEADERBOARD_TYPES));
    }
  }

  public List<LeaderboardEntry> leaderboard(String type, Integer limit) {
    return leaderboard(type, limit, null);
  }

  /**
   * 排行榜（名次从 1 起，不并列）。limit 默认 50、截断到 [1, 200]；minGames 为 null 时用 MIN_GAMES_WINRATE。
   */
  public List<LeaderboardEntry> leaderboard(String type, Integer limit, Integer minGames) {
    checkType(type, "stats.leaderboard");
    int n = limit == null ? 50 : Math.min(Math.max(limit, 1), MAX_LEADERBOARD_LIMIT);
    boolean winrate = type.equals("winrate");
    List<LeaderRow> rows =
        switch (type) {
          case "streak" -> mapper.streakList(n);
          case "maxStreak" -> mapper.maxStreakList(n);
          default -> mapper.winrateList(resolveMinGames(minGames), n);
        };
    String base = props.getPublicBaseUrl();
    List<LeaderboardEntry> out = new ArrayList<>();
    int rank = 0;
    for (LeaderRow r : rows) {
      rank++;
      Number value = winrate ? (Number) ((double) r.wins / r.games) : (Number) r.val;
      out.add(new LeaderboardEntry(
          rank, r.userId, r.nickname, r.avatar, PublicUsers.avatarUrl(r.avatar, base), value, r.games, r.wins));
    }
    return out;
  }

  public RankInfo rankOf(String type, long userId) {
    return rankOf(type, userId, null);
  }

  /** "我的名次" = 严格排在我前面的人数 + 1；不满足上榜条件时 rank 为 null，胜率榜给出 need（还差几局）。 */
  public RankInfo rankOf(String type, long userId, Integer minGames) {
    checkType(type, "stats.rankOf");
    RankedStats s = get(userId);
    if (type.equals("winrate")) {
      int min = resolveMinGames(minGames);
      if (s.games() < min) return new RankInfo(null, s.winrate(), s.games(), s.wins(), min - s.games());
      long ahead = mapper.winrateAhead(min, s.games(), s.wins(), userId);
      return new RankInfo((int) ahead + 1, s.winrate(), s.games(), s.wins(), 0);
    }
    boolean streak = type.equals("streak");
    long value = streak ? s.curStreak() : s.maxStreak();
    if (value <= 0) return new RankInfo(null, 0L, s.games(), s.wins(), 0);
    Long atRaw = streak ? s.curStreakAt() : s.maxStreakAt();
    long at = atRaw == null ? 0 : atRaw;
    long ahead = streak ? mapper.streakAhead(value, at, userId) : mapper.maxStreakAhead(value, at, userId);
    return new RankInfo((int) ahead + 1, value, s.games(), s.wins(), 0);
  }
}
