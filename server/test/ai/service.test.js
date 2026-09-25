'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createAiService, RULES_NO_FRIENDLY_PASS } = require('../../src/ai/service');
const { FakeEngine } = require('../../src/ai/fake');
const { AiError, replayMoves, isLegal } = require('../../src/ai/common');
const { pickRankMove } = require('../../src/ai/rank');
const { kyuFor, getLevel, publicLevels } = require('../../src/ai/levels');
const { captureLogger, rejectsWith, mulberry32, waitFor } = require('./helpers');

const BLACK = 1;
const WHITE = 2;
const RANK_LEVELS = ['k18', 'k12', 'k8', 'k4', 'k1', 'd3'];

function makeAi(engineOpts = {}, { config = {}, ...extra } = {}) {
  const engine = new FakeEngine(engineOpts);
  const logger = captureLogger();
  const ai = createAiService({ config: { aiMinThinkMs: 0, ...config }, logger, engine, rng: mulberry32(7), ...extra });
  return { ai, engine, logger };
}

// 一组合法、无提子的着手：偶数行偶数列上黑白交替；不够时补 pass（两次 pass 后服务端会 resume，照样合法）
function filler(size, count) {
  const out = [];
  for (let y = 0; y < size && out.length < count; y += 2) {
    for (let x = 0; x < size && out.length < count; x += 2) out.push(y * size + x);
  }
  while (out.length < count) out.push(-1);
  return out;
}

// 除 hot 外都是很小值的 policy（非法点仍然要是 -1 由调用方决定）
function flatPolicy(size, hot = {}, rest = 1e-4, pass = 1e-5) {
  const p = new Array(size * size).fill(rest);
  for (const [k, v] of Object.entries(hot)) p[Number(k)] = v;
  p.push(pass);
  return p;
}

function req(over = {}) {
  return { size: 9, komi: 7.5, moves: [40], color: WHITE, level: 'k8', humanJustPassed: false, ...over };
}

// ---------------------------------------------------------------------------------------------
// 选点：rank / policy / search

test('service: rank 档发 1 次评估的 policy 请求，按 KaTrain 规则选点', async () => {
  for (const level of RANK_LEVELS) {
    const { ai, engine } = makeAi({ policy: flatPolicy(9, { 20: 0.95 }) });
    const r = await ai.chooseMove(req({ level }));
    assert.deepEqual(r, { move: 20, resign: false, info: { winrate: 0.5, scoreLead: 0, visits: 1 } }, level);
    assert.equal(engine.queries.length, 1);
    const { query, timeoutMs } = engine.queries[0];
    assert.deepEqual(query, {
      boardXSize: 9,
      boardYSize: 9,
      komi: 7.5,
      moves: [['B', 'E5']],
      rules: 'chinese',
      maxVisits: 1,
      includePolicy: true,
      priority: 10,
      overrideSettings: { reportAnalysisWinratesAs: 'BLACK' },
    });
    assert.equal(timeoutMs, 15000);
  }
});

test('service: rank 档在小棋盘上使用修正后的级位（9 路 +10，13 路 +5）', async () => {
  for (const [size, level] of [
    [9, 'k8'],
    [13, 'k4'],
    [19, 'k12'],
  ]) {
    const moves = filler(size, 6);
    const { ai, engine } = makeAi({}, { rng: mulberry32(42) });
    const r = await ai.chooseMove(req({ size, moves, color: BLACK, level }));
    const ctx = engine.context(engine.queries[0].query);
    const expected = pickRankMove({
      policy: engine.defaultPolicy(ctx),
      boardSize: size,
      kyuRank: kyuFor(getLevel(level), size),
      rng: mulberry32(42),
    });
    assert.equal(r.move, expected, `${size} 路 ${level}`);
  }
});

test('service: 默认 policy 下各档在 9/13/19 路随机局面都给出合法着手', async () => {
  for (const size of [9, 13, 19]) {
    for (const level of [...RANK_LEVELS, 'd5', 'max']) {
      for (const count of [0, 1, 7, 20]) {
        const moves = filler(size, count);
        const color = count % 2 === 0 ? BLACK : WHITE;
        const { ai } = makeAi({}, { rng: mulberry32(count + size) });
        const r = await ai.chooseMove({ size, komi: 7.5, moves, color, level, humanJustPassed: false });
        assert.equal(r.resign, false);
        const state = replayMoves(size, 7.5, moves);
        assert.ok(r.move === -1 || isLegal(state, color, r.move), `${size} 路 ${level} ${count} 手：${r.move}`);
      }
    }
  }
});

