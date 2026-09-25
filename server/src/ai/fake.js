'use strict';
const engineRules = require('../engine');
const { publicLevels } = require('./levels');
const { isOwnEye } = require('./fallback');
const {
  BLACK,
  WHITE,
  EMPTY,
  PASS,
  AiError,
  unavailable,
  parseBoardRequest,
  parseMoveRequest,
  replayMoves,
  parseKataMove,
  isLegal,
  defaultSleep,
} = require('./common');

const { idxToGtp } = engineRules.coords;

// 测试替身（设计文档 7.2）：
//
// 1. createFakeAiService(options) —— 与 AiService 同接口、确定性、不需要 KataGo，给其他模块的测试用。
//    options：
//      available: bool（默认 true）
//      levels: [{ id, name, desc }]（默认与真实难度表相同）
//      move: fn(req, parsed) → { move, resign?, info? } | idx   自定义落子（默认：第一个合法且不填己方眼的点）
//      resign: bool                 —— chooseMove 一律认输
//      passWhenHumanPassed: bool    —— humanJustPassed 时 pass（默认 true）
//      dead: number[] | fn(req, parsed) → number[]   judgeDead 的结果（默认 []）
//      judgeFail: bool              —— judgeDead 失败
//      delayMs: number              —— 每次调用前等待
//    参数校验与真实服务一致（非法参数 reject，err.code = 'bad_request'）。
//    调用记录：ai.calls.chooseMove / ai.calls.judgeDead；ai.set(patch) 随时修改选项。
//
// 2. FakeEngine —— 模拟 KataGo 分析引擎（与 KataGoEngine 同接口：start/query/available/shutdown），
//    按请求合成 policy / moveInfos / rootInfo / ownership，让 service.js 的逻辑不依赖可执行文件就能单测。
//    options（都可以是值，也可以是 fn(query, ctx) 按请求计算；ctx 见 context()）：
//      rootInfo: { winrate, scoreLead }   黑方视角（默认 0.5 / 0）
//      policy: number[]                   includePolicy 时返回（默认按离边距离给合法点加权，非法点 -1）
//      passPolicy: number                 默认 policy 里 pass 的值（默认 1e-4）
//      moveInfos: Array<string | object>  maxVisits > 1 时返回（字符串为 GTP 坐标，按顺序给 order）
//      searchMove: idx | -1               默认 moveInfos 的第一选点
//      ownership: number[]                includeOwnership 时返回（默认：棋子 ±1，空点 0，黑方视角）
//      respond: fn(query, ctx, engine)    返回非 undefined 时直接作为响应；抛错即请求失败
//      available: bool、delayMs: number
//    记录：engine.queries = [{ query, timeoutMs }]；engine.set(patch) 修改选项。

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

// 第一个合法、且不填己方单点眼的点；没有就 pass
function firstReasonableMove(state, color) {
  const n = state.board.n;
  for (let idx = 0; idx < n * n; idx++) {
    if (state.board.get(idx) !== EMPTY) continue;
    if (isOwnEye(state.board, idx, color)) continue;
    if (isLegal(state, color, idx)) return idx;
  }
  return PASS;
}

