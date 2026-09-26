package com.gamego.web;

import static org.assertj.core.api.Assertions.assertThat;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.fasterxml.jackson.databind.JsonNode;
import com.gamego.auth.WxSecurityService;
import com.gamego.testsupport.FakeWx;
import com.gamego.testsupport.IntegrationTestBase;
import com.gamego.testsupport.TestImages;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

/** 服务端内容安全检测：昵称 msgSecCheck 2.0、头像 imgSecCheck；用本地假微信接口（对应 Node 测试 security.test.js）。 */
class SecurityTest extends IntegrationTestBase {

  /** 假微信接口的选项。 */
  static final class Opts {
    String risky;
    boolean imgRisky;
    boolean msgHttp500;
    boolean expireOnce;
    Integer msgErrcode;
  }

  private void fakeWx(Opts o) {
    props.getWx().setAppId("wxid");
    props.getWx().setSecret("sec");
    AtomicInteger expire = new AtomicInteger(o.expireOnce ? 1 : 0);
    AtomicInteger tokenN = new AtomicInteger();
    wx.setHandler(c -> {
      switch (c.path()) {
        case "/sns/jscode2session":
          return FakeWx.Reply.json("{\"openid\":\"o-" + c.query().get("js_code") + "\",\"session_key\":\"k\"}");
        case "/cgi-bin/stable_token":
          return FakeWx.Reply.json("{\"access_token\":\"AT" + tokenN.incrementAndGet() + "\",\"expires_in\":7200}");
        case "/wxa/msg_sec_check": {
          if (o.msgHttp500) return FakeWx.Reply.status(500, "{}");
          if (o.msgErrcode != null) {
            return FakeWx.Reply.json("{\"errcode\":" + o.msgErrcode + ",\"errmsg\":\"errcode " + o.msgErrcode + "\"}");
          }
          if (expire.getAndDecrement() > 0) return FakeWx.Reply.json("{\"errcode\":40001,\"errmsg\":\"invalid credential\"}");
          JsonNode body = mapper.readTree(c.body());
          boolean risky = o.risky != null && body.get("content").asText().contains(o.risky);
          return FakeWx.Reply.json("{\"errcode\":0,\"errmsg\":\"ok\",\"result\":{\"suggest\":\"" + (risky ? "risky" : "pass")
              + "\",\"label\":100},\"trace_id\":\"t1\"}");
        }
        case "/wxa/img_sec_check":
          return FakeWx.Reply.json(o.imgRisky ? "{\"errcode\":87014,\"errmsg\":\"risky content\"}" : "{\"errcode\":0,\"errmsg\":\"ok\"}");
        default:
          return FakeWx.Reply.status(404, "{\"errcode\":-1}");
      }
    });
  }

  private JsonNode wxUser(String code) {
    Resp r = api("POST", "/api/auth/login", null, Map.of("code", code));
    assertThat(r.status()).isEqualTo(200);
    return r.json();
  }

  private Resp putNick(String token, String nick) {
    return api("PUT", "/api/me/profile", token, Map.of("nickname", nick));
  }

  @Test
  void nicknameRiskyRejectedPassSavedTokenCached() throws Exception {
    Opts o = new Opts();
    o.risky = "违规";
    fakeWx(o);
    String token = tokenOf(wxUser("c1"));
    Resp bad = putNick(token, "违规昵称");
    assertThat(bad.status()).isEqualTo(400);
    assertThat(bad.errorCode()).isEqualTo("content_risky");
    assertThat(users.findById(1).nickname()).isEmpty();
    Resp ok = putNick(token, "好棋手");
    assertThat(ok.status()).isEqualTo(200);
    assertThat(ok.json().get("user").get("nickname").asText()).isEqualTo("好棋手");
    List<FakeWx.Call> checks = wx.of("/wxa/msg_sec_check");
    assertThat(checks).hasSize(2);
    JsonNode body = mapper.readTree(checks.get(1).body());
    assertThat(body.toString()).isEqualTo("{\"content\":\"好棋手\",\"version\":2,\"scene\":1,\"openid\":\"o-c1\"}");
    assertThat(checks.get(1).query().get("access_token")).isEqualTo("AT1");
    assertThat(wx.of("/cgi-bin/stable_token")).as("access_token 缓存").hasSize(1);
    assertThat(mapper.readTree(wx.of("/cgi-bin/stable_token").get(0).body()).toString())
        .isEqualTo("{\"grant_type\":\"client_credential\",\"appid\":\"wxid\",\"secret\":\"sec\",\"force_refresh\":false}");
    // 昵称没变不重复检测
    putNick(token, " 好棋手 ");
    assertThat(wx.of("/wxa/msg_sec_check")).hasSize(2);
  }

