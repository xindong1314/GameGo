package com.gamego.web;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.gamego.db.GameFinish;
import com.gamego.db.NewGame;
import com.gamego.testsupport.FakeWx;
import com.gamego.testsupport.IntegrationTestBase;
import com.gamego.testsupport.TestImages;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpRequest;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/** 每个 REST 接口（对应 Node 测试 http.test.js）。 */
class HttpApiTest extends IntegrationTestBase {

  private static final byte[] PNG = TestImages.PNG_BYTES;
  private static final byte[] JPEG = TestImages.JPEG_BYTES;

  private void wxConfigured() {
    props.getWx().setAppId("wxid");
    props.getWx().setSecret("sec");
  }

  // ---------- 基础 ----------

  @Test
  void healthzNotFoundMethodNotAllowedHead() {
    Resp h = api("GET", "/healthz");
    assertThat(h.status()).isEqualTo(200);
    assertThat(h.json().toString()).isEqualTo("{\"ok\":true}");
    assertThat(h.header("content-type")).startsWith("application/json");
    assertThat(h.header("cache-control")).isEqualTo("no-store");
    assertThat(h.header("x-content-type-options")).isEqualTo("nosniff");

    Resp nf = api("GET", "/api/nope");
    assertThat(nf.status()).isEqualTo(404);
    assertThat(nf.errorCode()).isEqualTo("not_found");
    assertThat(nf.errorMsg()).isNotEmpty();

    Resp m = api("DELETE", "/api/me");
    assertThat(m.status()).isEqualTo(405);
    assertThat(m.errorCode()).isEqualTo("method_not_allowed");
    assertThat(m.header("allow")).contains("GET");

    RawResp head = raw("HEAD", "/healthz");
    assertThat(head.status()).isEqualTo(200);
    assertThat(head.body()).isEmpty();
  }

  // ---------- 开发登录 ----------

  @Test
  void devLoginDisabledIs404WithoutReadingBody() {
    Resp r = api("POST", "/api/auth/dev-login", null, Map.of("deviceId", "abcdefgh"));
    assertThat(r.status()).isEqualTo(404);
    assertThat(r.errorCode()).isEqualTo("not_found");
    Resp r2 = api("POST", "/api/auth/dev-login", null, "{bad", Map.of("Content-Type", "application/json"));
    assertThat(r2.status()).isEqualTo(404);
  }

  @Test
  void devLoginIssuesTokenSameDeviceSameUserValidatesDeviceId() {
    props.setDevLogin(true);
    Resp r = api("POST", "/api/auth/dev-login", null, Map.of("deviceId", "device_0001"));
    assertThat(r.status()).isEqualTo(200);
    assertThat(r.json().get("token").asText()).matches("^[0-9a-f]{64}$");
    assertThat(r.json().get("user").toString()).isEqualTo("{\"id\":1,\"nickname\":\"\",\"avatarUrl\":\"\"}");
    assertThat(r.json().get("needProfile").asBoolean()).isTrue();
    assertThat(users.findById(1).openid()).isEqualTo("dev:device_0001");

    clock.advance(5000);
    Resp again = api("POST", "/api/auth/dev-login", null, Map.of("deviceId", "device_0001"));
    assertThat(again.json().get("user").get("id").asLong()).isEqualTo(1);
    assertThat(again.json().get("token").asText()).isNotEqualTo(r.json().get("token").asText());
    assertThat(users.findById(1).lastLoginAt()).isEqualTo(T0 + 5000);

    List<String> bad = List.of("{\"deviceId\":\"short\"}", "{\"deviceId\":\"" + "x".repeat(65) + "\"}",
        "{\"deviceId\":\"has space1\"}", "{\"deviceId\":\"bad/char!\"}", "{\"deviceId\":12345678}", "{\"deviceId\":null}",
        "{}");
    for (String body : bad) {
      Resp b = api("POST", "/api/auth/dev-login", null, body, Map.of("Content-Type", "application/json"));
      assertThat(b.status()).as(body).isEqualTo(400);
      assertThat(b.errorCode()).isEqualTo("bad_request");
    }
  }

  // ---------- 微信登录 ----------

  @Test
  void loginNotConfiguredIs503() {
    props.getWx().setAppId("wxid");
    Resp r = api("POST", "/api/auth/login", null, Map.of("code", "abc"));
    assertThat(r.status()).isEqualTo(503);
    assertThat(r.errorCode()).isEqualTo("wx_not_configured");
  }

