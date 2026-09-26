package com.gamego.db;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.gamego.testsupport.IntegrationTestBase;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.DuplicateKeyException;

/** users / sessions / transaction（对应 Node 测试 db.test.js 与 db-hygiene.test.js 的令牌部分）。 */
class UserSessionRepositoryTest extends IntegrationTestBase {

  // ---------- users ----------

  @Test
  void usersCreateFindUpdateTouch() {
    User u = users.create("wx-openid-1", T0);
    assertThat(u).isEqualTo(new User(1, "wx-openid-1", "", "", T0, T0));
    assertThat(users.findById(1)).isEqualTo(u);
    assertThat(users.findByOpenid("wx-openid-1")).isEqualTo(u);
    assertThat(users.findById(99)).isNull();
    assertThat(users.findById(0)).isNull();
    assertThat(users.findByOpenid("nope")).isNull();
    assertThat(users.findByOpenid("")).isNull();
    assertThat(users.findByOpenid(null)).isNull();

    User v = users.create("dev:abcdefgh", "棋手", "a1.png", T0 + 1);
    assertThat(v.id()).isEqualTo(2);
    assertThat(v.nickname()).isEqualTo("棋手");

    User u2 = users.updateProfile(1, "小明", null, T0 + 5);
    assertThat(u2.nickname()).isEqualTo("小明");
    assertThat(u2.avatar()).isEmpty();
    User u3 = users.updateProfile(1, null, "ff.jpg", T0 + 6);
    assertThat(u3.nickname()).isEqualTo("小明");
    assertThat(u3.avatar()).isEqualTo("ff.jpg");
    assertThat(users.updateProfile(1, null, null, T0 + 7)).isEqualTo(u3);
    assertThat(users.updateProfile(42, "x", null, T0)).isNull();

    assertThat(users.touchLogin(1, T0 + 100)).isTrue();
    assertThat(users.findById(1).lastLoginAt()).isEqualTo(T0 + 100);
    assertThat(users.touchLogin(42, T0)).isFalse();
  }

