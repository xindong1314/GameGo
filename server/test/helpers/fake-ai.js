'use strict';
const { createGame, play, pass, resume } = require('../../../miniprogram/utils/engine/game');
const { canPlay } = require('../../../miniprogram/utils/engine/rules');

// 测试用的 AiService（设计文档 7.1 的接口），确定性、不需要 KataGo。
//
// createFakeAi(options)：
//   available: bool（默认 true）
//   levels: [{ id, name, desc }]
//   script: number[]              —— 依次返回的着手（-1 为 pass），用完后按 strategy
//   strategy: 'first-legal' | 'pass' | 'resign' | fn(req) → { move, resign }
//   passWhenHumanPassed: bool     —— humanJustPassed 时 pass（默认 true）
//   manual: bool                  —— chooseMove 不自动完成，放进 pendingMoves 由测试 resolve/reject
//   failMoves: number             —— 接下来这么多次 chooseMove 直接失败
//   dead: number[] | fn(req)      —— judgeDead 的结果
//   manualJudge: bool             —— judgeDead 放进 pendingJudges 由测试完成
//   judgeFail: bool               —— judgeDead 失败
// 调用记录在 ai.calls.chooseMove / ai.calls.judgeDead。ai.set(patch) 可随时修改选项。

const DEFAULT_LEVELS = [
  { id: 'k10', name: '10级', desc: '入门' },
  { id: 'k5', name: '5级', desc: '初级' },
  { id: 'd1', name: '1段', desc: '中级' },
];

// 与服务端一致的重放：两次 pass 之后还有着手则先 resume
function replayState(size, komi, moves) {
  const s = createGame({ size, komi, autoScore: false });
  for (const mv of moves) {
    if (s.status === 'scoring') resume(s);
    const r = mv === -1 ? pass(s) : play(s, mv);
    if (!r.ok) throw new Error(`fake-ai: 着手 ${mv} 非法（${r.reason}）`);
  }
  return s;
}

// 第一个合法、且不填自己真眼（四邻都是己方或边）的点；没有就 pass
function firstLegal(req) {
  const s = replayState(req.size, req.komi, req.moves);
  const n = req.size;
  for (let idx = 0; idx < n * n; idx++) {
    if (s.board.get(idx) !== 0) continue;
    const nbs = s.board.neighbors(idx);
    if (nbs.every((nb) => s.board.get(nb) === req.color)) continue;
    if (canPlay(s.board, req.color, s.ko, idx).ok) return { move: idx, resign: false };
  }
  return { move: -1, resign: false };
}

function deferred(req) {
  const d = { req };
  d.promise = new Promise((resolve, reject) => {
    d.resolve = resolve;
    d.reject = reject;
  });
  return d;
}

function createFakeAi(options = {}) {
  const opts = {
    available: true,
    levels: DEFAULT_LEVELS,
    script: [],
    strategy: 'first-legal',
    passWhenHumanPassed: true,
    manual: false,
    failMoves: 0,
    dead: [],
    manualJudge: false,
    judgeFail: false,
    ...options,
  };
  opts.script = [...(opts.script || [])];
  const calls = { chooseMove: [], judgeDead: [] };
  const pendingMoves = [];
  const pendingJudges = [];

  function compute(req) {
    if (opts.script.length) return { move: opts.script.shift(), resign: false };
    if (typeof opts.strategy === 'function') return opts.strategy(req);
    if (opts.strategy === 'resign') return { move: -1, resign: true };
    if (opts.passWhenHumanPassed && req.humanJustPassed) return { move: -1, resign: false };
    if (opts.strategy === 'pass') return { move: -1, resign: false };
    return firstLegal(req);
  }

  const ai = {
    calls,
    pendingMoves,
    pendingJudges,
    shutdownCalled: false,
    set(patch) {
      Object.assign(opts, patch);
      if (patch.script) opts.script = [...patch.script];
    },
    available() {
      return Boolean(opts.available);
    },
    levels() {
      return opts.levels.map((l) => ({ ...l }));
    },
    chooseMove(req) {
      calls.chooseMove.push(JSON.parse(JSON.stringify(req)));
      if (opts.manual) {
        const d = deferred(req);
        pendingMoves.push(d);
        return d.promise;
      }
      if (opts.failMoves > 0) {
        opts.failMoves -= 1;
        return Promise.reject(new Error('fake-ai: 模拟落子失败'));
      }
      try {
        return Promise.resolve(compute(req));
      } catch (err) {
        return Promise.reject(err);
      }
    },
    judgeDead(req) {
      calls.judgeDead.push(JSON.parse(JSON.stringify(req)));
      if (opts.manualJudge) {
        const d = deferred(req);
        pendingJudges.push(d);
        return d.promise;
      }
      if (opts.judgeFail) return Promise.reject(new Error('fake-ai: 模拟死子判断失败'));
      const dead = typeof opts.dead === 'function' ? opts.dead(req) : opts.dead.slice();
      return Promise.resolve({ dead, source: 'katago' });
    },
    shutdown() {
      ai.shutdownCalled = true;
      return Promise.resolve();
    },
    // 测试辅助：完成最早一个挂起的 chooseMove（默认按 strategy 计算）
    resolveNextMove(result) {
      const d = pendingMoves.shift();
      if (!d) throw new Error('fake-ai: 没有挂起的 chooseMove');
      d.resolve(result === undefined ? compute(d.req) : result);
      return d;
    },
    rejectNextMove(err = new Error('fake-ai: 模拟落子失败')) {
      const d = pendingMoves.shift();
      if (!d) throw new Error('fake-ai: 没有挂起的 chooseMove');
      d.reject(err);
      return d;
    },
    resolveNextJudge(dead = []) {
      const d = pendingJudges.shift();
      if (!d) throw new Error('fake-ai: 没有挂起的 judgeDead');
      d.resolve({ dead, source: 'katago' });
      return d;
    },
    rejectNextJudge(err = new Error('fake-ai: 模拟死子判断失败')) {
      const d = pendingJudges.shift();
      if (!d) throw new Error('fake-ai: 没有挂起的 judgeDead');
      d.reject(err);
      return d;
    },
  };
  return ai;
}

module.exports = { createFakeAi, DEFAULT_LEVELS, replayState, firstLegal };
