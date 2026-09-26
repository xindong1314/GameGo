package com.gamego.auth;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.gamego.config.GameGoProperties;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * 微信小程序登录：用 wx.login 得到的 code 换取 openid（对应 Node 版 auth/wechat.js）。
 * 文档：https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/user-login/code2Session.html
 */
@Component
public class WechatClient {

  public static final String JSCODE2SESSION_PATH = "/sns/jscode2session";
  public static final long DEFAULT_TIMEOUT_MS = 8000;

  /** 常见错误码的中文说明（msg 会返回给客户端，不含任何密钥）。 */
  static final Map<Integer, String> ERRCODE_MSG =
      Map.of(
          -1, "微信系统繁忙，请稍后再试",
          40029, "登录凭证无效或已过期，请重新登录",
          40163, "登录凭证已被使用，请重新登录",
          45011, "登录过于频繁，请稍后再试",
          40226, "该微信账号存在风险，登录被拦截",
          40013, "服务器配置的 AppID 无效",
          40125, "服务器配置的 AppSecret 无效");

  /** code2Session 的结果。 */
  public record Session(String openid, String sessionKey, String unionid) {}

  private final WxHttp http;
  private final GameGoProperties props;
  private final ObjectMapper mapper;
  private volatile long timeoutMs = DEFAULT_TIMEOUT_MS;

  public WechatClient(WxHttp http, GameGoProperties props, ObjectMapper mapper) {
    this.http = http;
    this.props = props;
    this.mapper = mapper;
  }

  /** 超时（毫秒，测试用）。 */
  public void setTimeoutMs(long timeoutMs) {
    this.timeoutMs = timeoutMs;
  }

  static String enc(String s) {
    return URLEncoder.encode(s, StandardCharsets.UTF_8).replace("+", "%20");
  }

  /** code → openid；失败抛 {@link WxLoginException}（带中文说明与 errcode）。 */
  public Session code2Session(String appId, String secret, String code) throws WxLoginException {
    if (appId == null || appId.isEmpty() || secret == null || secret.isEmpty()) {
      throw new WxLoginException("服务器未配置微信 AppID/AppSecret");
    }
    if (code == null || code.isEmpty()) throw new WxLoginException("缺少登录凭证 code");
    String url =
        props.getWx().getApiBase() + JSCODE2SESSION_PATH + "?appid=" + enc(appId) + "&secret=" + enc(secret)
            + "&js_code=" + enc(code) + "&grant_type=authorization_code";
    WxHttp.Response res;
    try {
      res = http.get(url, timeoutMs);
    } catch (WxHttp.WxHttpException e) {
      if (e.isTimeout()) throw new WxLoginException("连接微信服务器超时", null, e);
      throw new WxLoginException("无法连接微信服务器", null, e);
    }
    if (res.status() < 200 || res.status() >= 300) {
      throw new WxLoginException("微信服务器返回 HTTP " + res.status());
    }
    JsonNode data;
    try {
      data = mapper.readTree(res.body());
    } catch (Exception e) {
      throw new WxLoginException("微信服务器返回了无法解析的数据", null, e);
    }
    if (data == null || !data.isObject()) throw new WxLoginException("微信服务器返回了无法解析的数据");

    JsonNode ec = data.get("errcode");
    int errcode = ec == null || ec.isNull() ? 0 : ec.asInt();
    if (errcode != 0) {
      String known = ERRCODE_MSG.get(errcode);
      String detail = data.path("errmsg").isTextual() ? data.get("errmsg").asText() : "";
      if (detail.length() > 200) detail = detail.substring(0, 200);
      String msg = known != null ? known : "微信登录失败（" + errcode + (detail.isEmpty() ? "" : "：" + detail) + "）";
      throw new WxLoginException(msg, errcode, null);
    }
    JsonNode openid = data.get("openid");
    if (openid == null || !openid.isTextual() || openid.asText().isEmpty() || openid.asText().length() > 128) {
      throw new WxLoginException("微信服务器没有返回 openid");
    }
    return new Session(
        openid.asText(),
        data.path("session_key").isTextual() ? data.get("session_key").asText() : "",
        data.path("unionid").isTextual() ? data.get("unionid").asText() : "");
  }
}
