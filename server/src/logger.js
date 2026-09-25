'use strict';
const util = require('node:util');

// 极简日志：带 ISO 时间戳与级别，debug/info 写 stdout，warn/error 写 stderr。
// 参数按 console.log 的规则格式化（Error 会带上堆栈）。

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function createLogger({ level = 'info', stdout = process.stdout, stderr = process.stderr, clock = () => new Date() } = {}) {
  const name = String(level || 'info').toLowerCase();
  if (!(name in LEVELS)) {
    throw new Error(`未知的日志级别 "${level}"，可选：${Object.keys(LEVELS).join(' / ')}`);
  }
  const threshold = LEVELS[name];

  function make(lv, stream) {
    if (LEVELS[lv] < threshold) return () => {};
    const tag = lv.toUpperCase().padEnd(5);
    return (...args) => {
      const line = `${clock().toISOString()} ${tag} ${util.format(...args)}\n`;
      try {
        stream.write(line);
      } catch {
        // 输出流已关闭（进程退出中）时放弃，不能让日志拖垮业务
      }
    };
  }

  return {
    level: name,
    debug: make('debug', stdout),
    info: make('info', stdout),
    warn: make('warn', stderr),
    error: make('error', stderr),
  };
}

const noop = () => {};
const silentLogger = Object.freeze({ level: 'silent', debug: noop, info: noop, warn: noop, error: noop });

module.exports = { createLogger, silentLogger, LEVELS };
