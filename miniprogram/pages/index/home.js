'use strict';
// 首页纯逻辑：路数/执子选项、hello 数据 → 顶部提示条、各入口地址。

const SIZES = [9, 13, 19];

const ROOM_COLORS = [
  { id: 'random', name: '随机' },
  { id: 'black', name: '执黑' },
  { id: 'white', name: '执白' },
];

const MODE_NAME = { ranked: '排位赛', friend: '好友对局', ai: '人机对局' };

// 真人对局排在人机对局前面
const MODE_ORDER = { ranked: 0, friend: 1, ai: 2 };

function normalizeSize(value, fallback) {
  const n = Number(value);
  if (SIZES.includes(n)) return n;
  return SIZES.includes(fallback) ? fallback : 19;
}

function normalizeRoomColor(value) {
  return ROOM_COLORS.some((c) => c.id === value) ? value : 'random';
}

function isGameId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

function playUrl(id) {
  return '/pages/play/play?id=' + encodeURIComponent(id);
}

function matchUrl(size) {
  return '/pages/match/match?size=' + normalizeSize(size);
}

function roomCreateUrl(size, color) {
  return '/pages/room/room?create=1&size=' + normalizeSize(size) + '&color=' + normalizeRoomColor(color);
}

// hello = { activeGames: [{ id, mode }], room: Room|null, matching: { size }|null }
// → [{ key, kind, text, url }]
function bannersFromHello(hello) {
  if (!hello || typeof hello !== 'object') return [];
  const banners = [];
  const games = Array.isArray(hello.activeGames)
    ? hello.activeGames.filter((g) => g && isGameId(g.id))
    : [];
  games
    .slice()
    .sort((a, b) => (MODE_ORDER[a.mode] !== undefined ? MODE_ORDER[a.mode] : 9)
      - (MODE_ORDER[b.mode] !== undefined ? MODE_ORDER[b.mode] : 9))
    .forEach((g) => {
      banners.push({
        key: 'game-' + g.id,
        kind: 'game',
        text: '你有一局' + (MODE_NAME[g.mode] || '对局') + '正在进行，点击返回',
        url: playUrl(g.id),
      });
    });
  const room = hello.room;
  if (room && typeof room.code === 'string' && /^\d{6}$/.test(room.code) && room.status !== 'closed') {
    banners.push({
      key: 'room-' + room.code,
      kind: 'room',
      text: '你的好友房 ' + room.code + ' 正在等待对手',
      url: '/pages/room/room?code=' + room.code,
    });
  }
  const matching = hello.matching;
  if (matching && SIZES.includes(Number(matching.size))) {
    banners.push({
      key: 'matching',
      kind: 'match',
      text: '正在匹配 ' + Number(matching.size) + ' 路对手，点击查看',
      url: matchUrl(matching.size),
    });
  }
  return banners;
}

// auth 的 User 对象 → 头部展示
function userView(user) {
  if (!user || typeof user !== 'object') return null;
  return {
    id: user.id,
    nickname: typeof user.nickname === 'string' ? user.nickname : '',
    avatarUrl: typeof user.avatarUrl === 'string' ? user.avatarUrl : '',
  };
}

module.exports = {
  SIZES,
  ROOM_COLORS,
  MODE_NAME,
  normalizeSize,
  normalizeRoomColor,
  isGameId,
  playUrl,
  matchUrl,
  roomCreateUrl,
  bannersFromHello,
  userView,
};