test('service: policy 档（d5）开局后下 policy 最高点，开局 22 手内按 KaTrain 加随机性', async () => {
  const moves = filler(19, 30);
  const hot = { 180: 0.3, 60: 0.25, 300: 0.2 };
  const { ai } = makeAi({ policy: flatPolicy(19, hot) });
  for (let i = 0; i < 5; i++) {
    const r = await ai.chooseMove(req({ size: 19, moves, color: BLACK, level: 'd5' }));
    assert.equal(r.move, 180);
  }
  // 开局：在 policy > 2% 的点里按 policy 加权抽取
  const seen = new Set();
  const { ai: ai2 } = makeAi({ policy: flatPolicy(19, hot) }, { rng: mulberry32(3) });
  for (let i = 0; i < 40; i++) seen.add((await ai2.chooseMove(req({ size: 19, moves: [], color: BLACK, level: 'd5' }))).move);
  assert.deepEqual([...seen].sort((a, b) => a - b), [60, 180, 300]);
});

test('service: 最强档用搜索（maxVisits 300、maxTime、friendlyPassOk:false），按 order 取第一选点', async () => {
  const { ai, engine } = makeAi({
    rootInfo: { winrate: 0.3, scoreLead: -2.5, visits: 301 },
    moveInfos: [
      { move: 'C3', order: 1 },
      { move: 'G7', order: 0 },
      { move: 'pass', order: 2 },
    ],
  });
  const r = await ai.chooseMove(req({ level: 'max', color: WHITE }));
  // G7 = x 6，y = 9 - 7 = 2 → 24；白方视角
  assert.equal(r.move, 24);
  assert.equal(r.resign, false);
  assert.equal(r.info.visits, 301);
  assert.ok(Math.abs(r.info.winrate - 0.7) < 1e-12);
  assert.equal(r.info.scoreLead, 2.5);
  const { query, timeoutMs } = engine.queries[0];
  assert.deepEqual(query.rules, {
    ko: 'SIMPLE',
    scoring: 'AREA',
    tax: 'NONE',
    suicide: false,
    hasButton: false,
    whiteHandicapBonus: '0',
    friendlyPassOk: false,
  });
  assert.deepEqual(query.rules, RULES_NO_FRIENDLY_PASS);
  assert.equal(query.maxVisits, 300);
  assert.equal(query.includePolicy, true);
  assert.deepEqual(query.overrideSettings, { maxTime: 8, conservativePass: false, wideRootNoise: 0, reportAnalysisWinratesAs: 'BLACK' });
  assert.equal(timeoutMs, 23000);
  assert.equal(engine.queries.length, 1);
});

test('service: 最强档第一选点是 pass 就 pass；人刚 pass 时不另做终局检查', async () => {
  const { ai, engine } = makeAi({ moveInfos: ['pass', 'E5'] });
  const r = await ai.chooseMove(req({ level: 'max', moves: [40, 41, -1], color: WHITE, humanJustPassed: true }));
  assert.equal(r.move, -1);
  assert.equal(r.resign, false);
  assert.equal(engine.queries.length, 1);
  assert.equal(engine.queries[0].query.maxVisits, 300);
});

test('service: 最强档第一选点不合法（KataGo 与本引擎不一致）→ 用下一个选点', async () => {
  const { ai, logger } = makeAi({ moveInfos: ['E5', 'D4'] }); // E5 已有子
  const r = await ai.chooseMove(req({ level: 'max' }));
  assert.equal(r.move, 5 * 9 + 3);
  assert.ok(logger.logs.debug.some((l) => l.includes('不合法')));
  // 所有选点都不合法 → policy 最高的合法点
  const { ai: ai2 } = makeAi({ moveInfos: ['E5'], policy: flatPolicy(9, { 40: 0.9, 70: 0.05 }) });
  assert.equal((await ai2.chooseMove(req({ level: 'max' }))).move, 70);
});

// ---------------------------------------------------------------------------------------------
// pass

test('service: rank 档 policy 第一是 pass → pass', async () => {
  const { ai } = makeAi({ policy: flatPolicy(9, { 20: 0.1 }, 1e-4, 0.8) });
  const r = await ai.chooseMove(req({ level: 'k12' }));
  assert.equal(r.move, -1);
  assert.equal(r.resign, false);
});

