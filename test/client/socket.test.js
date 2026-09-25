'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuth } = require('../../miniprogram/utils/net/auth');
const { createApi } = require('../../miniprogram/utils/net/api');
const { createSocket } = require('../../miniprogram/utils/net/socket');
const { createWxMock, createLogger, FakeTimers, flush, ok, httpError } = require('./wx-mock');

const WS = 'ws://srv:8080/ws';

// 服务端模拟：每次登录发新令牌 tokN，server.valid 里的才有效
function setup({ options, withApi = true } = {}) {
  const mock = createWxMock();
  const logger = createLogger();
  const timers = new FakeTimers(0);
  const server = { n: 0, valid: new Set() };
  mock.route('POST /api/auth/login', () => {
    server.n += 1;
    const token = `tok${server.n}`;
    server.valid.add(token);
    return ok({ token, user: { id: 1, nickname: 'Alice', avatarUrl: '' }, needProfile: false });
  });
  mock.route('GET /api/me', (ctx) => (server.valid.has(ctx.token)
    ? ok({ user: { id: 1, nickname: 'Alice', avatarUrl: '' } })
    : httpError(401, 'unauthorized')));
  const config = { API_BASE: 'http://srv:8080', WS_URL: WS, DEV_LOGIN: false };
  const auth = createAuth({ wx: mock.wx, config, logger });
  const api = createApi({ wx: mock.wx, config, auth, logger });
  const socket = createSocket({ wx: mock.wx, config, auth, api: withApi ? api : null, timers, logger, options });
  return { mock, logger, timers, server, auth, api, socket };
}

// 连接并完成 hello，返回 SocketTask
async function openReady(env, data = {}) {
  const p = env.socket.connect();
  await flush();
  const task = env.mock.lastSocket();
  task.serverOpen();
  task.reply(task.sentOf('hello')[0], data);
  await flush();
  await p;
  return task;
}

// 握手时 Authorization 头里的令牌（没有该头时为 null）
function bearer(task) {
  const h = task.options && task.options.header;
  const v = h && h.Authorization;
  if (typeof v !== 'string') return null;
  const m = /^Bearer (.+)$/.exec(v);
  return m ? m[1] : null;
}

// 断言恰好在 ms 毫秒后新建连接，返回新的 SocketTask
async function expectReconnectAfter(env, ms) {
  const before = env.mock.sockets.length;
  await env.timers.tick(ms - 1);
  assert.equal(env.mock.sockets.length, before, `不应在 ${ms - 1}ms 时重连`);
  await env.timers.tick(1);
  assert.equal(env.mock.sockets.length, before + 1, `应在 ${ms}ms 时重连`);
  return env.mock.lastSocket();
}

test('connect：登录后连接（令牌在 Authorization 头里，不进 URL），打开后先发 hello，ready 事件与 connect() 结果为 hello 数据', async () => {
  const env = setup();
  const { socket, mock } = env;
  const statuses = [];
  const readies = [];
  socket.on('status', (s) => statuses.push(s));
  socket.on('ready', (d) => readies.push(d));
  assert.equal(socket.getStatus(), 'closed');

  const p = socket.connect();
  assert.equal(socket.getStatus(), 'connecting');
  await flush();
  assert.equal(mock.sockets.length, 1);
  const task = mock.lastSocket();
  assert.equal(task.url, WS, 'URL 里没有令牌');
  assert.deepEqual(task.options.header, { Authorization: 'Bearer tok1' });
  assert.equal(task.sent.length, 0);

  task.serverOpen();
  assert.equal(socket.getStatus(), 'open');
  assert.equal(socket.isReady(), false);
  assert.equal(task.sent.length, 1);
  const hello = task.sent[0];
  assert.equal(hello.t, 'hello');
  assert.equal(typeof hello.rid, 'number');

  const data = { activeGames: [{ id: 'g1', mode: 'ranked' }], room: null, matching: { size: 19 } };
  task.reply(hello, data);
  await flush();
  assert.deepEqual(await p, data);
  assert.deepEqual(readies, [data]);
  assert.equal(socket.isReady(), true);
  assert.deepEqual(socket.getReadyData(), data);
  assert.deepEqual(statuses, ['connecting', 'open']);

  // 已就绪时 connect() 立即返回，不新建连接
  assert.deepEqual(await socket.connect(), data);
  assert.equal(mock.sockets.length, 1);
});

