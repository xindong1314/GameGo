package com.gamego.db;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.gamego.testsupport.IntegrationTestBase;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;

/** 排位统计与排行榜（对应 Node 测试 stats.test.js）。 */
class StatsRepositoryTest extends IntegrationTestBase {

  private long[] seed(int n) {
    long[] ids = new long[n];
    for (int i = 0; i < n; i++) ids[i] = users.create("u" + i, "用户" + i, i % 2 == 1 ? "a" + i + ".png" : "", T0).id();
    return ids;
  }

  private boolean win(long winner, long loser, long now) {
    String id = insertRanked(winner, loser, now);
    return stats.applyWin(id, winner, loser, now);
  }

  private boolean draw(long a, long b, long now) {
    String id = insertRanked(a, b, now);
    return stats.applyDraw(id, a, b, now);
  }

  /** 直接写统计行，便于构造并列情形。 */
  private void setStats(long userId, long games, long wins, long losses, long cur, Long curAt, long max, Long maxAt) {
    jdbc.update("DELETE FROM user_stats WHERE user_id = ?", userId);
    jdbc.update(
        "INSERT INTO user_stats (user_id, games, wins, losses, draws, cur_streak, max_streak, cur_streak_at, max_streak_at,"
            + " updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)",
        userId, games, wins, losses, cur, max, curAt, maxAt, T0);
  }

  private void checkRankOfMatchesList(String type, long[] userIds, Integer minGames) {
    List<LeaderboardEntry> list = stats.leaderboard(type, 200, minGames);
    for (long uid : userIds) {
      RankInfo r = stats.rankOf(type, uid, minGames);
      LeaderboardEntry item = list.stream().filter(it -> it.userId() == uid).findFirst().orElse(null);
      assertThat(r.rank()).as(type + " user " + uid).isEqualTo(item == null ? null : item.rank());
      if (item != null) assertThat(r.value().doubleValue()).isEqualTo(item.value().doubleValue());
    }
  }

  @Test
  void getReturnsZerosWhenMissing() {
    long[] u = seed(1);
    assertThat(stats.get(u[0])).isEqualTo(RankedStats.empty());
    assertThat(stats.get(12345).games()).isZero();
    assertThat(stats.get(0).games()).isZero();
  }

  @Test
  void winnerStreakUpLoserReset() {
    long[] u = seed(3);
    long a = u[0];
    long b = u[1];
    long c = u[2];
    assertThat(win(a, b, T0 + 1)).isTrue();
    assertThat(win(a, c, T0 + 2)).isTrue();
    assertThat(stats.get(a)).isEqualTo(new RankedStats(2, 2, 0, 0, 1.0, 2, 2, T0 + 2, T0 + 2));
    assertThat(stats.get(b)).isEqualTo(new RankedStats(1, 0, 1, 0, 0.0, 0, 0, null, null));

    // a 输一局：当前连胜清零，最高连胜保留
    win(b, a, T0 + 3);
    RankedStats s = stats.get(a);
    assertThat(s.curStreak()).isZero();
    assertThat(s.curStreakAt()).isNull();
    assertThat(s.maxStreak()).isEqualTo(2);
    assertThat(s.maxStreakAt()).isEqualTo(T0 + 2);
    assertThat(s.losses()).isEqualTo(1);
    assertThat(stats.get(b).curStreak()).isEqualTo(1);
    assertThat(stats.get(b).curStreakAt()).isEqualTo(T0 + 3);

    // 追平不更新最高连胜时间，超过才更新
    win(a, c, T0 + 4);
    win(a, c, T0 + 5);
    s = stats.get(a);
    assertThat(s.curStreak()).isEqualTo(2);
    assertThat(s.maxStreak()).isEqualTo(2);
    assertThat(s.maxStreakAt()).isEqualTo(T0 + 2);
    win(a, c, T0 + 6);
    s = stats.get(a);
    assertThat(s.curStreak()).isEqualTo(3);
    assertThat(s.maxStreak()).isEqualTo(3);
    assertThat(s.maxStreakAt()).isEqualTo(T0 + 6);
    assertThat(s.games()).isEqualTo(6);
    assertThat(s.wins()).isEqualTo(5);
    assertThat(s.winrate()).isEqualTo(5.0 / 6);
  }

