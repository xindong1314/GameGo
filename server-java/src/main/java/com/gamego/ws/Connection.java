package com.gamego.ws;

import com.gamego.game.Json;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.Map;

/**
 * 一个用户的 WebSocket 连接（对应 Node 版 ws/hub.js 的 Connection）。订阅集合只在游戏循环线程上读写；
 * closing / replaced / missedPongs 也会被 WebSocket 处理线程读取，所以是 volatile。
 */
public class Connection {
  final Hub hub;
  final Transport transport;
  final long userId;
  final long id;
  private final LinkedHashSet<String> subs = new LinkedHashSet<>();
  volatile int missedPongs = 0;
  volatile boolean closing = false;
  volatile boolean replaced = false;
  /** 消息限流触发后，处理线程不再接收这条连接的消息（关闭动作排在游戏循环里，保证之前的回复先发出）。 */
  volatile boolean rateClosed = false;

  Connection(Hub hub, Transport transport, long userId, long id) {
    this.hub = hub;
    this.transport = transport;
    this.userId = userId;
    this.id = id;
  }

  public long userId() {
    return userId;
  }

  public void subscribe(String gameId) {
    if (subs.contains(gameId)) return;
    if (subs.size() >= Hub.MAX_SUBSCRIPTIONS) {
      Iterator<String> it = subs.iterator();
      it.next();
      it.remove();
    }
    subs.add(gameId);
  }

  public boolean isSubscribed(String gameId) {
    return subs.contains(gameId);
  }

  /** 立即发送（不经过 batch 队列）。对方长期不读、积压超过上限时断开连接。 */
  public boolean sendNow(Map<String, Object> msg) {
    if (!transport.isOpen()) return false;
    long buffered = transport.bufferedBytes();
    if (buffered > hub.maxBufferedBytes) {
      hub.logger.warn("用户 " + userId + " 的连接发送积压 " + buffered + " 字节，断开");
      closing = true;
      transport.terminate();
      return false;
    }
    try {
      return transport.sendText(Json.write(msg));
    } catch (RuntimeException err) {
      hub.logger.warn("发送给用户 " + userId + " 失败：" + err.getMessage());
      return false;
    }
  }

  public void close(int code, String reason) {
    closing = true;
    try {
      transport.close(code, reason);
    } catch (RuntimeException err) {
      hub.logger.debug("关闭连接出错：" + err.getMessage());
      transport.terminate();
    }
  }

  public void terminate() {
    closing = true;
    transport.terminate();
  }
}
