package com.gamego.ws;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.gamego.config.TimeControl;
import com.gamego.game.GameSettings;
import com.gamego.game.Json;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** 协议校验与设置（对应 Node 测试 game/protocol.test.js）。 */
class ProtocolTest {

  static Protocol.Parsed parse(String json) {
    try {
      return Protocol.parse(Json.parse(json));
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }

  static Protocol.Parsed bad(String json) {
    Protocol.Parsed r = parse(json);
    assertThat(r.ok()).as("应当拒绝：" + json).isFalse();
    assertThat(r.err().code()).isEqualTo("bad_request");
    return r;
  }

  @Test
  void allTypesDefined() {
    assertThat(Protocol.TYPES.stream().sorted().toList())
        .containsExactly(
            "ai.start",
            "game.move",
            "game.pass",
            "game.resign",
            "game.score.accept",
            "game.score.resume",
            "game.score.toggle",
            "game.sync",
            "game.undo",
            "hello",
            "match.cancel",
            "match.join",
            "ping",
            "room.create",
            "room.get",
            "room.join",
            "room.leave");
  }

  @Test
  void validMessagesKeepDeclaredParams() {
    Protocol.Parsed h = parse("{\"t\":\"hello\",\"rid\":1,\"extra\":\"x\"}");
    assertThat(h.ok()).isTrue();
    assertThat(h.t()).isEqualTo("hello");
    assertThat(h.rid()).isEqualTo(1L);
    assertThat(h.params()).isEmpty();
    Protocol.Parsed p = parse("{\"t\":\"ping\"}");
    assertThat(p.ok()).isTrue();
    assertThat(p.rid()).isNull();
    assertThat(parse("{\"t\":\"game.move\",\"rid\":7,\"gameId\":\"abcdefghij12\",\"n\":1,\"idx\":360}").params())
        .isEqualTo(Map.of("gameId", "abcdefghij12", "n", 1, "idx", 360));
    assertThat(parse("{\"t\":\"ai.start\",\"rid\":0,\"size\":19,\"level\":\"d1\",\"color\":\"random\"}").params())
        .isEqualTo(Map.of("size", 19, "level", "d1", "color", "random"));
    assertThat(parse("{\"t\":\"room.get\",\"rid\":1,\"code\":\"012345\"}").ok()).isTrue();
    assertThat(parse("{\"t\":\"game.score.accept\",\"rid\":1,\"gameId\":\"abcdefghij12\",\"version\":3}").ok()).isTrue();
    assertThat(parse("{\"t\":\"game.score.toggle\",\"rid\":1,\"gameId\":\"abcdefghij12\",\"idx\":10}").params())
        .isEqualTo(Map.of("gameId", "abcdefghij12", "idx", 10));
    assertThat(parse("{\"t\":\"game.score.toggle\",\"rid\":1,\"gameId\":\"abcdefghij12\",\"idx\":10,\"version\":4}").params())
        .isEqualTo(Map.of("gameId", "abcdefghij12", "idx", 10, "version", 4));
    // JS 里 1.0 就是整数 1
    assertThat(parse("{\"t\":\"match.join\",\"rid\":2.0,\"size\":9.0}").params()).isEqualTo(Map.of("size", 9));
  }

  @Test
  void malformedMessages() {
    assertThat(bad("null").rid()).isNull();
    assertThat(bad("[1,2]").rid()).isNull();
    assertThat(bad("\"hello\"").rid()).isNull();
    assertThat(bad("{\"rid\":3}").rid()).isEqualTo(3L);
    assertThat(bad("{\"t\":5,\"rid\":3}").rid()).isEqualTo(3L);
    assertThat(bad("{\"t\":\"" + "x".repeat(40) + "\",\"rid\":3}").rid()).isEqualTo(3L);
    assertThat(bad("{\"t\":\"game.teleport\",\"rid\":3}").err().msg()).contains("未知");
    assertThat(bad("{\"t\":\"constructor\",\"rid\":3}").err().msg()).contains("未知");
    assertThat(bad("{\"t\":\"__proto__\",\"rid\":3}").err().msg()).contains("未知");
  }

  @Test
  void ridEcho() {
    assertThat(bad("{\"t\":\"hello\",\"rid\":-1}").rid()).isEqualTo(-1L);
    assertThat(bad("{\"t\":\"hello\",\"rid\":1.5}").rid()).isEqualTo(1.5);
    assertThat(bad("{\"t\":\"hello\",\"rid\":\"abc\"}").rid()).isEqualTo("abc");
    assertThat(bad("{\"t\":\"hello\",\"rid\":{\"a\":1}}").rid()).isNull();
    assertThat(bad("{\"t\":\"hello\",\"rid\":\"" + "x".repeat(100) + "\"}").rid()).isNull();
    assertThat(bad("{\"t\":\"hello\",\"rid\":null}").rid()).isNull();
  }

  @Test
  void paramTypesAndRanges() {
    for (String m :
        List.of(
            "{\"t\":\"match.join\",\"rid\":1}",
            "{\"t\":\"match.join\",\"rid\":1,\"size\":\"9\"}",
            "{\"t\":\"match.join\",\"rid\":1,\"size\":10}",
            "{\"t\":\"match.join\",\"rid\":1,\"size\":4294967305}",
            "{\"t\":\"room.create\",\"rid\":1,\"size\":9,\"color\":\"BLACK\"}",
            "{\"t\":\"room.create\",\"rid\":1,\"size\":9}",
            "{\"t\":\"room.get\",\"rid\":1,\"code\":123456}",
            "{\"t\":\"room.join\",\"rid\":1,\"code\":\"12345\"}",
            "{\"t\":\"room.join\",\"rid\":1,\"code\":\"1234567\"}",
            "{\"t\":\"room.join\",\"rid\":1,\"code\":\"12a456\"}",
            "{\"t\":\"ai.start\",\"rid\":1,\"size\":9,\"color\":\"black\",\"level\":\"\"}",
            "{\"t\":\"ai.start\",\"rid\":1,\"size\":9,\"color\":\"black\",\"level\":\"a b\"}",
            "{\"t\":\"ai.start\",\"rid\":1,\"size\":9,\"color\":\"black\",\"level\":5}",
            "{\"t\":\"game.sync\",\"rid\":1,\"gameId\":\"ABCDEFGHIJ12\"}",
            "{\"t\":\"game.sync\",\"rid\":1,\"gameId\":\"short\"}",
            "{\"t\":\"game.sync\",\"rid\":1}",
            "{\"t\":\"game.move\",\"rid\":1,\"gameId\":\"abcdefghij12\",\"n\":0,\"idx\":1}",
            "{\"t\":\"game.move\",\"rid\":1,\"gameId\":\"abcdefghij12\",\"n\":1,\"idx\":361}",
            "{\"t\":\"game.move\",\"rid\":1,\"gameId\":\"abcdefghij12\",\"n\":1,\"idx\":-1}",
            "{\"t\":\"game.move\",\"rid\":1,\"gameId\":\"abcdefghij12\",\"n\":1.5,\"idx\":1}",
            "{\"t\":\"game.move\",\"rid\":1,\"gameId\":\"abcdefghij12\",\"n\":\"1\",\"idx\":1}",
            "{\"t\":\"game.move\",\"rid\":1,\"gameId\":\"abcdefghij12\",\"n\":1}",
            "{\"t\":\"game.pass\",\"rid\":1,\"gameId\":\"abcdefghij12\"}",
            "{\"t\":\"game.score.toggle\",\"rid\":1,\"gameId\":\"abcdefghij12\",\"idx\":3,\"version\":\"3\"}",
            "{\"t\":\"game.score.toggle\",\"rid\":1,\"gameId\":\"abcdefghij12\",\"idx\":3,\"version\":null}",
            "{\"t\":\"game.score.accept\",\"rid\":1,\"gameId\":\"abcdefghij12\",\"version\":-1}",
            "{\"t\":\"game.score.accept\",\"rid\":1,\"gameId\":\"abcdefghij12\"}")) {
      bad(m);
    }
    Protocol.Parsed r = bad("{\"t\":\"game.move\",\"rid\":9,\"gameId\":\"abcdefghij12\",\"n\":1,\"idx\":\"x\"}");
    assertThat(r.rid()).isEqualTo(9L);
    assertThat(r.err().extra().get("field")).isEqualTo("idx");
    assertThat(Json.write(r.err().toJson())).isEqualTo("{\"code\":\"bad_request\",\"msg\":\"idx 必须是 0~360 之间的整数\",\"field\":\"idx\"}");
  }

  @Test
  void settingsDefaultsAndValidation() {
    GameSettings s = GameSettings.defaults();
    assertThat(s.komi).isEqualTo(7.5);
    assertThat(s.timeControls.get(19)).isEqualTo(new TimeControl(600000, 3, 30000));
    assertThat(s.abandonMs).isEqualTo(90000);
    assertThat(s.minMovesRanked).isEqualTo(10);
    assertThat(s.publicBaseUrl).isEqualTo("");
    assertThat(s.sizes).containsExactly(9, 13, 19);
    assertThat(GameSettings.builder().publicBaseUrl("https://x.com///").build().publicBaseUrl).isEqualTo("https://x.com");
    assertThat(GameSettings.builder().minMovesRanked(0).build().minMovesRanked).isEqualTo(0);
    assertThatThrownBy(() -> GameSettings.builder().abandonMs(0).build()).isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> GameSettings.builder().abandonMs(-5).build()).isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> GameSettings.builder().komi(Double.NaN).build()).isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> GameSettings.builder().timeControl(9, new TimeControl(0, 0, 0)).build())
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> GameSettings.builder().aiRetryDelaysMs(1L, -1L).build()).isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void jsonNumbersLikeJs() {
    assertThat(Json.write(Map.of("a", 45.0))).isEqualTo("{\"a\":45}");
    assertThat(Json.write(Map.of("a", 43.5))).isEqualTo("{\"a\":43.5}");
    assertThat(Json.write(Map.of("a", -0.0))).isEqualTo("{\"a\":0}");
  }
}