test('hello 结果规范化：缺字段补默认值', async () => {
  const env = setup();
  let ready = null;
  env.socket.on('ready', (d) => { ready = d; });
  await openReady(env, { activeGames: 'bad', extra: 1 });
  assert.deepEqual(ready, { activeGames: [], room: null, matching: null, extra: 1 });
});

test('WS_URL 原样使用（已带查询串也不拼令牌）；令牌原样放进 Authorization 头', async () => {
  const mock = createWxMock();
  mock.route('POST /api/auth/login', () => ok({ token: 'a/b', user: { id: 1, nickname: 'x' } }));
  const config = { API_BASE: 'http://srv', WS_URL: 'wss://srv/ws?v=2', DEV_LOGIN: false };
  const logger = createLogger();
  const auth = createAuth({ wx: mock.wx, config, logger });
  const socket = createSocket({ wx: mock.wx, config, auth, timers: new FakeTimers(), logger });
  socket.connect();
  await flush();
  assert.equal(mock.lastSocket().url, 'wss://srv/ws?v=2');
  assert.equal(bearer(mock.lastSocket()), 'a/b');
  assert.doesNotMatch(mock.lastSocket().url, /token/);
});

test('重复调用 connect / request 只建一个 SocketTask', async () => {
  const env = setup();
  env.socket.connect();
  env.socket.connect();
  env.socket.request('room.get', { code: '123456' }).catch(() => {});
  await flush();
  env.socket.connect();
  await flush();
  assert.equal(env.mock.sockets.length, 1);
  assert.equal(env.mock.loginCount, 1);
});

test('连接前调用 request：自动连接，hello 之后按顺序发出，按 rid 对应（乱序回应）', async () => {
  const env = setup();
  const p1 = env.socket.request('game.sync', { gameId: 'g1' });
  const p2 = env.socket.request('match.join', { size: 19 });
  const c1 = assert.rejects(p1, { code: 'not_found', msg: 'no game' });
  await flush();
  const task = env.mock.lastSocket();
  task.serverOpen();
  assert.deepEqual(task.sent.map((m) => m.t), ['hello', 'game.sync', 'match.join']);
  const [hello, sync, join] = task.sent;
  assert.equal(sync.gameId, 'g1');
  assert.equal(join.size, 19);
  assert.equal(new Set([hello.rid, sync.rid, join.rid]).size, 3);

  task.reply(join, { size: 19 });
  task.replyError(sync, 'not_found', 'no game');
  task.reply(hello, {});
  await c1;
  assert.deepEqual(await p2, { size: 19 });
});

test('request：已连接时立即发送；params 不能覆盖 t / rid；无 data 时 resolve {}；错误缺字段有默认值', async () => {
  const env = setup();
  const task = await openReady(env);
  const p = env.socket.request('game.pass', { gameId: 'g', n: 3, t: 'evil', rid: 999 });
  const msg = task.lastSent();
  assert.equal(msg.t, 'game.pass');
  assert.notEqual(msg.rid, 999);
  assert.equal(msg.n, 3);
  task.reply(msg);
  assert.deepEqual(await p, {});

  const p2 = env.socket.request('game.resign', { gameId: 'g' });
  task.serverSend({ t: 'res', rid: task.lastSent().rid, ok: false });
  await assert.rejects(p2, { code: 'internal', msg: '请求失败' });

  const p3 = env.socket.request('match.cancel');
  assert.deepEqual(Object.keys(task.lastSent()).sort(), ['rid', 't']);
  task.reply(task.lastSent(), null);
  assert.deepEqual(await p3, {});
});