test('service: 人刚 pass → rank 档先做 100 次搜索的终局检查，第一选点是 pass 则 AI 也 pass', async () => {
  const { ai, engine } = makeAi({
    rootInfo: { winrate: 0.9, scoreLead: 6 },
    respond: (q) => (q.maxVisits === 100 ? { id: q.id, rootInfo: { winrate: 0.9, scoreLead: 6, visits: 100 }, moveInfos: [{ move: 'pass', order: 0 }, { move: 'A1', order: 1 }] } : undefined),
    policy: flatPolicy(9, { 20: 0.95 }),
  });
  const r = await ai.chooseMove(req({ level: 'k18', moves: [40, 41, -1], color: WHITE, humanJustPassed: true }));
  assert.equal(r.move, -1);
  assert.equal(r.resign, false);
  assert.deepEqual(r.info, { winrate: 0.09999999999999998, scoreLead: -6, visits: 100 });
  assert.equal(engine.queries.length, 1, '终局检查已决定 pass，不再发 policy 请求');
  const { query, timeoutMs } = engine.queries[0];
  assert.equal(query.maxVisits, 100);
  assert.deepEqual(query.rules, RULES_NO_FRIENDLY_PASS);
  assert.deepEqual(query.overrideSettings, { maxTime: 5, conservativePass: false, wideRootNoise: 0, reportAnalysisWinratesAs: 'BLACK' });
  assert.equal(query.moves.at(-1)[1], 'pass');
  assert.equal(timeoutMs, 20000);
});

test('service: 人刚 pass 但终局检查的第一选点不是 pass、局面也未定 → 照常按难度选点', async () => {
  // 盘上只有黑 E5：现在就数子黑得 81 − 7.5 = 73.5 目；第一选点 C3 预期黑领先 80 目，比现在数子多 → 未定，继续下
  const { ai, engine } = makeAi({
    moveInfos: [{ move: 'C3', scoreLead: 80 }, 'pass'],
    policy: flatPolicy(9, { 20: 0.95 }),
  });
  const r = await ai.chooseMove(req({ level: 'k8', moves: [40, -1], color: BLACK, humanJustPassed: true }));
  assert.equal(r.move, 20);
  assert.deepEqual(
    engine.queries.map((q) => q.query.maxVisits),
    [100, 1],
  );
  // 人没有 pass 时不做终局检查
  const { ai: ai2, engine: e2 } = makeAi({ policy: flatPolicy(9, { 20: 0.95 }) });
  await ai2.chooseMove(req({ level: 'k8', moves: [40, -1], color: BLACK, humanJustPassed: false }));
  assert.deepEqual(
    e2.queries.map((q) => q.query.maxVisits),
    [1],
  );
});

// 回归：人刚 pass、局面已定，但对方死子还留在 AI 地里。friendlyPassOk:false 下 KataGo 按 Tromp-Taylor 评价 pass（死子算活子），
// 第一选点总是"去提死子"，所以以前 AI 要一颗颗提完才 pass（真实 KataGo：最强档 4 手、d5 5 手、k8 9 手，k18 30 手都没 pass）。
// 本项目数子时按归属判死，不提也一样，所以现在按"现在就数子"的目差判断局面已定就 pass。
// 局面（黑方视角的归属：A~E 列 +1，F~J 列 −1）：黑 E 列墙 + 白地里的死子 H5；白 F 列墙 + 黑地里的死子 B5；黑（人）刚 pass，轮到白（AI）。
// 现在数子（B5、H5 判死）：黑 45，白 36 + 7.5 → 白方视角 −1.5。
const gtp = (s, size = 9) => s.split(' ').map((p) => (p === 'pass' ? -1 : require('../../src/engine').coords.gtpToIdx(p, size)));
const SETTLED_MOVES = gtp(
  'E1 F1 E2 F2 E3 F3 E4 F4 E5 F5 E6 F6 E7 F7 E8 F8 E9 F9 H5 B5 pass',
);
const SETTLED_OWNERSHIP = Array.from({ length: 81 }, (_, i) => (i % 9 <= 4 ? 1 : -1));

test('service: 人刚 pass、局面已定但对方死子还在 AI 地里 → rank/policy 档也 pass（不用先提死子）', async () => {
  for (const level of ['k18', 'k8', 'd5']) {
    // 终局检查的第一选点是去提 H5（白地里的黑死子），预期目差（白方视角）−1.5，与现在数子相同 → 已定
    const { ai, engine } = makeAi({
      rootInfo: { winrate: 0.7, scoreLead: 1.5 },
      moveInfos: [{ move: 'H4', scoreLead: 1.5 }, 'pass'],
      ownership: SETTLED_OWNERSHIP,
    });
    const r = await ai.chooseMove({ size: 9, komi: 7.5, moves: SETTLED_MOVES, color: WHITE, level, humanJustPassed: true });
    assert.deepEqual([r.move, r.resign], [-1, false], level);
    assert.equal(engine.queries.length, 1, '终局检查已决定 pass');
    assert.equal(engine.queries[0].query.includeOwnership, true);
    assert.equal(engine.queries[0].query.maxVisits, 100);
  }
});