  @Test
  void nicknameTokenExpiredRefreshOnce() {
    Opts o = new Opts();
    o.expireOnce = true;
    fakeWx(o);
    String token = tokenOf(wxUser("c1"));
    assertThat(putNick(token, "棋手").status()).isEqualTo(200);
    assertThat(wx.of("/cgi-bin/stable_token")).hasSize(2);
    assertThat(wx.of("/wxa/msg_sec_check").get(1).query().get("access_token")).isEqualTo("AT2");
  }

  @Test
  void nicknameWxErrorOnPassesStrictRejects() {
    Opts o = new Opts();
    o.msgHttp500 = true;
    fakeWx(o);
    String a = tokenOf(wxUser("c1"));
    assertThat(putNick(a, "棋手").status()).isEqualTo(200);

    props.setSecCheck("strict");
    security.reset();
    String b = tokenOf(wxUser("c2"));
    Resp r = putNick(b, "棋手");
    assertThat(r.status()).isEqualTo(503);
    assertThat(r.errorCode()).isEqualTo("sec_check_unavailable");
  }

  @Test
  void skippedForDevUsersUnconfiguredOrOff() {
    Opts o = new Opts();
    o.risky = "违规";
    fakeWx(o);
    props.setDevLogin(true);
    String token = tokenOf(devLogin("device_0001"));
    assertThat(putNick(token, "违规").status()).isEqualTo(200);
    assertThat(uploadAvatar(token, TestImages.PNG_BYTES).status()).isEqualTo(200);
    assertThat(wx.calls()).isEmpty();

    props.setSecCheck("off");
    String u = tokenOf(wxUser("c1"));
    assertThat(putNick(u, "违规").status()).isEqualTo(200);
    assertThat(wx.of("/wxa/msg_sec_check")).isEmpty();

    props.setSecCheck("on");
    props.getWx().setSecret("");
    assertThat(security.enabled()).isFalse();
  }

  @Test
  void avatarRiskyRejectedNotSavedPassSaved() throws Exception {
    Opts o = new Opts();
    o.imgRisky = true;
    fakeWx(o);
    String a = tokenOf(wxUser("c1"));
    Resp r = uploadAvatar(a, TestImages.PNG_BYTES);
    assertThat(r.status()).isEqualTo(400);
    assertThat(r.errorCode()).isEqualTo("content_risky");
    try (var s = Files.list(Path.of(props.getAvatarDir()))) {
      assertThat(s.count()).isZero();
    }
    assertThat(users.findById(1).avatar()).isEmpty();

    security.reset();
    wx.reset();
    fakeWx(new Opts());
    String b = tokenOf(wxUser("c2"));
    assertThat(uploadAvatar(b, TestImages.PNG_BYTES).status()).isEqualTo(200);
    FakeWx.Call call = wx.of("/wxa/img_sec_check").get(0);
    assertThat(call.query().get("access_token")).isEqualTo("AT1");
    assertThat(call.contentType()).startsWith("multipart/form-data");
    assertThat(call.bodyText()).contains("name=\"media\"");
  }