test('request 参数校验', async () => {
  const env = setup();
  await assert.rejects(env.socket.request(''), { code: 'bad_request' });
  await assert.rejects(env.socket.request(5), { code: 'bad_request' });
  await assert.rejects(env.socket.request('x', [1]), { code: 'bad_request' });
  await assert.rejects(env.socket.request('x', 'str'), { code: 'bad_request' });
  assert.equal(env.mock.sockets.length, 0);
});

test('已发出但超时 → timeout；迟到的回应被忽略', async () => {
  const env = setup();
  const task = await openReady(env);
  const p = env.socket.request('game.move', { gameId: 'g', n: 1, idx: 0 }, { timeout: 5000 });
  const req = task.lastSent('game.move');
  const check = assert.rejects(p, { code: 'timeout' });
  await env.timers.tick(4999);
  await env.timers.tick(1);
  await check;
  task.reply(req, {}); // 不应抛错
  assert.equal(env.socket.getStatus(), 'open');
});

test('一直连不上 → offline（等待超时）', async () => {
  const env = setup();
  const p = env.socket.request('game.sync', { gameId: 'g' }, { timeout: 3000 });
  const check = assert.rejects(p, { code: 'offline' });
  await env.timers.tick(3000);
  await check;
  // 之后连上时不会再发出这个请求
  env.mock.lastSocket().serverOpen();
  assert.deepEqual(env.mock.lastSocket().sent.map((m) => m.t), ['hello']);
});

test('断线：已发出的请求 reject offline，排队的请求在重连后发出', async () => {
  const env = setup();
  const task = await openReady(env);
  const sent = env.socket.request('game.sync', { gameId: 'g' });
  const c1 = assert.rejects(sent, { code: 'offline' });
  task.serverClose(1006);
  await c1;
  assert.equal(env.socket.getStatus(), 'closed');
  assert.equal(env.socket.isReady(), false);

  const queued = env.socket.request('game.sync', { gameId: 'g' }, { timeout: 20000 });
  const t2 = await expectReconnectAfter(env, 1000);
  t2.serverOpen();
  assert.deepEqual(t2.sent.map((m) => m.t), ['hello', 'game.sync']);
  t2.reply(t2.sent[1], { game: { id: 'g' } });
  assert.deepEqual(await queued, { game: { id: 'g' } });
});

test('重连退避：1s、2s、4s、8s、15s、15s；完成 hello 后清零；每次重连都触发 ready', async () => {
  const env = setup();
  let readyCount = 0;
  env.socket.on('ready', () => { readyCount += 1; });
  const first = await openReady(env);
  assert.equal(readyCount, 1);
  first.serverClose(1006);
  let t = await expectReconnectAfter(env, 1000);
  for (const delay of [2000, 4000, 8000, 15000, 15000]) {
    t.serverClose(1006); // 打开前就失败
    t = await expectReconnectAfter(env, delay);
  }
  t.serverOpen();
  t.reply(t.sentOf('hello')[0], {});
  await flush();
  assert.equal(readyCount, 2);
  t.serverClose(1006);
  t = await expectReconnectAfter(env, 1000);
  // 只 open 没完成 hello 不清零
  t.serverOpen();
  t.serverClose(1006);
  await expectReconnectAfter(env, 2000);
});

