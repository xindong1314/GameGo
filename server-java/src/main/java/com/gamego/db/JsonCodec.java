package com.gamego.db;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.gamego.config.TimeControl;
import java.util.List;
import org.springframework.stereotype.Component;

/** games 表 JSON 列的序列化与解析。 */
@Component
public class JsonCodec {

  private static final TypeReference<List<Integer>> INT_LIST = new TypeReference<>() {};

  private final ObjectMapper mapper;

  public JsonCodec(ObjectMapper mapper) {
    this.mapper = mapper;
  }

  /** null → SQL NULL；其余按 JSON 序列化（Map、List、POJO、record、JsonNode 均可）。 */
  public String toJsonOrNull(Object v) {
    if (v == null) return null;
    if (v instanceof JsonNode n && n.isNull()) return null;
    try {
      return mapper.writeValueAsString(v);
    } catch (JsonProcessingException e) {
      throw new IllegalArgumentException("无法序列化为 JSON：" + e.getOriginalMessage(), e);
    }
  }

  public List<Integer> parseIntList(String text) throws JsonProcessingException {
    List<Integer> list = mapper.readValue(text, INT_LIST);
    if (list != null && list.contains(null)) throw new IllegalArgumentException("数组里有 null");
    return list;
  }

  public TimeControl parseTimeControl(String text) throws JsonProcessingException {
    JsonNode n = mapper.readTree(text);
    if (n == null || n.isNull()) return null;
    if (!n.isObject() || !n.path("mainMs").isNumber() || !n.path("periods").isIntegralNumber()
        || !n.path("periodMs").isNumber()) {
      throw new IllegalArgumentException("timeControl 格式不正确");
    }
    return new TimeControl(n.get("mainMs").asLong(), n.get("periods").asInt(), n.get("periodMs").asLong());
  }

  /** 解析为 JsonNode；JSON 的 null 返回 Java null。 */
  public JsonNode parseTree(String text) throws JsonProcessingException {
    JsonNode n = mapper.readTree(text);
    return n == null || n.isNull() || n.isMissingNode() ? null : n;
  }
}
