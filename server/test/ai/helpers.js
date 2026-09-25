'use strict';
const util = require('node:util');

// AI 模块测试的公共小工具

// 记录日志的 logger：logs.warn 等为格式化后的字符串数组
function captureLogger() {
  const logs = { debug: [], info: [], warn: [], error: [] };
  const logger = { logs };
  for (const level of Object.keys(logs)) logger[level] = (...args) => logs[level].push(util.format(...args));
  return logger;
}

// 轮询等待条件成立（带引用的定时器，保证事件循环不会提前结束）
async function waitFor(pred, { timeoutMs = 5000, intervalMs = 10, what = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// 等待 promise 被拒绝，返回错误
async function rejectsWith(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('应当被拒绝');
}

// 确定性的伪随机数（mulberry32）。算法：Tommy Ettinger，2017，CC0 公有领域
//   https://gist.github.com/tommyettinger/46a874533244883189143505d203312c
// JS 写法同 bryc/code（公有领域）：https://github.com/bryc/code/blob/master/jshash/PRNGs.md#mulberry32
function mulberry32(seed) {
  let s = seed;
  return function rng() {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { captureLogger, waitFor, rejectsWith, mulberry32 };
