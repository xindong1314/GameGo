'use strict';
const { publicUser, playerInfo, aiPlayerInfo } = require('../util/public-user');

// 把 GameRow 转成 REST 返回的 GameSummary / GameRecord（设计文档第 4 节）。
// ctx 缓存本次请求中查过的用户与难度名，列表里同一对手只查一次。

function createViewContext({ repos, ai, publicBaseUrl, logger }) {
  const userCache = new Map();
  let levelNames = null;

  function user(id) {
    if (!userCache.has(id)) userCache.set(id, repos.users.findById(id));
    return userCache.get(id);
  }

  function levelName(level) {
    if (!level) return '';
    if (!levelNames) {
      levelNames = new Map();
      try {
        const levels = ai && typeof ai.levels === 'function' ? ai.levels() : [];
        for (const l of levels || []) if (l && l.id) levelNames.set(String(l.id), String(l.name || l.id));
      } catch (err) {
        // 难度表取不到不影响看棋谱，用难度 id 代替名称
        if (logger) logger.warn('读取 AI 难度表失败：%s', err && err.message);
      }
    }
    return levelNames.get(level) || level;
  }

  return { user, levelName, publicBaseUrl };
}

function myColorOf(game, userId) {
  if (game.blackId === userId) return 1;
  if (game.whiteId === userId) return 2;
  return null;
}

// 'win' | 'loss' | 'draw' | 'void'；未结束的对局为 null
function myResultOf(game, myColor) {
  if (game.status !== 'ended') return null;
  if (game.reason === 'abort') return 'void';
  if (game.winner === 0) return 'draw';
  return game.winner === myColor ? 'win' : 'loss';
}

function missingUser(id) {
  return { id, nickname: '', avatarUrl: '' };
}

function gameSummary(game, userId, ctx) {
  const myColor = myColorOf(game, userId);
  const oppId = myColor === 1 ? game.whiteId : game.blackId;
  let opponent;
  if (game.mode === 'ai' || oppId === null) {
    opponent = { ai: true, level: game.aiLevel || '', levelName: ctx.levelName(game.aiLevel) };
  } else {
    const u = ctx.user(oppId);
    opponent = u ? publicUser(u, ctx.publicBaseUrl) : missingUser(oppId);
  }
  return {
    id: game.id,
    mode: game.mode,
    size: game.size,
    status: game.status,
    myColor,
    opponent,
    winner: game.winner,
    reason: game.reason,
    cause: game.cause || null,
    resultText: game.resultText || '',
    myResult: myResultOf(game, myColor),
    moveCount: Array.isArray(game.moves) ? game.moves.length : 0,
    createdAt: game.createdAt,
    endedAt: game.endedAt,
  };
}

function playerOf(game, id, ctx) {
  if (id === null) return aiPlayerInfo(game.aiLevel, ctx.levelName(game.aiLevel));
  const u = ctx.user(id);
  return u ? playerInfo(u, ctx.publicBaseUrl) : { userId: id, nickname: '', avatarUrl: '' };
}

function gameRecord(game, userId, ctx) {
  return {
    ...gameSummary(game, userId, ctx),
    komi: game.komi,
    moves: game.moves,
    dead: game.dead || [],
    players: { 1: playerOf(game, game.blackId, ctx), 2: playerOf(game, game.whiteId, ctx) },
    scoreBlack: game.scoreBlack,
    scoreWhite: game.scoreWhite,
  };
}

module.exports = { createViewContext, gameSummary, gameRecord, myColorOf, myResultOf };
