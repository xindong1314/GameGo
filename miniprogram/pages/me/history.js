'use strict';
// "我的"页纯逻辑：战绩卡片、对局列表行、分页合并、日期显示。
// GameSummary 见设计文档第 4 节。

const { isGameId } = require('../index/home');
const { formatPercent } = require('../leaderboard/rows');

const PAGE_SIZE = 20;

const MODE_BADGE = { ranked: '排位', friend: '好友', ai: '人机' };

const MY_RESULT = {
  win: { text: '胜', cls: 'win' },
  loss: { text: '负', cls: 'loss' },
  draw: { text: '和', cls: 'draw' },
  void: { text: '作废', cls: 'void' },
};

function toCount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// 时间戳（毫秒）→ 今天 '14:05' / '昨天 14:05' / 今年 '9月3日' / 更早 '2025年9月3日'（本地时区）
function formatDate(ts, now) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return '';
  const d = new Date(t);
  const n = new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now());
  const time = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  const startOfToday = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  const DAY = 24 * 3600 * 1000;
  if (t >= startOfToday && t < startOfToday + DAY) return time;
  if (t >= startOfToday - DAY && t < startOfToday) return '昨天 ' + time;
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

// resultText（B+R / W+T / B+3.5 / 0 / Void）→ 中文说明
function describeResult(resultText) {
  const text = typeof resultText === 'string' ? resultText.trim() : '';
  if (!text) return '';
  if (text === 'Void') return '对局作废';
  if (text === '0') return '和棋';
  const m = /^([BW])\+(.*)$/.exec(text);
  if (!m) return text;
  const side = m[1] === 'B' ? '黑' : '白';
  if (m[2] === 'R') return side + '中盘胜';
  if (m[2] === 'T') return side + '超时胜';
  if (/^\d+(\.\d+)?$/.test(m[2])) return `${side}胜 ${m[2]} 目`;
  return side + '胜';
}

// GameSummary → 列表行；数据不完整时返回 null
function formatGameRow(g, now) {
  if (!g || typeof g !== 'object' || !isGameId(g.id)) return null;
  const opp = g.opponent && typeof g.opponent === 'object' ? g.opponent : {};
  const isAi = !!opp.ai || g.mode === 'ai';
  const opponentName = isAi
    ? (typeof opp.levelName === 'string' && opp.levelName ? 'AI · ' + opp.levelName : 'AI')
    : (typeof opp.nickname === 'string' && opp.nickname ? opp.nickname : '棋友');
  const result = MY_RESULT[g.myResult] || MY_RESULT.void;
  const size = Number(g.size);
  const moves = toCount(g.moveCount);
  const color = Number(g.myColor);
  return {
    id: g.id,
    badge: MODE_BADGE[g.mode] || '对局',
    badgeCls: MODE_BADGE[g.mode] ? g.mode : 'other',
    isAi,
    opponentName,
    opponentAvatar: !isAi && typeof opp.avatarUrl === 'string' ? opp.avatarUrl : '',
    resultText: result.text,
    resultCls: result.cls,
    detail: describeResult(g.resultText),
    meta: [
      [9, 13, 19].includes(size) ? size + '路' : '',
      color === 1 ? '执黑' : color === 2 ? '执白' : '',
      moves ? moves + '手' : '',
    ].filter(Boolean).join(' · '),
    dateText: formatDate(g.endedAt || g.createdAt, now),
  };
}

// 追加一页，按 id 去重（before 游标在同一毫秒边界上可能返回重复项）
function mergeGames(existing, incoming) {
  const list = Array.isArray(existing) ? existing.slice() : [];
  const seen = {};
  list.forEach((r) => {
    if (r && r.id) seen[r.id] = true;
  });
  (Array.isArray(incoming) ? incoming : []).forEach((r) => {
    if (r && r.id && !seen[r.id]) {
      seen[r.id] = true;
      list.push(r);
    }
  });
  return list;
}

// 返回页面时的刷新：firstPage 里列表还没有的对局（按原顺序）插到最前面。
// firstPage 与现有列表没有任何重叠（新对局超过一页）时返回 null，表示应整体重新加载。
function prependGames(existing, firstPage) {
  const list = Array.isArray(existing) ? existing : [];
  const page = Array.isArray(firstPage) ? firstPage.filter((r) => r && r.id) : [];
  const seen = {};
  list.forEach((r) => {
    if (r && r.id) seen[r.id] = true;
  });
  const fresh = page.filter((r) => !seen[r.id]);
  if (!fresh.length) return list.slice();
  if (list.length && fresh.length === page.length) return null;
  return fresh.concat(list);
}

// 响应里的 next → 数字游标或 null（没有更多）
function nextCursor(next) {
  const n = Number(next);
  return next !== null && next !== undefined && next !== '' && Number.isFinite(n) && n > 0 ? n : null;
}

function gamesPath(before, limit) {
  const n = toCount(limit) || PAGE_SIZE;
  const cursor = nextCursor(before);
  return `/api/games?limit=${n}` + (cursor ? `&before=${cursor}` : '');
}

// RankedStats → 四张卡片 + 一行说明
function formatStats(stats) {
  const s = stats && typeof stats === 'object' ? stats : {};
  const games = toCount(s.games);
  const wins = toCount(s.wins);
  const losses = toCount(s.losses);
  const draws = toCount(s.draws);
  const rate = Number.isFinite(Number(s.winrate)) ? Number(s.winrate) : games ? wins / games : 0;
  return {
    cards: [
      { key: 'games', label: '局数', value: String(games) },
      { key: 'winrate', label: '胜率', value: games ? formatPercent(rate) : '—' },
      { key: 'cur', label: '当前连胜', value: String(toCount(s.curStreak)) },
      { key: 'max', label: '最高连胜', value: String(toCount(s.maxStreak)) },
    ],
    detail: games
      ? `${wins} 胜 ${losses} 负` + (draws ? ` ${draws} 和` : '')
      : '还没有排位赛记录，去快速匹配下一盘吧',
  };
}

function formatAi(ai) {
  const a = ai && typeof ai === 'object' ? ai : {};
  const games = toCount(a.games);
  if (!games) return '还没有人机对局';
  return `共 ${games} 局 · 胜 ${toCount(a.wins)} 局`;
}

// GET /api/me 的响应 → 页面数据
function formatMe(res) {
  const r = res && typeof res === 'object' ? res : {};
  const user = r.user && typeof r.user === 'object' ? r.user : {};
  const stats = formatStats(r.stats);
  return {
    user: {
      id: user.id,
      nickname: typeof user.nickname === 'string' ? user.nickname : '',
      avatarUrl: typeof user.avatarUrl === 'string' ? user.avatarUrl : '',
    },
    needProfile: r.needProfile === undefined ? !user.nickname : !!r.needProfile,
    statCards: stats.cards,
    statsDetail: stats.detail,
    aiText: formatAi(r.ai),
    activeIds: Array.isArray(r.activeGameIds) ? r.activeGameIds.filter(isGameId) : [],
  };
}

module.exports = {
  PAGE_SIZE,
  MODE_BADGE,
  formatDate,
  describeResult,
  formatGameRow,
  mergeGames,
  prependGames,
  nextCursor,
  gamesPath,
  formatStats,
  formatAi,
  formatMe,
};