  @Test
  void usersOpenidUniqueAndValidation() {
    users.create("dup", T0);
    assertThatThrownBy(() -> users.create("dup", T0)).isInstanceOf(DuplicateKeyException.class);
    assertThatThrownBy(() -> users.create("", T0)).isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> users.create(null, T0)).isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> users.create("x", "n".repeat(65), "", T0)).isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> users.updateProfile(0, "a", null, T0)).isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void replaceAvatarReturnsPrevious() {
    User u = users.create("o", T0);
    assertThat(users.replaceAvatar(u.id(), "a1.png")).isEqualTo("");
    assertThat(users.replaceAvatar(u.id(), "b2.jpg")).isEqualTo("a1.png");
    assertThat(users.findById(u.id()).avatar()).isEqualTo("b2.jpg");
    assertThat(users.replaceAvatar(999, "c.png")).isNull();
  }

  // ---------- sessions ----------

  @Test
  void sessionsFormatResolveRevoke() {
    User u = users.create("o", T0);
    String token = sessions.create(u.id(), T0);
    assertThat(token).matches("^[0-9a-f]{64}$");
    assertThat(sessions.create(u.id(), T0)).isNotEqualTo(token);
    assertThat(sessions.resolve(token, T0 + 1000)).isEqualTo(u.id());
    assertThat(sessions.resolve("x".repeat(64), T0)).isNull();
    assertThat(sessions.resolve(token.toUpperCase(), T0)).isNull();
    assertThat(sessions.resolve("", T0)).isNull();
    assertThat(sessions.resolve(null, T0)).isNull();
    assertThat(sessions.resolve("0".repeat(64), T0)).isNull();
    assertThat(sessions.revoke(token)).isTrue();
    assertThat(sessions.revoke(token)).isFalse();
    assertThat(sessions.resolve(token, T0 + 1000)).isNull();
    assertThatThrownBy(() -> sessions.create(999, T0)).isInstanceOf(DataIntegrityViolationException.class);
    assertThatThrownBy(() -> sessions.create(0, T0)).isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void sessionsExpireAfter30Days() {
    User u = users.create("o", T0);
    String token = sessions.create(u.id(), T0);
    assertThat(jdbc.queryForObject("SELECT expires_at FROM sessions WHERE token = ?", Long.class, token))
        .isEqualTo(T0 + SessionRepository.SESSION_TTL_MS);
    assertThat(jdbc.queryForObject("SELECT created_at FROM sessions WHERE token = ?", Long.class, token)).isEqualTo(T0);
    String t2 = sessions.create(u.id(), T0);
    assertThat(sessions.resolve(t2, T0 + 30 * DAY)).isNull();
    assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM sessions WHERE token = ?", Integer.class, t2)).isZero();
    assertThat(sessions.resolve(token, T0 + 30 * DAY - 1)).isEqualTo(u.id());
  }

  @Test
  void sessionsSlidingRenewal() {
    User u = users.create("o", T0);
    String token = sessions.create(u.id(), T0);
    java.util.function.Supplier<Long> expires =
        () -> jdbc.queryForObject("SELECT expires_at FROM sessions WHERE token = ?", Long.class, token);
    // 第 10 天：剩 20 天，不续期
    assertThat(sessions.resolve(token, T0 + 10 * DAY)).isEqualTo(u.id());
    assertThat(expires.get()).isEqualTo(T0 + 30 * DAY);
    // 第 15 天整：剩 15 天，不续期（"不足 15 天"才续）
    assertThat(sessions.resolve(token, T0 + 15 * DAY)).isEqualTo(u.id());
    assertThat(expires.get()).isEqualTo(T0 + 30 * DAY);
    // 第 16 天：剩 14 天，续到第 46 天
    assertThat(sessions.resolve(token, T0 + 16 * DAY)).isEqualTo(u.id());
    assertThat(expires.get()).isEqualTo(T0 + 46 * DAY);
    assertThat(sessions.resolve(token, T0 + 45 * DAY)).isEqualTo(u.id());
    assertThat(expires.get()).isEqualTo(T0 + 75 * DAY);
    assertThat(sessions.resolve(token, T0 + 75 * DAY)).isNull();
  }

  @Test
  void sessionsCreatePurgesUsersExpiredTokens() {
    User a = users.create("a", T0);
    User b = users.create("b", T0);
    sessions.create(a.id(), T0);
    sessions.create(b.id(), T0);
    sessions.create(a.id(), T0 + 31 * DAY);
    List<List<Long>> rows = new ArrayList<>();
    jdbc.query("SELECT user_id, created_at FROM sessions ORDER BY user_id",
        rs -> {
          rows.add(List.of(rs.getLong(1), rs.getLong(2)));
        });
    assertThat(rows).containsExactly(List.of(a.id(), T0 + 31 * DAY), List.of(b.id(), T0));
  }

  @Test
  void sessionsKeepNewestTenAndPurgeExpired() {
    User u = users.create("o1", T0);
    User v = users.create("o2", T0);
    List<String> tokens = new ArrayList<>();
    for (int i = 0; i < SessionRepository.MAX_SESSIONS_PER_USER + 3; i++) tokens.add(sessions.create(u.id(), T0 + i));
    assertThat(sessions.resolve(tokens.get(0), T0 + 100)).as("最旧的被挤掉").isNull();
    assertThat(sessions.resolve(tokens.get(2), T0 + 100)).isNull();
    assertThat(sessions.resolve(tokens.get(3), T0 + 100)).isEqualTo(u.id());
    assertThat(sessions.resolve(tokens.get(tokens.size() - 1), T0 + 100)).isEqualTo(u.id());
    String old = sessions.create(v.id(), T0);
    String fresh = sessions.create(v.id(), T0 + 20 * DAY);
    long later = T0 + SessionRepository.SESSION_TTL_MS + 20;
    assertThat(sessions.purgeExpired(later)).isEqualTo(SessionRepository.MAX_SESSIONS_PER_USER + 1);
    assertThat(sessions.purgeExpired(later)).isZero();
    assertThat(sessions.resolve(old, later + 1)).isNull();
    assertThat(sessions.resolve(fresh, later + 1)).isEqualTo(v.id());
  }

  // ---------- transaction ----------

  @Test
  void transactionCommitRollbackNestedSavepoint() {
    assertThat(db.transaction(() -> {
      users.create("a", T0);
      return 42;
    })).isEqualTo(42);
    assertThat(users.findByOpenid("a")).isNotNull();

    assertThatThrownBy(() -> db.transaction(() -> {
      users.create("b", T0);
      throw new IllegalStateException("boom");
    })).hasMessageContaining("boom");
    assertThat(users.findByOpenid("b")).isNull();

    // 内层失败只回滚内层
    db.run(() -> {
      users.create("c", T0);
      assertThatThrownBy(() -> db.run(() -> {
        users.create("d", T0);
        throw new IllegalStateException("inner");
      })).hasMessageContaining("inner");
      users.create("e", T0);
    });
    assertThat(users.findByOpenid("c")).isNotNull();
    assertThat(users.findByOpenid("d")).isNull();
    assertThat(users.findByOpenid("e")).isNotNull();

    // 外层失败回滚全部（包括已提交到保存点的内层）
    assertThatThrownBy(() -> db.run(() -> {
      db.run(() -> users.create("f", T0));
      throw new IllegalStateException("outer");
    })).hasMessageContaining("outer");
    assertThat(users.findByOpenid("f")).isNull();
    assertThatThrownBy(() -> db.transaction(null)).isInstanceOf(IllegalArgumentException.class);

    db.run(() -> users.create("h", T0));
    assertThat(users.findByOpenid("h")).isNotNull();
  }
}
