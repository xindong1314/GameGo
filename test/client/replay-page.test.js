'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, createPage, createWx, settle } = require('./play-harness');

const PASS = -1;

function record(over) {
  return Object.assign(
    {
      id: 'g1',
      mode: 'friend',
      size: 9,
      myColor: 2,
      winner: 2,
      reason: 'score',
      resultText: 'W+6.5',
      myResult: 'win',
      createdAt: Date.UTC(2026, 8, 25),
      komi: 7.5,
      moves: [40, 41, PASS, PASS],
      dead: [],
      players: { 1: { userId: 1, nickname: '甲', avatarUrl: '' }, 2: { userId: 2, nickname: '乙', avatarUrl: '' } },
      scoreBlack: 1,
      scoreWhite: 8.5,
    },
    over || {}
  );
}

function setup(t, { query = { id: 'g1' }, result, error } = {}) {
  const wx = createWx();
  global.wx = wx;
  const calls = [];
  const api = {
    request(opts) {
      calls.push(opts);
      return error ? Promise.reject(error) : Promise.resolve(result === undefined ? record() : result);
    },
  };
  const auth = { ensureLogin: () => Promise.resolve({ id: 2 }) };
  const def = loadPage('pages/replay/replay', { 'utils/net/api': api, 'utils/net/auth': auth });
  const page = createPage(def);
  page.onLoad(query);
  t.after(() => {
    page.onUnload();
    delete global.wx;
  });
  return { page, wx, calls, api };
}

test('加载棋谱：请求 GET /api/games/:id，停在最后一手并显示死子', async (t) => {
  const { page, calls } = setup(t);
  await settle();
  assert.deepEqual(calls, [{ method: 'GET', path: '/api/games/g1' }]);
  const d = page.data;
  assert.equal(d.loading, false);
  assert.equal(d.loaded, true);
  assert.equal(d.k, 4);
  assert.equal(d.total, 4);
  assert.equal(d.cells.length, 81);
  assert.equal(d.cells[41], 2);
  assert.deepEqual(d.marks.dead, []);
  assert.equal(d.marks.owner.length, 81);
  assert.equal(d.finalText, '黑 1 点 · 白 8.5 点（白含贴目 7.5）');
  assert.equal(d.resultLabel, '白胜 7.5 目');
  assert.equal(d.white.isMe, true);
  assert.equal(d.myResultText, '胜');
  assert.equal(d.canNext, false);
});

test('逐手翻看与进度条', async (t) => {
  const { page } = setup(t);
  await settle();
  page.onFirst();
  assert.equal(page.data.k, 0);
  assert.equal(page.data.cells[40], 0);
  assert.equal(page.data.marks, null);
  assert.equal(page.data.canPrev, false);
  const n = page.setDataCalls.length;
  page.onPrev();
  assert.equal(page.setDataCalls.length, n, '已在开头：不重复 setData');
  page.onNext();
  assert.equal(page.data.k, 1);
  assert.equal(page.data.cells[40], 1);
  assert.equal(page.data.moveText, '第 1 手 · 黑 E5');
  page.onSlide({ detail: { value: 3 } });
  assert.equal(page.data.k, 3);
  assert.equal(page.data.moveText, '第 3 手 · 黑 停一手');
  page.onSlide({ detail: { value: 'x' } });
  assert.equal(page.data.k, 3);
  page.onLast();
  assert.equal(page.data.k, 4);
  page.onPrev();
  assert.equal(page.data.k, 3);
});

test('拖动进度条：changing 事件节流（每 100ms 至多一次 setData，用最新位置），松手立即到位', async (t) => {
  const moves = [];
  for (let i = 0; i < 60; i++) moves.push(i);
  const { page } = setup(t, { result: record({ moves, reason: 'resign', scoreBlack: null, scoreWhite: null, dead: null }) });
  await settle();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  assert.equal(page.data.k, 60);
  const before = page.setDataCalls.length;
  // 一次快速拖动：60 个 changing 事件，间隔 5ms（共 300ms）
  for (let k = 0; k < 60; k++) {
    page.onSliding({ detail: { value: 59 - k } });
    t.mock.timers.tick(5);
  }
  const during = page.setDataCalls.length - before;
  assert.ok(during >= 2 && during <= 4, `拖动 300ms 内 setData ${during} 次`);
  t.mock.timers.tick(200);
  assert.equal(page.data.k, 0, '节流结束时停在最新位置');
  // 松手：立即到位，取消未执行的节流
  page.onSliding({ detail: { value: 10 } });
  page.onSliding({ detail: { value: 20 } });
  page.onSlide({ detail: { value: 25 } });
  assert.equal(page.data.k, 25);
  t.mock.timers.tick(500);
  assert.equal(page.data.k, 25, '松手后不再被迟到的节流覆盖');
  page.onSliding({ detail: { value: 'x' } });
  page.onSlide({ detail: {} });
  assert.equal(page.data.k, 25);
  // 卸载后迟到的节流不再 setData
  page.onSliding({ detail: { value: 30 } });
  page.onSliding({ detail: { value: 31 } });
  const n = page.setDataCalls.length;
  page.onUnload();
  t.mock.timers.tick(500);
  assert.equal(page.setDataCalls.length, n);
});

test('复制 SGF', async (t) => {
  const { page, wx } = setup(t);
  await settle();
  page.onCopySgf();
  const c = wx.named('setClipboardData')[0];
  assert.match(c.data, /^\(;FF\[4\].*SZ\[9\].*PB\[甲\]PW\[乙\].*RE\[W\+7\.5\];B\[ee\];W\[fe\];B\[\];W\[\]\)$/);
  assert.deepEqual(wx.named('showToast')[0], { title: 'SGF 棋谱已复制', icon: 'none' });
});

test('加载失败显示原因，可重试；编号无效不请求', async (t) => {
  const env = setup(t, { error: { code: 'not_found', msg: 'x', status: 404 } });
  await settle();
  assert.equal(env.page.data.loadError, '对局不存在');
  assert.equal(env.page.data.loaded, false);
  env.page.onRetry();
  await settle();
  assert.equal(env.calls.length, 2);

  const bad = setup(t, { query: { id: '' } });
  await settle();
  assert.equal(bad.page.data.loadError, '对局编号无效');
  assert.equal(bad.calls.length, 0);

  const broken = setup(t, { result: { id: 'g1', size: 30, moves: [] } });
  await settle();
  assert.match(broken.page.data.loadError, /路数无效/);
});
