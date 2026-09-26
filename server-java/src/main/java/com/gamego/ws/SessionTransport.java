package com.gamego.ws;

import jakarta.websocket.CloseReason;
import java.nio.ByteBuffer;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.PingMessage;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.adapter.NativeWebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;

/**
 * {@link Transport} 的 Spring WebSocket 实现：游戏循环线程只把消息放进队列（不阻塞），
 * 由发送线程池按顺序写出（对应 Node 里 ws.send 的非阻塞语义）；排队字节数即 bufferedAmount。
 * 底层会话用 {@link ConcurrentWebSocketSessionDecorator} 包装（发送时限 / 缓冲上限，超出直接断开）。
 */
public class SessionTransport implements Transport {

  private static final Logger log = LoggerFactory.getLogger(SessionTransport.class);
  static final int SEND_TIME_LIMIT_MS = 10000;
  static final int BUFFER_SIZE_LIMIT = (int) Hub.MAX_BUFFERED_BYTES;

  private record Close(int code, String reason) {}

  private static final Object PING = new Object();

  private final WebSocketSession raw;
  private final WebSocketSession session;
  private final Executor sender;
  private final ConcurrentLinkedQueue<Object> queue = new ConcurrentLinkedQueue<>();
  private final AtomicLong buffered = new AtomicLong();
  private final AtomicBoolean draining = new AtomicBoolean(false);
  private volatile boolean closeRequested = false;
  private volatile boolean terminated = false;

  public SessionTransport(WebSocketSession raw, Executor sender) {
    this.raw = raw;
    this.session =
        new ConcurrentWebSocketSessionDecorator(
            raw, SEND_TIME_LIMIT_MS, BUFFER_SIZE_LIMIT, ConcurrentWebSocketSessionDecorator.OverflowStrategy.TERMINATE);
    this.sender = sender;
  }

  @Override
  public boolean isOpen() {
    return !closeRequested && !terminated && raw.isOpen();
  }

  @Override
  public boolean isConnected() {
    return raw.isOpen();
  }

  @Override
  public long bufferedBytes() {
    return buffered.get();
  }

  static int utf8Length(String s) {
    int n = 0;
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (Character.isHighSurrogate(c)) {
        n += 4;
        i++;
      } else n += 3;
    }
    return n;
  }

  @Override
  public boolean sendText(String text) {
    if (!isOpen()) return false;
    buffered.addAndGet(utf8Length(text));
    queue.add(text);
    kick();
    return true;
  }

  @Override
  public void ping() {
    if (!isOpen()) return;
    queue.add(PING);
    kick();
  }

  @Override
  public void close(int code, String reason) {
    if (closeRequested || terminated) return;
    closeRequested = true;
    queue.add(new Close(code, reason));
    kick();
  }

  @Override
  public void terminate() {
    if (terminated) return;
    terminated = true;
    closeRequested = true;
    queue.clear();
    sender.execute(this::abort);
  }

  private void kick() {
    if (draining.compareAndSet(false, true)) {
      try {
        sender.execute(this::drain);
      } catch (RuntimeException e) {
        draining.set(false);
        log.debug("无法调度发送任务：{}", e.getMessage());
      }
    }
  }

  private void drain() {
    for (;;) {
      Object item = queue.poll();
      if (item == null) {
        draining.set(false);
        // 放下标志之后又有新消息进来：继续发
        if (queue.isEmpty() || !draining.compareAndSet(false, true)) return;
        continue;
      }
      if (terminated) {
        queue.clear();
        continue;
      }
      try {
        if (item instanceof String text) {
          try {
            if (raw.isOpen()) session.sendMessage(new TextMessage(text));
          } finally {
            buffered.addAndGet(-utf8Length(text));
          }
        } else if (item == PING) {
          if (raw.isOpen()) session.sendMessage(new PingMessage(ByteBuffer.allocate(0)));
        } else if (item instanceof Close c) {
          if (raw.isOpen()) session.close(new CloseStatus(c.code(), c.reason()));
        }
      } catch (Exception e) {
        log.debug("WebSocket 发送失败：{}", e.getMessage());
      }
    }
  }

  /** 立即断开：关闭底层连接（Tomcat 下直接关闭 socket，不等对方的关闭帧）。 */
  private void abort() {
    try {
      if (raw instanceof NativeWebSocketSession nws) {
        Object nat = nws.getNativeSession();
        if (nat instanceof org.apache.tomcat.websocket.WsSession ws) {
          CloseReason reason = new CloseReason(CloseReason.CloseCodes.GOING_AWAY, "");
          ws.doClose(reason, new CloseReason(CloseReason.CloseCodes.CLOSED_ABNORMALLY, ""), true);
          return;
        }
      }
      if (raw.isOpen()) raw.close(CloseStatus.GOING_AWAY);
    } catch (Exception e) {
      log.debug("断开 WebSocket 出错：{}", e.getMessage());
    }
  }
}
