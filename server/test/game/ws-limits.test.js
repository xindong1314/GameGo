'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { startServer } = require('./helpers/setup');
const { TestClient } = require('../helpers/ws-client');
const { Connection, MAX_BUFFERED_BYTES } = require('../../src/ws/hub');

// WebSocket 连接层的防护（回归测试）：
// - SL-3 对方不读数据：发送积压超过上限直接断开
// - SL-5 建立连接的频率按用户限流（429）；消息限流按用户计（重连不清零，见 e2e.test.js）
// - SL-6 令牌可以放在 Authorization 头里（不进访问日志）
// - CS-1 新连接顶替旧连接时退出匹配队列

test('慢读客户端：发送积压超过上限（默认 1MB）就断开连接，不再往里写（SL-3）', () => {
  const logs = [];
  const hub = { logger: { warn: (...a) => logs.push(a), debug() {} }, maxBufferedBytes: MAX_BUFFERED_BYTES };
  const sent = [];
  let terminated = 0;
  const ws = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: (s) => sent.push(s),
    terminate: () => {
      terminated += 1;
    },
  };
  const conn = new Connection(hub, ws, 7, 1);
  assert.equal(conn.sendNow({ t: 'pong' }), true);
  ws.bufferedAmount = MAX_BUFFERED_BYTES; // 正好等于上限：还可以
  assert.equal(conn.sendNow({ t: 'pong' }), true);
  ws.bufferedAmount = MAX_BUFFERED_BYTES + 1;
  assert.equal(conn.sendNow({ t: 'pong' }), false);
  assert.equal(sent.length, 2);
  assert.equal(terminated, 1);
  assert.equal(conn.closing, true);
  assert.equal(logs.length, 1);
});

test('建立连接的频率按用户限流：突发 10 次之后回 429（SL-5）', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const u = srv.user('Ann');
  const other = srv.user('Ben');
  for (let i = 0; i < 10; i++) {
    const c = await srv.connect(u.token);
    await c.req('hello');
  }
  await assert.rejects(TestClient.connect(srv.wsUrl, { token: u.token }), (err) => err.statusCode === 429);
  // 别的用户不受影响
  const b = await srv.connect(other.token);
  await b.req('hello');
});

test('令牌可以放在 Authorization: Bearer 头里；头里的令牌无效 → 401（SL-6）', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const u = srv.user('Ann');
  const open = (headers) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(srv.wsUrl, { headers });
      ws.once('open', () => resolve(ws));
      ws.once('unexpected-response', (req, res) => {
        ws.terminate();
        reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode }));
      });
      ws.once('error', () => {});
    });
  const ws = await open({ authorization: `Bearer ${u.token}` });
  const reply = new Promise((resolve) => ws.once('message', (d) => resolve(JSON.parse(d.toString()))));
  ws.send(JSON.stringify({ t: 'hello', rid: 1 }));
  const res = await reply;
  assert.equal(res.ok, true);
  assert.deepEqual(res.data.activeGames, []);
  ws.terminate();
  await assert.rejects(open({ authorization: `Bearer ${'0'.repeat(64)}` }), (err) => err.statusCode === 401);
});

test('第二台设备顶替连接：退出匹配队列，不会在不知情的情况下被配对（CS-1）', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const a = await srv.player('Ann');
  const b = await srv.player('Ben');
  await a.c.req('match.join', { size: 9 });
  const a2 = await srv.connect(a.token); // 在另一台设备上打开
  assert.equal((await a.c.closed).code, 4001);
  assert.equal((await a2.req('hello')).matching, null);
  await b.c.req('match.join', { size: 9 });
  await a2.expectNone('match.found', 100);
  assert.deepEqual((await b.c.req('hello')).matching, { size: 9 });
});
