'use strict';
const { KataGoEngine } = require('./katago');
const { LEVEL_IDS, getLevel, kyuFor, publicLevels } = require('./levels');
const { pickRankMove, pickPolicyMove } = require('./rank');
const { createFallbackAiService } = require('./fallback');
const {
  BLACK,
  PASS,
  AiError,
  unavailable,
  parseBoardRequest,
  parseMoveRequest,
  toKataMoves,
  parseKataMove,
  isLegal,
  infoForColor,
  deadFromOwnership,
  areaMarginIfEnded,
  resolveMinThinkMs,
  defaultSleep,
  waitMinThink,
  SILENT,
} = require('./common');

// AiService（设计文档 7.1）：
//   available() → bool
//   levels() → [{ id, name, desc }]
//   chooseMove({ size, komi, moves, color, level, humanJustPassed }) → Promise<{ move, resign, info? }>
//   judgeDead({ size, komi, moves }) → Promise<{ dead, source: 'katago' }>
//   shutdown() → Promise<void>
//
// createAiService({ config, logger }) 按配置选择实现：
//   config.katago 非空 → KataGo（创建时立即在后台启动进程，第一步棋不用等启动；启动中与崩溃重启期间
//                         available() 仍为 true，请求排队等待；连续启动失败后为 false，恢复后自动变回 true）
//   否则 config.aiFallback → 内置弱 AI（fallback.js）
//   否则 → 不可用（available() = false，levels() = []）
// 测试可以注入 engine（如 fake.js 的 FakeEngine）、rng、sleep、now。

// friendlyPassOk:false 的中国规则：与 'chinese' 预设的计分和合法性相同，但 AI 会先提净死子再 pass（7.4）
const RULES_NO_FRIENDLY_PASS = Object.freeze({
  ko: 'SIMPLE',
  scoring: 'AREA',
  tax: 'NONE',
  suicide: false,
  hasButton: false,
  whiteHandicapBonus: '0',
  friendlyPassOk: false,
});

// 认输：AI 视角胜率 < 2%，落后超过下列目数，且总手数 > 路数² × 0.4（7.5）。
// rank / policy 档的 1 次评估满足条件时，还要 100 次搜索（终局检查同款）也满足才认输。
const RESIGN_WINRATE = 0.02;
const RESIGN_LEAD = Object.freeze({ 9: 8, 13: 15, 19: 25 });
const RESIGN_MIN_MOVE_FRACTION = 0.4;

const MAX_REPICKS = 5; // 选出的点不合法时置 -1 重选的次数
// 人刚 pass 时：假设现在就数子（死子按这次搜索的归属判定，与 judgeDead 同一规则），AI 的目差比继续下的预期
// 少不到这么多 → 局面已定，AI 也 pass。见 settledForPass。
const SETTLED_MARGIN = 1;
const END_CHECK_VISITS = 100; // 人停一手后的"终局检查"；rank / policy 档认输前的核实搜索也用它
const JUDGE_VISITS = 200;

// 各类请求的超时（毫秒）；KataGo 内部排队的时间也算在内
const TIMEOUTS = Object.freeze({
  policy: 15000,
  endCheck: 20000,
  searchExtra: 15000, // 搜索档：maxTime + 这么多
});

// KataGo 请求优先级：1 次评估的请求插到长搜索前面
const PRIORITY = Object.freeze({ policy: 10, endCheck: 5, judge: 5, search: 0 });

function shouldResign(info, size, moveCount) {
  if (!info) return false;
  return (
    info.winrate < RESIGN_WINRATE &&
    info.scoreLead < -RESIGN_LEAD[size] &&
    moveCount > size * size * RESIGN_MIN_MOVE_FRACTION
  );
}

function checkPolicy(res, size) {
  const policy = res && res.policy;
  if (!Array.isArray(policy) || policy.length !== size * size + 1 || !policy.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    throw new AiError('katago_error', 'KataGo 返回的 policy 格式不对');
  }
  return policy;
}

