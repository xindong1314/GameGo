package com.gamego.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.gamego.auth.AuthService;
import com.gamego.auth.AuthenticatedUser;
import com.gamego.config.GameGoProperties;
import com.gamego.db.SessionRepository;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/** 登录、开发登录、注销（设计文档第 4 节）。 */
@RestController
public class AuthController {

  private final AuthService auth;
  private final RequestBodies bodies;
  private final RateLimits limits;
  private final GameGoProperties props;
  private final SessionRepository sessions;

  public AuthController(AuthService auth, RequestBodies bodies, RateLimits limits, GameGoProperties props,
      SessionRepository sessions) {
    this.auth = auth;
    this.bodies = bodies;
    this.limits = limits;
    this.props = props;
    this.sessions = sessions;
  }

  static String textOrNull(JsonNode n) {
    return n != null && n.isTextual() ? n.asText() : null;
  }

  /** POST /api/auth/login {code} → {token, user, needProfile}。 */
  @PostMapping("/api/auth/login")
  @LoginRateLimited
  public Map<String, Object> login(HttpServletRequest req) {
    ObjectNode body = bodies.readJsonObject(req);
    // 每次登录都要请求一次微信 code2Session：限制同时在途的数量，防止刷接口占满连接、耗尽调用额度
    ConcurrencyLimit.Release release = limits.loginSlots().acquire();
    if (release == null) {
      throw new ApiException(429, "rate_limited", "登录的人太多了，请稍后再试", Map.of("Retry-After", "2"), null);
    }
    try (release) {
      return auth.login(textOrNull(body.get("code")));
    }
  }

  /** POST /api/auth/dev-login {deviceId}：仅 DEV_LOGIN=1 时存在，否则 404（连请求体都不读）。 */
  @PostMapping("/api/auth/dev-login")
  @LoginRateLimited
  public Map<String, Object> devLogin(HttpServletRequest req) {
    if (!props.isDevLogin()) throw ApiException.notFound("接口不存在");
    ObjectNode body = bodies.readJsonObject(req);
    return auth.devLogin(textOrNull(body.get("deviceId")));
  }

  /** 注销当前令牌（其他设备上的令牌不受影响；已建立的 WebSocket 连接在断开前不受影响）。 */
  @PostMapping("/api/auth/logout")
  @RequireAuth
  public Map<String, Object> logout(AuthenticatedUser me) {
    sessions.revoke(me.token());
    return Map.of("ok", true);
  }
}
