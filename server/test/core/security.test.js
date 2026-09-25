'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { startHttp, PNG_BYTES, pngOf } = require('./helpers');
const { createWxSecurity } = require('../../src/auth/wx-security');

// 服务端内容安全检测（SL-7）：昵称 msgSecCheck 2.0、头像 imgSecCheck；用假的微信接口测试。

const WX = { appId: 'wxid', secret: 'sec' };

// 按路径分发的假微信接口。opts：{ risky: 文本关键字, imgRisky, msgHttp500, expireOnce, msgErrcode }
function fakeWx(opts = {}) {
  const calls = [];
  let expire = opts.expireOnce ? 1 : 0;
  let tokenN = 0;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const call = { path: u.pathname, query: Object.fromEntries(u.searchParams), init };
    if (typeof init.body === 'string') call.body = JSON.parse(init.body);
    calls.push(call);
    switch (u.pathname) {
      case '/sns/jscode2session':
        return json({ openid: `o-${u.searchParams.get('js_code')}`, session_key: 'k' });
      case '/cgi-bin/stable_token':
        tokenN += 1;
        return json({ access_token: `AT${tokenN}`, expires_in: 7200 });
      case '/wxa/msg_sec_check':
        if (opts.msgHttp500) return json({}, 500);
        if (opts.msgErrcode) return json({ errcode: opts.msgErrcode, errmsg: `errcode ${opts.msgErrcode}` });
        if (expire > 0) {
          expire -= 1;
          return json({ errcode: 40001, errmsg: 'invalid credential' });
        }
        return json({
          errcode: 0,
          errmsg: 'ok',
          result: { suggest: opts.risky && call.body.content.includes(opts.risky) ? 'risky' : 'pass', label: 100 },
          trace_id: 't1',
        });
      case '/wxa/img_sec_check':
        return json(opts.imgRisky ? { errcode: 87014, errmsg: 'risky content' } : { errcode: 0, errmsg: 'ok' });
      default:
        return json({ errcode: -1 }, 404);
    }
  };
  fetch.calls = calls;
  fetch.of = (p) => calls.filter((c) => c.path === p);
  return fetch;
}

async function wxUser(s, code = 'c1') {
  const r = await s.api('POST', '/api/auth/login', { body: { code } });
  assert.equal(r.status, 200);
  return r.json;
}