function validOwnership(own, n) {
  return Array.isArray(own) && own.length === n && own.every((v) => typeof v === 'number' && Number.isFinite(v));
}

// 人刚 pass 时判断局面是否已定（res 为带 includeOwnership 的搜索结果）。
// friendlyPassOk:false 规则下 KataGo 按 Tromp-Taylor 评价 pass（死子不提就算活子），所以对方死子还留在 AI 地里时
// 它总要先把死子一颗颗提干净才肯 pass——人得跟着 pass 好几次，弱档（按 policy 随机选点，不一定去提）甚至一直不 pass。
// 而本项目数子阶段会按归属判死（judgeDead），这些死子不提也不影响结果。所以：假设现在就终局、死子按这次搜索的归属判定，
// 算出 AI 视角的目差；它不比继续下的预期（第一选点的 scoreLead）少 SETTLED_MARGIN 目以上 → 已定。
function settledForPass(p, res) {
  if (!res || !validOwnership(res.ownership, p.size * p.size)) return false;
  const top = topMoveInfo(res)[0];
  const blackLead = top && Number.isFinite(Number(top.scoreLead)) ? Number(top.scoreLead) : Number(res.rootInfo && res.rootInfo.scoreLead);
  if (!Number.isFinite(blackLead)) return false;
  const expected = p.color === BLACK ? blackLead : 0 - blackLead;
  return areaMarginIfEnded(p.state.board, p.komi, res.ownership, p.color) >= expected - SETTLED_MARGIN;
}

function topMoveInfo(res) {
  const infos = Array.isArray(res && res.moveInfos) ? res.moveInfos.filter((m) => m && typeof m.move === 'string') : [];
  infos.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
  return infos;
}

