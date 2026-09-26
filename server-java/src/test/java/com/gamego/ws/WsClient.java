package com.gamego.ws;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.gamego.game.Json;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.net.http.WebSocketHandshakeException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.function.Predicate;

/**
 * 测试用 WebSocket 客户端（java.net.http.WebSocket，对应 Node 测试的 helpers/ws-client.js）。
 * 推送（非 res）进入 inbox；waitFor 先在 inbox 里找，找到就取走，否则等到来。
 */
public class WsClient implements WebSocket.Listener {

  public static final long DEFAULT_TIMEOUT = 5000;
  private static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();

  /** 连接被拒绝（HTTP 状态码）。 */
  public static final class Rejected extends RuntimeException {
    public final int status;

    Rejected(int status) {
      super("连接被拒绝：HTTP " + status);
      this.status = status;
    }
  }

  /** 请求失败（res.ok = false）。 */
  public static final class ReqError extends RuntimeException {
    public final String code;
    public final JsonNode err;

    ReqError(String t, JsonNode err) {
      super(t + " 失败：" + err);
      this.code = err.path("code").asText();
      this.err = err;
    }
  }

  public record CloseInfo(int code, String reason) {}

  private WebSocket ws;
  private final StringBuilder partial = new StringBuilder();
  public final List<JsonNode> log = new ArrayList<>();
  private final List<JsonNode> inbox = new ArrayList<>();
  private long nextRid = 1;
  public final CompletableFuture<CloseInfo> closed = new CompletableFuture<>();

  /** token 放在 ?token=（header 为 true 时放在 Authorization 头）。 */
  public static WsClient connect(String wsUrl, String token, boolean header) {
    WsClient c = new WsClient();
    WebSocket.Builder b = HTTP.newWebSocketBuilder().connectTimeout(Duration.ofSeconds(5));
    String url = wsUrl;
    if (token != null) {
      if (header) b.header("Authorization", "Bearer " + token);
      else url = wsUrl + "?token=" + URLEncoder.encode(token, StandardCharsets.UTF_8);
    }
    try {
      c.ws = b.buildAsync(URI.create(url), c).get(10, TimeUnit.SECONDS);
    } catch (ExecutionException e) {
      if (e.getCause() instanceof WebSocketHandshakeException he) throw new Rejected(he.getResponse().statusCode());
      throw new IllegalStateException(e.getCause());
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
    return c;
  }

  public static WsClient connect(String wsUrl, String token) {
    return connect(wsUrl, token, false);
  }

  // ---------------------------------------------------------------- Listener

  @Override
  public void onOpen(WebSocket webSocket) {
    webSocket.request(1);
  }

  @Override
  public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
    partial.append(data);
    if (last) {
      String text = partial.toString();
      partial.setLength(0);
      JsonNode msg;
      try {
        msg = Json.parse(text);
      } catch (Exception e) {
        msg = Json.MAPPER.createObjectNode().put("t", "__invalid__").put("raw", text);
      }
      synchronized (this) {
        log.add(msg);
        if (!"res".equals(msg.path("t").asText())) inbox.add(msg);
        notifyAll();
      }
    }
    webSocket.request(1);
    return null;
  }

  @Override
  public CompletionStage<?> onBinary(WebSocket webSocket, ByteBuffer data, boolean last) {
    webSocket.request(1);
    return null;
  }

