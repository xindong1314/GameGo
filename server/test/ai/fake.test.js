'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeAiService, FakeEngine } = require('../../src/ai/fake');
const { publicLevels } = require('../../src/ai/levels');
const { rejectsWith } = require('./helpers');

test('fake service: 与 AiService 同接口、确定性', async () => {
  const ai = createFakeAiService();
  assert.equal(ai.available(), true);
  assert.deepEqual(ai.levels(), publicLevels());
  const a = await ai.chooseMove({ size: 9, komi: 7.5, moves: [], color: 1, level: 'k8', humanJustPassed: false });
  const b = await ai.chooseMove({ size: 9, komi: 7.5, moves: [], color: 1, level: 'k8', humanJustPassed: false });
  assert.deepEqual(a, b);
  assert.deepEqual(a, { move: 0, resign: false, info: { winrate: 0.5, scoreLead: 0, visits: 1 } });
  // 第一个合法点被占 → 下一个
  assert.equal((await ai.chooseMove({ size: 9, komi: 7.5, moves: [0], color: 2, level: 'k8' })).move, 1);
  // 人刚 pass → pass
  assert.deepEqual(await ai.chooseMove({ size: 9, komi: 7.5, moves: [0, 1, -1], color: 2, level: 'k8', humanJustPassed: true }), {
    move: -1,
    resign: false,
  });
  assert.equal(ai.calls.chooseMove.length, 4);
  assert.deepEqual(await ai.judgeDead({ size: 9, komi: 7.5, moves: [-1, -1] }), { dead: [], source: 'katago' });
  assert.equal(ai.calls.judgeDead.length, 1);
});

test('fake service: 不填己方单点眼', async () => {
  // 黑 1、9 围住角 0：黑不下 0
  const ai = createFakeAiService();
  const r = await ai.chooseMove({ size: 9, komi: 7.5, moves: [1, 80, 9, 79], color: 1, level: 'k8' });
  assert.equal(r.move, 2);
});

test('fake service: 可配置落子、认输、死子、失败、不可用', async () => {
  const ai = createFakeAiService({ move: (req) => (req.moves.length === 0 ? 40 : { move: 41, info: { winrate: 0.2, scoreLead: -3, visits: 5 } }) });
  assert.deepEqual(await ai.chooseMove({ size: 9, komi: 7.5, moves: [], color: 1, level: 'd5' }), { move: 40, resign: false });
  assert.deepEqual(await ai.chooseMove({ size: 9, komi: 7.5, moves: [40], color: 2, level: 'd5' }), {
    move: 41,
    resign: false,
    info: { winrate: 0.2, scoreLead: -3, visits: 5 },
  });
  ai.set({ move: null, resign: true, dead: (req, p) => [p.moves[0]] });
  assert.deepEqual(await ai.chooseMove({ size: 9, komi: 7.5, moves: [40], color: 2, level: 'max' }), { move: -1, resign: true });
  assert.deepEqual(await ai.judgeDead({ size: 9, komi: 7.5, moves: [40, -1, -1] }), { dead: [40], source: 'katago' });
  ai.set({ judgeFail: true });
  assert.equal((await rejectsWith(ai.judgeDead({ size: 9, komi: 7.5, moves: [] }))).code, 'katago_error');
  ai.set({ available: false });
  assert.equal(ai.available(), false);
  assert.equal((await rejectsWith(ai.chooseMove({ size: 9, komi: 7.5, moves: [], color: 1, level: 'k8' }))).code, 'ai_unavailable');
  const custom = createFakeAiService({ levels: [{ id: 'x', name: 'X', desc: '', extra: 1 }] });
  assert.deepEqual(custom.levels(), [{ id: 'x', name: 'X', desc: '' }]);
  assert.equal((await rejectsWith(custom.chooseMove({ size: 9, komi: 7.5, moves: [], color: 1, level: 'k8' }))).code, 'bad_request');
  await custom.shutdown();
  assert.equal(custom.available(), false);
});

test('fake service: 参数校验与真实服务一致', async () => {
  const ai = createFakeAiService();
  for (const r of [
    { size: 9, komi: 7.5, moves: [], color: 2, level: 'k8' },
    { size: 9, komi: 7.5, moves: [40, 40], color: 1, level: 'k8' },
    { size: 11, komi: 7.5, moves: [], color: 1, level: 'k8' },
    { size: 9, komi: 7.5, moves: [], color: 1, level: 'nope' },
  ]) {
    assert.equal((await rejectsWith(ai.chooseMove(r))).code, 'bad_request', JSON.stringify(r));
  }
  assert.equal((await rejectsWith(ai.judgeDead({ size: 9, komi: 7.5, moves: [100] }))).code, 'bad_request');
});

