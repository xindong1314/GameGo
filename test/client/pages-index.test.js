'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./pages-harness');

function quiet(t) {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
}

const HELLO = {
  activeGames: [{ id: 'ranked000001', mode: 'ranked' }],
  room: null,
  matching: null,
};

function setup(t, opts = {}) {
  quiet(t);
  const env = h.createEnv(opts);
  env.socket.respond('hello', () => opts.hello || { activeGames: [], room: null, matching: null });
  const page = h.loadPage('index/index', env);
  return { env, page };
}

test('首页：显示用户、连接 socket、用 hello 显示进行中的对局', async (t) => {
  const { env, page } = setup(t, { hello: HELLO });
  page.onLoad({});
  page.onShow();
  assert.equal(page.data.loginState, 'loading');
  await h.flush();
  assert.equal(page.data.loginState, 'ok');
  assert.deepEqual(page.data.user, { id: 1, nickname: '小明', avatarUrl: '' });
  assert.equal(env.socket.connectCalls, 1);
  assert.equal(env.socket.sent('hello').length, 1);
  assert.equal(page.data.banners.length, 1);
  assert.equal(page.data.banners[0].url, '/pages/play/play?id=ranked000001');
  assert.equal(page.data.offline, false);

  page.onBannerTap({ currentTarget: { dataset: { url: page.data.banners[0].url } } });
  await h.flush();
  assert.equal(env.wx.last('navigateTo').url, '/pages/play/play?id=ranked000001');
});

test('首页：重连后的 ready 事件刷新提示；隐藏后不再响应', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({});
  page.onShow();
  await h.flush();
  assert.equal(page.data.banners.length, 0);
  assert.equal(env.socket.listenerCount('ready'), 1);
  env.socket.emit('ready', { activeGames: [], room: { code: '123456', status: 'waiting' }, matching: null });
  assert.equal(page.data.banners[0].kind, 'room');
  page.onHide();
  assert.equal(env.socket.listenerCount('ready'), 0);
  env.socket.emit('ready', { activeGames: [], room: null, matching: null });
  assert.equal(page.data.banners.length, 1, '隐藏时不更新');
  page.onShow();
  assert.equal(env.socket.listenerCount('ready'), 1, '再次显示时重新订阅，且不重复');
  page.onUnload();
  assert.equal(env.socket.listenerCount('ready'), 0);
});

test('首页：收到开局推送（match.found / game.start）时刷新进行中的横幅；隐藏后不响应', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({});
  page.onShow();
  page.onShow(); // 重复 onShow 不重复订阅
  await h.flush();
  assert.equal(env.socket.listenerCount('match.found'), 1);
  assert.equal(env.socket.listenerCount('game.start'), 1);
  assert.equal(page.data.banners.length, 0);
  env.socket.respond('hello', () => HELLO);
  const before = env.socket.sent('hello').length;
  env.socket.emit('match.found', { t: 'match.found', gameId: 'ranked000001' });
  await h.flush();
  assert.equal(env.socket.sent('hello').length, before + 1);
  assert.equal(page.data.banners[0].url, '/pages/play/play?id=ranked000001');
  env.socket.emit('game.start', { t: 'game.start', gameId: 'friend000001', mode: 'friend' });
  await h.flush();
  assert.equal(env.socket.sent('hello').length, before + 2);
  page.onHide();
  assert.equal(env.socket.listenerCount('match.found'), 0);
  assert.equal(env.socket.listenerCount('game.start'), 0);
  page.onShow();
  page.onUnload();
  assert.equal(env.socket.totalListeners(), 0);
});

test('首页：离线时提示，重连 ready 后恢复', async (t) => {
  const { env, page } = setup(t);
  env.socket.respond('hello', () => {
    throw { code: 'offline', msg: 'offline' };
  });
  page.onLoad({});
  page.onShow();
  await h.flush();
  assert.equal(page.data.offline, true);
  env.socket.emit('ready', { activeGames: [], room: null, matching: null });
  assert.equal(page.data.offline, false);
});