  @Test
  void drawCountsGamesAndDrawsKeepsStreak() {
    long[] u = seed(2);
    long a = u[0];
    long b = u[1];
    win(a, b, T0 + 1);
    assertThat(draw(a, b, T0 + 2)).isTrue();
    RankedStats sa = stats.get(a);
    RankedStats sb = stats.get(b);
    assertThat(List.of(sa.games(), sa.wins(), sa.draws(), sa.curStreak())).containsExactly(2L, 1L, 1L, 1L);
    assertThat(sa.curStreakAt()).isEqualTo(T0 + 1);
    assertThat(List.of(sb.games(), sb.losses(), sb.draws(), sb.curStreak())).containsExactly(2L, 1L, 1L, 0L);
    // 和棋也可只给 winnerId/loserId 表示双方
    String id = insertRanked(a, b, T0 + 3);
    assertThat(stats.applyRanked(id, b, a, true, null, T0 + 3)).isTrue();
    assertThat(stats.get(a).draws()).isEqualTo(2);
    assertThat(stats.get(b).draws()).isEqualTo(2);
  }

  @Test
  void countedGuardExactlyOnceEvenAfterFinish() {
    long[] u = seed(2);
    long a = u[0];
    long b = u[1];
    String id = insertRanked(a, b, T0);
    games.finish(id, GameFinish.of(1, "resign"), T0 + 10);
    assertThat(games.findById(id).counted()).isFalse();
    assertThat(stats.applyWin(id, a, b, T0 + 10)).isTrue();
    assertThat(games.findById(id).counted()).isTrue();
    assertThat(stats.applyWin(id, a, b, T0 + 11)).isFalse();
    assertThat(stats.applyDraw(id, a, b, T0 + 12)).isFalse();
    assertThat(stats.get(a).games()).isEqualTo(1);
    assertThat(stats.get(a).curStreakAt()).isEqualTo(T0 + 10);
    assertThat(stats.get(b).games()).isEqualTo(1);
  }

  @Test
  void rollsBackWithOuterTransaction() {
    long[] u = seed(2);
    long a = u[0];
    long b = u[1];
    String id = insertRanked(a, b, T0);
    assertThatThrownBy(() -> db.run(() -> {
      games.finish(id, GameFinish.of(2, "timeout"), T0);
      stats.applyWin(id, b, a, T0);
      throw new IllegalStateException("rollback");
    })).hasMessageContaining("rollback");
    assertThat(games.findById(id).status()).isEqualTo("playing");
    assertThat(games.findById(id).counted()).isFalse();
    assertThat(stats.get(b).games()).isZero();

    boolean r = db.transaction(() -> {
      games.finish(id, GameFinish.of(2, "timeout"), T0);
      return stats.applyWin(id, b, a, T0);
    });
    assertThat(r).isTrue();
    assertThat(stats.get(b).wins()).isEqualTo(1);
  }

  @Test
  void countedNotSetWhenStatsWriteFails() {
    long[] u = seed(1);
    long a = u[0];
    // games.black_id 没有外键，user_stats.user_id 有：不存在的用户会让统计写入失败
    String id = insertRanked(a, 999, T0);
    assertThatThrownBy(() -> stats.applyWin(id, 999, a, T0)).isInstanceOf(DataIntegrityViolationException.class);
    assertThat(games.findById(id).counted()).isFalse();
    assertThat(stats.get(a).games()).isZero();
  }

