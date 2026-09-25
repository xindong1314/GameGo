'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuth, SESSION_KEY, DEVICE_KEY } = require('../../miniprogram/utils/net/auth');
const { createWxMock, createLogger, flush, ok, httpError } = require('./wx-mock');

const API = 'http://srv:8080';

function setup({ devLogin = true, wxConfigured = true, devEnabled = true } = {}) {
  const mock = createWxMock();
  const logger = createLogger();
  const state = { n: 0, devIds: [] };
  mock.route('POST /api/auth/login', (ctx) => {
    if (!wxConfigured) return httpError(503, 'wx_not_configured');
    assert.match(ctx.data.code, /^code\d+$/);
    state.n += 1;
    return ok({ token: `tok${state.n}`, user: { id: 1, nickname: 'Alice', avatarUrl: '' }, needProfile: false });
  });
  mock.route('POST /api/auth/dev-login', (ctx) => {
    if (!devEnabled) return httpError(404, 'not_found', 'Not Found');
    state.devIds.push(ctx.data.deviceId);
    state.n += 1;
    return ok({ token: `dev${state.n}`, user: { id: 2, nickname: '', avatarUrl: '' }, needProfile: true });
  });
  const config = { API_BASE: `${API}/`, WS_URL: 'ws://srv:8080/ws', DEV_LOGIN: devLogin };
  const auth = createAuth({ wx: mock.wx, config, logger });
  return { mock, auth, logger, state, config };
}

test('首次登录：wx.login → POST /api/auth/login，令牌与用户写入本地存储', async () => {
  const { mock, auth } = setup();
  assert.equal(auth.getToken(), '');
  assert.equal(auth.getUser(), null);
  assert.equal(auth.needProfile(), true);

  const user = await auth.ensureLogin();
  assert.deepEqual(user, { id: 1, nickname: 'Alice', avatarUrl: '' });
  assert.equal(auth.getToken(), 'tok1');
  assert.equal(auth.needProfile(), false);
  assert.equal(mock.loginCount, 1);
  const req = mock.requests[0];
  assert.equal(req.url, `${API}/api/auth/login`); // API_BASE 末尾的 / 被去掉
  assert.equal(req.method, 'POST');
  assert.equal(req.header['content-type'], 'application/json');
  assert.deepEqual(mock.storage.get(SESSION_KEY), { token: 'tok1', user });
});

test('并发调用只登录一次', async () => {
  const { mock, auth } = setup();
  const results = await Promise.all([auth.ensureLogin(), auth.ensureLogin(), auth.ensureLogin()]);
  assert.equal(mock.loginCount, 1);
  assert.equal(mock.requests.length, 1);
  assert.ok(results.every((u) => u.id === 1));
});

test('已有令牌直接返回，不发请求；新实例从本地存储恢复', async () => {
  const { mock, auth, config } = setup();
  await auth.ensureLogin();
  await auth.ensureLogin();
  assert.equal(mock.requests.length, 1);

  const again = createAuth({ wx: mock.wx, config, logger: createLogger() });
  assert.equal(again.getToken(), 'tok1');
  const user = await again.ensureLogin();
  assert.equal(user.nickname, 'Alice');
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.loginCount, 1);
});

test('本地存储里格式不对的会话被忽略并重新登录', async () => {
  const { mock, auth, logger } = setup();
  mock.storage.set(SESSION_KEY, { token: 'x' }); // 缺 user
  const user = await auth.ensureLogin();
  assert.equal(user.id, 1);
  assert.equal(auth.getToken(), 'tok1');
  assert.equal(logger.count('warn'), 1);
});

test('503 wx_not_configured 且 DEV_LOGIN：改走开发登录，deviceId 只生成一次', async () => {
  const { mock, auth, state, config } = setup({ wxConfigured: false });
  const user = await auth.ensureLogin();
  assert.equal(user.id, 2);
  assert.equal(auth.getToken(), 'dev1');
  assert.equal(auth.needProfile(), true);
  assert.equal(state.devIds.length, 1);
  const id = state.devIds[0];
  assert.match(id, /^[a-z0-9]{24}$/);
  assert.equal(mock.storage.get(DEVICE_KEY), id);
  assert.equal(auth.getDeviceId(), id);

  // clear 不删 deviceId；再次登录用同一个
  auth.clear();
  assert.equal(auth.getToken(), '');
  assert.equal(mock.storage.has(SESSION_KEY), false);
  await auth.ensureLogin();
  assert.equal(state.devIds[1], id);

  // 新实例（模拟重启）也用同一个
  const again = createAuth({ wx: mock.wx, config, logger: createLogger() });
  assert.equal(again.getDeviceId(), id);
});

test('本地存储里非法的 deviceId 会被替换', () => {
  const { mock, auth } = setup();
  mock.storage.set(DEVICE_KEY, 'BAD ID!');
  const id = auth.getDeviceId();
  assert.match(id, /^[a-z0-9]{24}$/);
  assert.equal(mock.storage.get(DEVICE_KEY), id);
});

test('503 wx_not_configured 但未开 DEV_LOGIN：reject 原错误', async () => {
  const { auth, mock } = setup({ wxConfigured: false, devLogin: false });
  await assert.rejects(auth.ensureLogin(), { code: 'wx_not_configured', status: 503 });
  assert.equal(mock.requestsTo('/api/auth/dev-login').length, 0);
  assert.equal(auth.getToken(), '');
});

