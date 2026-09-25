'use strict';
// 好友房纯逻辑：页面参数解析、房号校验、展示数据、分享卡片。

const home = require('../index/home');

const CODE_RE = /^\d{6}$/;
const COLOR_IDS = ['black', 'white', 'random'];

// 去掉空白后必须是 6 位数字；否则返回 ''
function normalizeCode(value) {
  if (value === undefined || value === null) return '';
  const text = String(value).replace(/\s+/g, '');
  return CODE_RE.test(text) ? text : '';
}

// 输入框内容 → 只保留数字，最多 6 位
function sanitizeCodeInput(value) {
  return String(value === undefined || value === null ? '' : value).replace(/\D/g, '').slice(0, 6);
}

function truthy(v) {
  return v === '1' || v === 'true' || v === 1 || v === true;
}

// 页面参数 → { mode: 'create', size, color } | { mode: 'invite', code } | { mode: 'entry', invalidCode }
function parseRoomQuery(query) {
  const q = query && typeof query === 'object' ? query : {};
  if (truthy(q.create)) {
    return {
      mode: 'create',
      size: home.normalizeSize(q.size, 19),
      color: COLOR_IDS.includes(q.color) ? q.color : 'random',
    };
  }
  const hasCode = q.code !== undefined && q.code !== null && q.code !== '';
  const code = normalizeCode(q.code);
  if (code) return { mode: 'invite', code };
  return { mode: 'entry', invalidCode: hasCode };
}

// 契约里的 Room：{ code, owner: { userId, nickname, avatarUrl }, size, color, status, expiresIn }
function isRoom(room) {
  return !!room && typeof room === 'object'
    && CODE_RE.test(String(room.code))
    && !!room.owner && typeof room.owner === 'object'
    && [9, 13, 19].includes(Number(room.size));
}

// 从某一方的角度描述执子
function colorText(color, isOwner) {
  if (color === 'black') return isOwner ? '你执黑先行' : '你执白';
  if (color === 'white') return isOwner ? '你执白' : '你执黑先行';
  return '黑白随机分配';
}

function roomView(room, isOwner) {
  const owner = room.owner || {};
  const code = String(room.code);
  return {
    code,
    // 房号可能有重复数字，用位置作 wx:key
    digits: code.split('').map((d, i) => ({ i, d })),
    size: Number(room.size),
    sizeText: Number(room.size) + ' 路',
    colorText: colorText(room.color, isOwner),
    ownerName: owner.nickname || '棋友',
    ownerAvatar: owner.avatarUrl || '',
  };
}

// 剩余毫秒 → 'mm:ss'（负数按 0）
function formatRemain(ms) {
  const total = Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 1000) : 0;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

// 分享卡片：受邀者打开后进入 /pages/room/room?code=<房号>
function shareMessage(room) {
  const owner = (room && room.owner) || {};
  const name = typeof owner.nickname === 'string' && owner.nickname ? owner.nickname : '好友';
  return {
    title: `${name} 邀你下一盘围棋（${Number(room.size)}路）`,
    path: '/pages/room/room?code=' + room.code,
  };
}

// 房主不在线时好友加入了：对局可能已经因为房主没落子 / 离线而作废。
// 房主回到等待页、发现房间没了时，用"我的最近一局"（GET /api/games?limit=1 的第一项 GameSummary）解释原因。
// since：本页开始显示这个房间的本地时间；room：当时的房间（用路数与执子排除无关的对局）。
// 服务端时间与本机时间可能有偏差，放宽 SKEW_MS。与本房间无关时返回 ''。
const SKEW_MS = 60000;

function missedGameText(game, since, room) {
  const g = game && typeof game === 'object' ? game : null;
  if (!g || g.mode !== 'friend') return '';
  const created = Number(g.createdAt);
  if (!Number.isFinite(created) || !(Number(since) > 0) || created < Number(since) - SKEW_MS) return '';
  if (room && Number(room.size) && Number(g.size) !== Number(room.size)) return '';
  const fixed = room && (room.color === 'black' ? 1 : room.color === 'white' ? 2 : 0);
  if (fixed && Number(g.myColor) !== fixed) return '';
  const moves = Number(g.moveCount) || 0;
  if (g.myResult === 'void' || g.reason === 'abort') {
    if (moves === 0) {
      return g.myColor === 1
        ? '好友加入后，你没有在 60 秒内落下第一手，对局已作废'
        : '好友加入后没有落下第一手，对局已作废';
    }
    // 轮到的一方掉线太久、手数又不足时作废
    const toPlay = moves % 2 === 0 ? 1 : 2;
    return toPlay === g.myColor ? '好友加入后你离线太久，对局已作废' : '好友离线太久，对局已作废';
  }
  const outcome = g.myResult === 'win' ? '你赢了' : g.myResult === 'loss' ? '你输了' : g.myResult === 'draw' ? '和棋' : '已结束';
  return `好友加入后的对局已结束（${outcome}），可在"我的"查看棋谱`;
}

module.exports = {
  missedGameText,
  normalizeCode,
  sanitizeCodeInput,
  parseRoomQuery,
  isRoom,
  colorText,
  roomView,
  formatRemain,
  shareMessage,
};
