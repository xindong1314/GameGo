package com.gamego.web;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * REST 统一错误（对应 Node 版 http/errors.js 的 HttpError）：HTTP 状态码 + {@code { error: { code, msg } }}，
 * 可附带响应头（如 429 的 Retry-After）。
 */
public class ApiException extends RuntimeException {
  private final int status;
  private final String code;
  private final String msg;
  private final Map<String, String> headers;
  /** 附在服务端日志里的底层原因（不返回给客户端），如微信接口的 errcode。 */
  private final String detail;

  public ApiException(int status, String code, String msg) {
    this(status, code, msg, Map.of(), null);
  }

  public ApiException(int status, String code, String msg, Map<String, String> headers, String detail) {
    super(msg == null || msg.isEmpty() ? code : msg);
    this.status = status;
    this.code = code;
    this.msg = msg == null ? "" : msg;
    this.headers = headers == null ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(headers));
    this.detail = detail;
  }

  public int getStatus() {
    return status;
  }

  public String getCode() {
    return code;
  }

  public String getMsg() {
    return msg;
  }

  public Map<String, String> getHeaders() {
    return headers;
  }

  public String getDetail() {
    return detail;
  }

  // ---------- 常用错误 ----------

  public static ApiException badRequest(String msg) {
    return new ApiException(400, "bad_request", msg == null ? "请求参数不正确" : msg);
  }

  public static ApiException unauthorized(String msg) {
    return new ApiException(401, "unauthorized", msg == null ? "请先登录" : msg);
  }

  public static ApiException notFound(String msg) {
    return new ApiException(404, "not_found", msg == null ? "资源不存在" : msg);
  }

  public static ApiException rateLimited(String msg, long retryAfterSecs) {
    return new ApiException(429, "rate_limited", msg == null ? "请求太频繁，请稍后再试" : msg,
        Map.of("Retry-After", String.valueOf(retryAfterSecs)), null);
  }

  /** 413 too_large「请求内容过大（上限 16KB / 2MB）」。 */
  public static ApiException tooLarge(long limit) {
    String kb = limit >= 1024 * 1024 ? Math.round(limit / 1024.0 / 1024.0) + "MB" : Math.round(limit / 1024.0) + "KB";
    return new ApiException(413, "too_large", "请求内容过大（上限 " + kb + "）");
  }

  public static ApiException unsupportedMediaType(String msg) {
    return new ApiException(415, "unsupported_media_type", msg);
  }
}
