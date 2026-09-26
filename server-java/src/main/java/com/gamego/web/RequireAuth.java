package com.gamego.web;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * 需要令牌（Authorization: Bearer）的接口：缺失或失效返回 401；之后按用户限流（突发 60、每秒 10）。
 * 方法参数声明 {@link com.gamego.auth.AuthenticatedUser} 即可拿到当前用户。
 */
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface RequireAuth {}
