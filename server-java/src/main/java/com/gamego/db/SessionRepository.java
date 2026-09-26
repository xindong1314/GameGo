package com.gamego.db;

import com.gamego.db.mapper.DbRows.SessionRow;
import com.gamego.db.mapper.SessionMapper;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.regex.Pattern;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * 登录令牌（设计文档 3.1 sessions）：32 字节随机数的 hex（64 位小写），有效期 30 天；
 * resolve 时剩余不足 15 天则续到 30 天；每个用户只保留最新的 10 个令牌。
 */
@Repository
public class SessionRepository {

  public static final long DAY_MS = 86400000L;
  /** 令牌有效期 30 天。 */
  public static final long SESSION_TTL_MS = 30 * DAY_MS;
  /** 剩余不足 15 天时续到 30 天。 */
  public static final long SESSION_RENEW_BELOW_MS = 15 * DAY_MS;
  /** 每个用户最多保留的令牌数（多出来的最旧的作废）。 */
  public static final int MAX_SESSIONS_PER_USER = 10;

  public static final Pattern TOKEN_RE = Pattern.compile("^[0-9a-f]{64}$");

  private static final SecureRandom RANDOM = new SecureRandom();

  private final SessionMapper mapper;

  public SessionRepository(SessionMapper mapper) {
    this.mapper = mapper;
  }

  /** 发一个新令牌（顺手清理该用户已过期的令牌，并只保留最新的 10 个）。用户不存在时抛 DataIntegrityViolationException。 */
  @Transactional(propagation = Propagation.NESTED)
  public String create(long userId, long now) {
    Checks.userId(userId, "sessions.create", "userId");
    byte[] bytes = new byte[32];
    RANDOM.nextBytes(bytes);
    String token = HexFormat.of().formatHex(bytes);
    // 先用不加锁的查询找出要删的令牌，再按主键逐条删除：新用户没有任何会话时，
    // 范围 DELETE 会在索引上加间隙锁，两个新用户同时登录会在随后的 INSERT 上互相等待而死锁（MySQL）
    for (String old : mapper.userExpiredTokens(userId, now)) mapper.delete(old);
    mapper.insert(token, userId, now, now + SESSION_TTL_MS);
    for (String old : mapper.tokensBeyond(userId, MAX_SESSIONS_PER_USER)) mapper.delete(old);
    return token;
  }

  /** 有效返回 userId；格式不对、不存在、过期返回 null（过期的顺手删除）。剩余不足 15 天时续到 30 天。 */
  public Long resolve(String token, long now) {
    if (token == null || !TOKEN_RE.matcher(token).matches()) return null;
    SessionRow row = mapper.get(token);
    if (row == null) return null;
    if (row.expiresAt <= now) {
      mapper.delete(token);
      return null;
    }
    if (row.expiresAt - now < SESSION_RENEW_BELOW_MS) mapper.extend(token, now + SESSION_TTL_MS);
    return row.userId;
  }

  /** 注销一个令牌；不存在返回 false。 */
  public boolean revoke(String token) {
    if (token == null || token.isEmpty()) return false;
    return mapper.delete(token) > 0;
  }

  /** 删除所有已过期的令牌（服务启动时与每小时执行一次），返回删除条数。 */
  public int purgeExpired(long now) {
    return mapper.purgeExpired(now);
  }
}
