'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./pages-harness');

const ME = {
  user: { id: 1, nickname: '小明', avatarUrl: 'http://srv/avatars/a.png' },
  needProfile: false,
  stats: { games: 10, wins: 6, losses: 4, draws: 0, winrate: 0.6, curStreak: 2, maxStreak: 4 },
  ai: { games: 3, wins: 1 },
  activeGameIds: ['live00000001'],
};

function game(i) {
  return {
    id: 'g' + String(i).padStart(11, '0'),
    mode: i % 3 === 0 ? 'ai' : i % 3 === 1 ? 'ranked' : 'friend',
    size: 19,
    myColor: 1,
    opponent: i % 3 === 0 ? { ai: true, level: 'k5', levelName: '5级' } : { id: 2, nickname: '对手' + i, avatarUrl: '' },
    winner: 1,
    reason: 'score',
    resultText: 'B+2.5',
    myResult: 'win',
    moveCount: 100 + i,
    createdAt: 1700000000000 - i * 1000,
    endedAt: 1700000000000 - i * 1000 + 500,
  };
}

// 两页：第一页 g1..g20（next=游标），第二页 g20..g25（含一个重复）
function pages(before) {
  if (!before) return { items: Array.from({ length: 20 }, (_, k) => game(k + 1)), next: 1699999980000 };
  return { items: Array.from({ length: 6 }, (_, k) => game(k + 20)), next: null };
}

function setup(t, opts = {}) {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const env = h.createEnv();
  env.api.route('GET /api/me', () => opts.me || ME);
  env.api.route('GET /api/games', (o) => {
    const m = /before=(\d+)/.exec(o.path);
    return (opts.pages || pages)(m ? Number(m[1]) : null);
  });
  const page = h.loadPage('me/me', env);
  return { env, page };
}

test('我的：加载资料、战绩与第一页对局', async (t) => {
  const { env, page } = setup(t);
  page.onLoad();
  page.onShow();
  await h.flush();
  assert.equal(page.data.state, 'ok');
  assert.equal(page.data.user.nickname, '小明');
  assert.deepEqual(page.data.statCards.map((c) => c.value), ['10', '60%', '2', '4']);
  assert.equal(page.data.statsDetail, '6 胜 4 负');
  assert.equal(page.data.aiText, '共 3 局 · 胜 1 局');
  assert.deepEqual(page.data.activeIds, ['live00000001']);
  assert.equal(env.auth.user.nickname, '小明', '同步到 auth');
  assert.equal(env.api.callsTo('GET /api/games')[0].path, '/api/games?limit=20');
  assert.equal(page.data.listState, 'ok');
  assert.equal(page.data.games.length, 20);
  assert.equal(page.data.games[0].badge, '排位');
  assert.equal(page.data.games[2].opponentName, 'AI · 5级');
  assert.equal(page.data.noMore, false);
});

test('我的：上拉加载更多（before 游标、去重、到底后不再请求）', async (t) => {
  const { env, page } = setup(t);
  page.onLoad();
  await h.flush();
  page.onReachBottom();
  page.onReachBottom(); // 加载中重复触发
  assert.equal(page.data.loadingMore, true);
  await h.flush();
  const calls = env.api.callsTo('GET /api/games');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].path, '/api/games?limit=20&before=1699999980000');
  assert.equal(page.data.games.length, 25, 'g20 重复被去掉');
  assert.equal(page.data.noMore, true);
  assert.equal(page.data.loadingMore, false);
  page.onReachBottom();
  await h.flush();
  assert.equal(env.api.callsTo('GET /api/games').length, 2);
});

test('我的：加载更多失败 → 提示并可点击重试', async (t) => {
  const { env, page } = setup(t);
  let fail = true;
  env.api.route('GET /api/games', (o) => {
    const m = /before=(\d+)/.exec(o.path);
    if (m && fail) throw { code: 'timeout' };
    return pages(m ? Number(m[1]) : null);
  });
  page.onLoad();
  await h.flush();
  page.onReachBottom();
  await h.flush();
  assert.equal(page.data.loadMoreFailed, true);
  assert.equal(page.data.games.length, 20);
  assert.deepEqual(env.wx.toasts(), ['请求超时，请稍后重试']);
  fail = false;
  page.onLoadMore();
  await h.flush();
  assert.equal(page.data.loadMoreFailed, false);
  assert.equal(page.data.games.length, 25);
});

