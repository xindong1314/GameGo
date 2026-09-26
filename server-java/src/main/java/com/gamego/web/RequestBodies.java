package com.gamego.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import jakarta.servlet.http.HttpServletRequest;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Locale;
import org.springframework.stereotype.Component;

/**
 * 请求体读取（对应 Node 版 http/body.js）：JSON（上限 16KB）与 multipart/form-data（头像上传）。
 * 自己读原始请求体，保证大小限制与错误码与 Node 版一致：超限 413 too_large，类型不对 415，格式错误 400。
 */
@Component
public class RequestBodies {

  public static final int JSON_LIMIT = 16 * 1024;

  /** 客户端在请求体传输完成前断开（不再回写响应）。 */
  public static class ClientGoneException extends RuntimeException {
    public ClientGoneException(Throwable cause) {
      super("客户端在请求体传输完成前断开", cause);
    }
  }

  /** multipart 中的一个文件。 */
  public record UploadedFile(byte[] data, String filename) {}

  private final ObjectMapper mapper;

  public RequestBodies(ObjectMapper mapper) {
    this.mapper = mapper;
  }

  static String mediaType(HttpServletRequest req) {
    String ct = req.getContentType();
    if (ct == null) return "";
    int semi = ct.indexOf(';');
    return (semi >= 0 ? ct.substring(0, semi) : ct).trim().toLowerCase(Locale.ROOT);
  }

  /** 读取完整请求体；超过 limit 时立即停止读取并抛 413。 */
  public byte[] readBody(HttpServletRequest req, long limit) {
    long declared = req.getContentLengthLong();
    if (declared > limit) throw ApiException.tooLarge(limit);
    ByteArrayOutputStream out = new ByteArrayOutputStream((int) Math.min(Math.max(declared, 0), limit));
    byte[] buf = new byte[8192];
    long total = 0;
    try (InputStream in = req.getInputStream()) {
      int n;
      while ((n = in.read(buf)) != -1) {
        total += n;
        if (total > limit) throw ApiException.tooLarge(limit);
        out.write(buf, 0, n);
      }
    } catch (IOException e) {
      throw new ClientGoneException(e);
    }
    return out.toByteArray();
  }

  /** 读取 JSON 对象。未带 Content-Type 时也按 JSON 解析（兼容性），带了但不是 JSON 则 415；空请求体按 {} 处理。 */
  public ObjectNode readJsonObject(HttpServletRequest req) {
    String type = mediaType(req);
    if (!type.isEmpty() && !type.equals("application/json") && !type.endsWith("+json")) {
      throw ApiException.unsupportedMediaType("请求体必须是 JSON");
    }
    byte[] body = readBody(req, JSON_LIMIT);
    if (body.length == 0) return mapper.createObjectNode();
    JsonNode data;
    try {
      data = mapper.readTree(body);
    } catch (IOException e) {
      throw ApiException.badRequest("请求体不是合法的 JSON");
    }
    if (data == null || data.isMissingNode()) throw ApiException.badRequest("请求体不是合法的 JSON");
    if (!data.isObject()) throw ApiException.badRequest("请求体必须是 JSON 对象");
    return (ObjectNode) data;
  }

  /** 读取 multipart 中名为 field 的文件。 */
  public UploadedFile readMultipartFile(HttpServletRequest req, String field, long maxFileBytes, long maxBodyBytes) {
    if (!mediaType(req).equals("multipart/form-data")) {
      throw ApiException.unsupportedMediaType("请使用 multipart/form-data 上传文件");
    }
    byte[] body = readBody(req, maxBodyBytes);
    String boundary = MultipartParser.boundaryOf(req.getContentType());
    MultipartParser.Part file = null;
    try {
      if (boundary == null) throw new MultipartParser.MalformedException("缺少 boundary");
      for (MultipartParser.Part p : MultipartParser.parse(body, boundary)) {
        if (field.equals(p.name()) && file == null) file = p;
      }
    } catch (MultipartParser.MalformedException e) {
      throw ApiException.badRequest("无法解析上传内容");
    }
    if (file == null || file.filename() == null) throw ApiException.badRequest("缺少文件字段 " + field);
    if (file.data().length > maxFileBytes) throw ApiException.tooLarge(maxFileBytes);
    return new UploadedFile(file.data(), file.filename());
  }
}
