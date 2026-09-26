package com.gamego.web;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.gamego.api.ActiveGamesProvider;
import com.gamego.api.PublicUsers;
import com.gamego.auth.AuthenticatedUser;
import com.gamego.auth.SecCheckResult;
import com.gamego.auth.WxSecurityService;
import com.gamego.config.GameGoProperties;
import com.gamego.db.GameRepository;
import com.gamego.db.StatsRepository;
import com.gamego.db.User;
import com.gamego.db.UserRepository;
import jakarta.servlet.http.HttpServletRequest;
import java.time.Clock;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RestController;

/** 我的资料、统计、头像（设计文档第 4 节）。 */
@RestController
public class MeController {

  private static final Logger log = LoggerFactory.getLogger(MeController.class);

  private final GameGoProperties props;
  private final UserRepository users;
  private final StatsRepository stats;
  private final GameRepository games;
  private final ActiveGamesProvider activeGames;
  private final WxSecurityService security;
  private final RequestBodies bodies;
  private final AvatarStore avatars;
  private final RateLimits limits;
  private final Clock clock;

  public MeController(GameGoProperties props, UserRepository users, StatsRepository stats, GameRepository games,
      ActiveGamesProvider activeGames, WxSecurityService security, RequestBodies bodies, AvatarStore avatars,
      RateLimits limits, Clock clock) {
    this.props = props;
    this.users = users;
    this.stats = stats;
    this.games = games;
    this.activeGames = activeGames;
    this.security = security;
    this.bodies = bodies;
    this.avatars = avatars;
    this.limits = limits;
    this.clock = clock;
  }

  private List<String> activeGameIds(long userId) {
    List<String> ids = new ArrayList<>();
    try {
      List<Map<String, Object>> list = activeGames.activeGamesOf(userId);
      if (list != null) {
        for (Map<String, Object> g : list) {
          if (g != null && g.get("id") instanceof String s) ids.add(s);
        }
      }
    } catch (RuntimeException e) {
      // 首页依赖 /api/me，这里出错只记日志，不让整个接口失败
      log.error("获取进行中的对局失败（用户 {}）：", userId, e);
      return new ArrayList<>();
    }
    return ids;
  }

  /** GET /api/me → {user, needProfile, stats, ai: {games, wins}, activeGameIds}。 */
  @GetMapping("/api/me")
  @RequireAuth
  public Map<String, Object> me(AuthenticatedUser me) {
    User u = me.user();
    GameRepository.AiRecord ai = games.aiRecord(u.id());
    Map<String, Object> aiMap = new LinkedHashMap<>();
    aiMap.put("games", ai.games());
    aiMap.put("wins", ai.wins());
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("user", PublicUsers.publicUser(u, props.getPublicBaseUrl()));
    m.put("needProfile", u.nickname() == null || u.nickname().isEmpty());
    m.put("stats", PublicUsers.publicStats(stats.get(u.id())));
    m.put("ai", aiMap);
    m.put("activeGameIds", activeGameIds(u.id()));
    return m;
  }

  /** PUT /api/me/profile {nickname} → {user}。 */
  @PutMapping("/api/me/profile")
  @RequireAuth
  public Map<String, Object> profile(AuthenticatedUser me, HttpServletRequest req) {
    ObjectNode body = bodies.readJsonObject(req);
    String nickname = Validation.validateNickname(body.get("nickname"));
    User u = me.user();
    if (!nickname.equals(u.nickname())) {
      SecCheckResult r = security.checkText(nickname, u.openid());
      if (!r.ok()) {
        if ("risky".equals(r.reason())) throw new ApiException(400, "content_risky", "昵称含有不合适的内容，请修改");
        // 微信要求被检测的用户近两小时访问过小程序：绕过小程序直接调接口会走到这里
        if ("visit_expired".equals(r.reason())) {
          throw new ApiException(400, "sec_check_retry", "请重新打开小程序后再修改昵称");
        }
        throw new ApiException(503, "sec_check_unavailable", "暂时无法检测昵称内容，请稍后再试", Map.of(), r.error());
      }
    }
    User updated = users.updateProfile(u.id(), nickname, null, clock.millis());
    if (updated == null) throw ApiException.notFound("用户不存在");
    return Map.of("user", PublicUsers.publicUser(updated, props.getPublicBaseUrl()));
  }

  /** POST /api/me/avatar（multipart 字段 file）→ {user}。 */
  @PostMapping("/api/me/avatar")
  @RequireAuth
  public Map<String, Object> avatar(AuthenticatedUser me, HttpServletRequest req) {
    long uid = me.id();
    if (!limits.avatar().take(uid)) throw RateLimits.limited(limits.avatar(), uid, "上传太频繁，请稍后再试");
    ConcurrencyLimit.Release release = limits.uploadSlots().acquire();
    if (release == null) {
      throw new ApiException(429, "rate_limited", "上传的人太多了，请稍后再试", Map.of("Retry-After", "3"), null);
    }
    try (release) {
      User updated = avatars.upload(req, uid, me.user().openid());
      return Map.of("user", PublicUsers.publicUser(updated, props.getPublicBaseUrl()));
    }
  }
}
