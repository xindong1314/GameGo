'use strict';
const { Hub } = require('./ws/hub');
const { createRouter } = require('./ws/router');
const { buildSettings } = require('./game/settings');
const { GameManager } = require('./game/manager');
const { Matchmaker } = require('./game/matchmaker');
const { RoomRegistry } = require('./game/rooms');
const { Lobby } = require('./game/lobby');

// 实时服务（设计文档 2.5）：在 httpServer 上挂 WebSocket（路径 /ws），
// 组装匹配队列、好友房、对局管理器，并恢复未结束的对局。

const DEFAULT_TIMERS = Object.freeze({
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h),
});

const LOBBY_PRUNE_MS = 60000;
const noop = () => {};
const SILENT = Object.freeze({ debug: noop, info: noop, warn: noop, error: noop });

// 未提供 AI 服务时的占位：不可用
const NO_AI = Object.freeze({
  available: () => false,
  levels: () => [],
  chooseMove: () => Promise.reject(new Error('AI 不可用')),
  judgeDead: () => Promise.reject(new Error('AI 不可用')),
  shutdown: () => Promise.resolve(),
});

function checkTimers(timers) {
  for (const k of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']) {
    if (!timers || typeof timers[k] !== 'function') throw new TypeError(`createRealtime: timers.${k} 必须是函数`);
  }
}

// randomInt、hubLimits（见 ws/hub.js 的 limits）为可选的测试注入项
function createRealtime({ httpServer, repos, ai, config, logger, now = Date.now, timers = DEFAULT_TIMERS, randomInt, hubLimits } = {}) {
  if (!httpServer || typeof httpServer.on !== 'function') throw new TypeError('createRealtime: 需要 httpServer');
  if (!repos || !repos.sessions || !repos.games || !repos.users || !repos.stats || typeof repos.transaction !== 'function') {
    throw new TypeError('createRealtime: repos 不完整');
  }
  if (typeof now !== 'function') throw new TypeError('createRealtime: now 必须是函数');
  checkTimers(timers);
  const log = logger || SILENT;
  const aiService = ai || NO_AI;
  const settings = buildSettings(config);
  const rnd = typeof randomInt === 'function' ? { randomInt } : {};

  // 各模块互相引用：hub 的回调在连接到来时才会被调用，届时都已创建
  let manager = null;
  let lobby = null;
  let router = null;

  const hub = new Hub({
    httpServer,
    repos,
    logger: log,
    now,
    timers,
    limits: hubLimits,
    handlers: {
      onOpen: (conn) => manager.userOnline(conn.userId),
      onReplace: (conn) => lobby.userReplaced(conn.userId),
      onClose: (conn) => {
        lobby.userOffline(conn.userId);
        manager.userOffline(conn.userId);
      },
      onMessage: (conn, msg) => router.handle(conn, msg),
    },
  });

  manager = new GameManager({ repos, ai: aiService, settings, logger: log, now, timers, hub, ...rnd });
  const matchmaker = new Matchmaker({ sizes: settings.sizes, now });
  const rooms = new RoomRegistry({
    ttlMs: settings.roomTtlMs,
    now,
    timers,
    logger: log,
    onExpire: (room) => hub.batch(() => lobby.onRoomExpired(room)),
    ...rnd,
  });
  lobby = new Lobby({ manager, matchmaker, rooms, repos, hub, settings, logger: log, now, ...rnd });
  router = createRouter({ hub, lobby, manager, logger: log, now });

  manager.restore();
  hub.start();
  // 大厅的限流表（ai.start、猜房号）定期清掉补满的桶，内存占用有界
  const pruneTimer = timers.setInterval(() => {
    try {
      lobby.prune();
    } catch (err) {
      log.error('清理限流记录失败', err);
    }
  }, LOBBY_PRUNE_MS);
  if (pruneTimer && typeof pruneTimer.unref === 'function') pruneTimer.unref();

  let closing = null;
  return {
    activeGamesOf(userId) {
      return manager.activeGamesOf(userId);
    },
    close() {
      if (!closing) {
        timers.clearInterval(pruneTimer);
        manager.shutdown();
        rooms.clear();
        matchmaker.clear();
        closing = hub.close();
      }
      return closing;
    },
    // 测试与排障用，不属于对外契约
    _internals: { hub, manager, lobby, rooms, matchmaker, settings },
  };
}

module.exports = { createRealtime };
