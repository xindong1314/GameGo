package com.gamego.ws;

/**
 * 一条 WebSocket 连接的发送端（线程安全、不阻塞调用线程）。发送按调用顺序进行；
 * {@link #close} 在已排队的消息发完之后关闭；{@link #terminate} 丢弃排队的消息立即断开。
 * 生产实现 {@link SessionTransport}；测试里可以换成记录发送内容的实现。
 */
public interface Transport {
  /** 连接仍然打开且没有被要求关闭。 */
  boolean isOpen();

  /** 底层连接还没断开（关闭握手完成或断开后为 false）。 */
  boolean isConnected();

  /** 已排队、还没写出去的字节数（对应 ws 的 bufferedAmount）。 */
  long bufferedBytes();

  /** 排队发送一条文本消息；连接已关闭时返回 false。 */
  boolean sendText(String text);

  /** 排队发送一个 WebSocket ping 帧。 */
  void ping();

  /** 发完已排队的消息后以 code 关闭。 */
  void close(int code, String reason);

  /** 立即断开（不再发送排队中的消息）。 */
  void terminate();
}
