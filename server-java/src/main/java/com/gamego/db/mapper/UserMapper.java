package com.gamego.db.mapper;

import com.gamego.db.mapper.DbRows.UserRow;
import java.util.List;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Options;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

/** users 表。 */
@Mapper
public interface UserMapper {

  String COLS = "id, openid, nickname, avatar, created_at, last_login_at";

  @Select("SELECT " + COLS + " FROM users WHERE id = #{id}")
  UserRow findById(@Param("id") long id);

  @Select("SELECT " + COLS + " FROM users WHERE openid = #{openid}")
  UserRow findByOpenid(@Param("openid") String openid);

  @Insert(
      "INSERT INTO users (openid, nickname, avatar, created_at, last_login_at) "
          + "VALUES (#{openid}, #{nickname}, #{avatar}, #{createdAt}, #{lastLoginAt})")
  @Options(useGeneratedKeys = true, keyProperty = "id", keyColumn = "id")
  int insert(UserRow row);

  @Update("UPDATE users SET last_login_at = #{now} WHERE id = #{id}")
  int touchLogin(@Param("id") long id, @Param("now") long now);

  /** 只更新非 null 的字段。 */
  @Update(
      "<script>UPDATE users <set>"
          + "<if test='nickname != null'>nickname = #{nickname},</if>"
          + "<if test='avatar != null'>avatar = #{avatar},</if>"
          + "</set> WHERE id = #{id}</script>")
  int updateProfile(@Param("id") long id, @Param("nickname") String nickname, @Param("avatar") String avatar);

  /** 读当前头像并锁住该行（同一用户并发上传头像时串行化，避免漏删旧文件）。 */
  @Select("SELECT avatar FROM users WHERE id = #{id} FOR UPDATE")
  String lockAvatar(@Param("id") long id);

  /** 按 id 升序锁住若干用户行（统计更新时串行化，升序避免死锁）。 */
  @Select(
      "<script>SELECT id FROM users WHERE id IN "
          + "<foreach collection='ids' item='x' open='(' separator=',' close=')'>#{x}</foreach>"
          + " ORDER BY id FOR UPDATE</script>")
  List<Long> lockUsers(@Param("ids") List<Long> ids);
}
