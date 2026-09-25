'use strict';
const engine = require('../engine');
const { LEVEL_IDS } = require('./levels');
const {
  EMPTY,
  PASS,
  unavailable,
  parseMoveRequest,
  resolveMinThinkMs,
  defaultSleep,
  waitMinThink,
  SILENT,
} = require('./common');

// 内置练习 AI（AI_FALLBACK=1 且未配置 KataGo 时使用，只供开发联调）：
// - 能提子就提（提得最多的优先）；
// - 否则在"合理"的点里随机落子：合法、不填自己的单点眼、不自己送吃（落子后只剩一口气且没提子）；
// - 不下会让棋盘回到之前出现过的局面的着手（规则只禁简单劫，但这样可以避免在多劫循环里无休止地来回提）；
// - 没有合理的点，或者对方刚 pass 且没有可提的子 → pass；
// - 从不认输；judgeDead 直接 reject（数子阶段走手动）。

const BASIC_LEVEL = Object.freeze({
  id: 'basic',
  name: '内置练习 AI',
  desc: '服务器未配置 KataGo 时的内置 AI：随机落子，只会提子和不填眼，仅供开发测试',
});

// 也接受 KataGo 难度的 id：去掉 KataGo 配置后，之前开的人机对局仍能继续
const ACCEPTED_LEVELS = new Set([BASIC_LEVEL.id, ...LEVEL_IDS]);

function isOwnEye(board, idx, color) {
  return board.neighbors(idx).every((nb) => board.get(nb) === color);
}

const positionKey = (board) => board.cells.join('');

// 按着手序列重放，记下每一手之后的局面（含开局空盘）
function positionHistory(size, komi, moves) {
  const g = engine.game;
  const state = g.createGame({ size, komi, autoScore: false });
  const seen = new Set([positionKey(state.board)]);
  for (const mv of moves) {
    if (state.status === 'scoring') g.resume(state);
    if (mv === PASS) g.pass(state);
    else g.play(state, mv);
    seen.add(positionKey(state.board));
  }
  return seen;
}

// 返回 idx 或 PASS。seen：之前出现过的局面（positionKey），可选
function chooseFallbackMove(board, color, ko, { humanJustPassed = false, rng = Math.random, seen = null } = {}) {
  const { tryPlay } = engine.rules;
  const total = board.n * board.n;
  const captures = [];
  const normal = [];
  for (let idx = 0; idx < total; idx++) {
    if (board.get(idx) !== EMPTY || isOwnEye(board, idx, color)) continue;
    const b = board.clone();
    const r = tryPlay(b, color, ko, idx);
    if (!r.ok) continue;
    if (seen && seen.has(positionKey(b))) continue; // 回到以前的局面
    if (r.captured.length > 0) {
      captures.push({ idx, count: r.captured.length });
      continue;
    }
    if (b.group(idx).liberties.length <= 1) continue; // 自己送吃
    normal.push(idx);
  }
  if (captures.length) {
    const most = Math.max(...captures.map((c) => c.count));
    const best = captures.filter((c) => c.count === most);
    return best[Math.floor(rng() * best.length)].idx;
  }
  if (humanJustPassed || normal.length === 0) return PASS;
  return normal[Math.floor(rng() * normal.length)];
}

function createFallbackAiService({ config = {}, logger = SILENT, rng = Math.random, sleep = defaultSleep, now = Date.now } = {}) {
  const minThinkMs = resolveMinThinkMs(config || {});
  let closed = false;
  (logger || SILENT).info('使用内置练习 AI（AI_FALLBACK=1），仅供开发测试');
  return {
    kind: 'fallback',
    available() {
      return !closed;
    },
    levels() {
      return [{ ...BASIC_LEVEL }];
    },
    async chooseMove(req) {
      const startedAt = now();
      const p = parseMoveRequest(req, ACCEPTED_LEVELS);
      if (closed) throw unavailable('AI 已关闭');
      const seen = positionHistory(p.size, p.komi, p.moves);
      const move = chooseFallbackMove(p.state.board, p.color, p.state.ko, { humanJustPassed: p.humanJustPassed, rng, seen });
      await waitMinThink(startedAt, minThinkMs, now, sleep);
      return { move, resign: false };
    },
    judgeDead() {
      return Promise.reject(unavailable('内置练习 AI 不能判断死子'));
    },
    shutdown() {
      closed = true;
      return Promise.resolve();
    },
  };
}

module.exports = { createFallbackAiService, chooseFallbackMove, positionHistory, isOwnEye, BASIC_LEVEL };
