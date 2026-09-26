package com.gamego.web;

import org.springframework.core.MethodParameter;
import org.springframework.http.MediaType;
import org.springframework.http.converter.HttpMessageConverter;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyAdvice;

/** JSON 响应统一带 {@code Content-Type: application/json; charset=utf-8}（与 Node 版相同）。 */
@RestControllerAdvice(basePackages = "com.gamego.web")
public class JsonCharsetAdvice implements ResponseBodyAdvice<Object> {

  static final MediaType JSON_UTF8 = MediaType.parseMediaType("application/json; charset=utf-8");

  @Override
  public boolean supports(MethodParameter returnType, Class<? extends HttpMessageConverter<?>> converterType) {
    return true;
  }

  @Override
  public Object beforeBodyWrite(Object body, MethodParameter returnType, MediaType selected,
      Class<? extends HttpMessageConverter<?>> converterType, ServerHttpRequest req, ServerHttpResponse res) {
    if (selected != null && MediaType.APPLICATION_JSON.isCompatibleWith(selected)) {
      res.getHeaders().setContentType(JSON_UTF8);
    }
    return body;
  }
}
