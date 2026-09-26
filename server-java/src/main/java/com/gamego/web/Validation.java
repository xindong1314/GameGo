package com.gamego.web;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.regex.Pattern;

/** 请求参数校验（对应 Node 版 http/validate.js）。 */
public final class Validation {

  public static final int NICKNAME_MAX = 16;
  private static final Pattern LIMIT_RE = Pattern.compile("^\\d{1,6}$");
  private static final Pattern TS_RE = Pattern.compile("^\\d{1,16}$");
  private static final long MAX_SAFE_INTEGER = 9007199254740991L;

  private Validation() {}

  // 禁止的字符：控制字符（C0/C1/DEL）、零宽空格、行/段分隔符、双向文本控制符与 BOM（可用来伪造显示效果）。
  // 不拦截零宽连接符 U+200D：组合 emoji 需要它。
  static boolean isForbiddenCodePoint(int cp) {
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return true;
    if (cp == 0x200b || cp == 0x2028 || cp == 0x2029 || cp == 0xfeff) return true;
    return (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
  }

  /** 是否是合法的 UTF-16（没有落单的代理项），对应 JS 的 String.prototype.isWellFormed。 */
  static boolean isWellFormed(String s) {
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      if (Character.isHighSurrogate(c)) {
        if (i + 1 >= s.length() || !Character.isLowSurrogate(s.charAt(i + 1))) return false;
        i++;
      } else if (Character.isLowSurrogate(c)) {
        return false;
      }
    }
    return true;
  }

  /** JS String.prototype.trim 去掉的字符：空白（含 NBSP、BOM、Unicode Zs 类）与行终止符。 */
  static boolean isJsWhitespace(char c) {
    return c == '\t' || c == '\n' || c == 0x0b || c == '\f' || c == '\r' || c == ' ' || c == 0x00a0 || c == 0xfeff
        || c == 0x2028 || c == 0x2029 || Character.getType(c) == Character.SPACE_SEPARATOR;
  }

  /** 与 JS 的 String.prototype.trim 相同。 */
  public static String jsTrim(String s) {
    int start = 0;
    int end = s.length();
    while (start < end && isJsWhitespace(s.charAt(start))) start++;
    while (end > start && isJsWhitespace(s.charAt(end - 1))) end--;
    return s.substring(start, end);
  }

  /** 昵称：去首尾空白后 1~16 个字符（按 Unicode 码点计），不含控制字符。返回规范化后的昵称，不合法抛 400。 */
  public static String validateNickname(JsonNode raw) {
    if (raw == null || !raw.isTextual()) throw ApiException.badRequest("请填写昵称");
    return validateNickname(raw.asText());
  }

  public static String validateNickname(String raw) {
    if (raw == null) throw ApiException.badRequest("请填写昵称");
    if (!isWellFormed(raw)) throw ApiException.badRequest("昵称包含无效字符");
    String s = jsTrim(raw);
    int len = s.codePointCount(0, s.length());
    if (len == 0) throw ApiException.badRequest("昵称不能为空");
    if (len > NICKNAME_MAX) throw ApiException.badRequest("昵称最多 " + NICKNAME_MAX + " 个字");
    if (s.codePoints().anyMatch(Validation::isForbiddenCodePoint)) throw ApiException.badRequest("昵称不能包含控制字符");
    return s;
  }

  /** 查询参数中的正整数（如 limit），缺省返回 def，超出范围时截断到 [1, max]。 */
  public static int parseLimit(String raw, int def, int max) {
    if (raw == null || raw.isEmpty()) return def;
    if (!LIMIT_RE.matcher(raw).matches()) throw ApiException.badRequest("limit 必须是正整数");
    return Math.min(Math.max(Integer.parseInt(raw), 1), max);
  }

  /** 查询参数中的毫秒时间戳（游标），缺省返回 null。 */
  public static Long parseTimestamp(String raw, String name) {
    if (raw == null || raw.isEmpty()) return null;
    if (!TS_RE.matcher(raw).matches() || Long.parseLong(raw) > MAX_SAFE_INTEGER) {
      throw ApiException.badRequest(name + " 必须是毫秒时间戳");
    }
    return Long.parseLong(raw);
  }
}
