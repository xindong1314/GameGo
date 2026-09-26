package com.gamego.testsupport;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;

/** 本地的假微信接口（真实 HTTP），按路径分发给可替换的处理函数，并记录每次调用。 */
public class FakeWx implements AutoCloseable {

  /** 一次调用。 */
  public record Call(String method, String path, Map<String, String> query, String contentType, byte[] body) {
    public String bodyText() {
      return new String(body, StandardCharsets.UTF_8);
    }
  }

  /** 响应。delayMs > 0 时先等待再回复（测超时）。 */
  public record Reply(int status, String body, long delayMs) {
    public static Reply json(String body) {
      return new Reply(200, body, 0);
    }

    public static Reply status(int status, String body) {
      return new Reply(status, body, 0);
    }
  }

  /** 处理函数。 */
  public interface Handler {
    Reply handle(Call call) throws Exception;
  }

  private final HttpServer server;
  private final List<Call> calls = Collections.synchronizedList(new ArrayList<>());
  private volatile Handler handler = c -> Reply.status(404, "{\"errcode\":-1}");

  public FakeWx() throws IOException {
    server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.createContext("/", this::serve);
    server.setExecutor(Executors.newCachedThreadPool(r -> {
      Thread t = new Thread(r, "fake-wx");
      t.setDaemon(true);
      return t;
    }));
    server.start();
  }

  public String base() {
    return "http://127.0.0.1:" + server.getAddress().getPort();
  }

  public void setHandler(Handler h) {
    handler = h;
  }

  public void reset() {
    calls.clear();
    handler = c -> Reply.status(404, "{\"errcode\":-1}");
  }

  public List<Call> calls() {
    synchronized (calls) {
      return new ArrayList<>(calls);
    }
  }

  public List<Call> of(String path) {
    return calls().stream().filter(c -> c.path().equals(path)).toList();
  }

  static Map<String, String> parseQuery(String q) {
    Map<String, String> m = new LinkedHashMap<>();
    if (q == null || q.isEmpty()) return m;
    for (String kv : q.split("&")) {
      int eq = kv.indexOf('=');
      String k = eq < 0 ? kv : kv.substring(0, eq);
      String v = eq < 0 ? "" : kv.substring(eq + 1);
      m.put(URLDecoder.decode(k, StandardCharsets.UTF_8), URLDecoder.decode(v, StandardCharsets.UTF_8));
    }
    return m;
  }

  private void serve(HttpExchange ex) throws IOException {
    byte[] body = ex.getRequestBody().readAllBytes();
    Call call = new Call(ex.getRequestMethod(), ex.getRequestURI().getPath(), parseQuery(ex.getRequestURI().getRawQuery()),
        ex.getRequestHeaders().getFirst("Content-Type"), body);
    calls.add(call);
    Reply r;
    try {
      r = handler.handle(call);
    } catch (Exception e) {
      r = Reply.status(500, "{}");
    }
    if (r.delayMs() > 0) {
      try {
        Thread.sleep(r.delayMs());
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
      }
    }
    byte[] out = r.body().getBytes(StandardCharsets.UTF_8);
    ex.getResponseHeaders().set("Content-Type", "text/plain");
    try {
      ex.sendResponseHeaders(r.status(), out.length);
      try (OutputStream os = ex.getResponseBody()) {
        os.write(out);
      }
    } catch (IOException ignored) {
      // 客户端已超时断开
    }
  }

  @Override
  public void close() {
    server.stop(0);
  }
}
