package com.gamego.ws;

import com.fasterxml.jackson.databind.JsonNode;
import com.gamego.game.GameError;
import com.gamego.game.Json;
import com.gamego.game.Msg;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.regex.Pattern;

/**
 * 客户端消息的严格校验（设计文档 5.1 / 5.2，移植自 Node 版 ws/protocol.js）。
 * 只接受已知的消息类型；参数类型必须精确（数字不能是字符串），多余字段忽略。
 * 字段名以 ? 结尾表示可选：没有时不校验、不放进 params，给了就必须合法（null 也不合法）。
 */
public final class Protocol {
  private Protocol() {}

  public static final List<Integer> SIZES = List.of(9, 13, 19);
  public static final List<String> COLORS = List.of("black", "white", "random");
  public static final Pattern GAME_ID_RE = Pattern.compile("^[0-9a-z]{12}$");
  public static final Pattern ROOM_CODE_RE = Pattern.compile("^[0-9]{6}$");
  public static final Pattern LEVEL_RE = Pattern.compile("^[A-Za-z0-9_.-]{1,32}$");
  static final int MAX_IDX = 19 * 19 - 1;
  static final int MAX_N = 100000;
  static final int MAX_VERSION = 1000000000;
  static final int MAX_TYPE_LEN = 32;

  /** 字段校验：返回 [问题描述, 规范化后的值]；合法时问题描述为 null。 */
  private record Check(String problem, Object value) {}

  private static Function<JsonNode, Check> intIn(long min, long max, String name) {
    return v -> {
      Long n = Json.safeInt(v);
      if (n != null && n >= min && n <= max) return new Check(null, (int) (long) n);
      return new Check(name + " 必须是 " + min + "~" + max + " 之间的整数", null);
    };
  }

  private static Function<JsonNode, Check> text(Pattern re, String problem) {
    return v -> v != null && v.isTextual() && re.matcher(v.textValue()).matches() ? new Check(null, v.textValue()) : new Check(problem, null);
  }

  private static final Map<String, Function<JsonNode, Check>> FIELDS = new LinkedHashMap<>();

  static {
    FIELDS.put("size", v -> {
      Long n = Json.safeInt(v);
      return n != null && n >= 9 && n <= 19 && SIZES.contains((int) (long) n) ? new Check(null, (int) (long) n) : new Check("size 必须是 9、13 或 19", null);
    });
    FIELDS.put("color", v -> v != null && v.isTextual() && COLORS.contains(v.textValue())
        ? new Check(null, v.textValue())
        : new Check("color 必须是 black、white 或 random", null));
    FIELDS.put("code", text(ROOM_CODE_RE, "code 必须是 6 位数字"));
    FIELDS.put("gameId", text(GAME_ID_RE, "gameId 格式不对"));
    FIELDS.put("level", text(LEVEL_RE, "level 格式不对"));
    FIELDS.put("n", intIn(1, MAX_N, "n"));
    FIELDS.put("idx", intIn(0, MAX_IDX, "idx"));
    FIELDS.put("version", intIn(0, MAX_VERSION, "version"));
  }

  public static final Map<String, List<String>> SCHEMAS = new LinkedHashMap<>();

  static {
    SCHEMAS.put("ping", List.of());
    SCHEMAS.put("hello", List.of());
    SCHEMAS.put("match.join", List.of("size"));
    SCHEMAS.put("match.cancel", List.of());
    SCHEMAS.put("room.create", List.of("size", "color"));
    SCHEMAS.put("room.get", List.of("code"));
    SCHEMAS.put("room.join", List.of("code"));
    SCHEMAS.put("room.leave", List.of());
    SCHEMAS.put("ai.start", List.of("size", "level", "color"));
    SCHEMAS.put("game.sync", List.of("gameId"));
    SCHEMAS.put("game.move", List.of("gameId", "n", "idx"));
    SCHEMAS.put("game.pass", List.of("gameId", "n"));
    SCHEMAS.put("game.resign", List.of("gameId"));
    SCHEMAS.put("game.undo", List.of("gameId"));
    SCHEMAS.put("game.score.toggle", List.of("gameId", "idx", "version?"));
    SCHEMAS.put("game.score.accept", List.of("gameId", "version"));
    SCHEMAS.put("game.score.resume", List.of("gameId"));
  }

  public static final List<String> TYPES = List.copyOf(SCHEMAS.keySet());

  /**
   * 解析结果。成功：ok、t、rid（Long，没有为 null）、params；
   * 失败：rid 为能原样带回的值（Long / 数字 / 短字符串的 JsonNode，没有为 null → 不应回复）与 err。
   */
  public record Parsed(boolean ok, String t, Object rid, Map<String, Object> params, GameError err) {
    static Parsed fail(Object rid, GameError err) {
      return new Parsed(false, null, rid, null, err);
    }
  }

  /** rid 不合法时，能原样带回的（有限数字或短字符串）就带回，方便客户端对上号。 */
  static Object echoableRid(JsonNode rid) {
    if (rid == null) return null;
    if (rid.isNumber()) {
      double d = rid.doubleValue();
      if (!Double.isFinite(d)) return null;
      Long n = Json.safeInt(rid);
      return n != null ? (Object) n : (Object) d;
    }
    if (rid.isTextual() && rid.textValue().length() <= 64) return rid.textValue();
    return null;
  }

  /** msg 为 JSON 解析后的值（可以是任意 JSON）。 */
  public static Parsed parse(JsonNode msg) {
    if (msg == null || !msg.isObject()) return Parsed.fail(null, new GameError("bad_request", "消息必须是 JSON 对象"));
    Long rid = null;
    JsonNode ridNode = msg.get("rid");
    if (ridNode != null) {
      Long n = Json.safeInt(ridNode);
      if (n == null || n < 0) return Parsed.fail(echoableRid(ridNode), new GameError("bad_request", "rid 必须是非负整数"));
      rid = n;
    }
    JsonNode tn = msg.get("t");
    if (tn == null || !tn.isTextual() || tn.textValue().isEmpty() || tn.textValue().length() > MAX_TYPE_LEN) {
      return Parsed.fail(rid, new GameError("bad_request", "缺少消息类型 t"));
    }
    String t = tn.textValue();
    List<String> schema = SCHEMAS.get(t);
    if (schema == null) return Parsed.fail(rid, new GameError("bad_request", "未知的消息类型 " + t));
    Map<String, Object> params = new LinkedHashMap<>();
    for (String spec : schema) {
      boolean optional = spec.endsWith("?");
      String name = optional ? spec.substring(0, spec.length() - 1) : spec;
      JsonNode v = msg.get(name);
      if (optional && v == null) continue;
      Check c = FIELDS.get(name).apply(v);
      if (c.problem() != null) return Parsed.fail(rid, new GameError("bad_request", c.problem(), Msg.of("field", name)));
      params.put(name, c.value());
    }
    return new Parsed(true, t, rid, params, null);
  }
}