test('首页：登录失败显示重试，点击后重新登录', async (t) => {
  const { env, page } = setup(t, { loginError: { code: 'network' } });
  page.onLoad({});
  page.onShow();
  await h.flush();
  assert.equal(page.data.loginState, 'error');
  env.auth.loginError = null;
  page.onUserTap();
  await h.flush();
  assert.equal(page.data.loginState, 'ok');
  assert.equal(env.wx.count('navigateTo'), 0, '重试时不跳转');
});

test('首页：点击头像——有昵称去"我的"，没有昵称去资料页', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({});
  page.onShow();
  await h.flush();
  page.onUserTap();
  await h.flush();
  assert.equal(env.wx.last('navigateTo').url, '/pages/me/me');

  const s2 = setup(t, { user: { id: 2, nickname: '' } });
  s2.page.onLoad({});
  s2.page.onShow();
  await h.flush();
  s2.page.onUserTap();
  await h.flush();
  assert.equal(s2.env.wx.last('navigateTo').url, '/pages/profile/profile');
});

test('首页：快速匹配带上所选路数，并记住选择', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({});
  page.onPickMatchSize({ currentTarget: { dataset: { size: 13 } } });
  assert.equal(page.data.matchSize, 13);
  assert.equal(env.wx.storage['home.matchSize'], 13);
  page.onQuickMatch();
  page.onQuickMatch(); // 连点只跳一次
  await h.flush();
  assert.equal(env.wx.count('navigateTo'), 1);
  assert.equal(env.wx.last('navigateTo').url, '/pages/match/match?size=13');

  // 重新进入首页时恢复
  const page2 = h.loadPage('index/index', env);
  page2.onLoad({});
  assert.equal(page2.data.matchSize, 13);
});

test('首页：未设置昵称时联网入口先去资料页（带 redirect），本地对弈不受限', async (t) => {
  const { env, page } = setup(t, { user: { id: 1, nickname: '' } });
  page.onLoad({});
  page.onQuickMatch();
  await h.flush();
  assert.equal(env.wx.last('navigateTo').url,
    '/pages/profile/profile?redirect=' + encodeURIComponent('/pages/match/match?size=19'));
  page.onAi();
  await h.flush();
  assert.equal(env.wx.last('navigateTo').url, '/pages/profile/profile?redirect=' + encodeURIComponent('/pages/ai/ai'));
  page.onLeaderboard();
  await h.flush();
  assert.equal(env.wx.last('navigateTo').url,
    '/pages/profile/profile?redirect=' + encodeURIComponent('/pages/leaderboard/leaderboard'));
  page.onLocal();
  await h.flush();
  assert.equal(env.wx.last('navigateTo').url, '/pages/local/local');
  page.onMe();
  await h.flush();
  assert.equal(env.wx.last('navigateTo').url, '/pages/me/me');
});

test('首页：登录失败时联网入口不跳转并提示', async (t) => {
  const { env, page } = setup(t, { loginError: { code: 'offline' } });
  page.onLoad({});
  page.onAi();
  await h.flush();
  assert.equal(env.wx.count('navigateTo'), 0);
  assert.deepEqual(env.wx.toasts(), ['网络未连接，请检查网络后重试']);
  // 之后可以再次尝试
  env.auth.loginError = null;
  page.onAi();
  await h.flush();
  assert.equal(env.wx.last('navigateTo').url, '/pages/ai/ai');
});

test('首页：好友对战面板——创建房间与输入房号', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({});
  page.onOpenFriend();
  assert.equal(page.data.panel, true);
  page.onPickRoomSize({ currentTarget: { dataset: { size: '9' } } });
  page.onPickRoomColor({ currentTarget: { dataset: { color: 'white' } } });
  page.onPickRoomColor({ currentTarget: { dataset: { color: 'bogus' } } });
  assert.equal(page.data.roomColor, 'random', '非法颜色回到随机');
  page.onPickRoomColor({ currentTarget: { dataset: { color: 'white' } } });
  page.onCreateRoom();
  assert.equal(page.data.panel, false);
  await h.flush();
  assert.equal(env.wx.last('navigateTo').url, '/pages/room/room?create=1&size=9&color=white');
  assert.deepEqual(env.wx.storage['home.room'], { size: 9, color: 'white' });

  page.onOpenFriend();
  page.onEnterCode();
  await h.flush();
  assert.equal(env.wx.last('navigateTo').url, '/pages/room/room');

  page.onOpenFriend();
  page.onClosePanel();
  assert.equal(page.data.panel, false);
  page.noop();

  const page2 = h.loadPage('index/index', env);
  page2.onLoad({});
  assert.equal(page2.data.roomSize, 9);
  assert.equal(page2.data.roomColor, 'white');
});

