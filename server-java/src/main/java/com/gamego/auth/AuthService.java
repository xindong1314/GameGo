package com.gamego.auth;

import com.gamego.api.PublicUsers;
import com.gamego.config.GameGoProperties;
import com.gamego.db.DbTransactions;
import com.gamego.db.SessionRepository;
import com.gamego.db.User;
import com.gamego.db.UserRepository;
import com.gamego.web.ApiException;
import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;

/**
 * 登录与鉴权（设计文档第 4 节，对应 Node 版 auth/index.js）：
 *
 * <ul>
 *   <li>{@link #login(String)} 微信登录：code → openid → 查找或创建用户 → 发令牌；
 *   <li>{@link #devLogin(String)} 开发登录：仅 DEV_LOGIN=1；openid 为 {@code dev:<deviceId>}；
 *   <li>{@link #authenticate(String)} 解析 Authorization 头（失败抛 401）；
 *   <li>{@link #resolveToken(String)} 只校验令牌（WebSocket 握手用）。
 * </ul>
 */
@Service
public class AuthService {

  private static final Logger log = LoggerFactory.getLogger(AuthService.class);

  public static final Pattern DEVICE_ID_RE = Pattern.compile("^[A-Za-z0-9_-]{8,64}$");
  /** wx.login 的 code 是可见 ASCII 字符串（通常 32 位左右），这里只做宽松的格式校验。 */
  static final Pattern WX_CODE_RE = Pattern.compile("^[\\x21-\\x7e]{1,256}$");
  static final Pattern BEARER_RE = Pattern.compile("^Bearer[ \\t]+(\\S+)[ \\t]*$", Pattern.CASE_INSENSITIVE);

  private final GameGoProperties props;
  private final UserRepository users;
  private final SessionRepository sessions;
  private final DbTransactions db;
  private final WechatClient wechat;
  private final Clock clock;

  public AuthService(
      GameGoProperties props,
      UserRepository users,
      SessionRepository sessions,
      DbTransactions db,
      WechatClient wechat,
      Clock clock) {
    this.props = props;
    this.users = users;
    this.sessions = sessions;
    this.db = db;
    this.wechat = wechat;
    this.clock = clock;
  }

  private record Issued(User user, String token) {}

  /** 查找或创建用户、记录登录时间、发令牌（同一事务）。返回 {@code { token, user, needProfile }}。 */
  public Map<String, Object> issue(String openid) {
    long t = clock.millis();
    Issued issued;
    try {
      issued = db.transaction(() -> issueTx(openid, t));
    } catch (DuplicateKeyException e) {
      // 同一 openid 并发首次登录：另一个请求刚创建了用户，重试一次即可找到
      issued = db.transaction(() -> issueTx(openid, t));
    }
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("token", issued.token());
    out.put("user", PublicUsers.publicUser(issued.user(), props.getPublicBaseUrl()));
    out.put("needProfile", issued.user().nickname() == null || issued.user().nickname().isEmpty());
    return out;
  }

  private Issued issueTx(String openid, long t) {
    User u = users.findByOpenid(openid);
    if (u == null) {
      u = users.create(openid, t);
    } else {
      users.touchLogin(u.id(), t);
      u = users.findById(u.id());
    }
    return new Issued(u, sessions.create(u.id(), t));
  }

  /** 微信登录：未配置 AppID/AppSecret → 503 wx_not_configured；code 不合法 → 400；微信接口失败 → 502 wx_login_failed。 */
  public Map<String, Object> login(String code) {
    if (!props.isWxConfigured()) throw new ApiException(503, "wx_not_configured", "服务器未配置微信登录");
    if (code == null || !WX_CODE_RE.matcher(code).matches()) throw ApiException.badRequest("缺少或无效的登录凭证 code");
    WechatClient.Session session;
    try {
      session = wechat.code2Session(props.getWx().getAppId(), props.getWx().getSecret(), code);
    } catch (WxLoginException e) {
      log.warn("微信登录失败：{}{}", e.getMessage(), e.getErrcode() != null ? "（errcode " + e.getErrcode() + "）" : "");
      throw new ApiException(502, "wx_login_failed", e.getMessage(), Map.of(),
          e.getCause() != null ? e.getCause().toString() : null);
    }
    return issue(session.openid());
  }

  /** 开发登录：未开启时 404（假装接口不存在）；deviceId 须为 8~64 位字母、数字、下划线或连字符。 */
  public Map<String, Object> devLogin(String deviceId) {
    if (!props.isDevLogin()) throw ApiException.notFound("接口不存在");
    if (deviceId == null || !DEVICE_ID_RE.matcher(deviceId).matches()) {
      throw ApiException.badRequest("deviceId 须为 8~64 位字母、数字、下划线或连字符");
    }
    return issue("dev:" + deviceId);
  }

  /** 解析 Authorization 头（{@code Bearer <token>}），失败抛 401 unauthorized。 */
  public AuthenticatedUser authenticate(String header) {
    if (header == null || header.isEmpty()) throw ApiException.unauthorized("请先登录");
    Matcher m = BEARER_RE.matcher(header);
    if (!m.matches()) throw ApiException.unauthorized("登录凭证格式不正确");
    String token = m.group(1);
    Long userId = sessions.resolve(token, clock.millis());
    if (userId == null) throw ApiException.unauthorized("登录已失效，请重新登录");
    User user = users.findById(userId);
    if (user == null) throw ApiException.unauthorized("用户不存在，请重新登录");
    return new AuthenticatedUser(user, token);
  }

  /** 校验令牌（滑动续期），有效返回用户，否则 null。WebSocket 握手（Authorization 头或 ?token=）用。 */
  public User resolveToken(String token) {
    Long userId = sessions.resolve(token, clock.millis());
    return userId == null ? null : users.findById(userId);
  }
}
