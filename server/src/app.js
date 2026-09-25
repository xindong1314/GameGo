'use strict';
const { ensureDirs } = require('./config');
const { createLogger } = require('./logger');
const { openDb, createRepos } = require('./db');
const { createHttpServer } = require('./http/server');

// 组装并启动完整服务（设计文档 2.5）：数据库 → 仓储 → AI → HTTP → WebSocket（realtime）→ listen。
// 任何一步失败都会关闭已经创建的部分再抛出错误。

const SESSION_PURGE_INTERVAL_MS = 60 * 60 * 1000;

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    function onError(err) {
      server.off('listening', onListening);
      reject(err);
    }
    function onListening() {
      server.off('error', onError);
      resolve();
    }
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeHttp(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    // 已无请求的 keep-alive 连接立即关闭，其余连接等请求处理完
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    // 最多再等 5 秒，之后强制断开
    const t = setTimeout(() => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    }, 5000);
    t.unref();
  });
}

function hostForUrl(host) {
  if (!host || host === '0.0.0.0') return '127.0.0.1';
  if (host === '::') return '[::1]';
  return host.includes(':') ? `[${host}]` : host;
}

async function startServer({ config, ai, logger, now = Date.now } = {}) {
  if (!config) throw new TypeError('startServer: 需要 config');
  const log = logger || createLogger({ level: 'info' });
  const cleanups = []; // 逆序执行

  async function runCleanups() {
    while (cleanups.length) {
      const fn = cleanups.pop();
      try {
        await fn();
      } catch (err) {
        log.error('关闭服务时出错：', err);
      }
    }
  }

  try {
    ensureDirs(config);

    const db = openDb(config.dbPath);
    cleanups.push(() => db.close());
    const repos = createRepos(db, { publicBaseUrl: config.publicBaseUrl, minGamesWinrate: config.minGamesWinrate });

    // 定时清理过期令牌（启动时先清一次，之后每小时一次）
    const purgeSessions = () => {
      try {
        const n = repos.sessions.purgeExpired(now());
        if (n) log.info('清理了 %d 个过期令牌', n);
      } catch (err) {
        log.error('清理过期令牌失败：', err);
      }
    };
    purgeSessions();
    const purgeTimer = setInterval(purgeSessions, SESSION_PURGE_INTERVAL_MS);
    if (typeof purgeTimer.unref === 'function') purgeTimer.unref();
    cleanups.push(() => clearInterval(purgeTimer));

    let aiService = ai;
    if (!aiService) {
      // 延迟加载：只有真正需要内置 AI 服务时才依赖 ai 模块
      const { createAiService } = require('./ai/service');
      aiService = createAiService({ config, logger: log });
      cleanups.push(() => (typeof aiService.shutdown === 'function' ? aiService.shutdown() : undefined));
    }

    let realtime = null;
    const httpServer = createHttpServer({
      config,
      repos,
      ai: aiService,
      logger: log,
      now,
      getActiveGames: (userId) => (realtime ? realtime.activeGamesOf(userId) : []),
    });
    cleanups.push(() => closeHttp(httpServer));

    const { createRealtime } = require('./realtime');
    realtime = createRealtime({ httpServer, repos, ai: aiService, config, logger: log, now });
    // realtime 先于 HTTP 关闭（逆序），让它有机会保存对局并通知客户端
    cleanups.push(() => realtime.close());

    await listen(httpServer, config.port, config.host);
    const port = httpServer.address().port;
    const url = `http://${hostForUrl(config.host)}:${port}`;

    let closing = null;
    function close() {
      if (!closing) closing = runCleanups();
      return closing;
    }

    return { url, port, repos, ai: aiService, httpServer, close };
  } catch (err) {
    await runCleanups();
    throw err;
  }
}

module.exports = { startServer };