  @Test
  void loginCodeToOpenidFindOrCreateIssueToken() {
    wxConfigured();
    wx.setHandler(c -> FakeWx.Reply.json("{\"openid\":\"o-" + c.query().get("js_code") + "\",\"session_key\":\"k\"}"));
    Resp r = api("POST", "/api/auth/login", null, Map.of("code", "c1"));
    assertThat(r.status()).isEqualTo(200);
    assertThat(r.json().get("token").asText()).matches("^[0-9a-f]{64}$");
    assertThat(r.json().get("user").toString()).isEqualTo("{\"id\":1,\"nickname\":\"\",\"avatarUrl\":\"\"}");
    assertThat(r.json().get("needProfile").asBoolean()).isTrue();
    FakeWx.Call call = wx.of("/sns/jscode2session").get(0);
    assertThat(call.query().get("appid")).isEqualTo("wxid");
    assertThat(call.query().get("secret")).isEqualTo("sec");
    assertThat(call.query().get("grant_type")).isEqualTo("authorization_code");
    assertThat(users.findById(1).openid()).isEqualTo("o-c1");

    users.updateProfile(1, "老王", null, T0);
    Resp r2 = api("POST", "/api/auth/login", null, Map.of("code", "c1"));
    assertThat(r2.json().get("user").get("id").asLong()).isEqualTo(1);
    assertThat(r2.json().get("user").get("nickname").asText()).isEqualTo("老王");
    assertThat(r2.json().get("needProfile").asBoolean()).isFalse();
    assertThat(api("POST", "/api/auth/login", null, Map.of("code", "c2")).json().get("user").get("id").asLong()).isEqualTo(2);

    Resp me = api("GET", "/api/me", tokenOf(r.json()));
    assertThat(me.status()).isEqualTo(200);
    assertThat(me.json().get("user").get("id").asLong()).isEqualTo(1);
    // dev-login 在未开启时仍不可用
    assertThat(api("POST", "/api/auth/dev-login", null, Map.of("deviceId", "abcdefgh")).status()).isEqualTo(404);
  }

  @Test
  void loginWxErrorIs502AndBodyErrors() {
    wxConfigured();
    wx.setHandler(c -> FakeWx.Reply.json("{\"errcode\":40029,\"errmsg\":\"invalid code\"}"));
    Resp r = api("POST", "/api/auth/login", null, Map.of("code", "bad"));
    assertThat(r.status()).isEqualTo(502);
    assertThat(r.errorCode()).isEqualTo("wx_login_failed");
    assertThat(r.errorMsg()).contains("登录凭证无效");
    assertThat(users.findById(1)).isNull();

    assertThat(api("POST", "/api/auth/login", null, Map.of()).status()).isEqualTo(400);
    assertThat(api("POST", "/api/auth/login", null, Map.of("code", "has space")).status()).isEqualTo(400);
    assertThat(api("POST", "/api/auth/login", null, Map.of("code", 42)).status()).isEqualTo(400);
    Resp badJson = api("POST", "/api/auth/login", null, "{\"code\":", Map.of("Content-Type", "application/json"));
    assertThat(badJson.status()).isEqualTo(400);
    assertThat(badJson.errorCode()).isEqualTo("bad_request");
    assertThat(api("POST", "/api/auth/login", null, List.of("code")).status()).isEqualTo(400);
    Resp form = api("POST", "/api/auth/login", null, "code=1", Map.of("Content-Type", "application/x-www-form-urlencoded"));
    assertThat(form.status()).isEqualTo(415);
    assertThat(form.errorCode()).isEqualTo("unsupported_media_type");
    Resp big = api("POST", "/api/auth/login", null, Map.of("code", "a", "pad", "x".repeat(17 * 1024)));
    assertThat(big.status()).isEqualTo(413);
    assertThat(big.errorCode()).isEqualTo("too_large");
    assertThat(big.errorMsg()).contains("16KB");
    assertThat(api("GET", "/healthz").status()).isEqualTo(200);
  }

  @Test
  void loginNetworkErrorIs502() {
    wxConfigured();
    props.getWx().setApiBase("http://127.0.0.1:1"); // 没有服务在听
    Resp r = api("POST", "/api/auth/login", null, Map.of("code", "c"));
    assertThat(r.status()).isEqualTo(502);
    assertThat(r.errorCode()).isEqualTo("wx_login_failed");
  }

  // ---------- 鉴权 ----------

  @Test
  void authMissingMalformedInvalidExpiredAre401() {
    props.setDevLogin(true);
    String token = tokenOf(devLogin("device_0001"));
    String[][] paths = {{"GET", "/api/me"}, {"PUT", "/api/me/profile"}, {"POST", "/api/me/avatar"},
        {"GET", "/api/leaderboard"}, {"GET", "/api/games"}, {"GET", "/api/games/abc"}, {"POST", "/api/auth/logout"}};
    for (String[] p : paths) {
      Resp r = api(p[0], p[1]);
      assertThat(r.status()).as(p[0] + " " + p[1]).isEqualTo(401);
      assertThat(r.errorCode()).isEqualTo("unauthorized");
    }
    for (String header : List.of(token, "Basic " + token, "Bearer", "Bearer " + "0".repeat(64), "Bearer " + token + "x")) {
      Resp r = api("GET", "/api/me", null, null, Map.of("Authorization", header));
      assertThat(r.status()).as(header).isEqualTo(401);
    }
    assertThat(api("GET", "/api/me", null, null, Map.of("Authorization", "bearer  " + token)).status()).isEqualTo(200);

    clock.advance(30 * DAY);
    Resp expired = api("GET", "/api/me", token);
    assertThat(expired.status()).isEqualTo(401);
    assertThat(expired.errorCode()).isEqualTo("unauthorized");
  }

  @Test
  void authSlidingRenewal() {
    props.setDevLogin(true);
    String token = tokenOf(devLogin("device_0001"));
    clock.advance(20 * DAY);
    assertThat(api("GET", "/api/me", token).status()).isEqualTo(200);
    clock.advance(20 * DAY); // 距登录 40 天，续期后仍有效
    assertThat(api("GET", "/api/me", token).status()).isEqualTo(200);
  }

  // ---------- /api/me ----------

