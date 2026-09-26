package com.gamego.ws;

import com.gamego.game.GameError;
import com.gamego.game.GameLog;
import com.gamego.game.GameLoop;
import com.gamego.game.GameManager;
import com.gamego.game.Lobby;
import com.gamego.game.Msg;
import java.util.Map;

/**
 * 消息路由（移植自 Node 版 ws/router.js）：校验 → 分发给大厅/对局管理器 → 带 rid 的请求一定回一条 res。
 * 请求处理中产生的推送（对手的 game.move、match.found 等）经 hub.batch 排在 res 之后发出。只在游戏循环线程上调用。
 */
public class Router {

  @FunctionalInterface
  private interface Handler {
    /** 返回 res.data（null 表示没有 data 字段）。 */
    Object handle(Connection conn, long userId, Map<String, Object> p);
  }

  private final Hub hub;
  private final Lobby lobby;
  private final GameManager manager;
  private final GameLog logger;
  private final GameLoop loop;
  private final Map<String, Handler> handlers;

  public Router(Hub hub, Lobby lobby, GameManager manager, GameLog logger, GameLoop loop) {
    this.hub = hub;
    this.lobby = lobby;
    this.manager = manager;
    this.logger = logger;
    this.loop = loop;
    this.handlers = new java.util.HashMap<>();
    handlers.put("hello", (c, uid, p) -> lobby.hello(uid));
    handlers.put("match.join", (c, uid, p) -> lobby.matchJoin(uid, (Integer) p.get("size")));
    handlers.put("match.cancel", (c, uid, p) -> {
      lobby.matchCancel(uid);
      return null;
    });
    handlers.put("room.create", (c, uid, p) -> lobby.roomCreate(uid, (Integer) p.get("size"), (String) p.get("color")));
    handlers.put("room.get", (c, uid, p) -> lobby.roomGet(uid, (String) p.get("code")));
    handlers.put("room.join", (c, uid, p) -> lobby.roomJoin(uid, (String) p.get("code")));
    handlers.put("room.leave", (c, uid, p) -> {
      lobby.roomLeave(uid);
      return null;
    });
    handlers.put(
        "ai.start",
        (c, uid, p) -> lobby.aiStart(uid, (Integer) p.get("size"), (String) p.get("level"), (String) p.get("color")));
    handlers.put("game.sync", (c, uid, p) -> {
      String gameId = (String) p.get("gameId");
      Map<String, Object> game = manager.sync(uid, gameId);
      c.subscribe(gameId); // 只有对局者能走到这里
      return Msg.of("game", game);
    });
    handlers.put("game.move", (c, uid, p) -> {
      manager.move(uid, (String) p.get("gameId"), (Integer) p.get("n"), (Integer) p.get("idx"));
      return null;
    });
    handlers.put("game.pass", (c, uid, p) -> {
      manager.pass(uid, (String) p.get("gameId"), (Integer) p.get("n"));
      return null;
    });
    handlers.put("game.resign", (c, uid, p) -> {
      manager.resign(uid, (String) p.get("gameId"));
      return null;
    });
    handlers.put("game.undo", (c, uid, p) -> {
      manager.undo(uid, (String) p.get("gameId"));
      return null;
    });
    handlers.put("game.score.toggle", (c, uid, p) -> {
      manager.toggleDead(uid, (String) p.get("gameId"), (Integer) p.get("idx"), (Integer) p.get("version"));
      return null;
    });
    handlers.put("game.score.accept", (c, uid, p) -> {
      manager.acceptScore(uid, (String) p.get("gameId"), (Integer) p.get("version"));
      return null;
    });
    handlers.put("game.score.resume", (c, uid, p) -> {
      manager.resumeScore(uid, (String) p.get("gameId"));
      return null;
    });
  }

  private Map<String, Object> toErr(RuntimeException err, String t, long userId) {
    if (err instanceof GameError ge) return ge.toJson();
    logger.error("处理 " + t + "（用户 " + userId + "）时出错", err);
    return Msg.of("code", "internal", "msg", "服务器内部错误");
  }

  public void handle(Connection conn, Protocol.Parsed parsed) {
    if (!parsed.ok()) {
      if (parsed.rid() != null) {
        conn.sendNow(Msg.of("t", "res", "rid", parsed.rid(), "ok", false, "err", parsed.err().toJson()));
      } else {
        logger.debug("用户 " + conn.userId + " 发来无效消息：" + parsed.err().msg());
      }
      return;
    }
    String t = parsed.t();
    Object rid = parsed.rid();
    if (t.equals("ping")) {
      conn.sendNow(Msg.of("t", "pong", "ts", loop.now()));
      return;
    }
    hub.batch(() -> {
      Map<String, Object> res;
      try {
        Object data = handlers.get(t).handle(conn, conn.userId, parsed.params());
        res = Msg.of("t", "res", "rid", rid, "ok", true);
        if (data != null) res.put("data", data);
      } catch (RuntimeException err) {
        res = Msg.of("t", "res", "rid", rid, "ok", false, "err", toErr(err, t, conn.userId));
      }
      if (rid != null) conn.sendNow(res);
      else if (!Boolean.TRUE.equals(res.get("ok"))) {
        @SuppressWarnings("unchecked")
        Map<String, Object> e = (Map<String, Object>) res.get("err");
        logger.debug("用户 " + conn.userId + " 的 " + t + " 失败（无 rid）：" + e.get("code"));
      }
    });
  }
}