test('首页：页面打开失败时提示，且可以再次点击', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({});
  env.wx.failNext.navigateTo = true;
  page.onLocal();
  await h.flush();
  assert.deepEqual(env.wx.toasts(), ['页面打开失败']);
  page.onLocal();
  await h.flush();
  assert.equal(env.wx.count('navigateTo'), 2);
});

test('首页：本地存储异常不影响加载；分享回到首页', (t) => {
  const { env, page } = setup(t);
  env.wx.getStorageSync = () => {
    throw new Error('storage broken');
  };
  env.wx.setStorageSync = () => {
    throw new Error('storage broken');
  };
  page.onLoad({});
  assert.equal(page.data.matchSize, 19);
  page.onPickMatchSize({ currentTarget: { dataset: { size: 9 } } });
  assert.equal(page.data.matchSize, 9);
  assert.deepEqual(page.onShareAppMessage(), { title: '来下一盘围棋吧', path: '/pages/index/index' });
});

test('首页：被顶号后回到首页不自动重连（不去顶另一台设备），点击提示条才在本机重新连接', async (t) => {
  const { env, page } = setup(t, { hello: HELLO });
  let kicked = true;
  env.socket.isKicked = () => kicked;
  const connect = env.socket.connect;
  env.socket.connect = () => {
    kicked = false;
    return connect();
  };
  page.onLoad({});
  page.onShow();
  await h.flush();
  assert.equal(env.socket.connectCalls, 0, '不自动连接');
  assert.equal(env.socket.sent('hello').length, 0);
  assert.equal(page.data.kicked, true);
  assert.deepEqual(page.data.banners, []);
  assert.equal(page.data.offline, false);
  // 再次显示也不连
  page.onHide();
  page.onShow();
  await h.flush();
  assert.equal(env.socket.connectCalls, 0);
  // 用户点击：在本机重新连接
  page.onReconnect();
  await h.flush();
  assert.equal(page.data.kicked, false);
  assert.ok(env.socket.connectCalls >= 1);
  assert.equal(page.data.banners.length, 1);
});

test('首页：停留在首页时被顶号 → 显示提示条', async (t) => {
  const { env, page } = setup(t, { hello: HELLO });
  page.onLoad({});
  page.onShow();
  await h.flush();
  assert.equal(page.data.banners.length, 1);
  assert.equal(env.socket.listenerCount('kicked'), 1);
  env.socket.emit('kicked', { t: 'kicked', reason: 'replaced' });
  assert.equal(page.data.kicked, true);
  assert.deepEqual(page.data.banners, []);
  page.onUnload();
  assert.equal(env.socket.listenerCount('kicked'), 0);
});

test('首页：登录失败时显示具体原因（而不是"网络未连接"）', async (t) => {
  const { env, page } = setup(t, { loginError: { code: 'login_unavailable', msg: '服务器未配置微信登录，也未开启开发登录', status: 404 } });
  env.socket.respond('hello', () => {
    throw { code: 'offline' };
  });
  page.onLoad({});
  page.onShow();
  await h.flush();
  assert.equal(page.data.loginState, 'error');
  assert.equal(page.data.loginError, '服务器未配置微信登录，也未开启开发登录');
  const s2 = setup(t, { loginError: { code: 'network', msg: '网络连接失败，请检查网络', detail: 'request:fail' } });
  s2.page.onLoad({});
  s2.page.onShow();
  await h.flush();
  assert.equal(s2.page.data.loginError, '网络异常，请检查网络后重试');
  s2.env.auth.loginError = null;
  s2.page.onUserTap();
  await h.flush();
  assert.equal(s2.page.data.loginState, 'ok');
  assert.equal(s2.page.data.loginError, '');
});
