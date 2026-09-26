package com.gamego.db;

import com.gamego.db.mapper.DbRows.UserRow;
import com.gamego.db.mapper.UserMapper;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/** 用户仓储（设计文档 3.1 users）。查不到时返回 null（与 Node 版一致）。 */
@Repository
public class UserRepository {

  private final UserMapper mapper;

  public UserRepository(UserMapper mapper) {
    this.mapper = mapper;
  }

  static User toUser(UserRow r) {
    if (r == null) return null;
    return new User(r.id, r.openid, r.nickname, r.avatar, r.createdAt, r.lastLoginAt);
  }

  /** id 不是正整数或不存在时返回 null。 */
  public User findById(long id) {
    if (id <= 0) return null;
    return toUser(mapper.findById(id));
  }

  /** openid 为空或不存在时返回 null。 */
  public User findByOpenid(String openid) {
    if (openid == null || openid.isEmpty()) return null;
    return toUser(mapper.findByOpenid(openid));
  }

  public User create(String openid, long now) {
    return create(openid, "", "", now);
  }

  /** 新建用户；openid 唯一（重复时抛 DuplicateKeyException）。 */
  public User create(String openid, String nickname, String avatar, long now) {
    Checks.string(openid, "users.create", "openid", 128, false);
    Checks.string(nickname, "users.create", "nickname", 64, true);
    Checks.string(avatar, "users.create", "avatar", 128, true);
    UserRow row = new UserRow();
    row.openid = openid;
    row.nickname = nickname;
    row.avatar = avatar;
    row.createdAt = now;
    row.lastLoginAt = now;
    mapper.insert(row);
    return findById(row.id);
  }

  /**
   * 只更新非 null 的字段（nickname / avatar）；用户不存在返回 null。
   * users 表没有 updated_at 列，now 只为与 Node 版签名一致。
   */
  public User updateProfile(long id, String nickname, String avatar, long now) {
    Checks.userId(id, "users.updateProfile", "id");
    if (nickname != null) Checks.string(nickname, "users.updateProfile", "nickname", 64, true);
    if (avatar != null) Checks.string(avatar, "users.updateProfile", "avatar", 128, true);
    if (nickname != null || avatar != null) mapper.updateProfile(id, nickname, avatar);
    return findById(id);
  }

  /** 记录登录时间；用户不存在返回 false。 */
  public boolean touchLogin(long id, long now) {
    Checks.userId(id, "users.touchLogin", "id");
    return mapper.touchLogin(id, now) > 0;
  }

  /**
   * 换头像：锁住该用户行、读出旧头像文件名、写入新的，返回旧文件名（空串表示原来没有）；用户不存在返回 null。
   * 同一用户并发上传时串行执行，调用方在提交后删除旧文件，不会漏删。
   */
  @Transactional(propagation = Propagation.NESTED)
  public String replaceAvatar(long id, String avatar) {
    Checks.userId(id, "users.replaceAvatar", "id");
    Checks.string(avatar, "users.replaceAvatar", "avatar", 128, true);
    String prev = mapper.lockAvatar(id);
    if (prev == null) return null;
    mapper.updateProfile(id, null, avatar);
    return prev;
  }
}
