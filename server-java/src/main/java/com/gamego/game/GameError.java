package com.gamego.game;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 业务错误（对应 Node 版 game/errors.js 的 GameError）：code 为协议里的错误码（设计文档 5.2），
 * msg 为给用户看的中文说明，extra 为附加字段（如 stale 的 expected / version、illegal 的 reason、bad_request 的 field）。
 * 路由层把它转成 {@code { t: 'res', rid, ok: false, err: { code, msg, ...extra } }}，其他异常一律视为 internal。
 */
public class GameError extends RuntimeException {

  public static final List<String> CODES =
      List.of(
          "bad_request",
          "not_found",
          "not_player",
          "not_your_turn",
          "illegal",
          "stale",
          "in_game",
          "room_not_found",
          "own_room",
          "ai_unavailable",
          "nothing_to_undo",
          "wrong_phase",
          "rate_limited",
          "internal");

  private final String code;
  private final String msg;
  private final Map<String, Object> extra;

  public GameError(String code, String msg) {
    this(code, msg, null);
  }

  public GameError(String code, String msg, Map<String, Object> extra) {
    super(msg == null || msg.isEmpty() ? code : msg);
    this.code = code;
    this.msg = msg == null || msg.isEmpty() ? code : msg;
    this.extra = extra == null ? null : new LinkedHashMap<>(extra);
  }

  public String code() {
    return code;
  }

  public String msg() {
    return msg;
  }

  /** 附加字段（没有为 null）。 */
  public Map<String, Object> extra() {
    return extra;
  }

  /** {@code { code, msg, ...extra }}。 */
  public Map<String, Object> toJson() {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("code", code);
    m.put("msg", msg);
    if (extra != null) m.putAll(extra);
    return m;
  }
}
