'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pickRankMove, pickRankMoveDetailed, pickPolicyMove, rankNMoves, pyRound, PASS } = require('../../src/ai/rank');
const reference = require('./fixtures/katrain-reference.json');
const { mulberry32 } = require('./helpers');

// 与 KaTrain 原版 Python 代码的逐手比对：
// 用同一个伪随机数生成器（mulberry32，种子 12345）重建 3000 组合成的 policy（9/13/19 路、0~100% 非法点、
// 尖锐/平坦分布、pass 概率 0~0.3、人为制造的数值并列），以及每组要喂给 random.random() 的均匀随机数序列。
// fixtures/katrain-reference.json 记录了原版 RankStrategy / PolicyStrategy 在这些输入上选出的着手。

function buildCases() {
  const R = mulberry32(12345);
  const openU = () => {
    let u;
    do {
      u = R();
    } while (u === 0);
    return u;
  };
  function synthPolicy(size, { illegalFrac, sharp, passMass, roundTo }) {
    const n = size * size;
    const w = new Array(n).fill(0).map(() => Math.pow(openU(), sharp));
    const legal = w.map(() => R() >= illegalFrac);
    let sum = 0;
    for (let i = 0; i < n; i++) if (legal[i]) sum += w[i];
    const pol = new Array(n + 1);
    for (let i = 0; i < n; i++) pol[i] = legal[i] ? (w[i] / (sum || 1)) * (1 - passMass) : -1;
    pol[n] = passMass;
    if (legal.every((l) => !l)) pol[n] = 1;
    if (roundTo) for (let i = 0; i <= n; i++) if (pol[i] > 0) pol[i] = Math.max(1e-8, Math.round(pol[i] * roundTo) / roundTo);
    return pol;
  }
  const cases = [];
  for (let k = 0; k < 3000; k++) {
    const size = [9, 13, 19][k % 3];
    const opts = {
      illegalFrac: [0, 0.1, 0.4, 0.7, 0.95, 1][Math.floor(R() * 6)],
      sharp: [1, 3, 8, 20, 40][Math.floor(R() * 5)],
      passMass: [0, 1e-4, 0.001, 0.02, 0.3][Math.floor(R() * 5)],
      roundTo: [0, 0, 1000, 100][Math.floor(R() * 4)],
    };
    const policy = synthPolicy(size, opts);
    const kyu = [18, 15, 12, 10, 8, 6, 4, 2, 1, 0, -1, -2, 7.5, 3.3][Math.floor(R() * 14)];
    const uniforms = Array.from({ length: size * size + 5 }, openU);
    cases.push({ size, kyu, policy, uniforms });
  }
  return cases;
}

const CASES = buildCases();
const fromPy = (v) => (v === 'pass' ? PASS : v);
const seq = (arr) => {
  let i = 0;
  return () => arr[i++];
};

test('rank: 3000 组用例与 KaTrain 原版 RankStrategy 完全一致，覆盖所有决策分支', () => {
  assert.equal(reference.rank.length, CASES.length);
  const reasons = {};
  const mismatches = [];
  CASES.forEach((c, i) => {
    const d = pickRankMoveDetailed({ policy: c.policy, boardSize: c.size, kyuRank: c.kyu, rng: seq(c.uniforms) });
    const key = d.reason.replace(/\d+/g, 'N');
    reasons[key] = (reasons[key] || 0) + 1;
    if (d.move !== fromPy(reference.rank[i])) mismatches.push({ i, js: d.move, py: reference.rank[i], reason: d.reason });
  });
  assert.deepEqual(mismatches.slice(0, 5), []);
  for (const path of [
    'pass-in-top-N -> top policy move',
    'top policy > override',
    'top-N policy sum > overridetwo',
    'picked move policy < pass policy -> top policy move',
    'best of N random legal moves',
  ]) {
    assert.ok(reasons[path] > 0, `分支没覆盖到：${path}`);
  }
});

test('rank: 3000 组用例与 KaTrain 原版 PolicyStrategy（含开局 22 手随机化）完全一致', () => {
  assert.equal(reference.policy.length, CASES.length);
  let mismatches = 0;
  CASES.forEach((c, i) => {
    const mv = pickPolicyMove({ policy: c.policy, boardSize: c.size, movesPlayed: (i * 7) % 40, rng: seq(c.uniforms) });
    if (mv !== fromPy(reference.policy[i])) mismatches += 1;
  });
  assert.equal(mismatches, 0);
});

