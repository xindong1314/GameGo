'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuth } = require('../../miniprogram/utils/net/auth');
const { createApi, apiPath } = require('../../miniprogram/utils/net/api');
const { createWxMock, createLogger, ok, httpError } = require('./wx-mock');

const API = 'http://srv:8080';

// 服务端模拟：每次登录发新令牌，只有最新令牌有效
function setup() {
  const mock = createWxMock();
  const logger = createLogger();
  const server = { n: 0, valid: new Set() };
  mock.route('POST /api/auth/login', () => {
    server.n += 1;
    const token = `tok${server.n}`;
    server.valid.add(token);
    return ok({ token, user: { id: 1, nickname: 'Alice', avatarUrl: '' }, needProfile: false });
  });
  const config = { API_BASE: API, WS_URL: 'ws://srv:8080/ws', DEV_LOGIN: false };
  const auth = createAuth({ wx: mock.wx, config, logger });
  const api = createApi({ wx: mock.wx, config, auth, logger });
  const authed = (handler) => (ctx) => {
    if (!server.valid.has(ctx.token)) return httpError(401, 'unauthorized', 'bad token');
    return handler(ctx);
  };
  return { mock, auth, api, server, authed, logger };
}

test('GET：自动登录、带 Bearer 令牌、拼查询串（跳过空值）', async () => {
  const { mock, api, authed } = setup();
  let seen = null;
  mock.route('GET /api/games', authed((ctx) => {
    seen = ctx;
    return ok({ items: [], next: null });
  }));
  const data = await api.request({ method: 'GET', path: '/api/games', data: { before: 123, limit: 20, x: undefined, y: null } });
  assert.deepEqual(data, { items: [], next: null });
  assert.deepEqual(seen.query, { before: '123', limit: '20' });
  assert.equal(seen.header.Authorization, 'Bearer tok1');
  assert.equal(seen.opts.data, undefined);
  assert.equal(seen.opts.timeout, 10000);
});

test('POST / PUT：JSON 请求体；省略 data 时发 {}', async () => {
  const { mock, api, authed } = setup();
  const bodies = [];
  mock.route('PUT /api/me/profile', authed((ctx) => {
    bodies.push(ctx.data);
    return ok({ user: { id: 1, nickname: ctx.data.nickname || '', avatarUrl: '' } });
  }));
  const res = await api.put('/api/me/profile', { nickname: '棋手' });
  assert.equal(res.user.nickname, '棋手');
  await api.request({ method: 'put', path: '/api/me/profile' });
  assert.deepEqual(bodies, [{ nickname: '棋手' }, {}]);
  assert.equal(mock.requestsTo('/api/me/profile')[0].method, 'PUT');
  assert.equal(mock.requestsTo('/api/me/profile')[0].header['content-type'], 'application/json');
});

test('路径可省略 /api 前缀；字符串简写；get 便捷方法', async () => {
  const { mock, api, authed } = setup();
  mock.route('GET /api/me', authed(() => ok({ user: { id: 1 } })));
  assert.deepEqual(await api.request({ path: '/me' }), { user: { id: 1 } });
  assert.deepEqual(await api.request('/api/me'), { user: { id: 1 } });
  mock.route('GET /api/leaderboard', authed((ctx) => ok({ type: ctx.query.type })));
  assert.deepEqual(await api.get('/api/leaderboard', { type: 'winrate', limit: 50 }), { type: 'winrate' });
  assert.equal(apiPath('/me'), '/api/me');
  assert.equal(apiPath('/api/me'), '/api/me');
  assert.equal(apiPath('/api'), '/api');
  assert.equal(apiPath('/healthz'), '/healthz');
  assert.equal(apiPath('/avatars/a.png'), '/avatars/a.png');
  assert.equal(apiPath('/apix'), '/api/apix');
});

test('auth:false 不登录、不带令牌', async () => {
  const { mock, api } = setup();
  mock.route('GET /api/ai/levels', (ctx) => ok({ available: true, levels: [], auth: ctx.header.Authorization || null }));
  const res = await api.request({ path: '/api/ai/levels', auth: false });
  assert.equal(res.auth, null);
  assert.equal(mock.loginCount, 0);
});

test('401：清令牌 → 重新登录 → 用新令牌重试一次', async () => {
  const { mock, api, auth, server, authed } = setup();
  mock.route('GET /api/me', authed((ctx) => ok({ token: ctx.token })));
  await api.request({ path: '/api/me' });
  assert.equal(auth.getToken(), 'tok1');
  server.valid.clear(); // 令牌过期
  const res = await api.request({ path: '/api/me' });
  assert.equal(res.token, 'tok2');
  assert.equal(auth.getToken(), 'tok2');
  assert.equal(mock.loginCount, 2);
  assert.equal(mock.requestsTo('/api/me').length, 3);
});

test('401 两次：只重试一次，reject unauthorized', async () => {
  const { mock, api } = setup();
  mock.route('GET /api/me', () => httpError(401, 'unauthorized', 'nope'));
  await assert.rejects(api.request({ path: '/api/me' }), { code: 'unauthorized', msg: 'nope', status: 401 });
  assert.equal(mock.requestsTo('/api/me').length, 2);
  assert.equal(mock.loginCount, 2);
});

test('并发的 401 只会重新登录一次', async () => {
  const { mock, api, server, authed } = setup();
  mock.route('GET /api/me', authed((ctx) => ok({ token: ctx.token })));
  await api.request({ path: '/api/me' });
  server.valid.clear();
  const [a, b] = await Promise.all([api.request({ path: '/api/me' }), api.request({ path: '/api/me' })]);
  assert.equal(a.token, 'tok2');
  assert.equal(b.token, 'tok2');
  assert.equal(mock.loginCount, 2);
});