test('service: 人刚 pass，但继续下预期多得超过 1 目 → 未定，照常选点', async () => {
  // 第一选点预期白方视角 +3（比现在数子的 −1.5 多 4.5 目，例如还有能吃的棋）→ 继续下
  const { ai, engine } = makeAi({
    rootInfo: { winrate: 0.4, scoreLead: -3 },
    moveInfos: [{ move: 'H4', scoreLead: -3 }, 'pass'],
    ownership: SETTLED_OWNERSHIP,
    policy: flatPolicy(9, { 70: 0.95 }),
  });
  const r = await ai.chooseMove({ size: 9, komi: 7.5, moves: SETTLED_MOVES, color: WHITE, level: 'k8', humanJustPassed: true });
  assert.equal(r.move, 70);
  assert.deepEqual(
    engine.queries.map((q) => q.query.maxVisits),
    [100, 1],
  );
  // 差 1 目以内仍算已定（KataGo 的目差估计有误差）
  const edge = makeAi({ moveInfos: [{ move: 'H4', scoreLead: 0.6 }], ownership: SETTLED_OWNERSHIP, policy: flatPolicy(9, { 70: 0.95 }) });
  const r2 = await edge.ai.chooseMove({ size: 9, komi: 7.5, moves: SETTLED_MOVES, color: WHITE, level: 'k8', humanJustPassed: true });
  assert.equal(r2.move, -1, '预期 −0.6，现在数子 −1.5，差 0.9 目');
  // 归属不可用（格式不对）→ 不判定为已定
  const bad = makeAi({ moveInfos: [{ move: 'H4', scoreLead: 1.5 }], ownership: [1, 2, 3], policy: flatPolicy(9, { 70: 0.95 }) });
  const r3 = await bad.ai.chooseMove({ size: 9, komi: 7.5, moves: SETTLED_MOVES, color: WHITE, level: 'k8', humanJustPassed: true });
  assert.equal(r3.move, 70);
});

test('service: 最强档——人刚 pass 且局面已定 → pass；人没有 pass 时照常下第一选点、不要归属', async () => {
  const opts = { rootInfo: { winrate: 0.7, scoreLead: 1.5 }, moveInfos: [{ move: 'H4', scoreLead: 1.5 }, 'pass'], ownership: SETTLED_OWNERSHIP };
  const { ai, engine } = makeAi(opts);
  const r = await ai.chooseMove({ size: 9, komi: 7.5, moves: SETTLED_MOVES, color: WHITE, level: 'max', humanJustPassed: true });
  assert.deepEqual([r.move, r.resign], [-1, false]);
  assert.equal(engine.queries.length, 1);
  assert.equal(engine.queries[0].query.includeOwnership, true);
  assert.equal(engine.queries[0].query.maxVisits, 300);
  const other = makeAi(opts);
  const r2 = await other.ai.chooseMove({ size: 9, komi: 7.5, moves: SETTLED_MOVES, color: WHITE, level: 'max', humanJustPassed: false });
  assert.equal(r2.move, gtp('H4')[0]);
  assert.equal(other.engine.queries[0].query.includeOwnership, undefined);
});

test('service: 数子阶段后继续对局（着手以两次 pass 结尾）也能正常选点', async () => {
  const { ai, engine } = makeAi({ policy: flatPolicy(9, { 20: 0.95 }) });
  const r = await ai.chooseMove(req({ moves: [40, -1, -1], color: WHITE, level: 'k4', humanJustPassed: true }));
  assert.equal(r.move, 20);
  assert.deepEqual(engine.queries[0].query.moves, [
    ['B', 'E5'],
    ['W', 'pass'],
    ['B', 'pass'],
  ]);
});

// ---------------------------------------------------------------------------------------------
// 合法性校验与重选

test('service: 选出的点被本引擎判为不合法（劫）→ 置 -1 重选', async () => {
  // 黑 E? 提劫：黑 11 提掉白 10，白不能立即回提 10
  const moves = [1, 2, 9, 10, 19, 12, 80, 20, 11];
  const state = replayMoves(9, 7.5, moves);
  assert.equal(state.ko, 10);
  assert.equal(isLegal(state, WHITE, 10), false);
  // 假装 KataGo 认为回提合法且是第一选点
  const { ai, logger } = makeAi({ policy: flatPolicy(9, { 10: 0.95, 30: 0.9 }) });
  const r = await ai.chooseMove(req({ moves, color: WHITE, level: 'k18' }));
  assert.equal(r.move, 30);
  assert.ok(logger.logs.debug.some((l) => l.includes('着手 10 不合法')));
});

