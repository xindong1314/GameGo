package com.gamego.web;

import com.gamego.auth.AuthenticatedUser;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.List;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.MethodParameter;
import org.springframework.core.Ordered;
import org.springframework.web.bind.support.WebDataBinderFactory;
import org.springframework.web.context.request.NativeWebRequest;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.method.support.ModelAndViewContainer;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/** 注册拦截器（限流与鉴权）、当前用户参数解析、通用响应头。 */
@Configuration
public class WebMvcConfig implements WebMvcConfigurer {

  private final ApiInterceptor interceptor;

  public WebMvcConfig(ApiInterceptor interceptor) {
    this.interceptor = interceptor;
  }

  @Override
  public void addInterceptors(InterceptorRegistry registry) {
    registry.addInterceptor(interceptor);
  }

  @Override
  public void addArgumentResolvers(List<HandlerMethodArgumentResolver> resolvers) {
    resolvers.add(new HandlerMethodArgumentResolver() {
      @Override
      public boolean supportsParameter(MethodParameter parameter) {
        return AuthenticatedUser.class.equals(parameter.getParameterType());
      }

      @Override
      public Object resolveArgument(MethodParameter parameter, ModelAndViewContainer mav, NativeWebRequest req,
          WebDataBinderFactory binderFactory) {
        Object a = req.getAttribute(ApiInterceptor.USER_ATTR, NativeWebRequest.SCOPE_REQUEST);
        if (a == null) throw ApiException.unauthorized("请先登录");
        return a;
      }
    });
  }

  /** 所有响应默认 Cache-Control: no-store 与 X-Content-Type-Options: nosniff（头像接口自己改成长期缓存）。 */
  @Bean
  public FilterRegistrationBean<OncePerRequestFilter> gameGoCommonHeadersFilter() {
    OncePerRequestFilter f = new OncePerRequestFilter() {
      @Override
      protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
          throws ServletException, IOException {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        chain.doFilter(req, res);
      }
    };
    FilterRegistrationBean<OncePerRequestFilter> reg = new FilterRegistrationBean<>(f);
    reg.setOrder(Ordered.HIGHEST_PRECEDENCE);
    reg.addUrlPatterns("/*");
    return reg;
  }
}
