'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createWxMock, flush, ok } = require('./wx-mock');

const ROOT = path.join(__dirname, '../../miniprogram');

test('config.js 与设计文档 8.1 一致', () => {
  const config = require(path.join(ROOT, 'config.js'));
  assert.deepEqual(Object.keys(config).sort(), ['API_BASE', 'DEV_LOGIN', 'WS_URL']);
  assert.match(config.API_BASE, /^https?:\/\/[^/]+$/);
  assert.match(config.WS_URL, /^wss?:\/\/[^/]+\/ws$/);
  assert.equal(typeof config.DEV_LOGIN, 'boolean');
});

test('app.js：onLaunch 静默登录，失败不抛错', async () => {
  const mock = createWxMock();
  let def = null;
  global.wx = mock.wx;
  global.App = (d) => { def = d; };
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  const socket = require(path.join(ROOT, 'utils/net/socket.js'));
  const origOn = socket.on;
  const subs = [];
  socket.on = (t, fn) => {
    subs.push([t, fn]);
    return () => {};
  };
  try {
    require(path.join(ROOT, 'app.js'));
    assert.deepEqual(def.globalData, {});

    // 登录失败：只记日志
    mock.route('POST /api/auth/login', () => ({ fail: 'down' }));
    def.onLaunch.call(def);
    await flush();
    assert.equal(mock.loginCount, 1);
    assert.equal(warnings.length, 1);

    // 登录成功：令牌写入本地存储
    mock.route('POST /api/auth/login', () => ok({ token: 't1', user: { id: 1, nickname: 'A', avatarUrl: '' } }));
    def.onLaunch.call(def);
    await flush();
    assert.equal(mock.loginCount, 2);
    const auth = require(path.join(ROOT, 'utils/net/auth.js'));
    assert.equal(auth.getToken(), 't1');
    const url = mock.requestsTo('/api/auth/login')[0].url;
    assert.equal(url, `${require(path.join(ROOT, 'config.js')).API_BASE}/api/auth/login`);
    // 开局通知（好友房 game.start、排位 match.found）：各只订阅一次（onLaunch 调了两次）
    assert.deepEqual(subs.map((x) => x[0]), ['game.start', 'match.found']);
    assert.equal(typeof subs[0][1], 'function');
    assert.equal(typeof subs[1][1], 'function');
    // 应用层处理：不在匹配页时收到 match.found → 提示并进入对局
    global.getCurrentPages = () => [{ route: 'pages/ai/ai' }];
    const modals = [];
    const navs = [];
    mock.wx.showModal = (o) => {
      modals.push(o);
      o.success({ confirm: true });
    };
    mock.wx.navigateTo = (o) => navs.push(o.url);
    assert.equal(subs[1][1]({ t: 'match.found', gameId: 'rank00000001' }), true);
    assert.equal(modals[0].title, '匹配成功');
    assert.deepEqual(navs, ['/pages/play/play?id=rank00000001']);
    assert.equal(subs[0][1]({ t: 'game.start', gameId: 'friend000001', mode: 'friend' }), true);
    assert.equal(modals[1].title, '好友已加入');
  } finally {
    socket.on = origOn;
    console.warn = warn;
    delete global.wx;
    delete global.App;
    delete global.getCurrentPages;
  }
});