  @Test
  void avatarOverImgSecCheckLimitsRejectedInAnyMode() {
    byte[] big = TestImages.pngOf(1000, 1000);
    Opts o = new Opts();
    o.imgRisky = true;
    fakeWx(o);
    String a = tokenOf(wxUser("c1"));
    Resp r1 = uploadAvatar(a, TestImages.pngOf(751, 751));
    assertThat(r1.status()).isEqualTo(400);
    assertThat(r1.errorMsg()).contains("太大");
    assertThat(uploadAvatar(a, big).status()).isEqualTo(400);
    assertThat(users.findById(1).avatar()).as("没有保存").isEmpty();
    assertThat(uploadAvatar(a, TestImages.pngOf(750, 750)).errorCode()).as("限制以内的照常送检").isEqualTo("content_risky");
    assertThat(wx.of("/wxa/img_sec_check")).hasSize(1);

    // 不检测的情况（SEC_CHECK=off）仍按 2048 的上限收
    props.setSecCheck("off");
    fakeWx(new Opts());
    String c = tokenOf(wxUser("c3"));
    assertThat(uploadAvatar(c, big).status()).isEqualTo(200);

    props.setSecCheck("strict");
    String b = tokenOf(wxUser("c2"));
    Resp r = uploadAvatar(b, big);
    assertThat(r.status()).isEqualTo(400);
    assertThat(r.errorMsg()).contains("太大");
  }

  @Test
  void nickname61010RejectedInOnAndStrict() {
    for (String mode : List.of("on", "strict")) {
      props.setSecCheck(mode);
      security.reset();
      Opts o = new Opts();
      o.msgErrcode = 61010;
      fakeWx(o);
      String token = tokenOf(wxUser("c-" + mode));
      Resp r = putNick(token, "随便什么");
      assertThat(r.status()).as(mode).isEqualTo(400);
      assertThat(r.errorCode()).isEqualTo("sec_check_retry");
      assertThat(r.errorMsg()).contains("重新打开小程序");
    }
    // 微信那边的错误（如 -1 系统繁忙）仍按模式处理：on 放行
    props.setSecCheck("on");
    security.reset();
    Opts busy = new Opts();
    busy.msgErrcode = -1;
    fakeWx(busy);
    String b = tokenOf(wxUser("c-busy"));
    assertThat(putNick(b, "棋手").status()).isEqualTo(200);
  }

  @Test
  void wxErrcodeLoggedInBothModes() {
    Logger secLog = (Logger) LoggerFactory.getLogger(WxSecurityService.class);
    Logger errLog = (Logger) LoggerFactory.getLogger(GlobalExceptionHandler.class);
    ListAppender<ILoggingEvent> app = new ListAppender<>();
    app.start();
    secLog.addAppender(app);
    errLog.addAppender(app);
    try {
      props.setSecCheck("strict");
      Opts o = new Opts();
      o.msgErrcode = 40164;
      fakeWx(o);
      String a = tokenOf(wxUser("c1"));
      assertThat(putNick(a, "棋手").status()).isEqualTo(503);
      assertThat(app.list.stream().anyMatch(e -> e.getLevel().toString().equals("WARN")
          && e.getFormattedMessage().contains("40164"))).as("warn 日志应含 errcode").isTrue();
      assertThat(app.list.stream().anyMatch(e -> e.getLevel().toString().equals("ERROR")
          && e.getFormattedMessage().contains("40164"))).as("503 的 error 日志应含原因").isTrue();

      app.list.clear();
      props.setSecCheck("on");
      Opts q = new Opts();
      q.msgErrcode = 45009;
      fakeWx(q);
      String b = tokenOf(wxUser("c2"));
      assertThat(putNick(b, "棋手").status()).isEqualTo(200);
      assertThat(app.list.stream().anyMatch(e -> e.getFormattedMessage().contains("45009"))).isTrue();
    } finally {
      secLog.detachAppender(app);
      errLog.detachAppender(app);
    }
  }

  @Test
  void malformedJpegWithTrailingFfIs400NotError() {
    props.setDevLogin(true);
    String token = tokenOf(devLogin("device_ff01"));
    for (String hex : List.of("ffd8ffffffffffe0", "ffd8ffffffffffffffffe000", "ffd8ffe0")) {
      Resp r = uploadAvatar(token, java.util.HexFormat.of().parseHex(hex));
      assertThat(r.status()).as(hex).isEqualTo(400);
      assertThat(r.errorCode()).isEqualTo("bad_request");
    }
  }
}