async function upload(s, token, bytes) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: 'image/png' }), 'a.png');
  const res = await fetch(`${s.base}/api/me/avatar`, { method: 'POST', body: fd, headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test('昵称：msgSecCheck 判定违规 → 400 content_risky，资料不变；通过 → 保存；access_token 缓存复用', async (t) => {
  const fetch = fakeWx({ risky: '违规' });
  const s = await startHttp({ config: { wx: WX }, fetch });
  t.after(s.close);
  const { token } = await wxUser(s);
  const bad = await s.api('PUT', '/api/me/profile', { token, body: { nickname: '违规昵称' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'content_risky');
  assert.equal(s.repos.users.findById(1).nickname, '');
  const ok = await s.api('PUT', '/api/me/profile', { token, body: { nickname: '好棋手' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.nickname, '好棋手');
  const checks = fetch.of('/wxa/msg_sec_check');
  assert.equal(checks.length, 2);
  assert.deepEqual(checks[1].body, { content: '好棋手', version: 2, scene: 1, openid: 'o-c1' });
  assert.equal(checks[1].query.access_token, 'AT1');
  assert.equal(fetch.of('/cgi-bin/stable_token').length, 1, 'access_token 缓存');
  assert.deepEqual(fetch.of('/cgi-bin/stable_token')[0].body, { grant_type: 'client_credential', appid: 'wxid', secret: 'sec', force_refresh: false });
  // 昵称没变不重复检测
  await s.api('PUT', '/api/me/profile', { token, body: { nickname: ' 好棋手 ' } });
  assert.equal(fetch.of('/wxa/msg_sec_check').length, 2);
});

test('昵称：access_token 失效（40001）时刷新后重试一次', async (t) => {
  const fetch = fakeWx({ expireOnce: true });
  const s = await startHttp({ config: { wx: WX }, fetch });
  t.after(s.close);
  const { token } = await wxUser(s);
  assert.equal((await s.api('PUT', '/api/me/profile', { token, body: { nickname: '棋手' } })).status, 200);
  assert.equal(fetch.of('/cgi-bin/stable_token').length, 2);
  assert.equal(fetch.of('/wxa/msg_sec_check')[1].query.access_token, 'AT2');
});

test('昵称：微信接口出错时 SEC_CHECK=on 放行、strict 拒绝（503 sec_check_unavailable）', async (t) => {
  const on = await startHttp({ config: { wx: WX }, fetch: fakeWx({ msgHttp500: true }) });
  t.after(on.close);
  const a = await wxUser(on);
  assert.equal((await on.api('PUT', '/api/me/profile', { token: a.token, body: { nickname: '棋手' } })).status, 200);

  const strict = await startHttp({ config: { wx: WX, secCheck: 'strict' }, fetch: fakeWx({ msgHttp500: true }) });
  t.after(strict.close);
  const b = await wxUser(strict);
  const r = await strict.api('PUT', '/api/me/profile', { token: b.token, body: { nickname: '棋手' } });
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, 'sec_check_unavailable');
});

test('开发登录的用户、未配置 AppSecret、SEC_CHECK=off 时不调用微信接口', async (t) => {
  const f1 = fakeWx({ risky: '违规' });
  const dev = await startHttp({ config: { devLogin: true, wx: WX }, fetch: f1 });
  t.after(dev.close);
  const { token } = await dev.devLogin('device_0001');
  assert.equal((await dev.api('PUT', '/api/me/profile', { token, body: { nickname: '违规' } })).status, 200);
  assert.equal((await upload(dev, token, PNG_BYTES)).status, 200);
  assert.equal(f1.calls.length, 0);

  const f2 = fakeWx({ risky: '违规' });
  const off = await startHttp({ config: { wx: WX, secCheck: 'off' }, fetch: f2 });
  t.after(off.close);
  const u = await wxUser(off);
  assert.equal((await off.api('PUT', '/api/me/profile', { token: u.token, body: { nickname: '违规' } })).status, 200);
  assert.equal(f2.of('/wxa/msg_sec_check').length, 0);

  assert.equal(createWxSecurity({ config: { secCheck: 'on', wx: { appId: '', secret: '' } } }).enabled, false);
});

test('头像：imgSecCheck 判定违规 → 400 content_risky，不保存文件；通过 → 保存', async (t) => {
  const bad = await startHttp({ config: { wx: WX }, fetch: fakeWx({ imgRisky: true }) });
  t.after(bad.close);
  const a = await wxUser(bad);
  const r = await upload(bad, a.token, PNG_BYTES);
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'content_risky');
  assert.deepEqual(fs.existsSync(bad.config.avatarDir) ? fs.readdirSync(bad.config.avatarDir) : [], []);
  assert.equal(bad.repos.users.findById(1).avatar, '');

  const f = fakeWx();
  const good = await startHttp({ config: { wx: WX }, fetch: f });
  t.after(good.close);
  const b = await wxUser(good);
  assert.equal((await upload(good, b.token, PNG_BYTES)).status, 200);
  const call = f.of('/wxa/img_sec_check')[0];
  assert.equal(call.query.access_token, 'AT1');
  assert.ok(call.init.body instanceof FormData);
  assert.ok(call.init.body.get('media'));
});

test('头像：超出 imgSecCheck 限制（>750×1334、>1MB）的图片送不了检：on 与 strict 都拒绝，不能靠大图绕过检测（LS-3）', async (t) => {
  const big = pngOf({ width: 1000, height: 1000 });
  const f = fakeWx({ imgRisky: true });
  const on = await startHttp({ config: { wx: WX }, fetch: f });
  t.after(on.close);
  const a = await wxUser(on);
  const r1 = await upload(on, a.token, pngOf({ width: 751, height: 751 }));
  assert.equal(r1.status, 400);
  assert.match(r1.json.error.msg, /太大/);
  assert.equal((await upload(on, a.token, big)).status, 400);
  assert.equal(on.repos.users.findById(1).avatar, '', '没有保存');
  assert.equal((await upload(on, a.token, pngOf({ width: 750, height: 750 }))).json.error.code, 'content_risky', '限制以内的照常送检');
  assert.equal(f.of('/wxa/img_sec_check').length, 1);

  // 不检测的情况（SEC_CHECK=off、开发登录）仍按 2048 的上限收
  const off = await startHttp({ config: { wx: WX, secCheck: 'off' }, fetch: fakeWx() });
  t.after(off.close);
  const c = await wxUser(off);
  assert.equal((await upload(off, c.token, big)).status, 200);

  const strict = await startHttp({ config: { wx: WX, secCheck: 'strict' }, fetch: fakeWx() });
  t.after(strict.close);
  const b = await wxUser(strict);
  const r = await upload(strict, b.token, big);
  assert.equal(r.status, 400);
  assert.match(r.json.error.msg, /太大/);
});

test('昵称：msgSecCheck 返回 61010（用户近两小时没打开过小程序，直接调接口）→ on 与 strict 都拒绝，不放行（LS-4）', async (t) => {
  for (const secCheck of ['on', 'strict']) {
    const s = await startHttp({ config: { wx: WX, secCheck }, fetch: fakeWx({ msgErrcode: 61010 }) });
    t.after(s.close);
    const { token } = await wxUser(s);
    const r = await s.api('PUT', '/api/me/profile', { token, body: { nickname: '随便什么' } });
    assert.equal(r.status, 400, secCheck);
    assert.equal(r.json.error.code, 'sec_check_retry');
    assert.match(r.json.error.msg, /重新打开小程序/);
    assert.equal(s.repos.users.findById(1).nickname, '', '没有保存');
  }
  // 微信那边的错误（如 -1 系统繁忙）仍按模式处理：on 放行
  const busy = await startHttp({ config: { wx: WX }, fetch: fakeWx({ msgErrcode: -1 }) });
  t.after(busy.close);
  const b = await wxUser(busy);
  assert.equal((await busy.api('PUT', '/api/me/profile', { token: b.token, body: { nickname: '棋手' } })).status, 200);
});

test('内容安全检测失败时两种模式都在日志里记下微信的 errcode；strict 的 503 日志带上原因（LS-6）', async (t) => {
  const logs = [];
  const logger = {
    debug: () => {},
    info: () => {},
    warn: (...a) => logs.push(['warn', ...a].join(' ')),
    error: (...a) => logs.push(['error', ...a].join(' ')),
  };
  const strict = await startHttp({ config: { wx: WX, secCheck: 'strict' }, fetch: fakeWx({ msgErrcode: 40164 }), logger });
  t.after(strict.close);
  const a = await wxUser(strict);
  const r = await strict.api('PUT', '/api/me/profile', { token: a.token, body: { nickname: '棋手' } });
  assert.equal(r.status, 503);
  assert.ok(logs.some((l) => l.startsWith('warn') && l.includes('40164')), `warn 日志应含 errcode：${logs.join('\n')}`);
  assert.ok(logs.some((l) => l.startsWith('error') && l.includes('40164')), `503 的 error 日志应含原因：${logs.join('\n')}`);

  logs.length = 0;
  const on = await startHttp({ config: { wx: WX }, fetch: fakeWx({ msgErrcode: 45009 }), logger });
  t.after(on.close);
  const b = await wxUser(on);
  assert.equal((await on.api('PUT', '/api/me/profile', { token: b.token, body: { nickname: '棋手' } })).status, 200);
  assert.ok(logs.some((l) => l.includes('45009')));
});

test('头像：结尾是一串 FF 填充字节的畸形 JPEG → 400（不是 500，也不记错误堆栈）（LS-7）', async (t) => {
  const logs = [];
  const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: (...a) => logs.push(a.join(' ')) };
  const s = await startHttp({ config: { devLogin: true }, logger });
  t.after(s.close);
  const { token } = await s.devLogin('device_ff01');
  for (const hex of ['ffd8ffffffffffe0', 'ffd8ffffffffffffffffe000', 'ffd8ffe0']) {
    const r = await upload(s, token, Buffer.from(hex, 'hex'));
    assert.equal(r.status, 400, hex);
    assert.equal(r.json.error.code, 'bad_request');
  }
  assert.deepEqual(logs, []);
});