test('被踢（kicked 消息）：不再重连，未完成请求 reject kicked，之后 request 立即失败；connect() 可主动重连', async () => {
  const env = setup();
  const task = await openReady(env);
  const kicks = [];
  env.socket.on('kicked', (m) => kicks.push(m));
  const pending = env.socket.request('game.sync', { gameId: 'g' });
  const check = assert.rejects(pending, { code: 'kicked' });
  task.serverSend({ t: 'kicked', reason: 'replaced' });
  await check;
  assert.deepEqual(kicks, [{ t: 'kicked', reason: 'replaced' }]);
  assert.equal(env.socket.getStatus(), 'closed');
  assert.ok(task.isClosedByClient());
  task.serverClose(4001); // 服务端随后关闭：旧连接回调，忽略
  await env.timers.tick(60000);
  assert.equal(env.mock.sockets.length, 1);
  await assert.rejects(env.socket.request('game.sync', { gameId: 'g' }), { code: 'kicked' });
  env.mock.triggerAppShow(); // 回到前台也不重连
  await flush();
  assert.equal(env.mock.sockets.length, 1);

  env.socket.connect();
  await flush();
  assert.equal(env.mock.sockets.length, 2);
});

test('4001 关闭码（没收到 kicked 消息）同样视为被踢', async () => {
  const env = setup();
  const task = await openReady(env);
  const kicks = [];
  env.socket.on('kicked', (m) => kicks.push(m));
  const connectP = env.socket.connect();
  assert.deepEqual(await connectP, { activeGames: [], room: null, matching: null });
  task.serverClose(4001, 'replaced');
  assert.deepEqual(kicks, [{ t: 'kicked', reason: 'replaced' }]);
  await env.timers.tick(60000);
  assert.equal(env.mock.sockets.length, 1);
});

test('被踢时等待中的 connect() 也 reject kicked', async () => {
  const env = setup();
  const p = env.socket.connect();
  const check = assert.rejects(p, { code: 'kicked' });
  await flush();
  const task = env.mock.lastSocket();
  task.serverOpen();
  task.serverSend({ t: 'kicked', reason: 'replaced' });
  await check;
});

test('close()：不重连，未完成请求与 connect() reject closed，旧连接回调被忽略', async () => {
  const env = setup();
  const task = await openReady(env);
  const pushes = [];
  env.socket.on('game.move', (m) => pushes.push(m));
  const p = env.socket.request('game.sync', { gameId: 'g' });
  const check = assert.rejects(p, { code: 'closed' });
  env.socket.close();
  await check;
  assert.equal(env.socket.getStatus(), 'closed');
  assert.equal(task.closeCalls.length, 1);
  await flush(); // 假 SocketTask 异步触发 onClose
  task.serverSend({ t: 'game.move', gameId: 'g', n: 1, idx: 0 });
  assert.deepEqual(pushes, []);
  await env.timers.tick(60000);
  assert.equal(env.mock.sockets.length, 1);

  // 连接中 close：等待中的 connect() reject closed，登录完成后也不建连接
  const env2 = setup();
  const c = env2.socket.connect();
  const check2 = assert.rejects(c, { code: 'closed' });
  env2.socket.close();
  await check2;
  await flush();
  assert.equal(env2.mock.sockets.length, 0);
});

test('close() 之后 request 会自动重新连接', async () => {
  const env = setup();
  await openReady(env);
  env.socket.close();
  const p = env.socket.request('room.get', { code: '123456' });
  await flush();
  assert.equal(env.mock.sockets.length, 2);
  const t = env.mock.lastSocket();
  t.serverOpen();
  t.reply(t.lastSent('room.get'), { room: { code: '123456' } });
  assert.deepEqual(await p, { room: { code: '123456' } });
});

test('心跳：每 20 秒 ping，收到 pong 正常；10 秒无 pong 断开重连', async () => {
  const env = setup();
  const task = await openReady(env);
  const pings = [];
  env.socket.on('pong', (m) => pings.push(m.ts));
  await env.timers.tick(19999);
  assert.equal(task.sentOf('ping').length, 0);
  await env.timers.tick(1);
  assert.equal(task.sentOf('ping').length, 1);
  assert.deepEqual(Object.keys(task.lastSent('ping')), ['t']); // ping 不带 rid
  task.serverSend({ t: 'pong', ts: 123 });
  assert.deepEqual(pings, [123]);
  await env.timers.tick(10000);
  assert.equal(env.socket.getStatus(), 'open');

  await env.timers.tick(10000); // t=40s 第二次 ping，不回
  assert.equal(task.sentOf('ping').length, 2);
  const pending = env.socket.request('game.sync', { gameId: 'g' }, { timeout: 60000 });
  const check = assert.rejects(pending, { code: 'offline' });
  await env.timers.tick(9999);
  assert.equal(env.socket.getStatus(), 'open');
  await env.timers.tick(1);
  assert.equal(env.socket.getStatus(), 'closed');
  assert.ok(task.isClosedByClient());
  await check;
  await expectReconnectAfter(env, 1000);
});