test('service: 连续重选仍不合法 → 下 policy 最高的合法点', async () => {
  const moves = [0, 1, 2, 3, 4, 5, 6, 7]; // 第一行已被占满 8 个点
  const hot = { 0: 0.9, 1: 0.89, 2: 0.88, 3: 0.87, 4: 0.86, 5: 0.85, 6: 0.84, 7: 0.83, 50: 0.05 };
  const { ai, logger } = makeAi({ policy: flatPolicy(9, hot) });
  const r = await ai.chooseMove(req({ moves, color: BLACK, level: 'k1' }));
  assert.equal(r.move, 50);
  assert.equal(logger.logs.debug.filter((l) => l.includes('不合法')).length, 6, '首选 + 5 次重选');
});

// ---------------------------------------------------------------------------------------------
// 认输与视角

test('service: 胜率与目数都换算为 AI 视角（黑/白）', async () => {
  const rootInfo = { winrate: 0.7, scoreLead: 3.5, visits: 1 };
  const black = await makeAi({ rootInfo }).ai.chooseMove(req({ moves: [], color: BLACK }));
  assert.deepEqual(black.info, { winrate: 0.7, scoreLead: 3.5, visits: 1 });
  const white = await makeAi({ rootInfo }).ai.chooseMove(req({ moves: [40], color: WHITE }));
  assert.ok(Math.abs(white.info.winrate - 0.3) < 1e-12);
  assert.equal(white.info.scoreLead, -3.5);
  assert.equal(white.info.visits, 1);
});

test('service: 认输规则——AI 视角胜率 < 2%、落后超过阈值、手数 > 路数² × 0.4', async () => {
  const cases = [
    // [size, moveCount, AI 颜色, 黑方视角 rootInfo, 应认输]
    [9, 34, BLACK, { winrate: 0.01, scoreLead: -9 }, true],
    [9, 33, WHITE, { winrate: 0.99, scoreLead: 9 }, true],
    [9, 32, BLACK, { winrate: 0.01, scoreLead: -9 }, false], // 手数不够（需 > 32.4）
    [9, 34, BLACK, { winrate: 0.01, scoreLead: -8 }, false], // 落后没超过 8 目
    [9, 34, BLACK, { winrate: 0.02, scoreLead: -30 }, false], // 胜率不低于 2%
    [9, 33, WHITE, { winrate: 0.01, scoreLead: -30 }, false], // 白方其实大优
    [13, 68, BLACK, { winrate: 0.001, scoreLead: -15.5 }, true],
    [13, 68, BLACK, { winrate: 0.001, scoreLead: -15 }, false],
    [13, 66, BLACK, { winrate: 0.001, scoreLead: -40 }, false], // 需 > 67.6 手
    [19, 146, BLACK, { winrate: 0.001, scoreLead: -25.5 }, true],
    [19, 144, BLACK, { winrate: 0.001, scoreLead: -60 }, false],
    [19, 146, BLACK, { winrate: 0.001, scoreLead: -24 }, false],
  ];
  for (const [size, count, color, rootInfo, expected] of cases) {
    for (const level of ['k8', 'max']) {
      const moves = filler(size, count);
      assert.equal(moves.length % 2 === 0 ? BLACK : WHITE, color, '测试数据：颜色与手数对应');
      const { ai } = makeAi({ rootInfo, moveInfos: ['pass'] });
      const r = await ai.chooseMove({ size, komi: 7.5, moves, color, level, humanJustPassed: false });
      assert.equal(r.resign, expected, `${size} 路 ${count} 手 ${level} ${JSON.stringify(rootInfo)}`);
      if (expected) {
        assert.equal(r.move, -1);
        assert.ok(r.info.winrate < 0.02 && r.info.scoreLead < 0);
      }
    }
  }
});

