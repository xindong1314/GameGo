package com.gamego.ws;

import com.gamego.auth.AuthService;
import com.gamego.db.User;
import com.gamego.game.Json;
import com.gamego.game.Msg;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;
import org.springframework.web.util.UriComponentsBuilder;

/**
 * WebSocket 握手校验（对应 Node 版 hub._onUpgrade）：接受连接前校验令牌，失败回 401 JSON 并关闭。
 * 令牌优先取 {@code Authorization: Bearer} 头（不会出现在访问日志里），没有时取 {@code ?token=}；
 * 每个用户建立连接的频率有限（突发 10 次、每 6 秒恢复 1 次），超出回 429；服务器启动中 / 关闭中回 503。
 */
public class WsHandshakeInterceptor implements HandshakeInterceptor {

  private static final Logger log = LoggerFactory.getLogger(WsHandshakeInterceptor.class);
  static final Pattern BEARER_RE = Pattern.compile("^Bearer[ \\t]+(\\S+)[ \\t]*$", Pattern.CASE_INSENSITIVE);
  static final String ATTR_USER_ID = "gamego.userId";
  static final String ATTR_HUB = "gamego.hub";

  private final Realtime realtime;
  private final AuthService auth;

  public WsHandshakeInterceptor(Realtime realtime, AuthService auth) {
    this.realtime = realtime;
    this.auth = auth;
  }

  /** 令牌：Authorization: Bearer &lt;token&gt; 优先，其次 ?token=。 */
  static String tokenOf(ServerHttpRequest req) {
    List<String> hs = req.getHeaders().get(HttpHeaders.AUTHORIZATION);
    String h = hs == null || hs.isEmpty() ? null : hs.get(0);
    if (h != null && !h.isEmpty()) {
      Matcher m = BEARER_RE.matcher(h);
      if (m.matches()) return m.group(1);
    }
    String raw = UriComponentsBuilder.fromUri(req.getURI()).build().getQueryParams().getFirst("token");
    if (raw == null) return null;
    try {
      return URLDecoder.decode(raw, StandardCharsets.UTF_8);
    } catch (IllegalArgumentException e) {
      return raw;
    }
  }

  static void reject(ServerHttpResponse res, HttpStatus status, String code, String msg) {
    try {
      byte[] body = Json.write(Msg.of("error", Msg.of("code", code, "msg", msg))).getBytes(StandardCharsets.UTF_8);
      res.setStatusCode(status);
      res.getHeaders().setContentType(new MediaType("application", "json", StandardCharsets.UTF_8));
      res.getHeaders().set(HttpHeaders.CONNECTION, "close");
      res.getHeaders().setContentLength(body.length);
      res.getBody().write(body);
      res.flush();
    } catch (Exception e) {
      log.debug("回复握手失败：{}", e.getMessage());
    }
  }

  @Override
  public boolean beforeHandshake(
      ServerHttpRequest req, ServerHttpResponse res, WebSocketHandler handler, Map<String, Object> attrs) {
    String upgrade = req.getHeaders().getUpgrade();
    if (upgrade == null || !upgrade.equalsIgnoreCase("websocket")) {
      reject(res, HttpStatus.NOT_FOUND, "not_found", "不存在");
      return false;
    }
    Hub hub = realtime.hub();
    if (hub == null || hub.isClosed() || !hub.isStarted()) {
      reject(res, HttpStatus.SERVICE_UNAVAILABLE, "shutting_down", hub == null || !hub.isClosed() ? "服务器正在启动" : "服务器正在关闭");
      return false;
    }
    String token = tokenOf(req);
    Long userId = null;
    if (token != null && !token.isEmpty() && token.length() <= 256) {
      try {
        User u = auth.resolveToken(token);
        userId = u == null ? null : u.id();
      } catch (RuntimeException err) {
        log.error("校验 WebSocket 令牌失败", err);
        reject(res, HttpStatus.INTERNAL_SERVER_ERROR, "internal", "服务器内部错误");
        return false;
      }
    }
    if (userId == null || userId <= 0) {
      reject(res, HttpStatus.UNAUTHORIZED, "unauthorized", "登录已失效");
      return false;
    }
    if (!hub.takeUpgrade(userId)) {
      log.warn("用户 {} 重连过于频繁，拒绝", userId);
      reject(res, HttpStatus.TOO_MANY_REQUESTS, "rate_limited", "连接过于频繁，请稍后再试");
      return false;
    }
    attrs.put(ATTR_USER_ID, userId);
    attrs.put(ATTR_HUB, hub);
    return true;
  }

  @Override
  public void afterHandshake(ServerHttpRequest req, ServerHttpResponse res, WebSocketHandler handler, Exception ex) {}
}