  @Test
  void meReturnsUserStatsAiRecordActiveGames() {
    props.setDevLogin(true);
    JsonNode a = devLogin("device_000a");
    JsonNode b = devLogin("device_000b");
    long aid = userIdOf(a);
    long bid = userIdOf(b);
    activeGames.fn = uid -> uid == aid
        ? List.of(Map.of("id", "game00000001", "mode", "ranked"), Map.of("id", "game00000002", "mode", "ai"))
        : List.of();
    String gid = insertRanked(aid, bid, T0);
    games.finish(gid, GameFinish.of(1, "resign"), T0 + 1);
    stats.applyWin(gid, aid, bid, T0 + 1);
    for (int winner : new int[] {1, 2}) {
      String id = gameId();
      games.insert(new NewGame().id(id).mode("ai").size(9).komi(7.5).blackId(aid).aiLevel("k5").createdAt(T0));
      games.finish(id, GameFinish.of(winner, "score").scores(50, 38.5), T0 + 2);
    }
    Resp r = api("GET", "/api/me", tokenOf(a));
    assertThat(r.status()).isEqualTo(200);
    JsonNode j = r.json();
    assertThat(j.get("user").toString()).isEqualTo("{\"id\":" + aid + ",\"nickname\":\"\",\"avatarUrl\":\"\"}");
    assertThat(j.get("needProfile").asBoolean()).isTrue();
    assertThat(j.get("stats").get("games").asInt()).isEqualTo(1);
    assertThat(j.get("stats").get("wins").asInt()).isEqualTo(1);
    assertThat(j.get("stats").get("losses").asInt()).isZero();
    assertThat(j.get("stats").get("draws").asInt()).isZero();
    assertThat(j.get("stats").get("winrate").asDouble()).isEqualTo(1.0);
    assertThat(j.get("stats").get("curStreak").asInt()).isEqualTo(1);
    assertThat(j.get("stats").get("maxStreak").asInt()).isEqualTo(1);
    assertThat(fieldNames(j.get("stats")))
        .containsExactly("games", "wins", "losses", "draws", "winrate", "curStreak", "maxStreak");
    assertThat(j.get("ai").toString()).isEqualTo("{\"games\":2,\"wins\":1}");
    assertThat(j.get("activeGameIds").toString()).isEqualTo("[\"game00000001\",\"game00000002\"]");
    assertThat(fieldNames(j)).containsExactly("user", "needProfile", "stats", "ai", "activeGameIds");

    JsonNode rb = api("GET", "/api/me", tokenOf(b)).json();
    assertThat(rb.get("stats").get("losses").asInt()).isEqualTo(1);
    assertThat(rb.get("stats").get("winrate").asDouble()).isZero();
    assertThat(rb.get("activeGameIds").size()).isZero();
  }

  @Test
  void meActiveGamesErrorDoesNotBreak() {
    props.setDevLogin(true);
    activeGames.fn = uid -> {
      throw new IllegalStateException("boom");
    };
    JsonNode a = devLogin("device_000a");
    Resp r = api("GET", "/api/me", tokenOf(a));
    assertThat(r.status()).isEqualTo(200);
    assertThat(r.json().get("activeGameIds").size()).isZero();
  }

  static List<String> fieldNames(JsonNode n) {
    List<String> out = new java.util.ArrayList<>();
    n.fieldNames().forEachRemaining(out::add);
    return out;
  }

  // ---------- 资料 ----------

  @Test
  void profileTrimsCountsCodePointsRejectsControlChars() {
    props.setDevLogin(true);
    String token = tokenOf(devLogin("device_0001"));
    java.util.function.Function<Object, Resp> put = nick -> {
      Map<String, Object> body = new HashMap<>();
      body.put("nickname", nick);
      return api("PUT", "/api/me/profile", token, body);
    };
    Resp ok = put.apply("  小明  ");
    assertThat(ok.status()).isEqualTo(200);
    assertThat(ok.json().toString()).isEqualTo("{\"user\":{\"id\":1,\"nickname\":\"小明\",\"avatarUrl\":\"\"}}");
    assertThat(api("GET", "/api/me", token).json().get("needProfile").asBoolean()).isFalse();

    String emoji16 = new String(Character.toChars(0x1f600)).repeat(16); // 16 个码点、32 个 UTF-16 单元
    assertThat(put.apply(emoji16).status()).isEqualTo(200);
    assertThat(put.apply("一二三四五六七八九十一二三四五六").status()).isEqualTo(200);
    assertThat(put.apply("a").status()).isEqualTo(200);
    // 组合 emoji（含零宽连接符）允许
    StringBuilder fam = new StringBuilder();
    for (int cp : new int[] {0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467}) fam.appendCodePoint(cp);
    String family = fam.toString();
    assertThat(put.apply(family).json().get("user").get("nickname").asText()).isEqualTo(family);

    List<Object> bad = Arrays.asList("", "   ", "一二三四五六七八九十一二三四五六七",
        new String(Character.toChars(0x1f600)).repeat(17), "a\u0000b", "a\u0007b", "tab\tin", "nl\nin", "del\u007f",
        "c1\u0085", "rtl‮x", "zw​x", "ls x", "bom﻿x", 123, null, List.of("a"));
    for (Object nick : bad) {
      Resp r = put.apply(nick);
      assertThat(r.status()).as(String.valueOf(nick)).isEqualTo(400);
      assertThat(r.errorCode()).isEqualTo("bad_request");
    }
    // 落单的代理项（JSON 里的 \ud800）
    Resp lone = api("PUT", "/api/me/profile", token, "{\"nickname\":\"lone\\ud800\"}", Map.of("Content-Type", "application/json"));
    assertThat(lone.status()).isEqualTo(400);
    assertThat(api("PUT", "/api/me/profile", token, Map.of()).status()).isEqualTo(400);
    assertThat(users.findById(1).nickname()).isEqualTo(family);
  }