// 回归：rank / policy 档以前只凭 1 次评估（神经网络的直接判断）认输。真实 KataGo 上出现过 1 次评估判 AI 胜率 1%、
// 落后 33 目，300 次搜索却是胜率 97%、领先 43 目的局面（19 路 k1），AI 认输了一盘赢棋。现在要搜索核实后才认输。
test('service: rank/policy 档认输前用 100 次搜索核实——搜索不支持则继续下', async () => {
  const moves = filler(9, 34); // 轮到黑，手数够
  // 黑方视角：1 次评估说黑必败，搜索说黑领先
  const rootInfo = (q) => (q.maxVisits === 1 ? { winrate: 0.01, scoreLead: -30 } : { winrate: 0.8, scoreLead: 6 });
  for (const level of ['k18', 'k1', 'd5']) {
    const { ai, engine, logger } = makeAi({ rootInfo, moveInfos: ['E5'] });
    const r = await ai.chooseMove({ size: 9, komi: 7.5, moves, color: BLACK, level, humanJustPassed: false });
    assert.equal(r.resign, false, level);
    assert.notEqual(r.move, -1, level);
    assert.deepEqual(r.info, { winrate: 0.8, scoreLead: 6, visits: 100 }, '返回搜索的判断');
    assert.deepEqual(
      engine.queries.map(({ query }) => [query.maxVisits, query.rules]),
      [
        [1, 'chinese'],
        [100, RULES_NO_FRIENDLY_PASS],
      ],
    );
    assert.ok(logger.logs.info.some((l) => l.includes('搜索不支持')));
  }
});

test('service: rank/policy 档认输——1 次评估与核实搜索都满足条件才认输', async () => {
  const moves = filler(9, 34);
  const { ai, engine } = makeAi({ rootInfo: (q) => (q.maxVisits === 1 ? { winrate: 0.01, scoreLead: -30 } : { winrate: 0.005, scoreLead: -25 }) });
  const r = await ai.chooseMove({ size: 9, komi: 7.5, moves, color: BLACK, level: 'k8', humanJustPassed: false });
  assert.deepEqual([r.move, r.resign], [-1, true]);
  assert.deepEqual(r.info, { winrate: 0.005, scoreLead: -25, visits: 100 });
  assert.equal(engine.queries.length, 2);
  // 1 次评估不满足条件时不做核实搜索（平时每步仍然只有 1 次评估）
  const calm = makeAi({ rootInfo: { winrate: 0.3, scoreLead: -30 } });
  await calm.ai.chooseMove({ size: 9, komi: 7.5, moves, color: BLACK, level: 'k8', humanJustPassed: false });
  assert.equal(calm.engine.queries.length, 1);
});

test('service: 人刚 pass 时认输的核实直接用终局检查的结果，不再多发请求', async () => {
  const moves = filler(9, 35); // 轮到白（AI），人（黑）刚 pass
  moves[34] = -1;
  // 黑方视角：1 次评估说白必败（黑胜率 0.99），终局检查（100 次搜索，第一选点不是 pass、局面未定）说白领先
  const rootInfo = (q) => (q.maxVisits === 1 ? { winrate: 0.99, scoreLead: 30 } : { winrate: 0.3, scoreLead: -20 });
  const { ai, engine } = makeAi({ rootInfo, moveInfos: ['E5'] });
  const r = await ai.chooseMove({ size: 9, komi: 7.5, moves, color: WHITE, level: 'k4', humanJustPassed: true });
  assert.equal(r.resign, false);
  assert.notEqual(r.move, -1);
  assert.ok(Math.abs(r.info.winrate - 0.7) < 1e-12 && r.info.scoreLead === 20);
  assert.deepEqual(
    engine.queries.map(({ query }) => query.maxVisits),
    [100, 1],
  );
});

test('service: 认输前的核实搜索失败 → 这一步不认输，照常落子', async () => {
  const moves = filler(9, 34);
  const respond = (q) => {
    if (q.maxVisits === 100) throw new AiError('timeout', 'fake timeout');
    return undefined;
  };
  const { ai, logger } = makeAi({ rootInfo: { winrate: 0.01, scoreLead: -30 }, respond });
  const r = await ai.chooseMove({ size: 9, komi: 7.5, moves, color: BLACK, level: 'k12', humanJustPassed: false });
  assert.equal(r.resign, false);
  assert.notEqual(r.move, -1);
  assert.deepEqual(r.info, { winrate: 0.01, scoreLead: -30, visits: 1 });
  assert.ok(logger.logs.warn.some((l) => l.includes('核实搜索失败')));
});

test('service: 人 pass 后的终局检查也适用认输规则', async () => {
  const moves = filler(9, 35);
  const { ai } = makeAi({ rootInfo: { winrate: 0.995, scoreLead: 20 }, moveInfos: ['pass'] });
  const r = await ai.chooseMove({ size: 9, komi: 7.5, moves, color: WHITE, level: 'k18', humanJustPassed: true });
  assert.deepEqual([r.move, r.resign], [-1, true]);
});

// ---------------------------------------------------------------------------------------------
// 死子判定