test('回到前台：断线等待中立即重连；已连接时发 ping 探活；网络恢复同理', async () => {
  const env = setup();
  const task = await openReady(env);
  env.mock.triggerAppShow();
  assert.equal(task.sentOf('ping').length, 1);
  env.mock.triggerAppShow(); // 还在等 pong，不重复发
  assert.equal(task.sentOf('ping').length, 1);
  task.serverSend({ t: 'pong', ts: 1 });

  task.serverClose(1006); // 退避 1 秒
  env.mock.triggerAppShow();
  await flush();
  assert.equal(env.mock.sockets.length, 2);
  await env.timers.tick(5000); // 原来的退避定时器已取消，不会再建连接
  assert.equal(env.mock.sockets.length, 2);

  const t2 = env.mock.lastSocket();
  t2.serverClose(1006);
  env.mock.triggerNetwork(false);
  await flush();
  assert.equal(env.mock.sockets.length, 2);
  env.mock.triggerNetwork(true);
  await flush();
  assert.equal(env.mock.sockets.length, 3);
  // 连接中再回到前台：什么都不做
  env.mock.triggerAppShow();
  await flush();
  assert.equal(env.mock.sockets.length, 3);
  // onAppShow 只注册一次
  assert.equal(env.mock.appShowHandlers.length, 1);
});

test('令牌过期：连续两次打开前被拒绝 → GET /api/me（401）→ 重新登录 → 用新令牌连接', async () => {
  const env = setup();
  env.socket.connect();
  await flush();
  let t = env.mock.lastSocket();
  assert.equal(bearer(t), 'tok1');
  env.server.valid.clear(); // 服务端令牌失效
  t.serverError('401');
  t.serverClose(1006);
  t = await expectReconnectAfter(env, 1000);
  assert.equal(bearer(t), 'tok1');
  assert.equal(env.mock.requestsTo('/api/me').length, 0);
  t.serverError('401');
  t = await expectReconnectAfter(env, 2000);
  assert.equal(bearer(t), 'tok2');
  assert.equal(env.mock.requestsTo('/api/me').length, 2); // 401 + 重试
  assert.equal(env.mock.loginCount, 2);
  t.serverOpen();
  t.reply(t.sentOf('hello')[0], {});
  await flush();
  assert.equal(env.socket.isReady(), true);
});

test('令牌有效但服务器拒绝：校验通过不重新登录；没有 api 时直接清令牌重新登录', async () => {
  const env = setup();
  env.socket.connect();
  await flush();
  env.mock.lastSocket().serverClose(1006);
  await env.timers.tick(1000);
  env.mock.lastSocket().serverClose(1006);
  const t = await expectReconnectAfter(env, 2000);
  assert.equal(env.mock.requestsTo('/api/me').length, 1);
  assert.equal(env.mock.loginCount, 1);
  assert.equal(bearer(t), 'tok1');

  const env2 = setup({ withApi: false });
  env2.socket.connect();
  await flush();
  env2.mock.lastSocket().serverClose(1006);
  await env2.timers.tick(1000);
  env2.mock.lastSocket().serverClose(1006);
  const t2 = await expectReconnectAfter(env2, 2000);
  assert.equal(bearer(t2), 'tok2');
  assert.equal(env2.mock.loginCount, 2);
});