test('FakeEngine: 按 KataGo 的格式合成 policy / moveInfos / rootInfo / ownership', async () => {
  const eng = new FakeEngine({ rootInfo: { winrate: 0.8, scoreLead: 4 } });
  await eng.start();
  assert.equal(eng.available(), true);
  const r = await eng.query({
    boardXSize: 9,
    boardYSize: 9,
    komi: 7.5,
    moves: [
      ['B', 'E5'],
      ['W', 'pass'],
    ],
    rules: 'chinese',
    maxVisits: 50,
    includePolicy: true,
    includeOwnership: true,
    overrideSettings: { reportAnalysisWinratesAs: 'BLACK' },
  });
  assert.equal(r.policy.length, 82);
  assert.equal(r.policy[40], -1, '已有子的点为 -1');
  assert.ok(r.policy[0] > 0 && r.policy[81] > 0);
  assert.ok(Math.abs(r.policy.filter((v) => v > 0).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.equal(r.ownership.length, 81);
  assert.equal(r.ownership[40], 1);
  assert.deepEqual(r.rootInfo, { currentPlayer: 'B', visits: 50, winrate: 0.8, scoreLead: 4 });
  assert.ok(r.moveInfos.length > 1);
  assert.deepEqual(
    r.moveInfos.map((m) => m.order),
    r.moveInfos.map((_, i) => i),
  );
  assert.equal(r.turnNumber, 2);

  // 视角：WHITE / SIDETOMOVE
  const w = await eng.query({ boardXSize: 9, boardYSize: 9, komi: 7.5, moves: [['B', 'E5']], maxVisits: 1, includeOwnership: true, overrideSettings: { reportAnalysisWinratesAs: 'SIDETOMOVE' } });
  assert.equal(w.rootInfo.currentPlayer, 'W');
  assert.ok(Math.abs(w.rootInfo.winrate - 0.2) < 1e-12);
  assert.equal(w.rootInfo.scoreLead, -4);
  assert.equal(w.ownership[40], -1);
  assert.deepEqual(w.moveInfos, [], 'maxVisits 1 时 moveInfos 为空（与 KataGo 一致）');
  assert.equal(w.policy, undefined, '没要 policy 就不给');

  // 1 次评估时不给 moveInfos；searchMove 指定第一选点
  eng.set({ searchMove: -1 });
  const s = await eng.query({ boardXSize: 9, boardYSize: 9, komi: 7.5, moves: [], maxVisits: 10 });
  assert.equal(s.moveInfos[0].move, 'pass');
  assert.equal(eng.queries.length, 3);
  assert.equal(eng.lastQuery().maxVisits, 10);
});

test('FakeEngine: respond 覆盖、非法着手报错、不可用与关闭', async () => {
  const eng = new FakeEngine({ respond: (q, ctx) => (q.tag ? { id: q.id, tag: q.tag, toPlay: ctx.toPlay } : undefined) });
  assert.deepEqual(await eng.query({ tag: 'x', boardXSize: 9, boardYSize: 9, komi: 7.5, moves: [['B', 'A1']] }), { id: undefined, tag: 'x', toPlay: 2 });
  const e1 = await rejectsWith(eng.query({ boardXSize: 9, boardYSize: 9, komi: 7.5, moves: [['B', 'E5'], ['W', 'E5']] }));
  assert.equal(e1.code, 'katago_error');
  const e2 = await rejectsWith(eng.query({ boardXSize: 9, boardYSize: 9, komi: 7.5, moves: [['B', 'Z9']] }));
  assert.equal(e2.code, 'katago_error');
  const e3 = await rejectsWith(eng.query({ boardXSize: 9, boardYSize: 9, komi: 7.5, moves: [['W', 'E5']] }));
  assert.equal(e3.code, 'katago_error');
  eng.set({ available: false });
  assert.equal(eng.available(), false);
  assert.equal((await rejectsWith(eng.query({ boardXSize: 9, boardYSize: 9, komi: 7.5, moves: [] }))).code, 'ai_unavailable');
  eng.set({ available: true });
  await eng.shutdown();
  assert.equal(eng.available(), false);
  assert.equal((await rejectsWith(eng.query({ boardXSize: 9, boardYSize: 9, komi: 7.5, moves: [] }))).code, 'ai_unavailable');
});