test('我的：下拉刷新重置列表；刷新期间迟到的旧分页被丢弃', async (t) => {
  const { env, page } = setup(t);
  const slow = h.deferred();
  let first = true;
  env.api.route('GET /api/games', (o) => {
    const m = /before=(\d+)/.exec(o.path);
    if (m) return slow.promise;
    if (first) {
      first = false;
      return pages(null);
    }
    return { items: [game(99)], next: null };
  });
  page.onLoad();
  await h.flush();
  page.onReachBottom();
  await h.flush();
  page.onPullDownRefresh();
  await h.flush();
  assert.equal(env.wx.count('stopPullDownRefresh'), 1);
  assert.deepEqual(page.data.games.map((g) => g.id), ['g00000000099']);
  assert.equal(page.data.noMore, true);
  slow.resolve(pages(1));
  await h.flush();
  assert.deepEqual(page.data.games.map((g) => g.id), ['g00000000099'], '旧的分页结果不再合并');
  assert.equal(env.api.callsTo('GET /api/me').length, 2);
});

test('我的：空列表与列表加载失败', async (t) => {
  const { page } = setup(t, { pages: () => ({ items: [], next: null }) });
  page.onLoad();
  await h.flush();
  assert.equal(page.data.listState, 'empty');

  let fail = true;
  const s2 = setup(t, {
    pages: (before) => {
      if (fail) throw { code: 'internal' };
      return pages(before);
    },
  });
  s2.page.onLoad();
  await h.flush();
  assert.equal(s2.page.data.listState, 'error');
  assert.equal(s2.page.data.listError, '服务器开小差了，请稍后再试');
  fail = false;
  s2.page.onRetryGames();
  await h.flush();
  assert.equal(s2.page.data.listState, 'ok');
});

test('我的：资料加载失败显示错误；再次显示页面时静默刷新', async (t) => {
  const { env, page } = setup(t);
  let fail = true;
  env.api.route('GET /api/me', () => {
    if (fail) throw { code: 'offline' };
    return ME;
  });
  page.onLoad();
  page.onShow();
  await h.flush();
  assert.equal(page.data.state, 'error');
  assert.equal(page.data.errorText, '网络未连接，请检查网络后重试');
  fail = false;
  page.onRetryMe();
  await h.flush();
  assert.equal(page.data.state, 'ok');
  // 从资料页改完昵称回来
  env.api.route('GET /api/me', () => ({ ...ME, user: { ...ME.user, nickname: '新名字' } }));
  page.onShow();
  await h.flush();
  assert.equal(page.data.user.nickname, '新名字');
  // 静默刷新失败：保留旧数据，只提示
  env.api.route('GET /api/me', () => {
    throw { code: 'offline' };
  });
  page.onShow();
  await h.flush();
  assert.equal(page.data.state, 'ok');
  assert.equal(page.data.user.nickname, '新名字');
  assert.deepEqual(env.wx.toasts(), ['网络未连接，请检查网络后重试']);
});

test('我的：未设置昵称时提示去设置', async (t) => {
  const { page } = setup(t, { me: { ...ME, user: { id: 1, nickname: '', avatarUrl: '' }, needProfile: true } });
  page.onLoad();
  await h.flush();
  assert.equal(page.data.needProfile, true);
});

test('我的：导航到资料、复盘、进行中的对局', async (t) => {
  const { env, page } = setup(t);
  page.onLoad();
  await h.flush();
  page.onEditProfile();
  assert.equal(env.wx.last('navigateTo').url, '/pages/profile/profile');
  page.onGameTap({ currentTarget: { dataset: { id: 'g00000000001' } } });
  assert.equal(env.wx.last('navigateTo').url, '/pages/replay/replay?id=g00000000001');
  page.onGameTap({ currentTarget: { dataset: { id: undefined } } });
  assert.equal(env.wx.count('navigateTo'), 2);
  page.onActiveTap({ currentTarget: { dataset: { id: 'live00000001' } } });
  assert.equal(env.wx.last('navigateTo').url, '/pages/play/play?id=live00000001');
  env.wx.failNext.navigateTo = true;
  page.onGameTap({ currentTarget: { dataset: { id: 'g00000000002' } } });
  assert.deepEqual(env.wx.toasts(), ['打开复盘失败']);
});

test('我的：本地 setUser 抛错不影响显示', async (t) => {
  const { env, page } = setup(t);
  env.auth.setUser = () => {
    throw new TypeError('bad user');
  };
  page.onLoad();
  await h.flush();
  assert.equal(page.data.state, 'ok');
  assert.equal(page.data.user.nickname, '小明');
});