test('旧 SocketTask 的迟到回调一律忽略；迟到的 onOpen 会被关掉', async () => {
  const env = setup();
  const pushes = [];
  const statuses = [];
  env.socket.on('game.move', (m) => pushes.push(m));
  const old = await openReady(env);
  env.socket.on('status', (s) => statuses.push(s));
  old.serverClose(1006);
  const fresh = await expectReconnectAfter(env, 1000);
  assert.deepEqual(statuses, ['closed', 'connecting']);

  old.serverSend({ t: 'game.move', gameId: 'g', n: 1, idx: 0 });
  old.serverError('late');
  old.serverClose(1006);
  const closesBefore = old.closeCalls.length;
  old.serverOpen();
  assert.equal(old.closeCalls.length, closesBefore + 1);
  assert.deepEqual(pushes, []);
  assert.deepEqual(statuses, ['closed', 'connecting']);
  assert.equal(env.mock.sockets.length, 2);

  fresh.serverOpen();
  fresh.reply(fresh.sentOf('hello')[0], {});
  await flush();
  fresh.serverSend({ t: 'game.move', gameId: 'g', n: 1, idx: 0 });
  assert.equal(pushes.length, 1);
  await env.timers.tick(30000);
  assert.equal(env.mock.sockets.length, 2);
});

test('打开超时：放弃并重连；被放弃的连接迟到打开会被关掉', async () => {
  const env = setup();
  env.socket.connect();
  await flush();
  const slow = env.mock.lastSocket();
  await env.timers.tick(9999);
  assert.equal(env.socket.getStatus(), 'connecting');
  await env.timers.tick(1);
  assert.equal(env.socket.getStatus(), 'closed');
  assert.ok(slow.isClosedByClient());
  await expectReconnectAfter(env, 1000);
  slow.serverOpen();
  assert.equal(slow.sent.length, 0);
});

test('connectSocket 带 timeout（与单次打开超时一致），原生连接与本地同时放弃', async () => {
  const env = setup({ options: { openTimeoutMs: 7000 } });
  env.socket.connect();
  await flush();
  assert.equal(env.mock.lastSocket().options.timeout, 7000);
});

test('自己顶自己：被放弃的连接迟到建立、服务端顶掉新连接 → 不进入被踢状态，重连一次', async () => {
  const env = setup();
  const kicks = [];
  env.socket.on('kicked', (m) => kicks.push(m));
  env.socket.connect();
  await flush();
  const slow = env.mock.lastSocket();
  await env.timers.tick(10000); // 打开超时：放弃 slow
  const fresh = await expectReconnectAfter(env, 1000);
  fresh.serverOpen();
  fresh.reply(fresh.sentOf('hello')[0], {});
  await flush();
  assert.equal(env.socket.isReady(), true);
  // slow 的握手迟到地完成：服务端把它当新连接，顶掉 fresh
  slow.serverOpen();
  assert.ok(slow.isClosedByClient());
  fresh.serverSend({ t: 'kicked', reason: 'replaced' });
  fresh.serverClose(4001, 'replaced');
  await flush();
  assert.deepEqual(kicks, []);
  assert.equal(env.socket.isKicked(), false);
  assert.equal(env.socket.getStatus(), 'closed');
  const again = await expectReconnectAfter(env, 1000);
  again.serverOpen();
  again.reply(again.sentOf('hello')[0], {});
  await flush();
  assert.equal(env.socket.getStatus(), 'open');
  // 只宽容一次：之后真正的顶号照常进入被踢状态
  again.serverSend({ t: 'kicked', reason: 'replaced' });
  await flush();
  assert.equal(kicks.length, 1);
  assert.equal(env.socket.isKicked(), true);
  await env.timers.tick(60000);
  assert.equal(env.mock.sockets.length, 3);
});

