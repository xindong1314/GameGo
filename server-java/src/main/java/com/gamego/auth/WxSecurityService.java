package com.gamego.auth;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.gamego.config.GameGoProperties;
import java.time.Clock;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * 微信内容安全检测（对应 Node 版 auth/wx-security.js）：昵称 → msgSecCheck 2.0（scene 1 = 资料），
 * 头像 → imgSecCheck（同步接口，图片 ≤1MB、≤750×1334）。
 *
 * <p>SEC_CHECK：off 不检测；on（默认）违规拒绝，微信出错时放行并记日志；strict 微信出错也拒绝。
 * 用户自己能控制的情况在任何模式下都拒绝：头像超出送检限制 → too_large；msgSecCheck 返回 61010 → visit_expired。
 * 只有配置了 WX_APPID/WX_SECRET 才检测；开发登录的用户（openid 为 dev:…）跳过。
 */
@Component
public class WxSecurityService {

  private static final Logger log = LoggerFactory.getLogger(WxSecurityService.class);

  public static final String STABLE_TOKEN_PATH = "/cgi-bin/stable_token";
  public static final String MSG_SEC_CHECK_PATH = "/wxa/msg_sec_check";
  public static final String IMG_SEC_CHECK_PATH = "/wxa/img_sec_check";
  static final long TIMEOUT_MS = 6000;
  /** access_token 无效 / 过期 → 刷新后重试一次。 */
  static final Set<Integer> TOKEN_ERRCODES = Set.of(40001, 40014, 42001);
  /** imgSecCheck：内容含有违法违规内容。 */
  static final int RISKY_ERRCODE = 87014;
  /** msgSecCheck：用户近两小时没有访问过小程序（只有绕过小程序直接调接口才会出现）。 */
  static final int VISIT_EXPIRED_ERRCODE = 61010;
  public static final int IMG_MAX_BYTES = 1024 * 1024;
  public static final int IMG_MAX_WIDTH = 750;
  public static final int IMG_MAX_HEIGHT = 1334;

  /** 微信那边出错（带 errcode）。 */
  static class SecCheckError extends Exception {
    final Integer errcode;

    SecCheckError(String msg, Integer errcode, Throwable cause) {
      super(msg, cause);
      this.errcode = errcode;
    }
  }

  private final WxHttp http;
  private final GameGoProperties props;
  private final ObjectMapper mapper;
  private final Clock clock;

  private String tokenValue;
  private long tokenExpiresAt;

  public WxSecurityService(WxHttp http, GameGoProperties props, ObjectMapper mapper, Clock clock) {
    this.http = http;
    this.props = props;
    this.mapper = mapper;
    this.clock = clock;
  }

  /** 是否启用检测（SEC_CHECK 不是 off 且配置了 AppID/AppSecret）。 */
  public boolean enabled() {
    return !"off".equals(props.getSecCheck()) && props.isWxConfigured();
  }

  /** 清掉缓存的 access_token（测试用）。 */
  public synchronized void reset() {
    tokenValue = null;
    tokenExpiresAt = 0;
  }

  private boolean skip(String openid) {
    return !enabled() || openid == null || openid.isEmpty() || openid.startsWith("dev:");
  }

  private String base() {
    return props.getWx().getApiBase();
  }

  private JsonNode parse(WxHttp.Response res) throws SecCheckError {
    if (res.status() < 200 || res.status() >= 300) throw new SecCheckError("微信接口返回 HTTP " + res.status(), null, null);
    JsonNode data;
    try {
      data = mapper.readTree(res.body());
    } catch (Exception e) {
      throw new SecCheckError("微信接口返回了无法解析的数据", null, e);
    }
    if (data == null || !data.isObject()) throw new SecCheckError("微信接口返回了无法解析的数据", null, null);
    return data;
  }

  private interface Call {
    WxHttp.Response send() throws WxHttp.WxHttpException;
  }

  private JsonNode fetchJson(Call call) throws SecCheckError {
    try {
      return parse(call.send());
    } catch (WxHttp.WxHttpException e) {
      throw new SecCheckError(e.isTimeout() ? "连接微信接口超时" : "无法连接微信接口", null, e);
    }
  }

  // 稳定版 access_token（不会让别处获取的令牌失效），缓存到过期前 5 分钟
  private synchronized String accessToken(boolean forceRefresh) throws SecCheckError {
    if (!forceRefresh && tokenValue != null && tokenExpiresAt > clock.millis()) return tokenValue;
    ObjectNode body = mapper.createObjectNode();
    body.put("grant_type", "client_credential");
    body.put("appid", props.getWx().getAppId());
    body.put("secret", props.getWx().getSecret());
    body.put("force_refresh", false);
    JsonNode data = fetchJson(() -> http.postJson(base() + STABLE_TOKEN_PATH, body.toString(), TIMEOUT_MS));
    JsonNode at = data.get("access_token");
    if (at == null || !at.isTextual() || at.asText().isEmpty()) {
      Integer ec = data.has("errcode") ? data.get("errcode").asInt() : null;
      throw new SecCheckError("获取 access_token 失败（" + ec + " " + data.path("errmsg").asText("") + "）", ec, null);
    }
    long expiresIn = data.path("expires_in").asLong(0);
    long ttl = Math.max(600, expiresIn > 0 ? expiresIn : 7200) * 1000;
    tokenValue = at.asText();
    tokenExpiresAt = clock.millis() + ttl - 300000;
    return tokenValue;
  }

