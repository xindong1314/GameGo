'use strict';
// 排行榜纯逻辑：标签、行数据格式化、"我的名次"说明。
// 响应见设计文档第 4 节：{ type, items, me: { rank, value, games, wins, need }, minGames }

const TABS = [
  { type: 'streak', name: '当前连胜' },
  { type: 'maxStreak', name: '最高连胜' },
  { type: 'winrate', name: '胜率' },
];

const MEDALS = { 1: 'gold', 2: 'silver', 3: 'bronze' };
const DEFAULT_MIN_GAMES = 10;

function isBoardType(type) {
  return TABS.some((t) => t.type === type);
}

function toCount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// 0~1 → '62.3%' / '50%' / '100%'
function formatPercent(rate) {
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) return '0%';
  return Math.round(Math.min(r, 1) * 1000) / 10 + '%';
}

function formatValue(type, value) {
  if (type === 'winrate') return formatPercent(value);
  return toCount(value) + ' 连胜';
}

function recordText(wins, games) {
  return `${wins} 胜 / ${games} 局`;
}

// 兼容条目直接带 userId/nickname/avatarUrl，或嵌套在 user 里
function pick(item, key, userKey) {
  if (item[key] !== undefined && item[key] !== null) return item[key];
  if (item.user && typeof item.user === 'object' && item.user[userKey] !== undefined) return item.user[userKey];
  return undefined;
}

function formatRow(type, item, meId, index) {
  const rank = toCount(item.rank) || index + 1;
  const userId = pick(item, 'userId', 'id');
  const nickname = pick(item, 'nickname', 'nickname');
  const avatarUrl = pick(item, 'avatarUrl', 'avatarUrl');
  const games = toCount(item.games);
  const wins = toCount(item.wins);
  return {
    key: userId !== undefined ? 'u' + userId : 'r' + rank,
    rank,
    medal: MEDALS[rank] || '',
    userId,
    nickname: typeof nickname === 'string' && nickname ? nickname : '棋友',
    avatarUrl: typeof avatarUrl === 'string' ? avatarUrl : '',
    valueText: formatValue(type, item.value),
    subText: type === 'winrate' ? recordText(wins, games) : '',
    isMe: meId !== undefined && meId !== null && userId !== undefined && String(userId) === String(meId),
  };
}

function formatRows(type, items, meId) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((it) => it && typeof it === 'object')
    .map((it, i) => formatRow(type, it, meId, i));
}

// 底部"我的名次" → { ranked, rankText, valueText, note }
function formatMine(type, me, minGames) {
  const min = toCount(minGames) || DEFAULT_MIN_GAMES;
  if (!me || typeof me !== 'object') {
    return { ranked: false, rankText: '未上榜', valueText: '', note: '暂无排位数据' };
  }
  const games = toCount(me.games);
  const wins = toCount(me.wins);
  const rank = toCount(me.rank);
  if (rank > 0) {
    return {
      ranked: true,
      rankText: `第 ${rank} 名`,
      valueText: formatValue(type, me.value),
      note: type === 'winrate' ? recordText(wins, games) : '',
    };
  }
  if (type === 'winrate') {
    const need = toCount(me.need) || Math.max(0, min - games);
    const rate = Number.isFinite(Number(me.value)) ? Number(me.value) : games > 0 ? wins / games : 0;
    return {
      ranked: false,
      rankText: '未上榜',
      valueText: games > 0 ? formatPercent(rate) : '',
      note: need > 0 ? `再下 ${need} 局排位即可上榜` : '暂未上榜',
    };
  }
  if (type === 'streak') {
    return {
      ranked: false,
      rankText: '未上榜',
      valueText: '',
      note: games > 0 ? '当前没有连胜，赢一局排位即可上榜' : '赢一局排位赛即可上榜',
    };
  }
  return { ranked: false, rankText: '未上榜', valueText: '', note: '还没有排位赛胜局，赢一局即可上榜' };
}

function boardHint(type, minGames) {
  const min = toCount(minGames) || DEFAULT_MIN_GAMES;
  if (type === 'winrate') return `只统计排位赛（快速匹配），至少 ${min} 局才能上胜率榜`;
  return '只统计排位赛（快速匹配），好友对局和人机对局不计入';
}

// 整个响应 → 页面数据
function buildBoard(type, res, meId) {
  const data = res && typeof res === 'object' ? res : {};
  const minGames = toCount(data.minGames) || DEFAULT_MIN_GAMES;
  const rows = formatRows(type, data.items, meId);
  return {
    rows,
    mine: formatMine(type, data.me, minGames),
    minGames,
    hint: boardHint(type, minGames),
    state: rows.length ? 'ok' : 'empty',
  };
}

module.exports = {
  TABS,
  DEFAULT_MIN_GAMES,
  isBoardType,
  formatPercent,
  formatValue,
  formatRows,
  formatMine,
  boardHint,
  buildBoard,
};