test('错误映射：服务端错误体、无错误体、HTML、网络失败、超时、非 JSON 成功响应', async () => {
  const { mock, api, authed } = setup();
  mock.route('GET /api/a', authed(() => httpError(400, 'bad_request', '昵称太长')));
  await assert.rejects(api.request({ path: '/api/a' }), { code: 'bad_request', msg: '昵称太长', status: 400 });

  mock.route('GET /api/b', authed(() => ({ statusCode: 502, data: '<html>Bad Gateway</html>' })));
  await assert.rejects(api.request({ path: '/api/b' }), { code: 'http_502', msg: '服务器繁忙，请稍后再试', status: 502 });

  mock.route('GET /api/c', authed(() => ({ statusCode: 404, data: {} })));
  await assert.rejects(api.request({ path: '/api/c' }), { code: 'http_404', status: 404 });

  mock.route('GET /api/d', authed(() => ({ fail: 'net::ERR_CONNECTION_REFUSED' })));
  await assert.rejects(api.request({ path: '/api/d' }), { code: 'network', status: 0 });

  mock.route('GET /api/e', authed(() => ({ fail: 'timeout' })));
  await assert.rejects(api.request({ path: '/api/e' }), { code: 'timeout', status: 0 });

  mock.route('GET /api/f', authed(() => ok('not json')));
  await assert.rejects(api.request({ path: '/api/f' }), { code: 'bad_response', status: 200 });

  // 已是字符串的 JSON 也能解析
  mock.route('GET /api/g', authed(() => ok('{"x":1}')));
  assert.deepEqual(await api.request({ path: '/api/g' }), { x: 1 });
});

test('登录失败时 request reject 登录错误', async () => {
  const { mock, api } = setup();
  mock.route('POST /api/auth/login', () => ({ fail: 'down' }));
  await assert.rejects(api.request({ path: '/api/me' }), { code: 'network' });
});

test('参数校验', async () => {
  const { api } = setup();
  await assert.rejects(api.request(null), { code: 'bad_request' });
  await assert.rejects(api.request({ method: 'FOO', path: '/api/me' }), { code: 'bad_request' });
  await assert.rejects(api.request({ path: 'api/me' }), { code: 'bad_request' });
  await assert.rejects(api.request({ path: '/api/me', data: [1] }), { code: 'bad_request' });
  assert.throws(() => createApi({ wx: {}, config: {} }), TypeError);
});

test('uploadAvatar：wx.uploadFile 字段名 file，带令牌，解析字符串响应并更新本地用户', async () => {
  const { mock, api, auth, authed } = setup();
  let seen = null;
  mock.route('UPLOAD /api/me/avatar', authed((ctx) => {
    seen = ctx.opts;
    return ok({ user: { id: 1, nickname: 'Alice', avatarUrl: `${API}/avatars/abc.png` } });
  }));
  const res = await api.uploadAvatar('wxfile://tmp_1.png');
  assert.equal(res.user.avatarUrl, `${API}/avatars/abc.png`);
  assert.equal(seen.name, 'file');
  assert.equal(seen.filePath, 'wxfile://tmp_1.png');
  assert.equal(seen.url, `${API}/api/me/avatar`);
  assert.equal(seen.header.Authorization, 'Bearer tok1');
  assert.equal(seen.header['content-type'], undefined); // multipart 由 wx 自己设置
  assert.equal(auth.getUser().avatarUrl, `${API}/avatars/abc.png`);
});

test('uploadAvatar：401 重试一次；错误映射；响应格式错误；参数校验', async () => {
  const { mock, api, server, authed } = setup();
  let calls = 0;
  mock.route('UPLOAD /api/me/avatar', authed(() => {
    calls += 1;
    return ok({ user: { id: 1, nickname: 'A', avatarUrl: 'u' } });
  }));
  await api.uploadAvatar('a.png');
  server.valid.clear();
  await api.uploadAvatar('a.png');
  assert.equal(calls, 2);
  assert.equal(mock.uploads.length, 3);

  mock.route('UPLOAD /api/me/avatar', authed(() => httpError(413, 'too_large', '图片不能超过 2MB')));
  await assert.rejects(api.uploadAvatar('a.png'), { code: 'too_large', msg: '图片不能超过 2MB', status: 413 });

  mock.route('UPLOAD /api/me/avatar', authed(() => ({ statusCode: 200, data: 'oops' })));
  await assert.rejects(api.uploadAvatar('a.png'), { code: 'bad_response' });

  mock.route('UPLOAD /api/me/avatar', authed(() => ok({ nothing: true })));
  await assert.rejects(api.uploadAvatar('a.png'), { code: 'bad_response' });

  mock.route('UPLOAD /api/me/avatar', authed(() => ({ fail: 'net' })));
  await assert.rejects(api.uploadAvatar('a.png'), { code: 'network' });

  await assert.rejects(api.uploadAvatar(''), { code: 'bad_request' });
  await assert.rejects(api.uploadAvatar(null), { code: 'bad_request' });
});

test('默认单例导出与解构', () => {
  const api = require('../../miniprogram/utils/net/api');
  const { request, uploadAvatar } = api;
  assert.equal(typeof request, 'function');
  assert.equal(typeof uploadAvatar, 'function');
  assert.equal(typeof api.createApi, 'function');
});