  @Test
  void applyRankedValidation() {
    long[] u = seed(3);
    long a = u[0];
    long b = u[1];
    long c = u[2];
    String id = insertRanked(a, b, T0);
    assertThatThrownBy(() -> stats.applyRanked(null, a, b, false, null, T0)).hasMessageContaining("gameId");
    assertThatThrownBy(() -> stats.applyWin(id, a, a, T0)).isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> stats.applyRanked(id, a, null, false, null, T0)).isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> stats.applyRanked(id, null, null, true, List.of(a), T0))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> stats.applyWin("missing", a, b, T0)).hasMessageContaining("不存在");
    assertThatThrownBy(() -> stats.applyWin(id, a, c, T0)).hasMessageContaining("不符");
    String friend = gameId();
    games.insert(new NewGame().id(friend).mode("friend").size(9).komi(7.5).blackId(a).whiteId(b).createdAt(T0));
    assertThatThrownBy(() -> stats.applyWin(friend, a, b, T0)).hasMessageContaining("不是排位赛");
    assertThat(games.findById(id).counted()).isFalse();
    assertThat(stats.get(a).games()).isZero();
  }

  // ---------- 排行榜 ----------

  @Test
  void streakBoardOrdering() {
    long[] u = seed(7);
    setStats(u[0], 3, 3, 0, 3, T0 + 50, 3, T0 + 50);
    setStats(u[1], 5, 5, 0, 5, T0 + 90, 5, T0 + 90);
    setStats(u[2], 3, 3, 0, 3, T0 + 10, 3, T0 + 10);
    setStats(u[3], 3, 3, 0, 3, T0 + 10, 4, T0 + 1);
    setStats(u[4], 2, 0, 2, 0, null, 1, T0);
    setStats(u[5], 1, 1, 0, 1, T0, 1, T0);
    // u[6] 没有统计记录
    List<LeaderboardEntry> list = stats.leaderboard("streak", 50);
    assertThat(list.stream().map(it -> List.of((long) it.rank(), it.userId(), it.value().longValue())).toList())
        .containsExactly(List.of(1L, u[1], 5L), List.of(2L, u[2], 3L), List.of(3L, u[3], 3L), List.of(4L, u[0], 3L),
            List.of(5L, u[5], 1L));
    assertThat(list.get(0)).isEqualTo(
        new LeaderboardEntry(1, u[1], "用户1", "a1.png", "https://go.example.com/avatars/a1.png", 5L, 5, 5));
    assertThat(list.get(1).avatarUrl()).isEmpty();
    assertThat(stats.leaderboard("streak", 2).stream().map(LeaderboardEntry::userId).toList()).containsExactly(u[1], u[2]);
    checkRankOfMatchesList("streak", u, null);
    assertThat(stats.rankOf("streak", u[3])).isEqualTo(new RankInfo(3, 3L, 3, 3, 0));
    assertThat(stats.rankOf("streak", u[4])).isEqualTo(new RankInfo(null, 0L, 2, 0, 0));
    assertThat(stats.rankOf("streak", u[6])).isEqualTo(new RankInfo(null, 0L, 0, 0, 0));
  }

  @Test
  void maxStreakBoardOrdering() {
    long[] u = seed(5);
    setStats(u[0], 9, 6, 3, 0, null, 4, T0 + 30);
    setStats(u[1], 9, 6, 3, 0, null, 4, T0 + 20);
    setStats(u[2], 9, 6, 3, 0, null, 6, T0 + 99);
    setStats(u[3], 9, 6, 3, 0, null, 4, T0 + 20);
    setStats(u[4], 1, 0, 1, 0, null, 0, null);
    assertThat(stats.leaderboard("maxStreak", 50).stream()
        .map(it -> List.of((long) it.rank(), it.userId(), it.value().longValue())).toList())
        .containsExactly(List.of(1L, u[2], 6L), List.of(2L, u[1], 4L), List.of(3L, u[3], 4L), List.of(4L, u[0], 4L));
    checkRankOfMatchesList("maxStreak", u, null);
    assertThat(stats.rankOf("maxStreak", u[4]).rank()).isNull();
  }

  @Test
  void winrateBoardOrderingAndNeed() {
    long[] u = seed(8);
    setStats(u[0], 10, 5, 5, 0, null, 0, null); // 0.5
    setStats(u[1], 20, 10, 10, 0, null, 0, null); // 0.5，局数多排前
    setStats(u[2], 12, 9, 3, 0, null, 0, null); // 0.75
    setStats(u[3], 9, 9, 0, 0, null, 0, null); // 局数不够
    setStats(u[4], 30, 10, 20, 0, null, 0, null); // 1/3
    setStats(u[5], 15, 5, 10, 0, null, 0, null); // 1/3，局数少排后
    setStats(u[6], 30, 10, 20, 0, null, 0, null); // 1/3，与 u4 完全相同，按 user_id
    List<LeaderboardEntry> list = stats.leaderboard("winrate", 50);
    assertThat(list.stream().map(it -> List.of((long) it.rank(), it.userId())).toList())
        .containsExactly(List.of(1L, u[2]), List.of(2L, u[1]), List.of(3L, u[0]), List.of(4L, u[4]), List.of(5L, u[6]),
            List.of(6L, u[5]));
    assertThat(list.get(0).value()).isEqualTo(0.75);
    assertThat(list.get(3).value()).isEqualTo(1.0 / 3);
    checkRankOfMatchesList("winrate", u, null);
    assertThat(stats.rankOf("winrate", u[3])).isEqualTo(new RankInfo(null, 1.0, 9, 9, 1));
    assertThat(stats.rankOf("winrate", u[7])).isEqualTo(new RankInfo(null, 0.0, 0, 0, 10));
    assertThat(stats.rankOf("winrate", u[2])).isEqualTo(new RankInfo(1, 0.75, 12, 9, 0));

    // 逐次覆盖上榜局数
    List<LeaderboardEntry> low = stats.leaderboard("winrate", 50, 5);
    assertThat(low.get(0).userId()).isEqualTo(u[3]);
    assertThat(stats.rankOf("winrate", u[3], 5).rank()).isEqualTo(1);
    checkRankOfMatchesList("winrate", u, 5);
    assertThat(stats.rankOf("winrate", u[7], 5).need()).isEqualTo(5);
  }

  @Test
  void minGamesFromConfigAndValidation() {
    props.setMinGamesWinrate(3);
    long[] u = seed(1);
    setStats(u[0], 3, 1, 2, 0, null, 0, null);
    assertThat(stats.leaderboard("winrate", null)).hasSize(1);
    assertThat(stats.rankOf("winrate", u[0]).rank()).isEqualTo(1);
    assertThatThrownBy(() -> stats.leaderboard("elo", 10)).isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> stats.rankOf("elo", u[0])).isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> stats.leaderboard("winrate", 10, 0)).isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void realSequenceRankOfMatchesList() {
    props.setMinGamesWinrate(2);
    long[] u = seed(5);
    long t = T0;
    int[][] seq = {{0, 1}, {0, 2}, {3, 4}, {3, 0}, {1, 2}, {3, 1}, {4, 2}, {2, 0}, {3, 2}};
    for (int[] wl : seq) win(u[wl[0]], u[wl[1]], t += 1000);
    draw(u[1], u[4], t += 1000);
    for (String type : StatsRepository.LEADERBOARD_TYPES) checkRankOfMatchesList(type, u, null);
    LeaderboardEntry top = stats.leaderboard("streak", 1).get(0);
    assertThat(top.userId()).isEqualTo(u[3]);
    assertThat(top.value()).isEqualTo(4L);
    assertThat(stats.get(u[3]).maxStreak()).isEqualTo(4);
    long total = 0;
    for (long id : u) total += stats.get(id).games();
    assertThat(total).isEqualTo((seq.length + 1) * 2L);
  }
}
