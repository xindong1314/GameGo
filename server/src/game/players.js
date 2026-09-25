'use strict';
const crypto = require('node:crypto');

// 对局与房间里展示的玩家信息、排位统计格式、id 生成。
// 与 server/src/util/public-user.js（server-core）的 playerInfo 语义一致，这里内联一份以免模块间耦合。

function normalizeBase(publicBaseUrl) {
  return String(publicBaseUrl || '').replace(/\/+$/, '');
}

function avatarUrlOf(avatar, publicBaseUrl) {
  return avatar ? `${normalizeBase(publicBaseUrl)}/avatars/${avatar}` : '';
}

// 真人 PlayerInfo = { userId, nickname, avatarUrl }；用户记录缺失时仍给出 userId
function playerInfo(user, publicBaseUrl, userId) {
  if (!user) return { userId, nickname: '', avatarUrl: '' };
  return { userId: user.id, nickname: user.nickname || '', avatarUrl: avatarUrlOf(user.avatar, publicBaseUrl) };
}

// AI PlayerInfo = { ai: true, level, nickname: 'AI · 5级', avatarUrl: '' }
function aiPlayerInfo(level, levels) {
  let name = '';
  if (Array.isArray(levels)) {
    const found = levels.find((l) => l && l.id === level);
    if (found && found.name) name = String(found.name);
  }
  if (!name) name = String(level || '');
  return { ai: true, level: level || '', nickname: name ? `AI · ${name}` : 'AI', avatarUrl: '' };
}

function int0(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// 排位统计对外格式 RankedStats（去掉 curStreakAt / maxStreakAt 等内部字段）
function rankedStatsView(s) {
  const src = s || {};
  const games = int0(src.games);
  const wins = int0(src.wins);
  return {
    games,
    wins,
    losses: int0(src.losses),
    draws: int0(src.draws),
    winrate: games > 0 ? wins / games : 0,
    curStreak: int0(src.curStreak),
    maxStreak: int0(src.maxStreak),
  };
}

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const GAME_ID_RE = /^[0-9a-z]{12}$/;

// 12 位随机 base36 对局 id
function randomGameId(randomInt = crypto.randomInt) {
  let s = '';
  for (let i = 0; i < 12; i++) s += ID_ALPHABET[randomInt(36)];
  return s;
}

module.exports = { playerInfo, aiPlayerInfo, avatarUrlOf, rankedStatsView, randomGameId, GAME_ID_RE };