  // ---------- 头像 ----------

  @Test
  void avatarUploadServeReplaceDeletesOld() throws IOException {
    props.setDevLogin(true);
    String token = tokenOf(devLogin("device_0001"));
    Resp up = uploadAvatar(token, PNG, "file", "tmp_1", "application/octet-stream");
    assertThat(up.status()).isEqualTo(200);
    Matcher m = Pattern.compile("^https://go\\.example\\.com/avatars/([a-z0-9]+\\.png)$")
        .matcher(up.json().get("user").get("avatarUrl").asText());
    assertThat(m.matches()).isTrue();
    String first = m.group(1);
    Path firstPath = Path.of(props.getAvatarDir(), first);
    assertThat(Files.readAllBytes(firstPath)).isEqualTo(PNG);
    assertThat(users.findById(1).avatar()).isEqualTo(first);
    assertThat(api("GET", "/api/me", token).json().get("user").get("avatarUrl").asText())
        .isEqualTo(up.json().get("user").get("avatarUrl").asText());

    RawResp img = raw("GET", "/avatars/" + first);
    assertThat(img.status()).isEqualTo(200);
    assertThat(img.head().toLowerCase()).contains("content-type: image/png");
    assertThat(img.head().toLowerCase()).contains("content-length: " + PNG.length);
    assertThat(img.head().toLowerCase()).containsPattern("cache-control: public, max-age=\\d+");
    assertThat(img.head().toLowerCase()).contains("x-content-type-options: nosniff");
    assertThat(img.head().toLowerCase()).contains("last-modified: ");
    assertThat(img.body()).isEqualTo(PNG);
    RawResp head = raw("HEAD", "/avatars/" + first);
    assertThat(head.status()).isEqualTo(200);
    assertThat(head.body()).isEmpty();

    // 客户端声称是 PNG，实际是 JPEG：按魔数存成 .jpg
    Resp up2 = uploadAvatar(token, JPEG, "file", "x.png", "image/png");
    assertThat(up2.status()).isEqualTo(200);
    Matcher m2 = Pattern.compile("/avatars/([a-z0-9]+\\.jpg)$").matcher(up2.json().get("user").get("avatarUrl").asText());
    assertThat(m2.find()).isTrue();
    String second = m2.group(1);
    assertThat(second).isNotEqualTo(first);
    assertThat(Files.exists(firstPath)).as("旧头像应被删除").isFalse();
    assertThat(raw("GET", "/avatars/" + second).head().toLowerCase()).contains("content-type: image/jpeg");
    assertThat(raw("GET", "/avatars/" + first).status()).isEqualTo(404);
    assertThat(listAvatars()).containsExactly(second);
  }

  private List<String> listAvatars() throws IOException {
    try (Stream<Path> s = Files.list(Path.of(props.getAvatarDir()))) {
      return s.map(p -> p.getFileName().toString()).toList();
    }
  }

  @Test
  void avatarRejectsNonImageOversizeMissingFieldNonMultipartAnon() throws IOException {
    props.setDevLogin(true);
    props.getLimits().setAvatarBurst(100);
    limits.reset();
    String token = tokenOf(devLogin("device_0001"));

    Resp txt = uploadAvatar(token, "not an image at all".getBytes(StandardCharsets.UTF_8));
    assertThat(txt.status()).isEqualTo(400);
    assertThat(txt.errorCode()).isEqualTo("bad_request");
    assertThat(uploadAvatar(token, "GIF89a......".getBytes(StandardCharsets.UTF_8), "file", "a.gif", "image/gif").status())
        .isEqualTo(400);
    assertThat(uploadAvatar(token, new byte[0]).status()).isEqualTo(400);

    byte[] huge = new byte[PNG.length + 2 * 1024 * 1024];
    System.arraycopy(PNG, 0, huge, 0, PNG.length);
    Resp big = uploadAvatar(token, huge);
    assertThat(big.status()).isEqualTo(413);
    assertThat(big.errorCode()).isEqualTo("too_large");
    // 正好 2MB 可以
    byte[] exact = TestImages.pngOf(1, 1, 2 * 1024 * 1024);
    assertThat(exact.length).isEqualTo(2 * 1024 * 1024);
    assertThat(uploadAvatar(token, exact).status()).isEqualTo(200);

    // 结构不完整：PNG 没有 IEND、JPEG 没有帧头 / 没有 EOI、只有魔数
    Resp truncated = uploadAvatar(token, Arrays.copyOf(PNG, PNG.length - 12));
    assertThat(truncated.status()).isEqualTo(400);
    assertThat(truncated.errorMsg()).containsPattern("不完整|损坏");
    ByteArrayOutputStream noSof = new ByteArrayOutputStream();
    noSof.write(JPEG, 0, 20);
    noSof.write(JPEG, 33, JPEG.length - 33);
    assertThat(uploadAvatar(token, noSof.toByteArray(), "file", "a.jpg", "image/jpeg").status()).isEqualTo(400);
    assertThat(uploadAvatar(token, Arrays.copyOf(JPEG, JPEG.length - 2), "file", "a.jpg", "image/jpeg").status()).isEqualTo(400);
    assertThat(uploadAvatar(token, new byte[] {(byte) 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0}).status())
        .isEqualTo(400);
    // 宽高超过 2048：解压炸弹
    Resp bomb = uploadAvatar(token, TestImages.pngOf(30000, 30000));
    assertThat(bomb.status()).isEqualTo(400);
    assertThat(bomb.errorMsg()).contains("尺寸");
    assertThat(uploadAvatar(token, TestImages.jpegOf(4000, 100), "file", "a.jpg", "image/jpeg").status()).isEqualTo(400);
    assertThat(uploadAvatar(token, TestImages.pngOf(2048, 2048)).status()).isEqualTo(200);

    Resp wrongField = uploadAvatar(token, PNG, "image", "a.png", "image/png");
    assertThat(wrongField.status()).isEqualTo(400);
    assertThat(wrongField.errorMsg()).contains("file");

    assertThat(api("POST", "/api/me/avatar", token, Map.of("file", "x")).status()).isEqualTo(415);
    Resp broken = api("POST", "/api/me/avatar", token, "garbage", Map.of("Content-Type", "multipart/form-data; boundary=zzz"));
    assertThat(broken.status()).isEqualTo(400);

    assertThat(uploadAvatar(null, PNG).status()).isEqualTo(401);
    // 失败的上传不留文件（只有最后一次成功上传的那张）
    assertThat(listAvatars()).hasSize(1);
    assertThat(api("GET", "/healthz").status()).isEqualTo(200);
  }