test('wx.login 失败：DEV_LOGIN 时走开发登录，否则 reject wx_login_failed', async () => {
  const a = setup();
  a.mock.loginImpl = () => ({ errMsg: 'login:fail mocked' });
  const user = await a.auth.ensureLogin();
  assert.equal(user.id, 2);
  assert.equal(a.mock.requestsTo('/api/auth/login').length, 0);

  const b = setup({ devLogin: false });
  b.mock.loginImpl = () => ({ errMsg: 'login:fail mocked' });
  await assert.rejects(b.auth.ensureLogin(), { code: 'wx_login_failed' });

  const c = setup({ devLogin: false });
  c.mock.loginImpl = () => ({}); // 没有 code
  await assert.rejects(c.auth.ensureLogin(), { code: 'wx_login_failed' });
});

test('开发登录接口不存在（404）→ login_unavailable', async () => {
  const { auth } = setup({ wxConfigured: false, devEnabled: false });
  await assert.rejects(auth.ensureLogin(), { code: 'login_unavailable', status: 404 });
});

test('其他服务端错误原样 reject（如 502 wx_login_failed），不走开发登录', async () => {
  const { auth, mock } = setup();
  mock.route('POST /api/auth/login', () => httpError(502, 'wx_login_failed', '微信接口失败'));
  await assert.rejects(auth.ensureLogin(), { code: 'wx_login_failed', msg: '微信接口失败', status: 502 });
  assert.equal(mock.requestsTo('/api/auth/dev-login').length, 0);
});

test('失败后下一次调用会重新登录（不缓存失败）', async () => {
  const { auth, mock } = setup();
  mock.route('POST /api/auth/login', () => ({ fail: 'net down' }));
  await assert.rejects(auth.ensureLogin(), { code: 'network', status: 0 });
  mock.route('POST /api/auth/login', () => ok({ token: 't2', user: { id: 9, nickname: 'B', avatarUrl: '' } }));
  const user = await auth.ensureLogin();
  assert.equal(user.id, 9);
  assert.equal(mock.loginCount, 2);
});

test('登录响应缺字段 → bad_response，不保存', async () => {
  const { auth, mock } = setup();
  mock.route('POST /api/auth/login', () => ok({ token: '', user: { id: 1 } }));
  await assert.rejects(auth.ensureLogin(), { code: 'bad_response' });
  mock.route('POST /api/auth/login', () => ok({ token: 't', user: null }));
  await assert.rejects(auth.ensureLogin(), { code: 'bad_response' });
  mock.route('POST /api/auth/login', () => ok('<html>'));
  await assert.rejects(auth.ensureLogin(), { code: 'bad_response' });
  assert.equal(mock.storage.has(SESSION_KEY), false);
});

test('请求超时映射为 timeout', async () => {
  const { auth, mock } = setup();
  mock.route('POST /api/auth/login', () => ({ fail: 'timeout' }));
  await assert.rejects(auth.ensureLogin(), { code: 'timeout', status: 0 });
});

test('setUser 更新缓存与 needProfile；未登录时抛错；参数校验', async () => {
  const { auth, mock } = setup({ wxConfigured: false });
  assert.throws(() => auth.setUser({ id: 2, nickname: 'x' }), /尚未登录/);
  await auth.ensureLogin();
  assert.equal(auth.needProfile(), true);
  auth.setUser({ id: 2, nickname: '新名字', avatarUrl: 'http://a/b.png' });
  assert.equal(auth.needProfile(), false);
  assert.equal(auth.getUser().nickname, '新名字');
  assert.equal(mock.storage.get(SESSION_KEY).user.nickname, '新名字');
  assert.equal(mock.storage.get(SESSION_KEY).token, 'dev1');
  assert.throws(() => auth.setUser(null), TypeError);
  assert.throws(() => auth.setUser({ nickname: 'x' }), TypeError);
  auth.setUser({ id: 2, nickname: '   ', avatarUrl: '' });
  assert.equal(auth.needProfile(), true);
});

test('invalidate 只清除匹配的令牌', async () => {
  const { auth } = setup();
  await auth.ensureLogin();
  assert.equal(auth.invalidate('other'), false);
  assert.equal(auth.getToken(), 'tok1');
  assert.equal(auth.invalidate(''), false);
  assert.equal(auth.invalidate('tok1'), true);
  assert.equal(auth.getToken(), '');
  assert.equal(auth.invalidate('tok1'), false);
});

test('本地存储不可用时仍能在内存里工作，并记录错误', async () => {
  const { auth, mock, logger } = setup();
  mock.storageThrows = true;
  const user = await auth.ensureLogin();
  assert.equal(user.id, 1);
  assert.equal(auth.getToken(), 'tok1');
  assert.ok(logger.count('error') >= 1);
  assert.ok(logger.count('warn') >= 1);
  await auth.ensureLogin();
  assert.equal(mock.loginCount, 1);
});

test('默认单例可以在 Node 里 require（不立即访问 wx）', async () => {
  const auth = require('../../miniprogram/utils/net/auth');
  assert.equal(typeof auth.ensureLogin, 'function');
  const { ensureLogin, getUser } = auth; // 解构使用也可以
  assert.equal(typeof ensureLogin, 'function');
  assert.equal(typeof getUser, 'function');
  await flush();
});
