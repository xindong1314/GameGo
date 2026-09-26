package com.gamego.web;

import jakarta.servlet.RequestDispatcher;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import org.springframework.boot.web.servlet.error.ErrorController;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Spring MVC 之外的错误（如过滤器、容器转发到 /error 的错误）也按 {@code { error: { code, msg } }} 返回，
 * 代替 Spring Boot 默认的错误页。
 */
@RestController
public class JsonErrorController implements ErrorController {

  @RequestMapping("/error")
  public ResponseEntity<Object> error(HttpServletRequest req) {
    Object s = req.getAttribute(RequestDispatcher.ERROR_STATUS_CODE);
    int status = s instanceof Integer i ? i : 500;
    Map<String, Object> body =
        switch (status) {
          case 400 -> GlobalExceptionHandler.body("bad_request", "请求参数不正确");
          case 404 -> GlobalExceptionHandler.body("not_found", "接口不存在");
          case 405 -> GlobalExceptionHandler.body("method_not_allowed", "请求方法不被允许");
          case 413 -> GlobalExceptionHandler.body("too_large", "请求内容过大");
          default -> {
            if (status < 500 && status >= 400) yield GlobalExceptionHandler.body("bad_request", "请求参数不正确");
            status = 500;
            yield GlobalExceptionHandler.body("internal", "服务器内部错误");
          }
        };
    return ResponseEntity.status(status).body(body);
  }
}
