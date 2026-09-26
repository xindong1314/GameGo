package com.gamego.web;

import jakarta.servlet.http.HttpServletRequest;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.NoHandlerFoundException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

/**
 * 统一错误格式：HTTP 4xx/5xx + {@code { error: { code, msg } }}（设计文档第 4 节，对应 Node 版 handleError）。
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

  private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

  static Map<String, Object> body(String code, String msg) {
    Map<String, Object> err = new LinkedHashMap<>();
    err.put("code", code);
    err.put("msg", msg);
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("error", err);
    return m;
  }

  @ExceptionHandler(ApiException.class)
  public ResponseEntity<Object> api(ApiException e, HttpServletRequest req) {
    // wx_not_configured 是预期状态（开发环境未配置微信登录，客户端据此改走 dev-login），不算错误
    if (e.getStatus() >= 500 && !"wx_not_configured".equals(e.getCode())) {
      String cause = e.getDetail() != null ? "（" + e.getDetail() + "）" : "";
      log.error("{} {} → {} {}：{}{}", req.getMethod(), req.getRequestURI(), e.getStatus(), e.getCode(), e.getMessage(), cause);
    } else {
      log.debug("{} {} → {} {}", req.getMethod(), req.getRequestURI(), e.getStatus(), e.getCode());
    }
    ResponseEntity.BodyBuilder b = ResponseEntity.status(e.getStatus());
    e.getHeaders().forEach(b::header);
    return b.body(body(e.getCode(), e.getMsg()));
  }

  @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
  public ResponseEntity<Object> methodNotAllowed(HttpRequestMethodNotSupportedException e) {
    Set<String> allowed = new LinkedHashSet<>();
    Set<HttpMethod> supported = e.getSupportedHttpMethods();
    if (supported != null) {
      for (HttpMethod m : supported) {
        allowed.add(m.name());
        if (m == HttpMethod.GET) allowed.add("HEAD");
      }
    }
    return ResponseEntity.status(405)
        .header(HttpHeaders.ALLOW, String.join(", ", allowed))
        .body(body("method_not_allowed", "请求方法不被允许"));
  }

  @ExceptionHandler({NoHandlerFoundException.class, NoResourceFoundException.class})
  public ResponseEntity<Object> notFound(Exception e) {
    return ResponseEntity.status(404).body(body("not_found", "接口不存在"));
  }

  /** 客户端在请求体传输完成前断开：无法再回错误，只记调试日志。 */
  @ExceptionHandler(RequestBodies.ClientGoneException.class)
  public ResponseEntity<Object> clientGone(RequestBodies.ClientGoneException e, HttpServletRequest req) {
    log.debug("{} {}：客户端提前断开", req.getMethod(), req.getRequestURI());
    return ResponseEntity.status(400).header(HttpHeaders.CONNECTION, "close").body(body("bad_request", "请求体不完整"));
  }

  @ExceptionHandler(Exception.class)
  public ResponseEntity<Object> internal(Exception e, HttpServletRequest req) {
    // Spring MVC 自带的 4xx 异常（缺参数、类型不支持等）按其状态码返回
    if (e instanceof org.springframework.web.ErrorResponse er && er.getStatusCode().is4xxClientError()) {
      int status = er.getStatusCode().value();
      String code = status == 404 ? "not_found" : status == 413 ? "too_large" : status == 415 ? "unsupported_media_type" : "bad_request";
      log.debug("{} {} → {}：{}", req.getMethod(), req.getRequestURI(), status, e.getMessage());
      return ResponseEntity.status(status).body(body(code, "请求参数不正确"));
    }
    log.error("处理请求出错 {} {}：", req.getMethod(), req.getRequestURI(), e);
    return ResponseEntity.status(500).body(body("internal", "服务器内部错误"));
  }
}
