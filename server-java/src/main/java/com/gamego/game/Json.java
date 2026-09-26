package com.gamego.game;

import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializerProvider;
import com.fasterxml.jackson.databind.module.SimpleModule;
import com.fasterxml.jackson.databind.ser.std.StdSerializer;
import java.io.IOException;

/**
 * WebSocket 消息的 JSON 编解码，输出与 Node 版 JSON.stringify 一致：
 * 整数值的浮点数写成整数（45.0 → 45，与 JS 的 number 相同），null 字段照常输出；解析时拒绝 JSON 之后的多余内容。
 */
public final class Json {
  /** JS Number.MAX_SAFE_INTEGER。 */
  public static final long MAX_SAFE_INTEGER = 9007199254740991L;

  public static final ObjectMapper MAPPER = create();

  private Json() {}

  private static ObjectMapper create() {
    ObjectMapper m = new ObjectMapper();
    m.enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
    SimpleModule mod = new SimpleModule("gamego-js-numbers");
    mod.addSerializer(Double.class, new JsNumberSerializer());
    mod.addSerializer(double.class, new JsNumberSerializer());
    m.registerModule(mod);
    return m;
  }

  /** 与 JS 相同的数字写法：有限的整数值写成整数。 */
  static final class JsNumberSerializer extends StdSerializer<Double> {
    JsNumberSerializer() {
      super(Double.class);
    }

    @Override
    public void serialize(Double v, JsonGenerator gen, SerializerProvider p) throws IOException {
      double d = v;
      if (Double.isFinite(d) && d == Math.rint(d) && Math.abs(d) <= MAX_SAFE_INTEGER) {
        if (d == 0) gen.writeNumber(0);
        else gen.writeNumber((long) d);
      } else if (!Double.isFinite(d)) {
        gen.writeNull(); // JSON.stringify(NaN / Infinity) → null
      } else {
        gen.writeNumber(d);
      }
    }
  }

  public static String write(Object v) {
    try {
      return MAPPER.writeValueAsString(v);
    } catch (JsonProcessingException e) {
      throw new IllegalStateException("JSON 序列化失败", e);
    }
  }

  /** 解析失败抛 IOException。 */
  public static JsonNode parse(String text) throws IOException {
    return MAPPER.readTree(text);
  }

  /** 对象 → JsonNode（Map / List / 基本类型）。 */
  public static JsonNode tree(Object v) {
    return MAPPER.valueToTree(v);
  }

  /** JSON 值是"安全整数"（JS Number.isSafeInteger）时返回它，否则 null（1.0 这样的整数值浮点数也算）。 */
  public static Long safeInt(JsonNode v) {
    if (v == null || !v.isNumber()) return null;
    if (v.isIntegralNumber()) {
      if (!v.canConvertToLong()) return null;
      long l = v.longValue();
      return Math.abs(l) <= MAX_SAFE_INTEGER ? l : null;
    }
    double d = v.doubleValue();
    if (!Double.isFinite(d) || d != Math.rint(d) || Math.abs(d) > MAX_SAFE_INTEGER) return null;
    return (long) d;
  }
}
