package com.gamego.db.mapper;

import com.gamego.db.mapper.DbRows.CountRow;
import com.gamego.db.mapper.DbRows.GameDbRow;
import java.util.List;
import java.util.Map;
import org.apache.ibatis.annotations.Delete;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

/** games 表。 */
@Mapper
public interface GameMapper {

  String COLS =
      "id, mode, size, komi, black_id, white_id, ai_level, time_control, status, moves, clocks, dead, winner, reason,"
          + " score_black, score_white, result_text, counted, created_at, updated_at, ended_at, state, cause";

  @Insert(
      "INSERT INTO games (" + COLS + ") VALUES (#{id}, #{mode}, #{size}, #{komi}, #{blackId}, #{whiteId}, #{aiLevel},"
          + " #{timeControl}, #{status}, #{moves}, #{clocks}, #{dead}, #{winner}, #{reason}, #{scoreBlack},"
          + " #{scoreWhite}, #{resultText}, #{counted}, #{createdAt}, #{updatedAt}, #{endedAt}, #{state}, #{cause})")
  int insert(GameDbRow row);

  @Select("SELECT " + COLS + " FROM games WHERE id = #{id}")
  GameDbRow findById(@Param("id") String id);

  /**
   * 保存进度：p 中 setStatus/setMoves/setClocks/setState 为 true 的字段才更新；已结束的对局不改。
   */
  @Update(
      "<script>UPDATE games <set>"
          + "<if test='p.setStatus'>status = #{p.status},</if>"
          + "<if test='p.setMoves'>moves = #{p.moves},</if>"
          + "<if test='p.setClocks'>clocks = #{p.clocks},</if>"
          + "<if test='p.setState'>state = #{p.state},</if>"
          + "updated_at = #{p.now}"
          + "</set> WHERE id = #{p.id} AND status &lt;&gt; 'ended'</script>")
  int saveProgress(@Param("p") Map<String, Object> p);

  /** 终局：不写 counted，同时清空 state；已结束的对局不改。 */
  @Update(
      "<script>UPDATE games SET status = 'ended', winner = #{p.winner}, reason = #{p.reason},"
          + " score_black = #{p.scoreBlack}, score_white = #{p.scoreWhite}, result_text = #{p.resultText},"
          + " cause = #{p.cause}, state = NULL,"
          + "<if test='p.setMoves'> moves = #{p.moves},</if>"
          + "<if test='p.setDead'> dead = #{p.dead},</if>"
          + " ended_at = #{p.now}, updated_at = #{p.now}"
          + " WHERE id = #{p.id} AND status &lt;&gt; 'ended'</script>")
  int finish(@Param("p") Map<String, Object> p);

  /** 某用户执黑的已结束对局，按 created_at 倒序（走 games_black 索引）。 */
  @Select(
      "SELECT " + COLS + " FROM games WHERE black_id = #{uid} AND created_at < #{before} AND status = 'ended'"
          + " ORDER BY created_at DESC, id DESC LIMIT #{n}")
  List<GameDbRow> listEndedAsBlack(@Param("uid") long uid, @Param("before") long before, @Param("n") int n);

  /** 某用户执白的已结束对局，按 created_at 倒序（走 games_white 索引）。 */
  @Select(
      "SELECT " + COLS + " FROM games WHERE white_id = #{uid} AND created_at < #{before} AND status = 'ended'"
          + " ORDER BY created_at DESC, id DESC LIMIT #{n}")
  List<GameDbRow> listEndedAsWhite(@Param("uid") long uid, @Param("before") long before, @Param("n") int n);

  @Select("SELECT " + COLS + " FROM games WHERE status <> 'ended' ORDER BY created_at ASC, id ASC")
  List<GameDbRow> listUnfinished();

  /** counted 0→1 的防重守卫：返回 0 表示此前已计入。 */
  @Update("UPDATE games SET counted = 1 WHERE id = #{id} AND counted = 0")
  int markCounted(@Param("id") String id);

  /** 某人执黑、另一人执白、created_at >= since、已计入的排位赛局数（走 games_black 索引）。 */
  @Select(
      "SELECT COUNT(*) FROM games WHERE black_id = #{black} AND created_at >= #{since} AND white_id = #{white}"
          + " AND mode = 'ranked' AND counted = 1")
  long countCountedPair(@Param("black") long black, @Param("white") long white, @Param("since") long since);

  @Delete("DELETE FROM games WHERE id = #{id} AND status <> 'ended'")
  int discard(@Param("id") String id);

  /** 执黑的人机战绩（作废的不算）。 */
  @Select(
      "SELECT COUNT(*) AS games, COALESCE(SUM(CASE WHEN winner = 1 THEN 1 ELSE 0 END), 0) AS wins FROM games"
          + " WHERE black_id = #{uid} AND mode = 'ai' AND status = 'ended' AND reason <> 'abort'")
  CountRow aiRecordAsBlack(@Param("uid") long uid);

  /** 执白的人机战绩（作废的不算）。 */
  @Select(
      "SELECT COUNT(*) AS games, COALESCE(SUM(CASE WHEN winner = 2 THEN 1 ELSE 0 END), 0) AS wins FROM games"
          + " WHERE white_id = #{uid} AND mode = 'ai' AND status = 'ended' AND reason <> 'abort'")
  CountRow aiRecordAsWhite(@Param("uid") long uid);
}