  @Test
  void avatarWxUploadFileStyleRawMultipart() {
    props.setDevLogin(true);
    String token = tokenOf(devLogin("device_0001"));
    String b = "----WebKitFormBoundaryWX12345";
    ByteArrayOutputStream body = new ByteArrayOutputStream();
    body.writeBytes(("--" + b + "\r\nContent-Disposition: form-data; name=\"user\"\r\n\r\n1\r\n").getBytes(StandardCharsets.UTF_8));
    body.writeBytes(("--" + b + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"wxfile://tmp_abc.jpg\"\r\n"
        + "Content-Type: image/jpeg\r\n\r\n").getBytes(StandardCharsets.UTF_8));
    body.writeBytes(JPEG);
    body.writeBytes(("\r\n--" + b + "--\r\n").getBytes(StandardCharsets.UTF_8));
    Resp r = api("POST", "/api/me/avatar", token, body.toByteArray(), Map.of("Content-Type", "multipart/form-data; boundary=" + b));
    assertThat(r.status()).isEqualTo(200);
    assertThat(r.json().get("user").get("avatarUrl").asText()).matches(".*/avatars/[a-z0-9]+\\.jpg$");
  }

  @Test
  void avatarStaticStrictFilenameRejectsTraversal() throws IOException {
    Path dir = Path.of(props.getAvatarDir());
    Files.write(dir.resolve("abc123.png"), PNG);
    Files.write(dir.resolve("UPPER.png"), PNG);
    Files.write(dir.resolve("x.gif"), PNG);
    Files.createDirectories(dir.resolve("dir.png"));
    Path dataDir = Path.of(props.getDataDir());
    Files.writeString(dataDir.resolve("secret.png"), "secret");
    Files.writeString(dataDir.resolve("gamego.db"), "db");

    assertThat(raw("GET", "/avatars/abc123.png").status()).isEqualTo(200);
    List<String> attempts = List.of("/avatars/../secret.png", "/avatars/..%2Fsecret.png", "/avatars/%2e%2e%2fsecret.png",
        "/avatars/..%5Csecret.png", "/avatars/..\\secret.png", "/avatars/%2E%2E/gamego.db", "/avatars/../gamego.db",
        "/avatars//etc/passwd", "/avatars/UPPER.png", "/avatars/x.gif", "/avatars/abc123.PNG", "/avatars/abc123.png%00.png",
        "/avatars/dir.png", "/avatars/missing.png", "/avatars/", "/avatars/a/b.png");
    for (String p : attempts) {
      RawResp r = raw("GET", p);
      // 应用内一律 404；个别畸形地址（反斜杠、%00）Tomcat 在进入应用前就回 400，同样不会读到文件
      assertThat(r.status()).as(p).isIn(400, 404);
      assertThat(new String(r.body(), StandardCharsets.ISO_8859_1)).as(p).doesNotContain("secret");
    }
    for (String p : List.of("/avatars/..%2Fsecret.png", "/avatars/%2e%2e%2fsecret.png", "/avatars/../secret.png",
        "/avatars/UPPER.png", "/avatars/x.gif", "/avatars/abc123.PNG", "/avatars/dir.png", "/avatars/missing.png",
        "/avatars/", "/avatars/a/b.png", "/avatars//etc/passwd")) {
      assertThat(raw("GET", p).status()).as(p).isEqualTo(404);
    }
  }

