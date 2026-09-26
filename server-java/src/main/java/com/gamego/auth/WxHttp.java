package com.gamego.auth;

import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.HexFormat;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.springframework.stereotype.Component;

/**
 * 调用微信接口用的极简 HTTP 客户端（java.net.http）。超时覆盖整个请求（含读取响应正文），
 * 即使对方迟迟不发正文也能按时返回。
 */
@Component
public class WxHttp {

  /** HTTP 响应：状态码与正文（UTF-8 文本）。 */
  public record Response(int status, String body) {}

  /** 网络错误或超时。 */
  public static class WxHttpException extends Exception {
    private final boolean timeout;

    public WxHttpException(String msg, boolean timeout, Throwable cause) {
      super(msg, cause);
      this.timeout = timeout;
    }

    public boolean isTimeout() {
      return timeout;
    }
  }

  private static final SecureRandom RANDOM = new SecureRandom();

  private final HttpClient client =
      HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).followRedirects(HttpClient.Redirect.NEVER).build();

  public Response get(String url, long timeoutMs) throws WxHttpException {
    HttpRequest req = HttpRequest.newBuilder(URI.create(url)).GET().timeout(Duration.ofMillis(timeoutMs)).build();
    return send(req, timeoutMs);
  }

  public Response postJson(String url, String json, long timeoutMs) throws WxHttpException {
    HttpRequest req =
        HttpRequest.newBuilder(URI.create(url))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(json, StandardCharsets.UTF_8))
            .timeout(Duration.ofMillis(timeoutMs))
            .build();
    return send(req, timeoutMs);
  }

  /** multipart/form-data 上传一个文件字段。 */
  public Response postFile(String url, String field, String filename, String contentType, byte[] data, long timeoutMs)
      throws WxHttpException {
    String boundary = "----GameGo" + HexFormat.of().formatHex(randomBytes(12));
    ByteArrayOutputStream out = new ByteArrayOutputStream(data.length + 256);
    String head =
        "--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + field + "\"; filename=\"" + filename
            + "\"\r\nContent-Type: " + contentType + "\r\n\r\n";
    out.writeBytes(head.getBytes(StandardCharsets.UTF_8));
    out.writeBytes(data);
    out.writeBytes(("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
    HttpRequest req =
        HttpRequest.newBuilder(URI.create(url))
            .header("Content-Type", "multipart/form-data; boundary=" + boundary)
            .POST(HttpRequest.BodyPublishers.ofByteArray(out.toByteArray()))
            .timeout(Duration.ofMillis(timeoutMs))
            .build();
    return send(req, timeoutMs);
  }

  private static byte[] randomBytes(int n) {
    byte[] b = new byte[n];
    RANDOM.nextBytes(b);
    return b;
  }

  private Response send(HttpRequest req, long timeoutMs) throws WxHttpException {
    CompletableFuture<HttpResponse<String>> f =
        client.sendAsync(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    try {
      HttpResponse<String> res = f.get(timeoutMs, TimeUnit.MILLISECONDS);
      return new Response(res.statusCode(), res.body());
    } catch (TimeoutException e) {
      f.cancel(true);
      throw new WxHttpException("timeout", true, e);
    } catch (InterruptedException e) {
      f.cancel(true);
      Thread.currentThread().interrupt();
      throw new WxHttpException("interrupted", false, e);
    } catch (ExecutionException e) {
      Throwable c = e.getCause() == null ? e : e.getCause();
      boolean timeout = c instanceof java.net.http.HttpTimeoutException;
      throw new WxHttpException(c.toString(), timeout, c);
    }
  }
}