test('service: judgeDead 以块为单位取归属平均值，本方视角 <= -0.5 整块判死', async () => {
  // 黑 {0,1} 一块、白 {79,80} 一块、黑 40、白 44；终局两次 pass
  const moves = [0, 79, 1, 80, 40, 44, -1, -1];
  const ownership = new Array(81).fill(0);
  ownership[0] = -0.9; // 黑块平均 -0.55 → 死
  ownership[1] = -0.2;
  ownership[79] = 0.6; // 白块平均 +0.45 → 活（尽管 79 单点 > 0.5）
  ownership[80] = 0.3;
  ownership[40] = -0.5; // 正好 -0.5 → 死
  ownership[44] = 0.49; // 白方视角 -0.49 → 活
  const { ai, engine } = makeAi({ ownership });
  const r = await ai.judgeDead({ size: 9, komi: 7.5, moves });
  assert.deepEqual(r, { dead: [0, 1, 40], source: 'katago' });
  const { query, timeoutMs } = engine.queries[0];
  assert.equal(query.maxVisits, 200);
  assert.equal(query.includeOwnership, true);
  assert.equal(query.rules, 'chinese');
  assert.equal(query.overrideSettings.reportAnalysisWinratesAs, 'BLACK');
  assert.deepEqual(query.moves.slice(-2), [
    ['B', 'pass'],
    ['W', 'pass'],
  ]);
  assert.equal(query.moves.length, 8);
  assert.equal(timeoutMs, 14000);
});

test('service: judgeDead 超时与 judgeTimeoutMs 配置联动', async () => {
  const { ai, engine } = makeAi({}, { config: { judgeTimeoutMs: 8000 } });
  await ai.judgeDead({ size: 9, komi: 7.5, moves: [40, -1, -1] });
  assert.equal(engine.queries[0].timeoutMs, 7000);
});

test('service: judgeDead 失败、超时、返回格式不对时 reject', async () => {
  const fail = makeAi({
    respond: () => {
      throw new AiError('timeout', 'KataGo 请求超时（14000ms）');
    },
  });
  const e1 = await rejectsWith(fail.ai.judgeDead({ size: 9, komi: 7.5, moves: [] }));
  assert.equal(e1.code, 'timeout');

  const bad = makeAi({ ownership: [0, 0, 0] });
  const e2 = await rejectsWith(bad.ai.judgeDead({ size: 9, komi: 7.5, moves: [] }));
  assert.equal(e2.code, 'katago_error');

  const nan = makeAi({ ownership: new Array(81).fill(Number.NaN) });
  assert.equal((await rejectsWith(nan.ai.judgeDead({ size: 9, komi: 7.5, moves: [] }))).code, 'katago_error');

  const off = makeAi({ available: false });
  const e3 = await rejectsWith(off.ai.judgeDead({ size: 9, komi: 7.5, moves: [] }));
  assert.equal(e3.code, 'ai_unavailable');
  assert.equal(off.engine.queries.length, 0);
});

// ---------------------------------------------------------------------------------------------
// 参数校验

test('service: 参数不合法时 reject（bad_request），不发 KataGo 请求', async () => {
  const bad = [
    null,
    req({ size: 10 }),
    req({ size: '9' }),
    req({ komi: 7.3 }),
    req({ komi: '7.5' }),
    req({ komi: Number.NaN }),
    req({ moves: 'E5' }),
    req({ moves: [81] }),
    req({ moves: [1.5] }),
    req({ moves: [-2] }),
    req({ moves: [40, 40], color: BLACK }), // 占用
    req({ level: 'k99' }),
    req({ level: undefined }),
    req({ level: 'basic' }),
    req({ color: BLACK }), // 轮到白
    req({ color: 3 }),
    req({ moves: [], color: WHITE }),
  ];
  const { ai, engine } = makeAi();
  for (const r of bad) {
    const err = await rejectsWith(ai.chooseMove(r));
    assert.equal(err.code, 'bad_request', JSON.stringify(r));
  }
  // 自杀
  const suicide = await rejectsWith(ai.chooseMove(req({ moves: [1, 2, 9, 0], color: BLACK })));
  assert.equal(suicide.code, 'bad_request');
  assert.match(suicide.message, /第 4 手非法：suicide/);
  for (const r of [null, { size: 7, komi: 7.5, moves: [] }, { size: 9, komi: 7.5, moves: [40, 40] }]) {
    assert.equal((await rejectsWith(ai.judgeDead(r))).code, 'bad_request');
  }
  assert.equal(engine.queries.length, 0);
});

