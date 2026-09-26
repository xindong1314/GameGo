package com.gamego.ws;

import java.util.concurrent.Executor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.PongMessage;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.AbstractWebSocketHandler;

/**
 * /ws 的 WebSocket 处理器：握手已由 {@link WsHandshakeInterceptor} 完成鉴权；这里只把连接事件与消息转交给
 * 握手时的 {@link Hub}（限流与 JSON 解析在本线程，业务处理排进游戏循环）。
 */
public class GameWebSocketHandler extends AbstractWebSocketHandler {

  private static final Logger log = LoggerFactory.getLogger(GameWebSocketHandler.class);
  static final String ATTR_CONN = "gamego.conn";

  private final Executor sender;

  public GameWebSocketHandler(Executor sender) {
    this.sender = sender;
  }

  private static Connection conn(WebSocketSession session) {
    return (Connection) session.getAttributes().get(ATTR_CONN);
  }

  @Override
  public void afterConnectionEstablished(WebSocketSession session) {
    Hub hub = (Hub) session.getAttributes().get(WsHandshakeInterceptor.ATTR_HUB);
    Long userId = (Long) session.getAttributes().get(WsHandshakeInterceptor.ATTR_USER_ID);
    if (hub == null || userId == null) {
      try {
        session.close(CloseStatus.POLICY_VIOLATION);
      } catch (Exception ignored) {
        // 已断开
      }
      return;
    }
    Connection c = hub.open(new SessionTransport(session, sender), userId);
    session.getAttributes().put(ATTR_CONN, c);
  }

  @Override
  protected void handleTextMessage(WebSocketSession session, TextMessage message) {
    Connection c = conn(session);
    if (c != null) c.hub.onText(c, message.getPayload());
  }

  @Override
  protected void handleBinaryMessage(WebSocketSession session, BinaryMessage message) {
    Connection c = conn(session);
    if (c != null) c.hub.onBinary(c);
  }

  @Override
  protected void handlePongMessage(WebSocketSession session, PongMessage message) {
    Connection c = conn(session);
    if (c != null) c.hub.onPong(c);
  }

  @Override
  public void handleTransportError(WebSocketSession session, Throwable exception) {
    Connection c = conn(session);
    log.debug("用户 {} 的连接出错：{}", c == null ? null : c.userId, exception.getMessage());
  }

  @Override
  public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
    Connection c = conn(session);
    if (c != null) c.hub.closed(c);
  }

  @Override
  public boolean supportsPartialMessages() {
    return false;
  }
}
