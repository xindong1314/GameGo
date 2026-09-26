package com.gamego.web;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;

/**
 * 极简 multipart/form-data 解析（RFC 7578），只用于头像上传（wx.uploadFile / 浏览器 FormData 的标准格式）。
 * 结构不对一律抛 {@link MalformedException}。
 */
final class MultipartParser {

  /** 一个字段：filename 为 null 表示普通文本字段。 */
  record Part(String name, String filename, String contentType, byte[] data) {}

  static final class MalformedException extends Exception {
    MalformedException(String msg) {
      super(msg);
    }
  }

  private static final byte[] CRLF = {'\r', '\n'};
  private static final byte[] HEADER_END = {'\r', '\n', '\r', '\n'};

  private MultipartParser() {}

  /** 从 Content-Type 取 boundary 参数（可带引号）。 */
  static String boundaryOf(String contentType) {
    if (contentType == null) return null;
    for (String param : contentType.split(";")) {
      String p = param.trim();
      int eq = p.indexOf('=');
      if (eq > 0 && p.substring(0, eq).trim().equalsIgnoreCase("boundary")) {
        String v = p.substring(eq + 1).trim();
        if (v.length() >= 2 && v.startsWith("\"") && v.endsWith("\"")) v = v.substring(1, v.length() - 1);
        return v.isEmpty() || v.length() > 200 ? null : v;
      }
    }
    return null;
  }

  static List<Part> parse(byte[] body, String boundary) throws MalformedException {
    byte[] delim = ("--" + boundary).getBytes(StandardCharsets.ISO_8859_1);
    byte[] crlfDelim = new byte[delim.length + 2];
    crlfDelim[0] = '\r';
    crlfDelim[1] = '\n';
    System.arraycopy(delim, 0, crlfDelim, 2, delim.length);

    int pos = indexOf(body, delim, 0);
    if (pos < 0) throw new MalformedException("找不到分隔符");
    List<Part> parts = new ArrayList<>();
    while (true) {
      pos += delim.length;
      if (startsWith(body, pos, new byte[] {'-', '-'})) return parts; // 结束分隔符
      // 分隔符之后允许少量空白，然后必须是 CRLF
      while (pos < body.length && (body[pos] == ' ' || body[pos] == '\t')) pos++;
      if (!startsWith(body, pos, CRLF)) throw new MalformedException("分隔符后缺少换行");
      pos += 2;
      int headersEnd = indexOf(body, HEADER_END, pos);
      String headerText;
      int dataStart;
      if (startsWith(body, pos, CRLF)) { // 没有任何头
        headerText = "";
        dataStart = pos + 2;
      } else {
        if (headersEnd < 0) throw new MalformedException("字段头不完整");
        headerText = new String(body, pos, headersEnd - pos, StandardCharsets.UTF_8);
        dataStart = headersEnd + 4;
      }
      int next = indexOf(body, crlfDelim, dataStart);
      if (next < 0) throw new MalformedException("缺少结束分隔符");
      byte[] data = Arrays.copyOfRange(body, dataStart, next);

      String name = null;
      String filename = null;
      String contentType = null;
      for (String line : headerText.split("\r\n")) {
        int colon = line.indexOf(':');
        if (colon <= 0) continue;
        String key = line.substring(0, colon).trim().toLowerCase(Locale.ROOT);
        String value = line.substring(colon + 1).trim();
        if (key.equals("content-disposition")) {
          name = param(value, "name");
          filename = param(value, "filename");
        } else if (key.equals("content-type")) {
          contentType = value;
        }
      }
      if (name != null) parts.add(new Part(name, filename, contentType, data));
      pos = next + 2;
    }
  }

  /** 取 Content-Disposition 的参数值（name="x" 或 name=x）。 */
  static String param(String header, String key) {
    int i = 0;
    int n = header.length();
    // 跳过 disposition 类型（form-data）
    int semi = indexOfUnquoted(header, ';', 0);
    if (semi < 0) return null;
    i = semi + 1;
    while (i < n) {
      while (i < n && (header.charAt(i) == ' ' || header.charAt(i) == '\t')) i++;
      int eq = header.indexOf('=', i);
      if (eq < 0) return null;
      String k = header.substring(i, eq).trim();
      int j = eq + 1;
      String v;
      if (j < n && header.charAt(j) == '"') {
        StringBuilder sb = new StringBuilder();
        j++;
        while (j < n && header.charAt(j) != '"') {
          char c = header.charAt(j);
          if (c == '\\' && j + 1 < n) {
            j++;
            c = header.charAt(j);
          }
          sb.append(c);
          j++;
        }
        v = sb.toString();
        j++; // 结束引号
        int s = header.indexOf(';', j);
        i = s < 0 ? n : s + 1;
      } else {
        int s = header.indexOf(';', j);
        v = (s < 0 ? header.substring(j) : header.substring(j, s)).trim();
        i = s < 0 ? n : s + 1;
      }
      if (k.equalsIgnoreCase(key)) return v;
    }
    return null;
  }

  private static int indexOfUnquoted(String s, char ch, int from) {
    boolean quoted = false;
    for (int i = from; i < s.length(); i++) {
      char c = s.charAt(i);
      if (c == '"') quoted = !quoted;
      else if (c == ch && !quoted) return i;
    }
    return -1;
  }

  static boolean startsWith(byte[] a, int pos, byte[] b) {
    if (pos < 0 || pos + b.length > a.length) return false;
    for (int i = 0; i < b.length; i++) if (a[pos + i] != b[i]) return false;
    return true;
  }

  static int indexOf(byte[] a, byte[] b, int from) {
    outer:
    for (int i = Math.max(from, 0); i <= a.length - b.length; i++) {
      for (int j = 0; j < b.length; j++) if (a[i + j] != b[j]) continue outer;
      return i;
    }
    return -1;
  }
}
