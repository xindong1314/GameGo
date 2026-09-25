'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startHttp, PNG_BYTES } = require('./helpers');
const { clientIp } = require('../../src/http/server');
const { RateLimiter, createConcurrencyLimit } = require('../../src/util/rate-limit');

// REST 限流、真实 IP、注销（SL-5 / SL-6）

const DEV = { devLogin: true };

async function upload(s, token) {
  const fd = new FormData();
  fd.append('file', new Blob([PNG_BYTES], { type: 'image/png' }), 'a.png');
  const res = await fetch(`${s.base}/api/me/avatar`, { method: 'POST', body: fd, headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
}

test('RateLimiter：令牌桶按时间补充；allows 只看不取；prune 清掉补满的桶', () => {
  let t = 0;
  const lim = new RateLimiter({ capacity: 3, refillPerSec: 2, now: () => t });
  assert.equal(lim.take('a'), true);
  assert.equal(lim.take('a'), true);
  assert.equal(lim.take('a'), true);
  assert.equal(lim.take('a'), false);
  assert.equal(lim.allows('a'), false);
  assert.equal(lim.retryAfterMs('a'), 500);
  assert.equal(lim.take('b'), true, '各键独立');
  t = 500;
  assert.equal(lim.allows('a'), true);
  assert.equal(lim.take('a'), true);
  assert.equal(lim.take('a'), false);
  t = 10000;
  lim.prune();
  assert.equal(lim.size, 0);
  assert.throws(() => new RateLimiter({ capacity: 0, refillPerSec: 1 }), TypeError);

  const slots = createConcurrencyLimit(2);
  const r1 = slots.acquire();
  const r2 = slots.acquire();
  assert.equal(slots.acquire(), null);
  r1();
  r1(); // 重复释放无害
  assert.equal(slots.active, 1);
  assert.ok(slots.acquire());
  r2();
});

test('clientIp：只有来自本机（nginx）的请求才相信 X-Real-IP', () => {
  const req = (peer, real) => ({ socket: { remoteAddress: peer }, headers: real ? { 'x-real-ip': real } : {} });
  assert.equal(clientIp(req('127.0.0.1', '1.2.3.4')), '1.2.3.4');
  assert.equal(clientIp(req('::ffff:127.0.0.1', '5.6.7.8')), '5.6.7.8');
  assert.equal(clientIp(req('9.9.9.9', '1.2.3.4')), '9.9.9.9', '外部直连伪造的头不算数');
  assert.equal(clientIp(req('127.0.0.1')), '127.0.0.1');
});

test('登录接口按 IP 限流：超出 → 429 rate_limited + Retry-After；不同 X-Real-IP 分开计', async (t) => {
  const s = await startHttp({ config: DEV, limits: { loginBurst: 3, loginPerSec: 1 } });
  t.after(s.close);
  for (let i = 0; i < 3; i++) assert.equal((await s.api('POST', '/api/auth/dev-login', { body: { deviceId: `device_000${i}` } })).status, 200);
  const r = await s.api('POST', '/api/auth/dev-login', { body: { deviceId: 'device_0009' } });
  assert.equal(r.status, 429);
  assert.equal(r.json.error.code, 'rate_limited');
  assert.equal(r.headers.get('retry-after'), '1');
  // 微信登录接口共用同一个限额
  assert.equal((await s.api('POST', '/api/auth/login', { body: { code: 'x' } })).status, 429);
  // nginx 转发的不同用户（X-Real-IP）不互相影响
  const other = await s.api('POST', '/api/auth/dev-login', { body: { deviceId: 'device_0010' }, headers: { 'x-real-ip': '10.0.0.8' } });
  assert.equal(other.status, 200);
  s.now.advance(1000);
  assert.equal((await s.api('POST', '/api/auth/dev-login', { body: { deviceId: 'device_0009' } })).status, 200);
});

test('微信登录：同时在请求 code2Session 的数量有上限，超出 → 429', async (t) => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const fetch = async () => {
    await gate;
    return new Response(JSON.stringify({ openid: 'o-1', session_key: 'k' }), { status: 200 });
  };
  const s = await startHttp({ config: { wx: { appId: 'wxid', secret: 'sec' } }, fetch, limits: { loginConcurrent: 1 } });
  t.after(s.close);
  const first = s.api('POST', '/api/auth/login', { body: { code: 'c1' } });
  await new Promise((r) => setTimeout(r, 50));
  const second = await s.api('POST', '/api/auth/login', { body: { code: 'c2' } });
  assert.equal(second.status, 429);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await s.api('POST', '/api/auth/login', { body: { code: 'c3' } })).status, 200);
});

test('需要令牌的接口按用户限流；头像上传另有更严的限额', async (t) => {
  const s = await startHttp({ config: DEV, limits: { apiBurst: 4, apiPerSec: 1, avatarBurst: 2, avatarPerSec: 0.1 } });
  t.after(s.close);
  const a = await s.devLogin('device_000a');
  const b = await s.devLogin('device_000b');
  for (let i = 0; i < 4; i++) assert.equal((await s.api('GET', '/api/me', { token: a.token })).status, 200);
  const r = await s.api('GET', '/api/me', { token: a.token });
  assert.equal(r.status, 429);
  assert.equal(r.json.error.code, 'rate_limited');
  assert.equal((await s.api('GET', '/api/me', { token: b.token })).status, 200, '别的用户不受影响');
  assert.equal((await s.api('GET', '/healthz')).status, 200, '不需要令牌的接口不计');
  s.now.advance(10000);
  assert.equal((await upload(s, b.token)).status, 200);
  assert.equal((await upload(s, b.token)).status, 200);
  const third = await upload(s, b.token);
  assert.equal(third.status, 429);
  assert.equal(third.headers.get('retry-after'), '10');
});

test('POST /api/auth/logout：注销当前令牌，其他令牌不受影响（SL-6）', async (t) => {
  const s = await startHttp({ config: DEV });
  t.after(s.close);
  const one = await s.devLogin('device_0001');
  const two = await s.devLogin('device_0001'); // 同一用户另一台设备
  const r = await s.api('POST', '/api/auth/logout', { token: one.token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
  assert.equal((await s.api('GET', '/api/me', { token: one.token })).status, 401);
  assert.equal((await s.api('GET', '/api/me', { token: two.token })).status, 200);
  assert.equal((await s.api('POST', '/api/auth/logout')).status, 401);
});
