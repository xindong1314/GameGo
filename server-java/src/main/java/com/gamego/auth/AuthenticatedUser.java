package com.gamego.auth;

import com.gamego.db.User;

/** 通过令牌鉴权的用户与所用的令牌（控制器方法声明这个类型的参数即可拿到当前用户）。 */
public record AuthenticatedUser(User user, String token) {
  public long id() {
    return user.id();
  }
}