test('我的：从对局页返回时，新结束的对局补到列表顶部；已加载的分页保持不变', async (t) => {
  let extra = [];
  const { env, page } = setup(t, {
    pages: (before) => {
      if (!before) return { items: extra.concat(Array.from({ length: 20 }, (_, k) => game(k + 1))).slice(0, 20), next: 1699999980000 };
      return { items: Array.from({ length: 6 }, (_, k) => game(k + 20)), next: null };
    },
  });
  page.onLoad();
  page.onShow();
  await h.flush();
  page.onReachBottom();
  await h.flush();
  assert.equal(page.data.games.length, 25);
  // 点"进行中的对局"去下完，再返回
  const done = { ...game(0), id: 'live00000001', createdAt: 1700000001000 };
  extra = [done];
  env.api.route('GET /api/me', () => ({ ...ME, activeGameIds: [] }));
  page.onShow();
  await h.flush();
  assert.equal(page.data.games.length, 26);
  assert.equal(page.data.games[0].id, 'live00000001');
  assert.equal(page.data.games[25].id, game(25).id, '更早的分页还在');
  assert.deepEqual(page.data.activeIds, []);
  // 没有新对局：不改列表
  const n = page.setDataCalls;
  page.onShow();
  await h.flush();
  assert.equal(page.data.games.length, 26);
  assert.ok(page.setDataCalls - n <= 1, '只有资料的 setData');
});

test('我的：返回时列表还是空的 → 重新加载第一页', async (t) => {
  let items = [];
  const { page } = setup(t, { pages: () => ({ items, next: null }) });
  page.onLoad();
  page.onShow();
  await h.flush();
  assert.equal(page.data.listState, 'empty');
  items = [game(1)];
  page.onShow();
  await h.flush();
  assert.equal(page.data.listState, 'ok');
  assert.equal(page.data.games.length, 1);
});

test('我的：重新登录——先注销当前令牌，再清本地令牌、断开旧连接、重新登录，回到首页', async (t) => {
  const { env, page } = setup(t);
  const order = [];
  env.api.route('POST /api/auth/logout', () => {
    order.push('logout');
    return { ok: true };
  });
  const clear = env.auth.clear;
  env.auth.clear = () => {
    order.push('clear');
    clear();
  };
  const close = env.socket.close;
  env.socket.close = () => {
    order.push('close');
    close();
  };
  page.onLoad();
  page.onShow();
  await h.flush();
  const logins = env.auth.loginCalls;
  page.onRelogin();
  await h.flush();
  assert.equal(env.wx.all('showModal')[0].arg.confirmText, '重新登录');
  assert.deepEqual(order, ['logout', 'clear', 'close']);
  assert.equal(env.auth.loginCalls, logins + 1);
  assert.equal(env.socket.closeCalls, 1);
  assert.equal(env.wx.count('showLoading'), 1);
  assert.equal(env.wx.count('hideLoading'), 1);
  assert.equal(env.wx.last('reLaunch').url, '/pages/index/index');
});

test('我的：重新登录——用户取消不做任何事；注销失败时保留本地令牌并提示', async (t) => {
  const { env, page } = setup(t);
  env.api.route('POST /api/auth/logout', () => {
    throw { code: 'offline', msg: 'offline' };
  });
  page.onLoad();
  page.onShow();
  await h.flush();
  env.wx.modalResponse = { confirm: false, cancel: true };
  page.onRelogin();
  await h.flush();
  assert.equal(env.api.callsTo('POST /api/auth/logout').length, 0);
  env.wx.modalResponse = { confirm: true, cancel: false };
  page.onRelogin();
  await h.flush();
  assert.equal(env.api.callsTo('POST /api/auth/logout').length, 1);
  assert.equal(env.auth.clearCalls, 0);
  assert.equal(env.socket.closeCalls, 0);
  assert.equal(env.wx.count('reLaunch'), 0);
  assert.deepEqual(env.wx.toasts(), ['网络未连接，请检查网络后重试']);
  // 可以再试
  env.api.route('POST /api/auth/logout', () => ({ ok: true }));
  page.onRelogin();
  await h.flush();
  assert.equal(env.auth.clearCalls, 1);
  assert.equal(env.wx.last('reLaunch').url, '/pages/index/index');
});
