'use strict';
// 人机设置纯逻辑：难度列表校验、默认难度、执子选项、本地记住的设置。

const home = require('../index/home');

const AI_COLORS = [
  { id: 'black', name: '执黑', desc: '先行' },
  { id: 'white', name: '执白', desc: '后行' },
  { id: 'random', name: '随机', desc: '猜先' },
];

function isColor(value) {
  return AI_COLORS.some((c) => c.id === value);
}

// GET /api/ai/levels 的响应 → { available, levels: [{ id, name, desc }] }（丢弃不完整的条目）
function normalizeLevels(res) {
  const list = res && Array.isArray(res.levels) ? res.levels : [];
  const seen = {};
  const levels = [];
  list.forEach((lv) => {
    if (!lv || (typeof lv.id !== 'string' && typeof lv.id !== 'number')) return;
    const id = String(lv.id);
    if (!id || seen[id]) return;
    seen[id] = true;
    levels.push({
      id,
      name: typeof lv.name === 'string' && lv.name ? lv.name : id,
      desc: typeof lv.desc === 'string' ? lv.desc : '',
    });
  });
  return { available: !!(res && res.available) && levels.length > 0, levels };
}

// 优先用上次选的难度，否则选第一档（最容易）
function pickLevel(levels, preferredId) {
  if (!Array.isArray(levels) || levels.length === 0) return '';
  const pref = preferredId === undefined || preferredId === null ? '' : String(preferredId);
  if (pref && levels.some((lv) => lv.id === pref)) return pref;
  return levels[0].id;
}

// 本地存储里的设置 → 合法值
function normalizeSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    size: home.normalizeSize(s.size, 19),
    level: typeof s.level === 'string' ? s.level : '',
    color: isColor(s.color) ? s.color : 'random',
  };
}

module.exports = {
  AI_COLORS,
  isColor,
  normalizeLevels,
  pickLevel,
  normalizeSettings,
};
