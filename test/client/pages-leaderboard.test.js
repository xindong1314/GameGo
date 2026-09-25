'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./pages-harness');

const BOARDS = {
  streak: {
    type: 'streak',
    items: [
      { rank: 1, userId: 5, nickname: '甲', avatarUrl: '', value: 7, games: 30, wins: 20 },
      { rank: 2, userId: 1, nickname: '小明', avatarUrl: '', value: 3, games: 12, wins: 8 },
    ],
    me: { rank: 2, value: 3, games: 12, wins: 8, need: 0 },
    minGames: 10,
  },
  maxStreak: { type: 'maxStreak', items: [], me: { rank: null, value: 0, games: 0, wins: 0, need: 0 }, minGames: 10 },
  winrate: {
    type: 'winrate',
    items: [{ rank: 1, userId: 5, nickname: '甲', avatarUrl: '', value: 0.667, games: 30, wins: 20 }],
    me: { rank: null, value: 0.667, games: 6, wins: 4, need: 4 },
    minGames: 10,
  },
};

function typeOf(opts) {
  return /type=(\w+)/.exec(opts.path)[1];
}

function setup(t) {
  t.mock.method(console, 'warn', () => {});
  const env = h.createEnv();
  env.api.route('GET /api/leaderboard', (o) => BOARDS[typeOf(o)]);
  const page = h.loadPage('leaderboard/leaderboard', env);
  return { env, page };
}

test('排行榜：默认当前连胜榜，标出自己，底部显示我的名次', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({});
  assert.equal(page.data.state, 'loading');
  await h.flush();
  assert.equal(env.api.calls[0].path, '/api/leaderboard?type=streak&limit=50');
  assert.equal(page.data.state, 'ok');
  assert.equal(page.data.rows.length, 2);
  assert.equal(page.data.rows[0].medal, 'gold');
  assert.equal(page.data.rows[1].isMe, true);
  assert.equal(page.data.rows[0].valueText, '7 连胜');
  assert.equal(page.data.mine.rankText, '第 2 名');
  assert.match(page.data.hint, /只统计排位赛/);
});

test('排行榜：切换标签，已加载的榜用缓存', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({});
  await h.flush();
  page.onTab({ currentTarget: { dataset: { type: 'winrate' } } });
  assert.equal(page.data.type, 'winrate');
  assert.equal(page.data.state, 'loading');
  await h.flush();
  assert.equal(page.data.rows[0].valueText, '66.7%');
  assert.equal(page.data.rows[0].subText, '20 胜 / 30 局');
  assert.equal(page.data.mine.rankText, '未上榜');
  assert.equal(page.data.mine.note, '再下 4 局排位即可上榜');
  assert.match(page.data.hint, /至少 10 局/);
  page.onTab({ currentTarget: { dataset: { type: 'streak' } } });
  assert.equal(page.data.state, 'ok');
  assert.equal(page.data.rows[0].valueText, '7 连胜');
  assert.equal(env.api.calls.length, 2, '切回时不再请求');
  page.onTab({ currentTarget: { dataset: { type: 'streak' } } });
  page.onTab({ currentTarget: { dataset: { type: 'bogus' } } });
  assert.equal(env.api.calls.length, 2);
});

test('排行榜：空榜', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({ type: 'maxStreak' });
  await h.flush();
  assert.equal(page.data.type, 'maxStreak');
  assert.equal(page.data.state, 'empty');
  assert.match(page.data.mine.note, /还没有排位赛胜局/);
  page.onGoHome();
  assert.equal(env.wx.count('navigateBack'), 1);
});

test('排行榜：先发的请求后返回时不覆盖当前标签', async (t) => {
  const { env, page } = setup(t);
  const slow = h.deferred();
  env.api.route('GET /api/leaderboard', (o) => (typeOf(o) === 'streak' ? slow.promise : BOARDS[typeOf(o)]));
  page.onLoad({});
  await h.flush();
  page.onTab({ currentTarget: { dataset: { type: 'winrate' } } });
  await h.flush();
  assert.equal(page.data.rows[0].valueText, '66.7%');
  slow.resolve(BOARDS.streak);
  await h.flush();
  assert.equal(page.data.type, 'winrate');
  assert.equal(page.data.rows[0].valueText, '66.7%');
  page.onTab({ currentTarget: { dataset: { type: 'streak' } } });
  assert.equal(page.data.rows[0].valueText, '7 连胜', '迟到的结果已缓存');
  assert.equal(env.api.calls.length, 2);
});

test('排行榜：加载失败显示错误，重试成功', async (t) => {
  const { env, page } = setup(t);
  let fail = true;
  env.api.route('GET /api/leaderboard', (o) => {
    if (fail) throw { code: 'internal', msg: 'db' };
    return BOARDS[typeOf(o)];
  });
  page.onLoad({});
  await h.flush();
  assert.equal(page.data.state, 'error');
  assert.equal(page.data.errorText, '服务器开小差了，请稍后再试');
  fail = false;
  page.onRetry();
  await h.flush();
  assert.equal(page.data.state, 'ok');
});

test('排行榜：下拉刷新重新请求；失败时保留旧数据并提示', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({});
  await h.flush();
  page.onPullDownRefresh();
  assert.equal(page.data.state, 'ok', '刷新时不清空列表');
  await h.flush();
  assert.equal(env.api.calls.length, 2);
  assert.equal(env.wx.count('stopPullDownRefresh'), 1);
  env.api.route('GET /api/leaderboard', () => {
    throw { code: 'offline' };
  });
  page.onPullDownRefresh();
  await h.flush();
  assert.equal(page.data.state, 'ok');
  assert.equal(page.data.rows.length, 2);
  assert.deepEqual(env.wx.toasts(), ['网络未连接，请检查网络后重试']);
  assert.equal(env.wx.count('stopPullDownRefresh'), 2);
});

test('排行榜：登录失败也显示错误', async (t) => {
  const { env, page } = setup(t);
  env.auth.loginError = { code: 'wx_login_failed' };
  page.onLoad({});
  await h.flush();
  assert.equal(page.data.state, 'error');
  assert.equal(page.data.errorText, '微信登录失败，请稍后重试');
});