  @Override
  public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
    synchronized (this) {
      closed.complete(new CloseInfo(statusCode, reason));
      notifyAll();
    }
    return null;
  }

  @Override
  public void onError(WebSocket webSocket, Throwable error) {
    synchronized (this) {
      closed.complete(new CloseInfo(1006, String.valueOf(error)));
      notifyAll();
    }
  }

  // ---------------------------------------------------------------- 发送

  public boolean isOpen() {
    return !closed.isDone() && !ws.isOutputClosed();
  }

  public void sendRaw(String text) {
    ws.sendText(text, true).join();
  }

  public void send(Object obj) {
    sendRaw(Json.write(obj));
  }

  public void sendBinary(byte[] data) {
    ws.sendBinary(ByteBuffer.wrap(data), true).join();
  }

  // request() 之间的最小间隔：服务端限流为每用户每秒 20 条，测试连续请求时留出余量（与 Node 测试的 pace 一致），
  // 避免机器繁忙时偶发 4008。限流测试用 send() 直接连发，不受影响。
  private static final long REQUEST_GAP_MS = 55;
  private long lastRequestAt;

  /** 发送请求并等待 res（完整的 res 消息）。 */
  public JsonNode request(String t, Map<String, Object> params) {
    long rid;
    long wait;
    synchronized (this) {
      rid = nextRid++;
      long now = System.currentTimeMillis();
      wait = Math.max(0, lastRequestAt + REQUEST_GAP_MS - now);
      lastRequestAt = now + wait;
    }
    if (wait > 0) sleep(wait);
    ObjectNode msg = Json.MAPPER.valueToTree(params == null ? Map.of() : params);
    msg.put("t", t);
    msg.put("rid", rid);
    sendRaw(msg.toString());
    long deadline = System.currentTimeMillis() + DEFAULT_TIMEOUT;
    synchronized (this) {
      for (;;) {
        for (JsonNode m : log) {
          if ("res".equals(m.path("t").asText()) && m.path("rid").asLong(-1) == rid) return m;
        }
        if (closed.isDone()) throw new IllegalStateException(t + "：连接已关闭 " + closed.getNow(null));
        long left = deadline - System.currentTimeMillis();
        if (left <= 0) throw new IllegalStateException(t + " 请求超时");
        try {
          wait(left);
        } catch (InterruptedException e) {
          Thread.currentThread().interrupt();
          throw new IllegalStateException(e);
        }
      }
    }
  }

  public JsonNode request(String t) {
    return request(t, null);
  }

  /** ok 时返回 data（没有 data 时为 null），否则抛 ReqError。 */
  public JsonNode req(String t, Map<String, Object> params) {
    JsonNode res = request(t, params);
    if (!res.path("ok").asBoolean()) throw new ReqError(t, res.path("err"));
    return res.get("data");
  }

  public JsonNode req(String t) {
    return req(t, null);
  }

  /** 请求失败时的错误码（成功返回 null）。 */
  public String errCode(String t, Map<String, Object> params) {
    JsonNode res = request(t, params);
    return res.path("ok").asBoolean() ? null : res.path("err").path("code").asText();
  }

  // ---------------------------------------------------------------- 接收

  public JsonNode waitFor(String t) {
    return waitFor(t, null, DEFAULT_TIMEOUT);
  }

  public JsonNode waitFor(String t, Predicate<JsonNode> filter) {
    return waitFor(t, filter, DEFAULT_TIMEOUT);
  }

  public synchronized JsonNode waitFor(String t, Predicate<JsonNode> filter, long timeoutMs) {
    long deadline = System.currentTimeMillis() + timeoutMs;
    for (;;) {
      Iterator<JsonNode> it = inbox.iterator();
      while (it.hasNext()) {
        JsonNode m = it.next();
        if (t.equals(m.path("t").asText()) && (filter == null || filter.test(m))) {
          it.remove();
          return m;
        }
      }
      if (closed.isDone()) throw new IllegalStateException("连接已关闭，等不到 " + t + "：" + closed.getNow(null));
      long left = deadline - System.currentTimeMillis();
      if (left <= 0) throw new IllegalStateException("等待 " + t + " 超时；收到过：" + log);
      try {
        wait(left);
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        throw new IllegalStateException(e);
      }
    }
  }

  /** 断言一段时间内没有收到某类推送。 */
  public void expectNone(String t, long ms) {
    sleep(ms);
    synchronized (this) {
      for (JsonNode m : inbox) {
        if (t.equals(m.path("t").asText())) throw new AssertionError("不应收到 " + t + "：" + m);
      }
    }
  }

  /** 取走 inbox 里某类推送。 */
  public synchronized List<JsonNode> drain(String t) {
    List<JsonNode> out = new ArrayList<>();
    inbox.removeIf(m -> {
      if (t == null || t.equals(m.path("t").asText())) {
        out.add(m);
        return true;
      }
      return false;
    });
    return out;
  }

  public synchronized List<JsonNode> logCopy() {
    return new ArrayList<>(log);
  }

  /** 等待连接关闭。 */
  public CloseInfo awaitClose() {
    try {
      return closed.get(10, TimeUnit.SECONDS);
    } catch (Exception e) {
      throw new IllegalStateException("连接没有关闭", e);
    }
  }

  public void close() {
    if (!ws.isOutputClosed()) {
      try {
        ws.sendClose(1000, "").get(5, TimeUnit.SECONDS);
      } catch (Exception ignored) {
        // 已断开
      }
    }
  }

  public void abort() {
    ws.abort();
  }

  public static void sleep(long ms) {
    try {
      Thread.sleep(ms);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
    }
  }
}
