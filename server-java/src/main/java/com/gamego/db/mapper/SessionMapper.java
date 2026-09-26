package com.gamego.db.mapper;

import com.gamego.db.mapper.DbRows.SessionRow;
import java.util.List;
import org.apache.ibatis.annotations.Delete;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

/** sessions 表（登录令牌）。 */
@Mapper
public interface SessionMapper {

  @Insert(
      "INSERT INTO sessions (token, user_id, created_at, expires_at) "
          + "VALUES (#{token}, #{userId}, #{createdAt}, #{expiresAt})")
  int insert(
      @Param("token") String token,
      @Param("userId") long userId,
      @Param("createdAt") long createdAt,
      @Param("expiresAt") long expiresAt);

  @Select("SELECT user_id, expires_at FROM sessions WHERE token = #{token}")
  SessionRow get(@Param("token") String token);

  @Update("UPDATE sessions SET expires_at = #{expiresAt} WHERE token = #{token}")
  int extend(@Param("token") String token, @Param("expiresAt") long expiresAt);

  @Delete("DELETE FROM sessions WHERE token = #{token}")
  int delete(@Param("token") String token);

  /** 某用户已过期的令牌（普通一致性读，不加锁）。发令牌时先查再按主键删，避免范围 DELETE 的间隙锁导致并发登录死锁。 */
  @Select("SELECT token FROM sessions WHERE user_id = #{userId} AND expires_at <= #{now}")
  List<String> userExpiredTokens(@Param("userId") long userId, @Param("now") long now);

  /** 删除某用户已过期的令牌（走 sessions_user 索引）。 */
  @Delete("DELETE FROM sessions WHERE user_id = #{userId} AND expires_at <= #{now}")
  int purgeUserExpired(@Param("userId") long userId, @Param("now") long now);

  /** 删除全部已过期的令牌（走 sessions_expires 索引）。 */
  @Delete("DELETE FROM sessions WHERE expires_at <= #{now}")
  int purgeExpired(@Param("now") long now);

  /** 某用户按新到旧排序、跳过最新 keep 个之后的令牌（要作废的）。 */
  @Select(
      "SELECT token FROM sessions WHERE user_id = #{userId} "
          + "ORDER BY created_at DESC, expires_at DESC LIMIT 1000000 OFFSET #{keep}")
  List<String> tokensBeyond(@Param("userId") long userId, @Param("keep") int keep);
}
