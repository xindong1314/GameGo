'use strict';

// 对外（REST / WebSocket）展示用户信息时只暴露 id、昵称与头像地址，不暴露 openid。

const AVATAR_FILE_RE = /^[a-z0-9]+\.(png|jpg)$/;

function normalizeBase(publicBaseUrl) {
  return String(publicBaseUrl || '').replace(/\/+$/, '');
}

// avatar 为头像文件名（不含域名），空串表示没有头像
function avatarUrl(avatar, publicBaseUrl) {
  if (!avatar) return '';
  return `${normalizeBase(publicBaseUrl)}/avatars/${avatar}`;
}

function assertUser(user, fn) {
  if (!user || typeof user !== 'object' || user.id === undefined || user.id === null) {
    throw new TypeError(`${fn}: 需要用户对象，收到 ${user === null ? 'null' : typeof user}`);
  }
}

// REST 用：{ id, nickname, avatarUrl }
function publicUser(user, publicBaseUrl) {
  assertUser(user, 'publicUser');
  return { id: user.id, nickname: user.nickname || '', avatarUrl: avatarUrl(user.avatar, publicBaseUrl) };
}

// 对局快照用：{ userId, nickname, avatarUrl }
function playerInfo(user, publicBaseUrl) {
  assertUser(user, 'playerInfo');
  return { userId: user.id, nickname: user.nickname || '', avatarUrl: avatarUrl(user.avatar, publicBaseUrl) };
}

// AI 一方的 PlayerInfo：{ ai: true, level, nickname: 'AI · 5级', avatarUrl: '' }
function aiPlayerInfo(level, levelName) {
  const name = levelName || level || '';
  return { ai: true, level: level || '', nickname: name ? `AI · ${name}` : 'AI', avatarUrl: '' };
}

// 排位统计对外格式 RankedStats（去掉内部用的 curStreakAt / maxStreakAt）
function publicStats(stats) {
  const s = stats || {};
  const games = s.games || 0;
  const wins = s.wins || 0;
  return {
    games,
    wins,
    losses: s.losses || 0,
    draws: s.draws || 0,
    winrate: games > 0 ? wins / games : 0,
    curStreak: s.curStreak || 0,
    maxStreak: s.maxStreak || 0,
  };
}

module.exports = { publicUser, playerInfo, aiPlayerInfo, avatarUrl, publicStats, AVATAR_FILE_RE };
