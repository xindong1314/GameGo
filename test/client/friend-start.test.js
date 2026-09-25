'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const h = require('./pages-harness');

const { createFriendStartNotifier, createGameStartNotifier } = require(path.join(h.MINI_ROOT, 'utils', 'friend-start'));

function setup(pages) {
  const wx = h.createFakeWx();
  const stack = pages.slice();
  const notify = createFriendStartNotifier({ wxApi: wx, getPages: () => stack });
  return { wx, stack, notify };
}

test('好友房开局通知：房主在其他页面 → 弹窗并进入对局；同一局只提示一次', async () => {
  const { wx, notify } = setup([{ route: 'pages/index/index' }]);
  assert.equal(notify({ t: 'game.start', gameId: 'friend000001', mode: 'friend' }), true);
  await h.flush();
  assert.equal(wx.last('showModal').title, '好友已加入');
  assert.equal(wx.last('showModal').showCancel, false);
  assert.equal(wx.last('navigateTo').url, '/pages/play/play?id=friend000001');
  assert.equal(notify({ t: 'game.start', gameId: 'friend000001', mode: 'friend' }), false);
  assert.equal(wx.count('showModal'), 1);
});

test('好友房开局通知：好友房页自己处理；已在这局的对局页不提示；非法数据忽略', () => {
  assert.equal(setup([{ route: 'pages/index/index' }, { route: 'pages/room/room' }]).notify({ gameId: 'friend000001', mode: 'friend' }), false);
  assert.equal(setup([{ route: 'pages/play/play', options: { id: 'friend000001' } }]).notify({ gameId: 'friend000001', mode: 'friend' }), false);
  // 正在下另一局（如人机）时照样提示
  assert.equal(setup([{ route: 'pages/play/play', options: { id: 'ai0000000001' } }]).notify({ gameId: 'friend000001', mode: 'friend' }), true);
  const { wx, notify } = setup([]);
  assert.equal(notify(null), false);
  assert.equal(notify({ gameId: '../x' }), false);
  assert.equal(notify({ gameId: 'rank00000001', mode: 'ranked' }), false);
  assert.equal(wx.count('showModal'), 0);
});

test('好友房开局通知：页面栈满导致 navigateTo 失败时改用 redirectTo', async () => {
  const { wx, notify } = setup([{ route: 'pages/me/me' }]);
  wx.failNext.navigateTo = true;
  notify({ gameId: 'friend000002', mode: 'friend' });
  await h.flush();
  assert.equal(wx.last('redirectTo').url, '/pages/play/play?id=friend000002');
});

// ---------- 排位赛 match.found（设计文档 8.3：可能在匹配页之外到达）----------

function setupGame(pages) {
  const wx = h.createFakeWx();
  const stack = pages.slice();
  const n = createGameStartNotifier({ wxApi: wx, getPages: () => stack });
  return { wx, stack, n };
}

test('匹配成功通知：离开匹配页（改为人机/取消）的同时配对成功 → 在当前页提示并进入对局；同一局只提示一次', async () => {
  const { wx, n } = setupGame([{ route: 'pages/index/index' }, { route: 'pages/ai/ai' }]);
  assert.equal(n.onMatchFound({ t: 'match.found', gameId: 'rank00000001' }), true);
  await h.flush();
  const modal = wx.last('showModal');
  assert.equal(modal.title, '匹配成功');
  assert.equal(modal.confirmText, '进入对局');
  assert.equal(modal.showCancel, false);
  assert.equal(wx.last('navigateTo').url, '/pages/play/play?id=rank00000001');
  assert.equal(n.onMatchFound({ gameId: 'rank00000001' }), false);
  assert.equal(wx.count('showModal'), 1);
});

test('匹配成功通知：匹配页自己处理；已在这局的对局页不提示；非法数据忽略；与好友房通知互不影响', () => {
  assert.equal(setupGame([{ route: 'pages/match/match' }]).n.onMatchFound({ gameId: 'rank00000001' }), false);
  assert.equal(setupGame([{ route: 'pages/play/play', options: { id: 'rank00000001' } }]).n.onMatchFound({ gameId: 'rank00000001' }), false);
  // 好友房页上收到 match.found（不会同时发生，但不应被当成好友房自己处理）
  assert.equal(setupGame([{ route: 'pages/room/room' }]).n.onMatchFound({ gameId: 'rank00000001' }), true);
  // 匹配页上收到好友房开局：照样提示
  assert.equal(setupGame([{ route: 'pages/match/match' }]).n.onGameStart({ gameId: 'friend000001', mode: 'friend' }), true);
  const { wx, n } = setupGame([]);
  assert.equal(n.onMatchFound(null), false);
  assert.equal(n.onMatchFound({ gameId: '../x' }), false);
  assert.equal(n.onGameStart({ gameId: 'rank00000001', mode: 'ranked' }), false);
  assert.equal(wx.count('showModal'), 0);
});