  @Test
  void chunkedBodyOverLimitIs413AndClientAbortDoesNotBreak() throws Exception {
    props.setDevLogin(true);
    StringBuilder sb = new StringBuilder("{\"deviceId\":\"abcdefgh\",\"pad\":\"");
    sb.append("x".repeat(20 * 1024)).append("\"}");
    byte[] bytes = sb.toString().getBytes(StandardCharsets.UTF_8);
    HttpRequest req = HttpRequest.newBuilder(URI.create(base() + "/api/auth/dev-login"))
        .header("Content-Type", "application/json")
        .POST(HttpRequest.BodyPublishers.ofInputStream(() -> new java.io.ByteArrayInputStream(bytes)))
        .build();
    try {
      Resp r = send(req);
      assertThat(r.status()).isEqualTo(413);
    } catch (java.io.UncheckedIOException e) {
      // 服务端回 413 后关闭连接，客户端可能在发送途中收到重置
    }

    // 上传到一半断开
    String token = tokenOf(devLogin("device_0001"));
    try (java.net.Socket s = new java.net.Socket("127.0.0.1", port)) {
      String head = "POST /api/me/avatar HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer " + token
          + "\r\nContent-Type: multipart/form-data; boundary=abc\r\nContent-Length: 100000\r\n\r\n"
          + "--abc\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.png\"\r\n\r\n";
      s.getOutputStream().write(head.getBytes(StandardCharsets.ISO_8859_1));
      s.getOutputStream().flush();
      Thread.sleep(50);
    }
    Thread.sleep(100);
    assertThat(api("GET", "/healthz").status()).isEqualTo(200);
    assertThat(users.findById(1).avatar()).isEmpty();
  }

  @Test
  void concurrentAvatarUploadsKeepOneFile() throws Exception {
    props.setDevLogin(true);
    String token = tokenOf(devLogin("device_0001"));
    List<CompletableFuture<Resp>> fs = List.of(
        CompletableFuture.supplyAsync(() -> uploadAvatar(token, PNG)),
        CompletableFuture.supplyAsync(() -> uploadAvatar(token, JPEG)),
        CompletableFuture.supplyAsync(() -> uploadAvatar(token, PNG)));
    for (CompletableFuture<Resp> f : fs) assertThat(f.get().status()).isEqualTo(200);
    List<String> files = listAvatars();
    assertThat(files).hasSize(1);
    assertThat(users.findById(1).avatar()).isEqualTo(files.get(0));
  }

  // ---------- 排行榜 ----------

  @Test
  void leaderboardThreeBoardsMeMinGamesValidation() {
    props.setDevLogin(true);
    props.setMinGamesWinrate(2);
    JsonNode a = devLogin("device_000a");
    JsonNode b = devLogin("device_000b");
    JsonNode c = devLogin("device_000c");
    long aid = userIdOf(a);
    long bid = userIdOf(b);
    long cid = userIdOf(c);
    users.updateProfile(aid, "甲", "aa11.png", T0);
    long[] now = {T0};
    java.util.function.BiConsumer<Long, Long> play = (w, l) -> {
      now[0] += 1000;
      String id = insertRanked(w, l, now[0]);
      stats.applyWin(id, w, l, now[0]);
    };
    play.accept(aid, bid);
    play.accept(aid, bid);
    play.accept(bid, cid);

    Resp streak = api("GET", "/api/leaderboard?type=streak", tokenOf(c));
    assertThat(streak.status()).isEqualTo(200);
    assertThat(streak.json().toString()).isEqualTo(
        "{\"type\":\"streak\",\"items\":["
            + "{\"rank\":1,\"userId\":" + aid + ",\"nickname\":\"甲\",\"avatarUrl\":\"https://go.example.com/avatars/aa11.png\",\"value\":2,\"games\":2,\"wins\":2},"
            + "{\"rank\":2,\"userId\":" + bid + ",\"nickname\":\"\",\"avatarUrl\":\"\",\"value\":1,\"games\":3,\"wins\":1}],"
            + "\"me\":{\"rank\":null,\"value\":0,\"games\":1,\"wins\":0,\"need\":0},\"minGames\":2}");

    Resp def = api("GET", "/api/leaderboard", tokenOf(a));
    assertThat(def.json().get("type").asText()).isEqualTo("streak");
    assertThat(def.json().get("me").get("rank").asInt()).isEqualTo(1);

    Resp max = api("GET", "/api/leaderboard?type=maxStreak&limit=1", tokenOf(b));
    assertThat(ids(max.json().get("items"), "userId")).containsExactly(aid);
    assertThat(max.json().get("me").toString()).isEqualTo("{\"rank\":2,\"value\":1,\"games\":3,\"wins\":1,\"need\":0}");

    Resp wr = api("GET", "/api/leaderboard?type=winrate", tokenOf(c));
    JsonNode items = wr.json().get("items");
    assertThat(items.get(0).get("userId").asLong()).isEqualTo(aid);
    assertThat(items.get(0).get("value").asDouble()).isEqualTo(1.0);
    assertThat(items.get(1).get("userId").asLong()).isEqualTo(bid);
    assertThat(items.get(1).get("value").asDouble()).isEqualTo(1.0 / 3);
    JsonNode me = wr.json().get("me");
    assertThat(me.get("rank").isNull()).isTrue();
    assertThat(me.get("value").asDouble()).isZero();
    assertThat(me.get("need").asInt()).isEqualTo(1);

    assertThat(api("GET", "/api/leaderboard?type=elo", tokenOf(a)).status()).isEqualTo(400);
    assertThat(api("GET", "/api/leaderboard?limit=abc", tokenOf(a)).status()).isEqualTo(400);
    assertThat(api("GET", "/api/leaderboard?limit=-1", tokenOf(a)).status()).isEqualTo(400);
    assertThat(api("GET", "/api/leaderboard?limit=100000", tokenOf(a)).status()).isEqualTo(200);
  }

  // ---------- 对局列表与棋谱 ----------