test('service: KataGo 请求失败或返回格式不对时 reject', async () => {
  const err = new AiError('katago_error', 'KataGo 拒绝请求：boom');
  const { ai } = makeAi({
    respond: () => {
      throw err;
    },
  });
  assert.equal(await rejectsWith(ai.chooseMove(req())), err);
  const { ai: ai2 } = makeAi({ policy: [0.5, 0.5] });
  assert.equal((await rejectsWith(ai2.chooseMove(req()))).code, 'katago_error');
});

// ---------------------------------------------------------------------------------------------
// 可用性、最短思考时间、配置

test('service: 引擎不可用或已关闭时 available() 为 false，chooseMove reject', async () => {
  const { ai, engine } = makeAi({ available: false });
  assert.equal(ai.available(), false);
  assert.deepEqual(ai.levels(), publicLevels(), '不可用时仍列出难度');
  assert.equal((await rejectsWith(ai.chooseMove(req()))).code, 'ai_unavailable');
  engine.set({ available: true });
  assert.equal(ai.available(), true);
  await ai.chooseMove(req());
  await ai.shutdown();
  assert.equal(engine.stopped, true);
  assert.equal(ai.available(), false);
  assert.equal((await rejectsWith(ai.chooseMove(req()))).code, 'ai_unavailable');
});

test('service: 最短思考时间（config.aiMinThinkMs，默认 600ms）', async () => {
  // 默认值：注入时钟与 sleep
  const sleeps = [];
  let clock = 1000;
  const engine = new FakeEngine();
  const ai = createAiService({
    config: {},
    engine,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  await ai.chooseMove(req());
  assert.deepEqual(sleeps, [600]);

  // 已经想了 450ms → 只再等 150ms
  const sleeps2 = [];
  let t = 0;
  const engine2 = new FakeEngine({
    respond: () => {
      t += 450;
      return undefined;
    },
  });
  const ai2 = createAiService({
    config: { aiMinThinkMs: 600 },
    engine: engine2,
    now: () => t,
    sleep: async (ms) => sleeps2.push(ms),
  });
  await ai2.chooseMove(req());
  assert.deepEqual(sleeps2, [150]);

  // 设为 0 → 不等待
  const sleeps3 = [];
  const ai3 = createAiService({ config: { aiMinThinkMs: 0 }, engine: new FakeEngine(), sleep: async (ms) => sleeps3.push(ms) });
  await ai3.chooseMove(req());
  assert.deepEqual(sleeps3, []);

  // 真实计时
  const ai4 = createAiService({ config: { aiMinThinkMs: 120 }, engine: new FakeEngine() });
  const t0 = Date.now();
  await ai4.chooseMove(req());
  assert.ok(Date.now() - t0 >= 110);

  assert.throws(() => createAiService({ config: { aiMinThinkMs: -1 } }), /aiMinThinkMs/);
});

test('service: createAiService 按配置选择实现', async (t) => {
  const none = createAiService({ config: { katago: null, aiFallback: false } });
  assert.equal(none.kind, 'none');
  assert.equal(none.available(), false);
  assert.deepEqual(none.levels(), []);
  assert.equal((await rejectsWith(none.chooseMove(req()))).code, 'ai_unavailable');
  assert.equal((await rejectsWith(none.judgeDead({ size: 9, komi: 7.5, moves: [] }))).code, 'ai_unavailable');
  await none.shutdown();

  const fb = createAiService({ config: { aiFallback: true, aiMinThinkMs: 0 } });
  assert.equal(fb.kind, 'fallback');
  assert.equal(fb.available(), true);
  assert.deepEqual(fb.levels().map((l) => l.id), ['basic']);

  // 配置了 KataGo 但可执行文件不存在：不抛错、不崩溃，很快变为不可用；难度表照常列出
  const logger = captureLogger();
  const kg = createAiService({
    config: {
      katago: { path: path.join(__dirname, 'fixtures', 'missing-katago.exe'), model: 'm.bin.gz', config: 'a.cfg' },
      aiFallback: true,
      aiMinThinkMs: 0,
    },
    logger,
  });
  t.after(() => kg.shutdown());
  assert.equal(kg.kind, 'katago');
  assert.equal(kg.levels().length, 8);
  await waitFor(() => !kg.available(), { what: 'KataGo 标记为不可用' });
  assert.equal((await rejectsWith(kg.chooseMove(req()))).code, 'ai_unavailable');
  assert.ok(logger.logs.warn.some((l) => l.includes('KataGo 首次启动失败')));
  await kg.shutdown();
  assert.equal(kg.available(), false);
});
