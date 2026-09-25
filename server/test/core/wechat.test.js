'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { code2Session, WxLoginError, JSCODE2SESSION_URL } = require('../../src/auth/wechat');

function jsonResponse(obj, status = 200) {
  // 微信接口的 Content-Type 常是 text/plain，按文本返回 JSON
  return new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'text/plain' },
  });
}

test('code2Session：成功时返回 openid，请求参数正确', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ openid: 'oABC', session_key: 'sk', unionid: 'un' });
  };
  const r = await code2Session('wxapp', 's&cret', 'code/1', { fetch });
  assert.deepEqual(r, { openid: 'oABC', sessionKey: 'sk', unionid: 'un' });
  assert.equal(calls.length, 1);
  const u = new URL(calls[0].url);
  assert.equal(`${u.origin}${u.pathname}`, JSCODE2SESSION_URL);
  assert.equal(u.searchParams.get('appid'), 'wxapp');
  assert.equal(u.searchParams.get('secret'), 's&cret');
  assert.equal(u.searchParams.get('js_code'), 'code/1');
  assert.equal(u.searchParams.get('grant_type'), 'authorization_code');
  assert.equal(calls[0].init.method, 'GET');
  assert.ok(calls[0].init.signal instanceof AbortSignal);

  const r2 = await code2Session('a', 'b', 'c', { fetch: async () => jsonResponse({ openid: 'o2', errcode: 0 }) });
  assert.deepEqual(r2, { openid: 'o2', sessionKey: '', unionid: '' });
});

test('code2Session：errcode 非 0 → WxLoginError（带中文说明与 errcode）', async () => {
  const fetch = async () => jsonResponse({ errcode: 40029, errmsg: 'invalid code, rid: 1' });
  await assert.rejects(code2Session('a', 'b', 'c', { fetch }), (err) => {
    assert.ok(err instanceof WxLoginError);
    assert.equal(err.code, 'wx_login_failed');
    assert.equal(err.errcode, 40029);
    assert.match(err.message, /登录凭证无效/);
    return true;
  });
  const unknown = async () => jsonResponse({ errcode: 12345, errmsg: 'strange' });
  await assert.rejects(code2Session('a', 'b', 'c', { fetch: unknown }), /12345：strange/);
  const busy = async () => jsonResponse({ errcode: -1, errmsg: 'system error' });
  await assert.rejects(code2Session('a', 'b', 'c', { fetch: busy }), /系统繁忙/);
});

test('code2Session：网络错误、HTTP 错误、坏数据、缺 openid', async () => {
  const cases = [
    [
      async () => {
        throw new TypeError('fetch failed');
      },
      /无法连接微信服务器/,
    ],
    [async () => jsonResponse('bad gateway', 502), /HTTP 502/],
    [async () => jsonResponse('<html>'), /无法解析/],
    [async () => jsonResponse('null'), /无法解析/],
    [async () => jsonResponse({ session_key: 'x' }), /没有返回 openid/],
    [async () => jsonResponse({ openid: '' }), /没有返回 openid/],
  ];
  for (const [fetch, re] of cases) {
    await assert.rejects(code2Session('a', 'b', 'c', { fetch }), (err) => {
      assert.ok(err instanceof WxLoginError, String(err));
      assert.match(err.message, re);
      assert.doesNotMatch(err.message, /secret|b&/);
      return true;
    });
  }
});

test('code2Session：超时（即使 fetch 不理会 signal）', async () => {
  let signal;
  const fetch = (url, init) => {
    signal = init.signal;
    return new Promise(() => {}); // 永不返回
  };
  const started = Date.now();
  await assert.rejects(code2Session('a', 'b', 'c', { fetch, timeoutMs: 50 }), /超时/);
  assert.ok(Date.now() - started < 2000);
  assert.equal(signal.aborted, true);

  // 响应头到了但正文迟迟不来
  const slowBody = async () => ({ ok: true, status: 200, text: () => new Promise(() => {}) });
  await assert.rejects(code2Session('a', 'b', 'c', { fetch: slowBody, timeoutMs: 50 }), /超时/);
});

test('code2Session：参数缺失直接失败，不发请求', async () => {
  let called = false;
  const fetch = async () => {
    called = true;
    return jsonResponse({ openid: 'x' });
  };
  await assert.rejects(code2Session('', 'b', 'c', { fetch }), WxLoginError);
  await assert.rejects(code2Session('a', '', 'c', { fetch }), WxLoginError);
  await assert.rejects(code2Session('a', 'b', '', { fetch }), WxLoginError);
  await assert.rejects(code2Session('a', 'b', 5, { fetch }), WxLoginError);
  assert.equal(called, false);
});
