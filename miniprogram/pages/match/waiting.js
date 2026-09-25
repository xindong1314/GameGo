'use strict';
// 匹配页纯逻辑：已等待时长、何时提示改为人机、从 hello 中找进行中的真人对局。

const { isGameId } = require('../index/home');

// 等待超过这么多秒，提示可以先和 AI 下
const AI_HINT_SEC = 60;

function elapsedSeconds(startedAt, now) {
  const ms = Number(now) - Number(startedAt);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.floor(ms / 1000);
}

// 秒数 → 'm:ss'，满一小时为 'h:mm:ss'
function formatElapsed(sec) {
  const s = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// activeGames 中第一局指定模式的对局；modes 按优先级排列
function findActiveGame(activeGames, modes) {
  if (!Array.isArray(activeGames)) return null;
  for (const mode of modes) {
    const g = activeGames.find((x) => x && x.mode === mode && isGameId(x.id));
    if (g) return g;
  }
  return null;
}

module.exports = {
  AI_HINT_SEC,
  elapsedSeconds,
  formatElapsed,
  findActiveGame,
};
