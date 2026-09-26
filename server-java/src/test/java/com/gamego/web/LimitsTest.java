package com.gamego.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.gamego.testsupport.FakeWx;
import com.gamego.testsupport.IntegrationTestBase;
import com.gamego.testsupport.TestImages;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;

/** REST 限流、真实 IP、注销（对应 Node 测试 limits.test.js）。 */
class LimitsTest extends IntegrationTestBase {

  @Test
  void rateLimiterTokenBucket() {
    AtomicLong t = new AtomicLong(0);
    RateLimiter lim = new RateLimiter(3, 2, t::get);
    assertThat(lim.take("a")).isTrue();
    assertThat(lim.take("a")).isTrue();
    assertThat(lim.take("a")).isTrue();
    assertThat(lim.take("a")).isFalse();
    assertThat(lim.allows("a")).isFalse();
    assertThat(lim.retryAfterMs("a")).isEqualTo(500);
    assertThat(lim.take("b")).as("各键独立").isTrue();
    t.set(500);
    assertThat(lim.allows("a")).isTrue();
    assertThat(lim.take("a")).isTrue();
    assertThat(lim.take("a")).isFalse();
    t.set(10000);
    lim.prune();
    assertThat(lim.size()).isZero();
    assertThatThrownBy(() -> new RateLimiter(0, 1, t::get)).isInstanceOf(IllegalArgumentException.class);

    ConcurrencyLimit slots = new ConcurrencyLimit(2);
    ConcurrencyLimit.Release r1 = slots.acquire();
    ConcurrencyLimit.Release r2 = slots.acquire();
    assertThat(slots.acquire()).isNull();
    r1.close();
    r1.close(); // 重复释放无害
    assertThat(slots.active()).isEqualTo(1);
    assertThat(slots.acquire()).isNotNull();
    r2.close();
  }

  @Test
  void clientIpTrustsXRealIpOnlyFromLoopback() {
    assertThat(ClientIp.of("127.0.0.1", "1.2.3.4")).isEqualTo("1.2.3.4");
    assertThat(ClientIp.of("::ffff:127.0.0.1", "5.6.7.8")).isEqualTo("5.6.7.8");
    assertThat(ClientIp.of("0:0:0:0:0:0:0:1", "5.6.7.8")).isEqualTo("5.6.7.8");
    assertThat(ClientIp.of("9.9.9.9", "1.2.3.4")).as("外部直连伪造的头不算数").isEqualTo("9.9.9.9");
    assertThat(ClientIp.of("127.0.0.1", null)).isEqualTo("127.0.0.1");
  }

  @Test
  void loginLimitedPerIpWithRetryAfterAndXRealIp() {
    props.setDevLogin(true);
    props.getLimits().setLoginBurst(3);
    props.getLimits().setLoginPerSec(1);
    limits.reset();
    for (int i = 0; i < 3; i++) {
      assertThat(api("POST", "/api/auth/dev-login", null, Map.of("deviceId", "device_000" + i)).status()).isEqualTo(200);
    }
    Resp r = api("POST", "/api/auth/dev-login", null, Map.of("deviceId", "device_0009"));
    assertThat(r.status()).isEqualTo(429);
    assertThat(r.errorCode()).isEqualTo("rate_limited");
    assertThat(r.header("retry-after")).isEqualTo("1");
    // 微信登录接口共用同一个限额
    assertThat(api("POST", "/api/auth/login", null, Map.of("code", "x")).status()).isEqualTo(429);
    // nginx 转发的不同用户（X-Real-IP）不互相影响
    Resp other = api("POST", "/api/auth/dev-login", null, Map.of("deviceId", "device_0010"), Map.of("X-Real-IP", "10.0.0.8"));
    assertThat(other.status()).isEqualTo(200);
    clock.advance(1000);
    assertThat(api("POST", "/api/auth/dev-login", null, Map.of("deviceId", "device_0009")).status()).isEqualTo(200);
  }

  @Test
  void wxLoginConcurrencyCap() throws Exception {
    props.getWx().setAppId("wxid");
    props.getWx().setSecret("sec");
    props.getLimits().setLoginConcurrent(1);
    limits.reset();
    CountDownLatch gate = new CountDownLatch(1);
    CountDownLatch entered = new CountDownLatch(1);
    wx.setHandler(c -> {
      if (c.query().get("js_code").equals("c1")) {
        entered.countDown();
        gate.await(10, TimeUnit.SECONDS);
      }
      return FakeWx.Reply.json("{\"openid\":\"o-1\",\"session_key\":\"k\"}");
    });
    CompletableFuture<Resp> first = CompletableFuture.supplyAsync(() -> api("POST", "/api/auth/login", null, Map.of("code", "c1")));
    assertThat(entered.await(10, TimeUnit.SECONDS)).isTrue();
    Resp second = api("POST", "/api/auth/login", null, Map.of("code", "c2"));
    assertThat(second.status()).isEqualTo(429);
    assertThat(second.header("retry-after")).isEqualTo("2");
    gate.countDown();
    assertThat(first.get(10, TimeUnit.SECONDS).status()).isEqualTo(200);
    assertThat(api("POST", "/api/auth/login", null, Map.of("code", "c3")).status()).isEqualTo(200);
  }

  @Test
  void apiLimitedPerUserAvatarStricter() {
    props.setDevLogin(true);
    props.getLimits().setApiBurst(4);
    props.getLimits().setApiPerSec(1);
    props.getLimits().setAvatarBurst(2);
    props.getLimits().setAvatarPerSec(0.1);
    limits.reset();
    JsonNode a = devLogin("device_000a");
    JsonNode b = devLogin("device_000b");
    for (int i = 0; i < 4; i++) assertThat(api("GET", "/api/me", tokenOf(a)).status()).isEqualTo(200);
    Resp r = api("GET", "/api/me", tokenOf(a));
    assertThat(r.status()).isEqualTo(429);
    assertThat(r.errorCode()).isEqualTo("rate_limited");
    assertThat(api("GET", "/api/me", tokenOf(b)).status()).as("别的用户不受影响").isEqualTo(200);
    assertThat(api("GET", "/healthz").status()).as("不需要令牌的接口不计").isEqualTo(200);
    clock.advance(10000);
    assertThat(uploadAvatar(tokenOf(b), TestImages.PNG_BYTES).status()).isEqualTo(200);
    assertThat(uploadAvatar(tokenOf(b), TestImages.PNG_BYTES).status()).isEqualTo(200);
    Resp third = uploadAvatar(tokenOf(b), TestImages.PNG_BYTES);
    assertThat(third.status()).isEqualTo(429);
    assertThat(third.header("retry-after")).isEqualTo("10");
  }

  @Test
  void logoutRevokesOnlyCurrentToken() {
    props.setDevLogin(true);
    JsonNode one = devLogin("device_0001");
    JsonNode two = devLogin("device_0001"); // 同一用户另一台设备
    Resp r = api("POST", "/api/auth/logout", tokenOf(one));
    assertThat(r.status()).isEqualTo(200);
    assertThat(r.json().toString()).isEqualTo("{\"ok\":true}");
    assertThat(api("GET", "/api/me", tokenOf(one)).status()).isEqualTo(401);
    assertThat(api("GET", "/api/me", tokenOf(two)).status()).isEqualTo(200);
    assertThat(api("POST", "/api/auth/logout").status()).isEqualTo(401);
  }
}