test('rank: n_moves 公式与原版一致（195 组：路数 × 级位 × 合法点比例）', () => {
  const entries = Object.entries(reference.nmoves);
  assert.equal(entries.length, 195);
  for (const [key, expected] of entries) {
    const [size, kyu, frac] = key.split('|').map(Number);
    const nLegal = pyRound(frac * size * size);
    assert.equal(rankNMoves(nLegal, size * size, kyu), expected, key);
  }
  // 几个研究报告里的数：19 路空盘 8 级看 55 个点，18 级 15 个，3 段 132 个
  assert.equal(rankNMoves(361, 361, 8), 55);
  assert.equal(rankNMoves(361, 361, 18), 15);
  assert.equal(rankNMoves(361, 361, -2), 132);
});

test('rank: pyRound 是银行家舍入', () => {
  assert.deepEqual([0.5, 1.5, 2.5, 2.4, 2.6, 3.5].map(pyRound), [0, 2, 2, 2, 3, 4]);
});

test('rank: 下标约定——返回值就是本项目的 idx（左上角为 0），pass 为 -1', () => {
  const n = 9;
  const policy = new Array(n * n + 1).fill(0.001);
  policy[2] = 0.95; // C9（第一行第 3 列）
  assert.equal(pickRankMove({ policy, boardSize: 9, kyuRank: 18, rng: mulberry32(1) }), 2);
  const passTop = new Array(n * n + 1).fill(-1);
  passTop[40] = 0.2;
  passTop[n * n] = 0.8;
  assert.equal(pickRankMove({ policy: passTop, boardSize: 9, kyuRank: 8, rng: mulberry32(1) }), PASS);
  assert.equal(pickPolicyMove({ policy: passTop, boardSize: 9, movesPlayed: 50 }), PASS);
});

test('rank: pass 规则——pass 在前 5 → 下 policy 第一；抽中的点不如 pass → 下 policy 第一', () => {
  const n = 19;
  const policy = new Array(n * n + 1).fill(-1);
  policy[0] = 0.4;
  policy[1] = 0.1;
  policy[n * n] = 0.5; // pass 排第一
  assert.equal(pickRankMoveDetailed({ policy, boardSize: 19, kyuRank: 8, rng: mulberry32(1) }).move, PASS);
  policy[n * n] = 0.3; // pass 排第二（前 5）→ 下第一的点
  const d = pickRankMoveDetailed({ policy, boardSize: 19, kyuRank: 8, rng: mulberry32(1) });
  assert.equal(d.move, 0);
  assert.match(d.reason, /pass-in-top-5/);

  // 没有任何合法点 → pass
  const none = new Array(n * n + 1).fill(-1);
  none[n * n] = 1;
  assert.equal(pickRankMove({ policy: none, boardSize: 19, kyuRank: 8, rng: mulberry32(1) }), PASS);
});

test('rank: 平坦 policy 上按级位抽样——越强抽的点越多，选中名次越靠前', () => {
  const n = 19;
  // 几何衰减的"开局"policy：idx 顺序即名次
  const policy = new Array(n * n + 1);
  let s = 0;
  for (let i = 0; i < n * n; i++) {
    policy[i] = Math.pow(0.9, i);
    s += policy[i];
  }
  for (let i = 0; i < n * n; i++) policy[i] /= s;
  policy[n * n] = 1e-6;
  const meanRank = (kyu) => {
    const rng = mulberry32(99);
    let sum = 0;
    for (let t = 0; t < 3000; t++) sum += pickRankMove({ policy, boardSize: 19, kyuRank: kyu, rng }) + 1;
    return sum / 3000;
  };
  const r18 = meanRank(18);
  const r8 = meanRank(8);
  const rd3 = meanRank(-2);
  assert.ok(r18 > r8 && r8 > rd3, `${r18} > ${r8} > ${rd3}`);
  assert.ok(r18 > 15 && r18 < 30, `18 级平均名次约 22：${r18}`);
  assert.ok(rd3 < 4, `3 段平均名次约 2.7：${rd3}`);
});

test('rank: 参数校验', () => {
  assert.throws(() => pickRankMove({ policy: [0.5, 0.5], boardSize: 9, kyuRank: 8 }), /length 82/);
  assert.throws(() => pickRankMove({ policy: new Array(82).fill(0.01), boardSize: 9, kyuRank: NaN }), /kyuRank/);
  assert.throws(() => pickPolicyMove({ policy: [], boardSize: 9, movesPlayed: 0 }), /length 82/);
});