test('自己顶自己：迟到的 kicked 先于旧连接的 onOpen 到达也按断线处理；超过窗口期的顶号照常生效', async () => {
  const env = setup();
  const kicks = [];
  env.socket.on('kicked', (m) => kicks.push(m));
  env.socket.connect();
  await flush();
  await env.timers.tick(10000);
  const fresh = await expectReconnectAfter(env, 1000);
  fresh.serverOpen();
  fresh.reply(fresh.sentOf('hello')[0], {});
  await flush();
  fresh.serverSend({ t: 'kicked', reason: 'replaced' });
  await flush();
  assert.deepEqual(kicks, []);
  const next = await expectReconnectAfter(env, 1000);
  next.serverOpen();
  next.reply(next.sentOf('hello')[0], {});
  await flush();
  // 窗口期（15 秒）过后，没有被放弃的连接：顶号当真
  await env.timers.tick(15000);
  next.serverSend({ t: 'kicked', reason: 'replaced' });
  await flush();
  assert.equal(kicks.length, 1);
  assert.equal(env.socket.isKicked(), true);
});

test('isKicked：被踢后为真，主动 connect() 后清除', async () => {
  const env = setup();
  assert.equal(env.socket.isKicked(), false);
  const task = await openReady(env);
  task.serverSend({ t: 'kicked', reason: 'replaced' });
  await flush();
  assert.equal(env.socket.isKicked(), true);
  env.socket.connect();
  assert.equal(env.socket.isKicked(), false);
});

test('服务端错误的附加字段（reason / expected / version）随 reject 一起带上', async () => {
  const env = setup();
  const task = await openReady(env);
  const p = env.socket.request('game.move', { gameId: 'g', n: 3, idx: 4 });
  task.serverSend({ t: 'res', rid: task.lastSent().rid, ok: false, err: { code: 'illegal', msg: '打劫，不能立即提回', reason: 'ko', bad: { x: 1 } } });
  await assert.rejects(p, (err) => {
    assert.deepEqual(err, { code: 'illegal', msg: '打劫，不能立即提回', reason: 'ko' });
    return true;
  });
  const p2 = env.socket.request('game.pass', { gameId: 'g', n: 3 });
  task.serverSend({ t: 'res', rid: task.lastSent().rid, ok: false, err: { code: 'stale', msg: 'x', expected: 5 } });
  await assert.rejects(p2, { code: 'stale', expected: 5 });
});

test('hello 失败（服务端错误或超时）→ 断开重连', async () => {
  const env = setup();
  env.socket.connect();
  await flush();
  const t = env.mock.lastSocket();
  t.serverOpen();
  t.replyError(t.sentOf('hello')[0], 'internal', 'boom');
  await flush();
  assert.equal(env.socket.getStatus(), 'closed');
  assert.ok(t.isClosedByClient());
  assert.ok(env.logger.count('error') >= 1);
  const t2 = await expectReconnectAfter(env, 1000);
  t2.serverOpen(); // hello 不回：10 秒后超时重连
  await env.timers.tick(10000);
  assert.equal(env.socket.getStatus(), 'closed');
  await expectReconnectAfter(env, 2000);
});

test('登录失败：按退避重试，恢复后连上', async () => {
  const env = setup();
  const loginRoute = env.mock.routes.get('POST /api/auth/login');
  env.mock.route('POST /api/auth/login', () => ({ fail: 'down' }));
  const p = env.socket.connect({ timeout: 60000 });
  await flush();
  assert.equal(env.mock.sockets.length, 0);
  assert.equal(env.socket.getStatus(), 'closed');
  await env.timers.tick(1000);
  assert.equal(env.mock.loginCount, 2);
  env.mock.route('POST /api/auth/login', loginRoute);
  await env.timers.tick(2000);
  assert.equal(env.mock.sockets.length, 1);
  const t = env.mock.lastSocket();
  t.serverOpen();
  t.reply(t.sentOf('hello')[0], { activeGames: [] });
  assert.deepEqual(await p, { activeGames: [], room: null, matching: null });
});