  private Map<String, String> seedGames(long me, long opp) {
    Map<String, String> ids = new LinkedHashMap<>();
    ids.put("ranked", insertRanked(opp, me, T0 + 1000));
    games.finish(ids.get("ranked"), GameFinish.of(2, "score").moves(List.of(40, 41, -1, -1)).dead(List.of(41))
        .scores(30, 51.5).cause("agreed"), T0 + 1500);
    ids.put("friend", gameId());
    games.insert(new NewGame().id(ids.get("friend")).mode("friend").size(13).komi(7.5).blackId(me).whiteId(opp)
        .createdAt(T0 + 2000));
    games.finish(ids.get("friend"), GameFinish.of(0, "abort").cause("first_move"), T0 + 2500);
    ids.put("ai", gameId());
    games.insert(new NewGame().id(ids.get("ai")).mode("ai").size(19).komi(7.5).blackId(me).aiLevel("k5")
        .moves(List.of(60)).createdAt(T0 + 3000));
    games.finish(ids.get("ai"), GameFinish.of(2, "resign"), T0 + 3500);
    ids.put("ai2", gameId());
    games.insert(new NewGame().id(ids.get("ai2")).mode("ai").size(9).komi(7).whiteId(me).aiLevel("dan9")
        .createdAt(T0 + 4000));
    games.finish(ids.get("ai2"), GameFinish.of(0, "score").scores(40, 40), T0 + 4500);
    ids.put("playing", insertRanked(me, opp, T0 + 5000));
    return ids;
  }

  @Test
  void gamesListSummaryFieldsEndedOnlyDescendingCursor() {
    props.setDevLogin(true);
    JsonNode me = devLogin("device_00me");
    JsonNode opp = devLogin("device_0opp");
    long meId = userIdOf(me);
    long oppId = userIdOf(opp);
    users.updateProfile(oppId, "对手", "bb22.jpg", T0);
    Map<String, String> ids = seedGames(meId, oppId);

    Resp r = api("GET", "/api/games", tokenOf(me));
    assertThat(r.status()).isEqualTo(200);
    assertThat(r.json().get("next").isNull()).isTrue();
    JsonNode items = r.json().get("items");
    assertThat(List.of(items.get(0).get("id").asText(), items.get(1).get("id").asText(), items.get(2).get("id").asText(),
        items.get(3).get("id").asText())).containsExactly(ids.get("ai2"), ids.get("ai"), ids.get("friend"), ids.get("ranked"));
    assertThat(items.size()).isEqualTo(4);
    JsonNode ai2 = items.get(0);
    JsonNode ai = items.get(1);
    JsonNode friend = items.get(2);
    JsonNode ranked = items.get(3);
    assertThat(ranked.toString()).isEqualTo("{\"id\":\"" + ids.get("ranked") + "\",\"mode\":\"ranked\",\"size\":9,"
        + "\"status\":\"ended\",\"myColor\":2,\"opponent\":{\"id\":" + oppId + ",\"nickname\":\"对手\","
        + "\"avatarUrl\":\"https://go.example.com/avatars/bb22.jpg\"},\"winner\":2,\"reason\":\"score\",\"cause\":\"agreed\","
        + "\"resultText\":\"W+21.5\",\"myResult\":\"win\",\"moveCount\":4,\"createdAt\":" + (T0 + 1000) + ",\"endedAt\":"
        + (T0 + 1500) + "}");
    assertThat(friend.get("myColor").asInt()).isEqualTo(1);
    assertThat(friend.get("cause").asText()).isEqualTo("first_move");
    assertThat(ai.get("cause").isNull()).isTrue();
    assertThat(friend.get("myResult").asText()).isEqualTo("void");
    assertThat(friend.get("resultText").asText()).isEqualTo("Void");
    assertThat(ai.get("opponent").toString()).isEqualTo("{\"ai\":true,\"level\":\"k5\",\"levelName\":\"5级\"}");
    assertThat(ai.get("myResult").asText()).isEqualTo("loss");
    assertThat(ai.get("resultText").asText()).isEqualTo("W+R");
    assertThat(ai.get("moveCount").asInt()).isEqualTo(1);
    assertThat(ai2.get("opponent").toString()).isEqualTo("{\"ai\":true,\"level\":\"dan9\",\"levelName\":\"dan9\"}");
    assertThat(ai2.get("myColor").asInt()).isEqualTo(2);
    assertThat(ai2.get("myResult").asText()).isEqualTo("draw");

    Resp p1 = api("GET", "/api/games?limit=3", tokenOf(me));
    assertThat(p1.json().get("items").size()).isEqualTo(3);
    assertThat(p1.json().get("next").asLong()).isEqualTo(T0 + 2000);
    Resp p2 = api("GET", "/api/games?limit=3&before=" + p1.json().get("next").asLong(), tokenOf(me));
    assertThat(p2.json().get("items").size()).isEqualTo(1);
    assertThat(p2.json().get("items").get(0).get("id").asText()).isEqualTo(ids.get("ranked"));
    assertThat(p2.json().get("next").isNull()).isTrue();
    assertThat(api("GET", "/api/games?limit=4", tokenOf(me)).json().get("next").isNull()).isTrue();

    JsonNode o = api("GET", "/api/games", tokenOf(opp)).json().get("items");
    assertThat(o.size()).isEqualTo(2);
    assertThat(o.get(0).get("id").asText()).isEqualTo(ids.get("friend"));
    assertThat(o.get(0).get("myColor").asInt()).isEqualTo(2);
    assertThat(o.get(0).get("myResult").asText()).isEqualTo("void");
    assertThat(o.get(1).get("myColor").asInt()).isEqualTo(1);
    assertThat(o.get(1).get("myResult").asText()).isEqualTo("loss");
    assertThat(o.get(1).get("opponent").toString()).isEqualTo("{\"id\":" + meId + ",\"nickname\":\"\",\"avatarUrl\":\"\"}");

    assertThat(api("GET", "/api/games?before=abc", tokenOf(me)).status()).isEqualTo(400);
    assertThat(api("GET", "/api/games?limit=0", tokenOf(me)).json().get("items").size()).isEqualTo(1);
  }

