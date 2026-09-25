'use strict';
// 本地对弈页：中国规则数子（双方停一手 → 点选死棋 → 确认计分 / 继续对局）
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const h = require('./pages-harness');

const LS = require(path.join(h.MINI_ROOT, 'pages', 'game', 'local-score'));
const { Board } = require(path.join(h.MINI_ROOT, 'utils', 'engine', 'board'));

function setup(query = { size: '9', komi: '7.5' }) {
  const env = h.createEnv();
  const page = h.loadPage('game/game', env);
  page.onLoad(query);
  return { env, page };
}

function put(page, idx) {
  page.onPick({ detail: { idx } });
  page.onConfirm();
}

test('本地对弈：双方停一手进入数子阶段（不再直接按 Tromp-Taylor 终局），点选死棋后确认计分', () => {
  const { page } = setup();
  // 黑在左上角一带，白一子孤立在黑地里
  put(page, 0); // 黑 A9
  put(page, 40); // 白 E5
  put(page, 10); // 黑
  assert.equal(page.data.toPlay, 2);
  page.onPass(); // 白停
  assert.equal(page.data.status, 'playing');
  page.onPass(); // 黑停
  assert.equal(page.data.status, 'scoring');
  assert.ok(page.data.marks && page.data.marks.owner.length === 81);
  assert.deepEqual(page.data.marks.dead, []);
  assert.match(page.data.score.komiText, /贴目 7.5/);
  const before = page.data.score.blackText;
  // 数子阶段不能落子
  page.onPick({ detail: { idx: 20 } });
  assert.equal(page.data.preview, null);
  // 点空点：提示
  page.onBoardTap({ detail: { idx: 20 } });
  assert.equal(page.data.hint, '点击棋子可标记死活');
  // 把白子标为死棋：黑的点数增加
  page.onBoardTap({ detail: { idx: 40 } });
  assert.deepEqual(page.data.marks.dead, [40]);
  assert.notEqual(page.data.score.blackText, before);
  assert.equal(page.data.score.blackText, '81 点');
  assert.equal(page.data.score.whiteText, '7.5 点');
  page.onAcceptScore();
  assert.equal(page.data.status, 'ended');
  assert.equal(page.data.result.reason, 'score');
  assert.equal(page.data.result.winner, 1);
  assert.equal(page.data.end.title, '黑胜');
  assert.equal(page.data.end.detail, '黑 81 点 : 白 7.5 点');
  assert.deepEqual(page.data.marks.dead, [40], '终局后仍显示死子');
});

test('本地对弈：数子阶段继续对局 / 悔棋回到对局；再来一局', () => {
  const { page } = setup();
  put(page, 40);
  page.onPass();
  page.onPass();
  assert.equal(page.data.status, 'scoring');
  page.onBoardTap({ detail: { idx: 40 } });
  page.onResumeScore();
  assert.equal(page.data.status, 'playing');
  assert.equal(page.data.marks, null);
  assert.equal(page.data.toPlay, 2, '轮到最先停一手的白方');
  page.onPass();
  page.onPass();
  assert.equal(page.data.status, 'scoring');
  assert.deepEqual(page.data.marks.dead, [], '重新数子时死子清空');
  page.onUndo();
  assert.equal(page.data.status, 'playing');
  page.onRestart();
  assert.equal(page.data.status, 'playing');
  assert.equal(page.data.cells.filter((c) => c).length, 0);
});

test('本地对弈：认输与悔棋认输', async () => {
  const { env, page } = setup();
  put(page, 40);
  page.onResign();
  await h.flush();
  assert.match(env.wx.last('showModal').content, /白方/);
  assert.equal(page.data.status, 'ended');
  assert.equal(page.data.end.title, '黑胜');
  assert.equal(page.data.end.detail, '白方认输');
  page.onUndo();
  assert.equal(page.data.status, 'playing');
});

test('local-score：计分视图与点选', () => {
  const b = new Board(9);
  b.set(0, 1);
  b.set(1, 2);
  assert.equal(LS.toggle(b, [], 40), null, '空点');
  assert.equal(LS.toggle(b, [], 81), null, '越界');
  assert.deepEqual(LS.toggle(b, [], 1), [1]);
  assert.deepEqual(LS.toggle(b, [1], 1), []);
  const v = LS.scoreView(b, 7.5, [1]);
  assert.equal(v.blackText, '81 点');
  assert.equal(v.leadText, '按当前标记：黑胜 73.5 目');
  assert.equal(LS.scoreView(b, 0, []).komiText, '');
  assert.deepEqual(LS.endView({ winner: 0, reason: 'score', black: 40, white: 40 }).title, '和棋');
  assert.equal(LS.endView(null), null);
});
