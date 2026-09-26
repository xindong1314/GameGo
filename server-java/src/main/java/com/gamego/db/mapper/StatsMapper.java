package com.gamego.db.mapper;

import com.gamego.db.mapper.DbRows.LeaderRow;
import com.gamego.db.mapper.DbRows.StatsRow;
import java.util.List;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

/**
 * user_stats 表与排行榜（设计文档 3.3）。名次不并列；"我的名次" = 严格排在我前面的人数 + 1，与列表顺序一致。
 * 时间戳为 NULL 的异常数据按 0 处理，保证列表与名次的比较一致。
 */
@Mapper
public interface StatsMapper {

  String COLS =
      "user_id, games, wins, losses, draws, cur_streak, max_streak, cur_streak_at, max_streak_at, updated_at";

  @Select("SELECT " + COLS + " FROM user_stats WHERE user_id = #{userId}")
  StatsRow get(@Param("userId") long userId);

  @Insert(
      "INSERT INTO user_stats (" + COLS + ") VALUES (#{userId}, #{games}, #{wins}, #{losses}, #{draws},"
          + " #{curStreak}, #{maxStreak}, #{curStreakAt}, #{maxStreakAt}, #{updatedAt})")
  int insert(StatsRow row);

  @Update(
      "UPDATE user_stats SET games = #{games}, wins = #{wins}, losses = #{losses}, draws = #{draws},"
          + " cur_streak = #{curStreak}, max_streak = #{maxStreak}, cur_streak_at = #{curStreakAt},"
          + " max_streak_at = #{maxStreakAt}, updated_at = #{updatedAt} WHERE user_id = #{userId}")
  int update(StatsRow row);

  // ---------- 当前连胜：cur_streak DESC, cur_streak_at ASC, user_id ASC ----------

  @Select(
      "SELECT s.user_id, s.games, s.wins, s.cur_streak AS val, u.nickname, u.avatar"
          + " FROM user_stats s JOIN users u ON u.id = s.user_id"
          + " WHERE s.cur_streak > 0"
          + " ORDER BY s.cur_streak DESC, COALESCE(s.cur_streak_at, 0) ASC, s.user_id ASC"
          + " LIMIT #{n}")
  List<LeaderRow> streakList(@Param("n") int n);

  @Select(
      "SELECT COUNT(*) FROM user_stats WHERE cur_streak > 0 AND ("
          + " cur_streak > #{v} OR (cur_streak = #{v} AND ("
          + " COALESCE(cur_streak_at, 0) < #{at} OR (COALESCE(cur_streak_at, 0) = #{at} AND user_id < #{uid}))))")
  long streakAhead(@Param("v") long v, @Param("at") long at, @Param("uid") long uid);

  // ---------- 最高连胜：max_streak DESC, max_streak_at ASC, user_id ASC ----------

  @Select(
      "SELECT s.user_id, s.games, s.wins, s.max_streak AS val, u.nickname, u.avatar"
          + " FROM user_stats s JOIN users u ON u.id = s.user_id"
          + " WHERE s.max_streak > 0"
          + " ORDER BY s.max_streak DESC, COALESCE(s.max_streak_at, 0) ASC, s.user_id ASC"
          + " LIMIT #{n}")
  List<LeaderRow> maxStreakList(@Param("n") int n);

  @Select(
      "SELECT COUNT(*) FROM user_stats WHERE max_streak > 0 AND ("
          + " max_streak > #{v} OR (max_streak = #{v} AND ("
          + " COALESCE(max_streak_at, 0) < #{at} OR (COALESCE(max_streak_at, 0) = #{at} AND user_id < #{uid}))))")
  long maxStreakAhead(@Param("v") long v, @Param("at") long at, @Param("uid") long uid);

  // ---------- 胜率：games >= min，wins/games DESC, games DESC, user_id ASC ----------

  /**
   * 胜率排序用双精度（{@code wins * 1e0} 在 MySQL 中是 DOUBLE，避免整数除法得到只有 4 位小数的 DECIMAL）；
   * value 由 Java 按 wins / games 计算。
   */
  @Select(
      "SELECT s.user_id, s.games, s.wins, u.nickname, u.avatar"
          + " FROM user_stats s JOIN users u ON u.id = s.user_id"
          + " WHERE s.games >= #{min}"
          + " ORDER BY s.wins * 1e0 / s.games DESC, s.games DESC, s.user_id ASC"
          + " LIMIT #{n}")
  List<LeaderRow> winrateList(@Param("min") int min, @Param("n") int n);

  /** 胜率比较用交叉相乘（整数精确），与列表的排序结果一致。 */
  @Select(
      "SELECT COUNT(*) FROM user_stats WHERE games >= #{min} AND ("
          + " wins * #{g} > #{w} * games OR (wins * #{g} = #{w} * games AND ("
          + " games > #{g} OR (games = #{g} AND user_id < #{uid}))))")
  long winrateAhead(@Param("min") int min, @Param("g") long g, @Param("w") long w, @Param("uid") long uid);
}