test('connect() 等待超时 reject offline，后台继续重连；只调用不 await 不产生未处理的 rejection', async () => {
  const env = setup();
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    env.socket.connect(); // 不 await
    const p = env.socket.connect({ timeout: 3000 });
    const check = assert.rejects(p, { code: 'offline' });
    await env.timers.tick(10000); // 默认 10 秒的那个也超时
    await check;
    await flush();
    assert.deepEqual(unhandled, []);
    // 打开超时后后台继续重连
    await env.timers.tick(1000);
    assert.equal(env.mock.sockets.length, 2);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('connectSocket 失败（fail 回调或抛错）→ 重连', async () => {
  const env = setup();
  env.mock.connectSocketFail = 'connectSocket:fail url not in domain list';
  env.socket.connect();
  await flush();
  assert.equal(env.socket.getStatus(), 'closed');
  env.mock.connectSocketFail = null;
  env.mock.connectSocketThrows = true;
  await env.timers.tick(1000);
  assert.equal(env.socket.getStatus(), 'closed');
  env.mock.connectSocketThrows = false;
  await env.timers.tick(2000);
  assert.equal(env.socket.getStatus(), 'connecting');
  assert.equal(env.mock.sockets.length, 2);
});

test('发送失败 → offline；消息过大 → too_large', async () => {
  const env = setup();
  await openReady(env);
  env.mock.sendFails = true;
  await assert.rejects(env.socket.request('game.sync', { gameId: 'g' }), { code: 'offline' });
  env.mock.sendFails = false;
  await assert.rejects(env.socket.request('x', { big: 'a'.repeat(17 * 1024) }), { code: 'too_large' });
  await assert.rejects(env.socket.request('x', { big: '中'.repeat(6000) }), { code: 'too_large' }); // 18000 字节
});

test('推送：on / once / off；非法消息记录日志并忽略；保留事件名不被服务端推送覆盖', async () => {
  const env = setup();
  const task = await openReady(env);
  const got = [];
  const fn = (m) => got.push(['on', m.idx]);
  env.socket.on('game.move', fn);
  env.socket.once('game.move', (m) => got.push(['once', m.idx]));
  let statusEvents = 0;
  env.socket.on('status', () => { statusEvents += 1; });

  task.serverSend({ t: 'game.move', gameId: 'g', n: 1, idx: 10 });
  task.serverSend({ t: 'game.move', gameId: 'g', n: 2, idx: 11 });
  assert.deepEqual(got, [['on', 10], ['once', 10], ['on', 11]]);
  assert.equal(env.socket.off('game.move', fn), true);
  task.serverSend({ t: 'game.move', gameId: 'g', n: 3, idx: 12 });
  assert.equal(got.length, 3);

  const errorsBefore = env.logger.count('error');
  task.serverSend('not json');
  task.serverSend({ nope: 1 });
  task.serverSend([1, 2]);
  task._emit('message', { data: new ArrayBuffer(4) });
  assert.equal(env.logger.count('error'), errorsBefore + 3);
  task.serverSend({ t: 'status', x: 1 });
  task.serverSend({ t: 'ready' });
  assert.equal(statusEvents, 0);
  assert.equal(env.socket.getStatus(), 'open');
  // 未知 rid 的 res 被忽略
  task.serverSend({ t: 'res', rid: 9999, ok: true });
});

test('默认单例：可 require（不访问 wx），两种导入方式都可用', () => {
  const socket = require('../../miniprogram/utils/net/socket');
  assert.equal(socket.socket, socket);
  assert.equal(typeof socket.createSocket, 'function');
  const { connect, request, on, off } = socket;
  assert.equal(typeof connect, 'function');
  assert.equal(typeof request, 'function');
  assert.equal(typeof on, 'function');
  assert.equal(typeof off, 'function');
  assert.equal(socket.getStatus(), 'closed');
  assert.throws(() => createSocket({}), TypeError);
});
