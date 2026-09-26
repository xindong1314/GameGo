package com.gamego.web;

import com.gamego.auth.AuthService;
import com.gamego.auth.AuthenticatedUser;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerInterceptor;

/**
 * 路由匹配之后、处理之前的检查，顺序与 Node 版相同：登录限流（按 IP）→ 鉴权（401）→ 接口限流（按用户，429）。
 */
@Component
public class ApiInterceptor implements HandlerInterceptor {

  /** 当前用户在请求属性里的键。 */
  public static final String USER_ATTR = ApiInterceptor.class.getName() + ".user";

  private final AuthService auth;
  private final RateLimits limits;

  public ApiInterceptor(AuthService auth, RateLimits limits) {
    this.auth = auth;
    this.limits = limits;
  }

  @Override
  public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
    if (!(handler instanceof HandlerMethod hm)) return true;
    if (hm.hasMethodAnnotation(LoginRateLimited.class)) {
      String ip = ClientIp.of(request);
      if (!limits.login().take(ip)) throw RateLimits.limited(limits.login(), ip, "登录太频繁，请稍后再试");
    }
    if (hm.hasMethodAnnotation(RequireAuth.class)) {
      AuthenticatedUser a = auth.authenticate(request.getHeader("Authorization"));
      request.setAttribute(USER_ATTR, a);
      if (!limits.api().take(a.id())) throw RateLimits.limited(limits.api(), a.id(), null);
    }
    return true;
  }
}