function createFakeAiService(options = {}) {
  const opts = {
    available: true,
    levels: publicLevels(),
    move: null,
    resign: false,
    passWhenHumanPassed: true,
    dead: [],
    judgeFail: false,
    delayMs: 0,
    ...options,
  };
  const calls = { chooseMove: [], judgeDead: [] };
  let closed = false;

  const isAvailable = () => !closed && Boolean(opts.available);

  function normalizeMove(r) {
    if (Number.isInteger(r)) return { move: r, resign: false };
    return { move: r.move === undefined ? PASS : r.move, resign: r.resign === true, ...(r.info ? { info: r.info } : {}) };
  }

  const ai = {
    kind: 'fake',
    calls,
    set(patch) {
      Object.assign(opts, patch);
    },
    available: isAvailable,
    levels() {
      return opts.levels.map(({ id, name, desc }) => ({ id, name, desc }));
    },
    async chooseMove(req) {
      calls.chooseMove.push(clone(req));
      const p = parseMoveRequest(req, new Set(opts.levels.map((l) => l.id)));
      if (!isAvailable()) throw unavailable();
      if (opts.delayMs) await defaultSleep(opts.delayMs);
      if (typeof opts.move === 'function') return normalizeMove(opts.move(req, p));
      if (opts.resign) return { move: PASS, resign: true };
      if (opts.passWhenHumanPassed && p.humanJustPassed) return { move: PASS, resign: false };
      return { move: firstReasonableMove(p.state, p.color), resign: false, info: { winrate: 0.5, scoreLead: 0, visits: 1 } };
    },
    async judgeDead(req) {
      calls.judgeDead.push(clone(req));
      const p = parseBoardRequest(req);
      if (!isAvailable()) throw unavailable();
      if (opts.delayMs) await defaultSleep(opts.delayMs);
      if (opts.judgeFail) throw new AiError('katago_error', 'fake-ai：模拟死子判断失败');
      const dead = typeof opts.dead === 'function' ? opts.dead(req, p) : opts.dead.slice();
      return { dead, source: 'katago' };
    },
    shutdown() {
      closed = true;
      return Promise.resolve();
    },
  };
  return ai;
}

// ---------------------------------------------------------------------------------------------
// FakeEngine

function lineFromEdge(idx, n) {
  const x = idx % n;
  const y = (idx - x) / n;
  return Math.min(x, y, n - 1 - x, n - 1 - y);
}

class FakeEngine {
  constructor(options = {}) {
    this.opts = {
      available: true,
      delayMs: 0,
      passPolicy: 1e-4,
      rootInfo: { winrate: 0.5, scoreLead: 0 },
      ...options,
    };
    this.queries = [];
    this.started = false;
    this.stopped = false;
  }

  set(patch) {
    Object.assign(this.opts, patch);
  }

  start() {
    this.started = true;
    return Promise.resolve();
  }

  available() {
    return !this.stopped && Boolean(this.opts.available);
  }

  shutdown() {
    this.stopped = true;
    return Promise.resolve();
  }

  lastQuery() {
    const q = this.queries[this.queries.length - 1];
    return q ? q.query : undefined;
  }

  async query(query, { timeoutMs } = {}) {
    this.queries.push({ query: clone(query), timeoutMs });
    if (this.stopped) throw unavailable('FakeEngine 已关闭');
    if (!this.opts.available) throw unavailable('FakeEngine 不可用');
    if (this.opts.delayMs) await defaultSleep(this.opts.delayMs);
    const ctx = this.context(query);
    if (typeof this.opts.respond === 'function') {
      const r = await this.opts.respond(query, ctx, this);
      if (r !== undefined) return r;
    }
    return this.synthesize(query, ctx);
  }

  // 解析请求里的局面：{ size, state（本项目引擎的对局状态）, toPlay, legal(idx), perspective }
  context(query) {
    const size = query.boardXSize;
    if (size !== query.boardYSize) throw new AiError('katago_error', 'FakeEngine 只支持正方形棋盘');
    const moves = (query.moves || []).map(([player, loc], i) => {
      if (player !== (i % 2 === 0 ? 'B' : 'W')) throw new AiError('katago_error', `FakeEngine：第 ${i + 1} 手颜色不交替`);
      const idx = parseKataMove(loc, size);
      if (idx === null) throw new AiError('katago_error', `Could not parse board location: ${loc}`, { field: 'moves' });
      return idx;
    });
    let state;
    try {
      state = replayMoves(size, query.komi, moves);
    } catch (err) {
      throw new AiError('katago_error', `Illegal move: ${err.message}`, { field: 'moves' });
    }
    const toPlay = moves.length % 2 === 0 ? BLACK : WHITE;
    const perspective = (query.overrideSettings && query.overrideSettings.reportAnalysisWinratesAs) || 'BLACK';
    return {
      size,
      moves,
      state,
      toPlay,
      perspective,
      legal: (idx) => isLegal(state, toPlay, idx),
    };
  }

