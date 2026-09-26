package com.gamego.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.gamego.config.GameGoProperties;
import com.gamego.testsupport.FakeWx;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** code2Session（对应 Node 测试 wechat.test.js），HTTP 调用打到本地的假微信接口。 */
class WechatClientTest {

  private FakeWx wx;
  private GameGoProperties props;
  private WechatClient client;

  @BeforeEach
  void setUp() throws Exception {
    wx = new FakeWx();
    props = new GameGoProperties();
    props.getWx().setApiBase(wx.base());
    client = new WechatClient(new WxHttp(), props, new ObjectMapper());
  }

  @AfterEach
  void tearDown() {
    wx.close();
  }

  private WxLoginException fail(String appId, String secret, String code) {
    try {
      client.code2Session(appId, secret, code);
    } catch (WxLoginException e) {
      return e;
    }
    throw new AssertionError("应当失败");
  }

  @Test
  void successReturnsOpenidWithCorrectParams() throws Exception {
    wx.setHandler(c -> FakeWx.Reply.json("{\"openid\":\"oABC\",\"session_key\":\"sk\",\"unionid\":\"un\"}"));
    WechatClient.Session r = client.code2Session("wxapp", "s&cret", "code/1");
    assertThat(r).isEqualTo(new WechatClient.Session("oABC", "sk", "un"));
    List<FakeWx.Call> calls = wx.calls();
    assertThat(calls).hasSize(1);
    assertThat(calls.get(0).path()).isEqualTo("/sns/jscode2session");
    assertThat(calls.get(0).method()).isEqualTo("GET");
    assertThat(calls.get(0).query().get("appid")).isEqualTo("wxapp");
    assertThat(calls.get(0).query().get("secret")).isEqualTo("s&cret");
    assertThat(calls.get(0).query().get("js_code")).isEqualTo("code/1");
    assertThat(calls.get(0).query().get("grant_type")).isEqualTo("authorization_code");

    wx.setHandler(c -> FakeWx.Reply.json("{\"openid\":\"o2\",\"errcode\":0}"));
    assertThat(client.code2Session("a", "b", "c")).isEqualTo(new WechatClient.Session("o2", "", ""));
  }

  @Test
  void errcodeMappedToChineseMessage() {
    wx.setHandler(c -> FakeWx.Reply.json("{\"errcode\":40029,\"errmsg\":\"invalid code, rid: 1\"}"));
    WxLoginException e = fail("a", "b", "c");
    assertThat(e.getErrcode()).isEqualTo(40029);
    assertThat(e.getMessage()).contains("登录凭证无效");
    wx.setHandler(c -> FakeWx.Reply.json("{\"errcode\":12345,\"errmsg\":\"strange\"}"));
    assertThat(fail("a", "b", "c").getMessage()).contains("12345：strange");
    wx.setHandler(c -> FakeWx.Reply.json("{\"errcode\":-1,\"errmsg\":\"system error\"}"));
    assertThat(fail("a", "b", "c").getMessage()).contains("系统繁忙");
  }

  @Test
  void networkHttpBadDataMissingOpenid() {
    record Case(FakeWx.Handler h, String re) {}
    List<Case> cases = List.of(
        new Case(c -> FakeWx.Reply.status(502, "bad gateway"), "HTTP 502"),
        new Case(c -> FakeWx.Reply.json("<html>"), "无法解析"),
        new Case(c -> FakeWx.Reply.json("null"), "无法解析"),
        new Case(c -> FakeWx.Reply.json("{\"session_key\":\"x\"}"), "没有返回 openid"),
        new Case(c -> FakeWx.Reply.json("{\"openid\":\"\"}"), "没有返回 openid"));
    for (Case k : cases) {
      wx.setHandler(k.h());
      WxLoginException e = fail("a", "b&", "c");
      assertThat(e.getMessage()).contains(k.re());
      assertThat(e.getMessage()).doesNotContain("b&").doesNotContain("secret");
    }
    props.getWx().setApiBase("http://127.0.0.1:1");
    assertThat(fail("a", "b", "c").getMessage()).contains("无法连接微信服务器");
  }

  @Test
  void timeoutEvenIfServerNeverAnswers() {
    wx.setHandler(c -> new FakeWx.Reply(200, "{\"openid\":\"x\"}", 3000));
    client.setTimeoutMs(200);
    long started = System.currentTimeMillis();
    assertThat(fail("a", "b", "c").getMessage()).contains("超时");
    assertThat(System.currentTimeMillis() - started).isLessThan(2000);
  }

  @Test
  void missingParamsFailWithoutRequest() {
    wx.setHandler(c -> FakeWx.Reply.json("{\"openid\":\"x\"}"));
    assertThatThrownBy(() -> client.code2Session("", "b", "c")).isInstanceOf(WxLoginException.class);
    assertThatThrownBy(() -> client.code2Session("a", "", "c")).isInstanceOf(WxLoginException.class);
    assertThatThrownBy(() -> client.code2Session("a", "b", "")).isInstanceOf(WxLoginException.class);
    assertThatThrownBy(() -> client.code2Session("a", "b", null)).isInstanceOf(WxLoginException.class);
    assertThat(wx.calls()).isEmpty();
  }
}
