package com.gamego.web;

import jakarta.servlet.http.HttpServletRequest;
import java.util.Set;

/** 客户端 IP：只有请求来自本机（nginx 反向代理）时才相信 X-Real-IP，否则用 TCP 对端地址。 */
public final class ClientIp {
  static final Set<String> LOOPBACK = Set.of("127.0.0.1", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1");

  private ClientIp() {}

  public static String of(HttpServletRequest req) {
    return of(req.getRemoteAddr(), req.getHeader("X-Real-IP"));
  }

  public static String of(String peer, String realIp) {
    String p = peer == null ? "" : peer;
    if (LOOPBACK.contains(p) && realIp != null && !realIp.isEmpty() && realIp.length() <= 64) return realIp.trim();
    return p;
  }
}