function createKataGoAiService({ engine, config, logger, rng, sleep, now }) {
  const minThinkMs = resolveMinThinkMs(config);
  const judgeTimeoutMs = Math.max(1000, (config.judgeTimeoutMs || 15000) - 1000);
  let closed = false;

  function base(p) {
    return {
      boardXSize: p.size,
      boardYSize: p.size,
      komi: p.komi,
      moves: toKataMoves(p.moves, p.size),
    };
  }

  function ensureAvailable() {
    if (closed) throw unavailable('AI 已关闭');
    if (!engine.available()) throw unavailable('KataGo 不可用');
  }

  // 用 pick(policy) 选点，交给本项目引擎校验；不合法就把该点置 -1 重选，
  // 最多重选 MAX_REPICKS 次，仍不行则下 policy 最高的合法点，都没有就 pass
  function pickLegal(p, policy, pick) {
    const pol = policy.slice();
    for (let attempt = 0; attempt <= MAX_REPICKS; attempt++) {
      const mv = pick(pol);
      if (mv === PASS) return PASS;
      if (isLegal(p.state, p.color, mv)) return mv;
      logger.debug(`AI 选出的着手 ${mv} 不合法，重选`);
      if (Number.isInteger(mv) && mv >= 0 && mv < pol.length - 1) pol[mv] = -1;
    }
    return bestLegalByPolicy(p, pol);
  }

  function bestLegalByPolicy(p, policy) {
    const n = p.size * p.size;
    const order = [];
    for (let i = 0; i < n; i++) if (policy[i] > 0) order.push(i);
    order.sort((a, b) => policy[b] - policy[a] || a - b);
    for (const i of order) if (isLegal(p.state, p.color, i)) return i;
    return PASS;
  }

  function result(move, info, resign = false) {
    const out = { move, resign };
    if (info) out.info = info;
    return out;
  }

  // 人停一手后的终局检查：100 次搜索（friendlyPassOk:false）。第一选点是 pass，或局面已定（settledForPass），
  // 则 AI 也 pass（shouldPass）。rank / policy 档认输前的核实也用它（见 confirmResign）。
  async function endCheck(p) {
    const res = await engine.query(
      {
        ...base(p),
        rules: RULES_NO_FRIENDLY_PASS,
        maxVisits: END_CHECK_VISITS,
        includeOwnership: true,
        priority: PRIORITY.endCheck,
        overrideSettings: { maxTime: 5, conservativePass: false, wideRootNoise: 0, reportAnalysisWinratesAs: 'BLACK' },
      },
      { timeoutMs: TIMEOUTS.endCheck },
    );
    const top = topMoveInfo(res)[0];
    const passTop = Boolean(top && parseKataMove(top.move, p.size) === PASS);
    const shouldPass = passTop || (p.humanJustPassed && settledForPass(p, res));
    return { passTop, shouldPass, info: infoForColor(res.rootInfo, p.color) };
  }

  // 1 次评估（神经网络的直接判断）说该认输时，先用一次搜索核实（本步已经做过终局检查就直接用它的结果）。
  // 对杀、大块死活未定的局面里 1 次评估可能严重误判：实测 19 路出现过 1 次评估判 AI 胜率 1%、落后 33 目，
  // 300 次搜索却是胜率 97%、领先 43 目的局面——不核实的话 AI 会认输一盘赢棋。
  // 返回 { resign, info }；核实用的搜索失败时不认输（照常下这一步，下一步再判断）。
  async function confirmResign(p, searched) {
    let check = searched;
    if (!check) {
      try {
        check = await endCheck(p);
      } catch (err) {
        logger.warn(`认输前的核实搜索失败，这一步先不认输：${err.message}`);
        return { resign: false, info: null };
      }
    }
    const resign = shouldResign(check.info, p.size, p.moves.length);
    if (!resign) {
      const i = check.info;
      logger.info(`1 次评估判断应认输，但搜索不支持（AI 视角胜率 ${i ? i.winrate.toFixed(3) : '?'}、目差 ${i ? i.scoreLead.toFixed(1) : '?'}），继续下`);
    }
    return { resign, info: check.info || null };
  }

  // rank / policy 档：1 次评估取 policy，按 KaTrain 策略选点
  async function policyMove(p, level) {
    let searched = null; // 本步已做的终局检查（100 次搜索）
    if (p.humanJustPassed) {
      const check = await endCheck(p);
      if (check.shouldPass) {
        if (shouldResign(check.info, p.size, p.moves.length)) return result(PASS, check.info, true);
        return result(PASS, check.info);
      }
      searched = check;
    }
    const res = await engine.query(
      {
        ...base(p),
        rules: 'chinese',
        maxVisits: 1,
        includePolicy: true,
        priority: PRIORITY.policy,
        overrideSettings: { reportAnalysisWinratesAs: 'BLACK' },
      },
      { timeoutMs: TIMEOUTS.policy },
    );
    const policy = checkPolicy(res, p.size);
    let info = infoForColor(res.rootInfo, p.color);
    if (shouldResign(info, p.size, p.moves.length)) {
      const confirmed = await confirmResign(p, searched);
      if (confirmed.resign) return result(PASS, confirmed.info, true);
      if (confirmed.info) info = confirmed.info; // 搜索的判断比 1 次评估准
    }
    const pick =
      level.kind === 'rank'
        ? (pol) => pickRankMove({ policy: pol, boardSize: p.size, kyuRank: kyuFor(level, p.size), rng })
        : (pol) => pickPolicyMove({ policy: pol, boardSize: p.size, movesPlayed: p.moves.length, openingMoves: level.openingMoves, rng });
    return result(pickLegal(p, policy, pick), info);
  }

  // 最强档：真正的搜索，取 order 最小的合法着手
  async function searchMove(p, level) {
    const res = await engine.query(
      {
        ...base(p),
        rules: RULES_NO_FRIENDLY_PASS,
        maxVisits: level.maxVisits,
        includePolicy: true,
        ...(p.humanJustPassed ? { includeOwnership: true } : {}),
        priority: PRIORITY.search,
        overrideSettings: {
          maxTime: level.maxTimeSec,
          conservativePass: false,
          wideRootNoise: 0,
          reportAnalysisWinratesAs: 'BLACK',
        },
      },
      { timeoutMs: level.maxTimeSec * 1000 + TIMEOUTS.searchExtra },
    );
    const info = infoForColor(res.rootInfo, p.color);
    if (shouldResign(info, p.size, p.moves.length)) return result(PASS, info, true);
    if (p.humanJustPassed && settledForPass(p, res)) return result(PASS, info); // 见 settledForPass
    for (const mi of topMoveInfo(res)) {
      const mv = parseKataMove(mi.move, p.size);
      if (mv === PASS) return result(PASS, info);
      if (mv !== null && isLegal(p.state, p.color, mv)) return result(mv, info);
      logger.debug(`KataGo 搜索给出的着手 ${mi.move} 不合法，换下一个`);
    }
    if (Array.isArray(res.policy) && res.policy.length === p.size * p.size + 1) {
      return result(bestLegalByPolicy(p, res.policy), info);
    }
    return result(PASS, info);
  }

  return {
    kind: 'katago',
    engine,
    available() {
      return !closed && engine.available();
    },
    levels() {
      return publicLevels();
    },
    async chooseMove(req) {
      const startedAt = now();
      const p = parseMoveRequest(req, LEVEL_IDS);
      ensureAvailable();
      const level = getLevel(p.level);
      const out = level.kind === 'search' ? await searchMove(p, level) : await policyMove(p, level);
      await waitMinThink(startedAt, minThinkMs, now, sleep);
      return out;
    },
    async judgeDead(req) {
      const p = parseBoardRequest(req);
      ensureAvailable();
      const res = await engine.query(
        {
          ...base(p),
          rules: 'chinese',
          maxVisits: JUDGE_VISITS,
          includeOwnership: true,
          priority: PRIORITY.judge,
          overrideSettings: { maxTime: 8, reportAnalysisWinratesAs: 'BLACK' },
        },
        { timeoutMs: judgeTimeoutMs },
      );
      const own = res && res.ownership;
      if (!validOwnership(own, p.size * p.size)) throw new AiError('katago_error', 'KataGo 返回的 ownership 格式不对');
      return { dead: deadFromOwnership(p.state.board, own), source: 'katago' };
    },
    async shutdown() {
      closed = true;
      await engine.shutdown();
    },
  };
}

