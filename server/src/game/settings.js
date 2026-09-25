'use strict';
const { normalizeTimeControl } = require('./clock');

// 从 Config（设计文档 2.5）提取对局相关设置并校验。缺省项用默认值，给了但不合法直接抛错（启动即失败）。

const SIZES = Object.freeze([9, 13, 19]);

const DEFAULT_TIME_CONTROLS = {
  9: { mainMs: 180000, periods: 3, periodMs: 20000 },
  13: { mainMs: 360000, periods: 3, periodMs: 30000 },
  19: { mainMs: 600000, periods: 3, periodMs: 30000 },
};

const DEFAULTS = {
  komi: 7.5,
  minMovesRanked: 10,
  rankedPairDailyMax: 3, // 同一对手 24 小时内最多计入排行的局数（0 = 不限）
  firstMoveTimeoutMs: 60000,
  abandonMs: 90000,
  scoringTimeoutMs: 180000,
  judgeTimeoutMs: 15000,
  aiIdleTimeoutMs: 86400000,
  roomTtlMs: 1800000,
  // 以下各项不在 Config 契约里，可选覆盖（测试用）
  aiMoveTimeoutMs: 60000, // 单次 AI 落子请求的兜底超时
  aiRetryDelaysMs: [2000, 5000, 10000, 20000], // AI 落子失败后的重试间隔；全部失败则对局作废
  resumeLimit: 1, // 真人对局每方每局最多"继续对局"几次（0 = 不允许）
  scoringGraceMs: 60000, // 有人点选死子后，自动确认时限至少顺延到这么久之后
  arrivalGraceMs: 300000, // 开局时不在线、或重启恢复后还没回来的玩家最多等多久（超时作废）
  aiMaxPerUser: 2, // 每个玩家同时在途的 AI 落子请求上限（被悔棋等作废但 AI 还在算的也算），超出的排队
  aiMaxInflight: 16, // 全服同时在途的 AI 落子请求上限，超出的排队
  aiStartBurst: 5, // ai.start 限流：突发次数
  aiStartRefillMs: 10000, // ai.start 限流：每隔多久恢复一次
  roomMissBurst: 10, // room.get / room.join 找不到房间的次数限流（防猜房号）：突发次数
  roomMissRefillMs: 6000, // 每隔多久恢复一次
  endedCacheMax: 2000, // 内存里保留的刚结束对局最多多少局
};

function positiveInt(config, key, { allowZero = false } = {}) {
  const v = config[key];
  if (v === undefined || v === null) return DEFAULTS[key];
  if (!Number.isSafeInteger(v) || v < 0 || (!allowZero && v === 0)) {
    throw new TypeError(`config.${key} 必须是${allowZero ? '非负' : '正'}整数，当前为 ${String(v)}`);
  }
  return v;
}

function buildSettings(config) {
  const c = config && typeof config === 'object' ? config : {};
  const komi = c.komi === undefined || c.komi === null ? DEFAULTS.komi : c.komi;
  if (typeof komi !== 'number' || !Number.isFinite(komi)) throw new TypeError('config.komi 必须是数字');

  const timeControls = {};
  for (const size of SIZES) {
    const tc = c.timeControls && c.timeControls[size];
    timeControls[size] = normalizeTimeControl(tc || DEFAULT_TIME_CONTROLS[size]);
  }

  let aiRetryDelaysMs = DEFAULTS.aiRetryDelaysMs;
  if (c.aiRetryDelaysMs !== undefined) {
    if (!Array.isArray(c.aiRetryDelaysMs) || !c.aiRetryDelaysMs.every((v) => Number.isSafeInteger(v) && v >= 0)) {
      throw new TypeError('config.aiRetryDelaysMs 必须是非负整数数组');
    }
    aiRetryDelaysMs = c.aiRetryDelaysMs.slice();
  }

  return Object.freeze({
    sizes: SIZES,
    komi,
    timeControls,
    publicBaseUrl: String(c.publicBaseUrl || '').replace(/\/+$/, ''),
    minMovesRanked: positiveInt(c, 'minMovesRanked', { allowZero: true }),
    rankedPairDailyMax: positiveInt(c, 'rankedPairDailyMax', { allowZero: true }),
    firstMoveTimeoutMs: positiveInt(c, 'firstMoveTimeoutMs'),
    abandonMs: positiveInt(c, 'abandonMs'),
    scoringTimeoutMs: positiveInt(c, 'scoringTimeoutMs'),
    judgeTimeoutMs: positiveInt(c, 'judgeTimeoutMs'),
    aiIdleTimeoutMs: positiveInt(c, 'aiIdleTimeoutMs'),
    roomTtlMs: positiveInt(c, 'roomTtlMs'),
    aiMoveTimeoutMs: positiveInt(c, 'aiMoveTimeoutMs'),
    aiRetryDelaysMs,
    resumeLimit: positiveInt(c, 'resumeLimit', { allowZero: true }),
    scoringGraceMs: positiveInt(c, 'scoringGraceMs'),
    arrivalGraceMs: positiveInt(c, 'arrivalGraceMs'),
    aiMaxPerUser: positiveInt(c, 'aiMaxPerUser'),
    aiMaxInflight: positiveInt(c, 'aiMaxInflight'),
    aiStartBurst: positiveInt(c, 'aiStartBurst'),
    aiStartRefillMs: positiveInt(c, 'aiStartRefillMs'),
    roomMissBurst: positiveInt(c, 'roomMissBurst'),
    roomMissRefillMs: positiveInt(c, 'roomMissRefillMs'),
    endedCacheMax: positiveInt(c, 'endedCacheMax'),
  });
}

module.exports = { buildSettings, SIZES, DEFAULT_TIME_CONTROLS, DEFAULTS };