  @Test
  void gameDetailRecordOnlyForParticipants() {
    props.setDevLogin(true);
    JsonNode me = devLogin("device_00me");
    JsonNode opp = devLogin("device_0opp");
    JsonNode other = devLogin("device_other");
    long meId = userIdOf(me);
    long oppId = userIdOf(opp);
    users.updateProfile(oppId, "对手", "bb22.jpg", T0);
    users.updateProfile(meId, "我", null, T0);
    Map<String, String> ids = seedGames(meId, oppId);

    Resp r = api("GET", "/api/games/" + ids.get("ranked"), tokenOf(me));
    assertThat(r.status()).isEqualTo(200);
    assertThat(r.json().toString()).isEqualTo("{\"id\":\"" + ids.get("ranked") + "\",\"mode\":\"ranked\",\"size\":9,"
        + "\"status\":\"ended\",\"myColor\":2,\"opponent\":{\"id\":" + oppId + ",\"nickname\":\"对手\","
        + "\"avatarUrl\":\"https://go.example.com/avatars/bb22.jpg\"},\"winner\":2,\"reason\":\"score\",\"cause\":\"agreed\","
        + "\"resultText\":\"W+21.5\",\"myResult\":\"win\",\"moveCount\":4,\"createdAt\":" + (T0 + 1000) + ",\"endedAt\":"
        + (T0 + 1500) + ",\"komi\":7.5,\"moves\":[40,41,-1,-1],\"dead\":[41],\"players\":{"
        + "\"1\":{\"userId\":" + oppId + ",\"nickname\":\"对手\",\"avatarUrl\":\"https://go.example.com/avatars/bb22.jpg\"},"
        + "\"2\":{\"userId\":" + meId + ",\"nickname\":\"我\",\"avatarUrl\":\"\"}},\"scoreBlack\":30.0,\"scoreWhite\":51.5}");

    Resp ai = api("GET", "/api/games/" + ids.get("ai"), tokenOf(me));
    assertThat(ai.json().get("players").toString()).isEqualTo("{\"1\":{\"userId\":" + meId
        + ",\"nickname\":\"我\",\"avatarUrl\":\"\"},\"2\":{\"ai\":true,\"level\":\"k5\",\"nickname\":\"AI · 5级\",\"avatarUrl\":\"\"}}");
    assertThat(ai.json().get("dead").toString()).isEqualTo("[]");
    assertThat(ai.json().get("scoreBlack").isNull()).isTrue();

    Resp playing = api("GET", "/api/games/" + ids.get("playing"), tokenOf(me));
    assertThat(playing.status()).isEqualTo(200);
    assertThat(playing.json().get("status").asText()).isEqualTo("playing");
    assertThat(playing.json().get("myResult").isNull()).isTrue();

    for (String p : List.of("/api/games/" + ids.get("ranked"), "/api/games/" + ids.get("ai"))) {
      Resp r2 = api("GET", p, tokenOf(other));
      assertThat(r2.status()).as(p).isEqualTo(404);
      assertThat(r2.errorCode()).isEqualTo("not_found");
    }
    assertThat(api("GET", "/api/games/nonexistent01", tokenOf(me)).status()).isEqualTo(404);
    assertThat(api("GET", "/api/games/%2e%2e", tokenOf(me)).status()).isEqualTo(404);
    assertThat(api("GET", "/api/games/" + "x".repeat(100), tokenOf(me)).status()).isEqualTo(404);
  }

  // ---------- AI 难度 ----------

  @Test
  void aiLevelsFromProviderNoAuth() {
    Resp r = api("GET", "/api/ai/levels");
    assertThat(r.status()).isEqualTo(200);
    assertThat(r.json().toString()).isEqualTo("{\"available\":true,\"levels\":[{\"id\":\"k5\",\"name\":\"5级\",\"desc\":\"\"}]}");

    aiLevels.available = false;
    aiLevels.levels = () -> List.of(Map.of("id", "k1", "name", "1级", "desc", "较强", "extra", 1));
    assertThat(api("GET", "/api/ai/levels").json().toString())
        .isEqualTo("{\"available\":false,\"levels\":[{\"id\":\"k1\",\"name\":\"1级\",\"desc\":\"较强\"}]}");

    aiLevels.levels = List::of;
    assertThat(api("GET", "/api/ai/levels").json().toString()).isEqualTo("{\"available\":false,\"levels\":[]}");

    aiLevels.available = true;
    aiLevels.levels = () -> {
      throw new IllegalStateException("boom");
    };
    Resp b = api("GET", "/api/ai/levels");
    assertThat(b.status()).isEqualTo(500);
    assertThat(b.json().toString()).isEqualTo("{\"error\":{\"code\":\"internal\",\"msg\":\"服务器内部错误\"}}");
  }
}
