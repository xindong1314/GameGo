'use strict';
const { parseMessage } = require('./protocol');
const { GameError } = require('../game/errors');

// 消息路由：校验 → 分发给大厅/对局管理器 → 带 rid 的请求一定回一条 res。
// 请求处理中产生的推送（对手的 game.move、match.found 等）经 hub.batch 排在 res 之后发出。

function createRouter({ hub, lobby, manager, logger, now = Date.now }) {
  const handlers = {
    hello: (ctx) => lobby.hello(ctx.userId),
    'match.join': (ctx, p) => lobby.matchJoin(ctx.userId, p.size),
    'match.cancel': (ctx) => {
      lobby.matchCancel(ctx.userId);
    },
    'room.create': (ctx, p) => lobby.roomCreate(ctx.userId, p.size, p.color),
    'room.get': (ctx, p) => lobby.roomGet(ctx.userId, p.code),
    'room.join': (ctx, p) => lobby.roomJoin(ctx.userId, p.code),
    'room.leave': (ctx) => {
      lobby.roomLeave(ctx.userId);
    },
    'ai.start': (ctx, p) => lobby.aiStart(ctx.userId, p),
    'game.sync': (ctx, p) => {
      const game = manager.sync(ctx.userId, p.gameId);
      ctx.conn.subscribe(p.gameId); // 只有对局者能走到这里
      return { game };
    },
    'game.move': (ctx, p) => {
      manager.move(ctx.userId, p.gameId, p.n, p.idx);
    },
    'game.pass': (ctx, p) => {
      manager.pass(ctx.userId, p.gameId, p.n);
    },
    'game.resign': (ctx, p) => {
      manager.resign(ctx.userId, p.gameId);
    },
    'game.undo': (ctx, p) => {
      manager.undo(ctx.userId, p.gameId);
    },
    'game.score.toggle': (ctx, p) => {
      manager.toggleDead(ctx.userId, p.gameId, p.idx, p.version);
    },
    'game.score.accept': (ctx, p) => {
      manager.acceptScore(ctx.userId, p.gameId, p.version);
    },
    'game.score.resume': (ctx, p) => {
      manager.resumeScore(ctx.userId, p.gameId);
    },
  };

  function toErr(err, t, userId) {
    if (err instanceof GameError) return err.toJSON();
    logger.error(`处理 ${t}（用户 ${userId}）时出错`, err);
    return { code: 'internal', msg: '服务器内部错误' };
  }

  // conn：{ userId, sendNow(msg), subscribe(gameId) }；msg：JSON.parse 之后的值
  function handle(conn, msg) {
    const parsed = parseMessage(msg);
    if (!parsed.ok) {
      if (parsed.rid !== undefined) {
        conn.sendNow({ t: 'res', rid: parsed.rid, ok: false, err: parsed.err.toJSON() });
      } else {
        logger.debug(`用户 ${conn.userId} 发来无效消息：${parsed.err.msg}`);
      }
      return;
    }
    const { t, rid, params } = parsed;
    if (t === 'ping') {
      conn.sendNow({ t: 'pong', ts: now() });
      return;
    }
    hub.batch(() => {
      let res;
      try {
        const data = handlers[t]({ conn, userId: conn.userId }, params);
        res = { t: 'res', rid, ok: true };
        if (data !== undefined) res.data = data;
      } catch (err) {
        res = { t: 'res', rid, ok: false, err: toErr(err, t, conn.userId) };
      }
      if (rid !== undefined) conn.sendNow(res);
      else if (!res.ok) logger.debug(`用户 ${conn.userId} 的 ${t} 失败（无 rid）：${res.err.code}`);
    });
  }

  return { handle };
}

module.exports = { createRouter };
