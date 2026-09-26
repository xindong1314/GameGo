package com.gamego.game;

import java.util.Map;

/**
 * 推送通道（由 com.gamego.ws.Hub 实现；对应 Node 版 manager / lobby 用到的 hub 接口）。只在游戏循环线程上调用。
 */
public interface GamePush {
  /** 发给用户当前的连接。 */
  void send(long userId, Map<String, Object> msg);

  /** 只发给订阅了该局（game.sync 过）的连接。 */
  void sendGame(long userId, String gameId, Map<String, Object> msg);

  /** 用户当前是否有连接。 */
  boolean isOnline(long userId);
}