  _value(name, query, ctx) {
    const v = this.opts[name];
    return typeof v === 'function' ? v(query, ctx) : v;
  }

  // 黑方视角的值按 reportAnalysisWinratesAs 换算
  _flip(ctx) {
    return ctx.perspective === 'WHITE' || (ctx.perspective === 'SIDETOMOVE' && ctx.toPlay === WHITE);
  }

  defaultPolicy(ctx) {
    const n = ctx.size * ctx.size;
    const passPolicy = this.opts.passPolicy;
    const w = new Array(n).fill(0);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      if (ctx.legal(i)) {
        w[i] = 1 + lineFromEdge(i, ctx.size);
        sum += w[i];
      }
    }
    const policy = w.map((x) => (x > 0 ? (x / sum) * (1 - passPolicy) : -1));
    policy.push(sum > 0 ? passPolicy : 1);
    return policy;
  }

  synthesize(query, ctx) {
    const n = ctx.size * ctx.size;
    const flip = this._flip(ctx);
    const visits = Number.isInteger(query.maxVisits) ? query.maxVisits : 1;
    const ri = this._value('rootInfo', query, ctx) || {};
    const bw = typeof ri.winrate === 'number' ? ri.winrate : 0.5;
    const bl = typeof ri.scoreLead === 'number' ? ri.scoreLead : 0;
    const res = {
      id: query.id,
      isDuringSearch: false,
      turnNumber: ctx.moves.length,
      rootInfo: {
        currentPlayer: ctx.toPlay === BLACK ? 'B' : 'W',
        visits: ri.visits !== undefined ? ri.visits : visits,
        winrate: flip ? 1 - bw : bw,
        scoreLead: flip ? -bl : bl,
      },
      moveInfos: [],
    };

    const custom = this._value('policy', query, ctx);
    const policy = Array.isArray(custom) ? custom.slice() : this.defaultPolicy(ctx);
    if (query.includePolicy) res.policy = policy;

    if (visits > 1) {
      let infos = this._value('moveInfos', query, ctx);
      if (!Array.isArray(infos)) {
        const ranked = [];
        for (let i = 0; i < n; i++) if (policy[i] > 0) ranked.push(i);
        ranked.sort((a, b) => policy[b] - policy[a] || a - b);
        const top = ranked.slice(0, 5);
        if (policy[n] > 0) top.push(PASS);
        const sm = this._value('searchMove', query, ctx);
        if (Number.isInteger(sm)) {
          const k = top.indexOf(sm);
          if (k >= 0) top.splice(k, 1);
          top.unshift(sm);
        }
        infos = top.map((idx) => idxToGtp(idx, ctx.size));
      }
      res.moveInfos = infos.map((mi, order) => {
        const o = typeof mi === 'string' ? { move: mi } : { ...mi };
        return {
          order,
          visits: Math.max(1, Math.round(visits / (order + 2))),
          winrate: res.rootInfo.winrate,
          scoreLead: res.rootInfo.scoreLead,
          prior: 0,
          pv: [o.move],
          ...o,
        };
      });
    }

    if (query.includeOwnership) {
      const own = this._value('ownership', query, ctx);
      let ownership;
      if (Array.isArray(own)) {
        ownership = own.slice();
      } else {
        ownership = [];
        for (let i = 0; i < n; i++) {
          const c = ctx.state.board.get(i);
          ownership.push(c === BLACK ? 1 : c === WHITE ? -1 : 0);
        }
      }
      res.ownership = flip ? ownership.map((v) => -v) : ownership;
    }
    return res;
  }
}

module.exports = { createFakeAiService, FakeEngine, firstReasonableMove };