function createUnavailableAiService() {
  const fail = () => Promise.reject(unavailable('未配置 KataGo，AI 不可用'));
  return {
    kind: 'none',
    available: () => false,
    levels: () => [],
    chooseMove: fail,
    judgeDead: fail,
    shutdown: () => Promise.resolve(),
  };
}

function createAiService({ config = {}, logger = SILENT, engine = null, rng = Math.random, sleep = defaultSleep, now = Date.now } = {}) {
  const log = logger || SILENT;
  const cfg = config || {};
  resolveMinThinkMs(cfg); // 配置不合法时尽早报错
  if (engine) return createKataGoAiService({ engine, config: cfg, logger: log, rng, sleep, now });
  if (cfg.katago) {
    const { path, model, config: cfgFile } = cfg.katago;
    const eng = new KataGoEngine({ path, model, config: cfgFile, logger: log });
    // 立即在后台启动；失败会自动重试，这里只记日志（不能让 KataGo 的问题影响服务启动）
    eng.start().catch((err) => log.warn(`KataGo 首次启动失败：${err.message}`));
    return createKataGoAiService({ engine: eng, config: cfg, logger: log, rng, sleep, now });
  }
  if (cfg.aiFallback) return createFallbackAiService({ config: cfg, logger: log, rng, sleep, now });
  return createUnavailableAiService();
}

module.exports = {
  createAiService,
  createKataGoAiService,
  createUnavailableAiService,
  RULES_NO_FRIENDLY_PASS,
  RESIGN_WINRATE,
  RESIGN_LEAD,
  shouldResign,
};
