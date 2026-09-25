'use strict';
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { startServer } = require('./app');

// 服务入口：读取配置（含 server/.env）→ 启动 → 收到 SIGINT/SIGTERM 时优雅退出。

const SHUTDOWN_TIMEOUT_MS = 15000;

async function main() {
  let config;
  let logger;
  try {
    config = loadConfig(); // 会先读取 server/.env（若存在）
    logger = createLogger({ level: process.env.LOG_LEVEL || 'info' });
  } catch (err) {
    process.stderr.write(`配置错误：${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  if (config.devLogin) logger.warn('DEV_LOGIN=1：开发登录已开启，正式上线前务必关闭');
  if (!config.wx.appId || !config.wx.secret) logger.warn('未配置 WX_APPID/WX_SECRET：微信登录不可用');
  if (config.katago) logger.info('KataGo：%s（模型 %s）', config.katago.path, config.katago.model);
  else logger.warn('未配置 KataGo（KATAGO_PATH/KATAGO_MODEL）%s', config.aiFallback ? '，使用内置弱 AI' : '，人机对弈不可用');

  let app;
  try {
    app = await startServer({ config, logger });
  } catch (err) {
    logger.error('启动失败：', err);
    process.exitCode = 1;
    return;
  }
  logger.info('服务已启动：%s（数据库 %s，对外地址 %s）', app.url, config.dbPath, config.publicBaseUrl);

  let stopping = false;
  async function shutdown(signal, code = 0) {
    if (stopping) {
      logger.warn('再次收到 %s，立即退出', signal);
      process.exit(1);
    }
    stopping = true;
    logger.info('收到 %s，正在关闭…', signal);
    const timer = setTimeout(() => {
      logger.error('关闭超时（%d 秒），强制退出', SHUTDOWN_TIMEOUT_MS / 1000);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    try {
      await app.close();
      logger.info('已关闭');
    } catch (err) {
      logger.error('关闭时出错：', err);
      code = 1;
    }
    process.exit(code);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error('未处理的 Promise 拒绝：', reason);
  });
  process.on('uncaughtException', (err) => {
    logger.error('未捕获的异常，进程将退出：', err);
    shutdown('uncaughtException', 1);
  });
}

main();