  private interface TokenCall {
    JsonNode send(String token) throws SecCheckError;
  }

  // 带 access_token 调用；令牌失效时刷新后重试一次
  private JsonNode callWithToken(TokenCall send) throws SecCheckError {
    for (int attempt = 0; ; attempt++) {
      String t = accessToken(attempt > 0);
      JsonNode data = send.send(t);
      int code = data.path("errcode").asInt(0);
      if (TOKEN_ERRCODES.contains(code) && attempt == 0) {
        synchronized (this) {
          tokenValue = null;
        }
        continue;
      }
      return data;
    }
  }

  // 微信那边出错：两种模式都记下错误码，on 放行、strict 拒绝
  private SecCheckResult unavailable(String what, SecCheckError err) {
    String code = err.errcode != null ? "（errcode " + err.errcode + "）" : "";
    if ("strict".equals(props.getSecCheck())) {
      log.warn("{}内容安全检测失败{}，SEC_CHECK=strict 拒绝保存：{}", what, code, err.getMessage());
      return SecCheckResult.unavailable(err.getMessage() + code);
    }
    log.warn("{}内容安全检测未完成{}，按 SEC_CHECK=on 放行：{}", what, code, err.getMessage());
    return SecCheckResult.uncheckedPass(err.getMessage() + code);
  }

  /** 昵称 → ok / risky / visit_expired / unavailable。 */
  public SecCheckResult checkText(String content, String openid) {
    if (skip(openid)) return SecCheckResult.skip();
    try {
      JsonNode data =
          callWithToken(t -> {
            ObjectNode body = mapper.createObjectNode();
            body.put("content", content);
            body.put("version", 2);
            body.put("scene", 1);
            body.put("openid", openid);
            return fetchJson(() -> http.postJson(base() + MSG_SEC_CHECK_PATH + "?access_token=" + WechatClient.enc(t),
                body.toString(), TIMEOUT_MS));
          });
      int code = data.path("errcode").asInt(0);
      // 访问记录超时是调用方（用户）造成的：任何模式都拒绝，让他打开小程序后再改
      if (code == VISIT_EXPIRED_ERRCODE) return SecCheckResult.reject("visit_expired");
      if (code != 0) {
        throw new SecCheckError("msgSecCheck 出错（" + code + " " + data.path("errmsg").asText("") + "）", code, null);
      }
      String suggest = data.path("result").path("suggest").asText("");
      if ("risky".equals(suggest)) return SecCheckResult.reject("risky");
      if ("review".equals(suggest)) {
        log.info("昵称内容安全检测建议人工复核：{}（trace {}）", content, data.path("trace_id").asText(""));
      }
      return SecCheckResult.pass();
    } catch (SecCheckError e) {
      return unavailable("昵称", e);
    }
  }

  /** 头像（已通过结构检查的 PNG/JPEG）→ ok / risky / too_large / unavailable。type 为 png 或 jpg。 */
  public SecCheckResult checkImage(byte[] buffer, String openid, String type, long width, long height) {
    if (skip(openid)) return SecCheckResult.skip();
    if (buffer.length > IMG_MAX_BYTES || width > IMG_MAX_WIDTH || height > IMG_MAX_HEIGHT) {
      // imgSecCheck 只收 1MB、750×1334 以内的图片：送不了检的一律不保存（任何模式），否则传大图就能绕过检测
      return SecCheckResult.reject("too_large");
    }
    String mime = "jpg".equals(type) ? "image/jpeg" : "png".equals(type) ? "image/png" : "application/octet-stream";
    String ext = type == null ? "png" : type;
    try {
      JsonNode data =
          callWithToken(t -> fetchJson(() -> http.postFile(
              base() + IMG_SEC_CHECK_PATH + "?access_token=" + WechatClient.enc(t), "media", "avatar." + ext, mime,
              buffer, TIMEOUT_MS)));
      int code = data.path("errcode").asInt(0);
      if (code == RISKY_ERRCODE) return SecCheckResult.reject("risky");
      if (code != 0) {
        throw new SecCheckError("imgSecCheck 出错（" + code + " " + data.path("errmsg").asText("") + "）", code, null);
      }
      return SecCheckResult.pass();
    } catch (SecCheckError e) {
      return unavailable("头像", e);
    }
  }
}
