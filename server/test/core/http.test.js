'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DAY, T0, startHttp, rawRequest, insertRanked, gameId, PNG_BYTES, JPEG_BYTES, jpegOf, pngOf } = require('./helpers');

const DEV = { devLogin: true };

function wxFetch(handler) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(new URL(url));
    const body = handler(new URL(url));
    return new Response(JSON.stringify(body), { status: 200 });
  };
  fetch.calls = calls;
  return fetch;
}

async function uploadAvatar(s, token, bytes, { field = 'file', filename = 'a.png', type = 'image/png' } = {}) {
  const fd = new FormData();
  fd.append(field, new Blob([bytes], { type }), filename);
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const res = await fetch(`${s.base}/api/me/avatar`, { method: 'POST', body: fd, headers });
  return { status: res.status, json: await res.json().catch(() => null) };
}

// ---------- 基础 ----------

test('GET /healthz；未知路径 404；方法不对 405', async (t) => {
  const s = await startHttp();
  t.after(s.close);
  const h = await s.api('GET', '/healthz');
  assert.equal(h.status, 200);
  assert.deepEqual(h.json, { ok: true });
  assert.match(h.headers.get('content-type'), /^application\/json/);
  assert.equal(h.headers.get('cache-control'), 'no-store');

  const nf = await s.api('GET', '/api/nope');
  assert.equal(nf.status, 404);
  assert.equal(nf.json.error.code, 'not_found');
  assert.equal(typeof nf.json.error.msg, 'string');

  const m = await s.api('DELETE', '/api/me');
  assert.equal(m.status, 405);
  assert.equal(m.json.error.code, 'method_not_allowed');
  assert.match(m.headers.get('allow'), /GET/);

  const head = await rawRequest(s.port, 'HEAD', '/healthz');
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
});

// ---------- 开发登录 ----------

test('dev-login：未开启时 404（不读请求体）', async (t) => {
  const s = await startHttp();
  t.after(s.close);
  const r = await s.api('POST', '/api/auth/dev-login', { body: { deviceId: 'abcdefgh' } });
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, 'not_found');
  const r2 = await s.api('POST', '/api/auth/dev-login', { raw: '{bad', headers: { 'content-type': 'application/json' } });
  assert.equal(r2.status, 404);
});

test('dev-login：开启后发令牌，同一设备同一用户，deviceId 校验', async (t) => {
  const s = await startHttp({ config: DEV });
  t.after(s.close);
  const r = await s.api('POST', '/api/auth/dev-login', { body: { deviceId: 'device_0001' } });
  assert.equal(r.status, 200);
  assert.match(r.json.token, /^[0-9a-f]{64}$/);
  assert.deepEqual(r.json.user, { id: 1, nickname: '', avatarUrl: '' });
  assert.equal(r.json.needProfile, true);
  assert.equal(s.repos.users.findById(1).openid, 'dev:device_0001');

  s.now.advance(5000);
  const again = await s.api('POST', '/api/auth/dev-login', { body: { deviceId: 'device_0001' } });
  assert.equal(again.json.user.id, 1);
  assert.notEqual(again.json.token, r.json.token);
  assert.equal(s.repos.users.findById(1).lastLoginAt, T0 + 5000);

  for (const deviceId of ['short', 'x'.repeat(65), 'has space1', 'bad/char!', 12345678, null, undefined]) {
    const b = await s.api('POST', '/api/auth/dev-login', { body: { deviceId } });
    assert.equal(b.status, 400, String(deviceId));
    assert.equal(b.json.error.code, 'bad_request');
  }
});

// ---------- 微信登录 ----------

test('login：未配置 AppID/AppSecret → 503 wx_not_configured', async (t) => {
  const s = await startHttp({ config: { wx: { appId: 'wxid', secret: '' } } });
  t.after(s.close);
  const r = await s.api('POST', '/api/auth/login', { body: { code: 'abc' } });
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, 'wx_not_configured');
});

test('login：code 换 openid → 查找或创建用户 → 发令牌', async (t) => {
  const fetch = wxFetch((u) => ({ openid: `o-${u.searchParams.get('js_code')}`, session_key: 'k' }));
  const s = await startHttp({ config: { wx: { appId: 'wxid', secret: 'sec' } }, fetch });
  t.after(s.close);
  const r = await s.api('POST', '/api/auth/login', { body: { code: 'c1' } });
  assert.equal(r.status, 200);
  assert.match(r.json.token, /^[0-9a-f]{64}$/);
  assert.deepEqual(r.json.user, { id: 1, nickname: '', avatarUrl: '' });
  assert.equal(r.json.needProfile, true);
  assert.equal(fetch.calls[0].searchParams.get('appid'), 'wxid');
  assert.equal(fetch.calls[0].searchParams.get('secret'), 'sec');
  assert.equal(s.repos.users.findById(1).openid, 'o-c1');

  // 同一 openid 再登录是同一用户；设置过昵称后 needProfile=false
  s.repos.users.updateProfile(1, { nickname: '老王' }, T0);
  const r2 = await s.api('POST', '/api/auth/login', { body: { code: 'c1' } });
  assert.equal(r2.json.user.id, 1);
  assert.equal(r2.json.user.nickname, '老王');
  assert.equal(r2.json.needProfile, false);
  const r3 = await s.api('POST', '/api/auth/login', { body: { code: 'c2' } });
  assert.equal(r3.json.user.id, 2);

  const me = await s.api('GET', '/api/me', { token: r.json.token });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.id, 1);

  // dev-login 在未开启时仍不可用
  assert.equal((await s.api('POST', '/api/auth/dev-login', { body: { deviceId: 'abcdefgh' } })).status, 404);
});

test('login：微信返回错误 → 502 wx_login_failed；参数与请求体错误', async (t) => {
  const fetch = wxFetch(() => ({ errcode: 40029, errmsg: 'invalid code' }));
  const s = await startHttp({ config: { wx: { appId: 'wxid', secret: 'sec' } }, fetch });
  t.after(s.close);
  const r = await s.api('POST', '/api/auth/login', { body: { code: 'bad' } });
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, 'wx_login_failed');
  assert.match(r.json.error.msg, /登录凭证无效/);
  assert.equal(s.repos.users.findById(1), null);

  assert.equal((await s.api('POST', '/api/auth/login', { body: {} })).status, 400);
  assert.equal((await s.api('POST', '/api/auth/login', { body: { code: 'has space' } })).status, 400);
  assert.equal((await s.api('POST', '/api/auth/login', { body: { code: 42 } })).status, 400);
  const badJson = await s.api('POST', '/api/auth/login', { raw: '{"code":', headers: { 'content-type': 'application/json' } });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.json.error.code, 'bad_request');
  const arr = await s.api('POST', '/api/auth/login', { body: ['code'] });
  assert.equal(arr.status, 400);
  const form = await s.api('POST', '/api/auth/login', { raw: 'code=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(form.status, 415);
  assert.equal(form.json.error.code, 'unsupported_media_type');
  const big = await s.api('POST', '/api/auth/login', { body: { code: 'a', pad: 'x'.repeat(17 * 1024) } });
  assert.equal(big.status, 413);
  assert.equal(big.json.error.code, 'too_large');
  // 服务仍然正常
  assert.equal((await s.api('GET', '/healthz')).status, 200);
});

test('login：网络错误也返回 502', async (t) => {
  const fetch = async () => {
    throw new TypeError('fetch failed');
  };
  const s = await startHttp({ config: { wx: { appId: 'wxid', secret: 'sec' } }, fetch });
  t.after(s.close);
  const r = await s.api('POST', '/api/auth/login', { body: { code: 'c' } });
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, 'wx_login_failed');
});

// ---------- 鉴权 ----------

test('鉴权：缺失、格式错误、无效、过期的令牌都返回 401', async (t) => {
  const s = await startHttp({ config: DEV });
  t.after(s.close);
  const { token } = await s.devLogin('device_0001');
  const protectedPaths = [
    ['GET', '/api/me'],
    ['PUT', '/api/me/profile'],
    ['POST', '/api/me/avatar'],
    ['GET', '/api/leaderboard'],
    ['GET', '/api/games'],
    ['GET', '/api/games/abc'],
  ];
  for (const [method, p] of protectedPaths) {
    const r = await s.api(method, p);
    assert.equal(r.status, 401, `${method} ${p}`);
    assert.equal(r.json.error.code, 'unauthorized');
  }
  for (const header of [token, `Basic ${token}`, 'Bearer', `Bearer ${'0'.repeat(64)}`, `Bearer ${token}x`]) {
    const r = await s.api('GET', '/api/me', { headers: { authorization: header } });
    assert.equal(r.status, 401, header);
  }
  assert.equal((await s.api('GET', '/api/me', { headers: { authorization: `bearer  ${token}` } })).status, 200);

  // 30 天未使用 → 过期
  s.now.advance(30 * DAY);
  const expired = await s.api('GET', '/api/me', { token });
  assert.equal(expired.status, 401);
  assert.equal(expired.json.error.code, 'unauthorized');
});

test('鉴权：使用中的令牌滑动续期', async (t) => {
  const s = await startHttp({ config: DEV });
  t.after(s.close);
  const { token } = await s.devLogin('device_0001');
  s.now.advance(20 * DAY);
  assert.equal((await s.api('GET', '/api/me', { token })).status, 200);
  s.now.advance(20 * DAY); // 距登录 40 天，续期后仍有效
  assert.equal((await s.api('GET', '/api/me', { token })).status, 200);
});

// ---------- /api/me ----------

test('GET /api/me：用户、needProfile、排位统计、人机战绩、进行中的对局', async (t) => {
  const active = new Map();
  const s = await startHttp({ config: DEV, getActiveGames: (uid) => active.get(uid) || [] });
  t.after(s.close);
  const a = await s.devLogin('device_000a');
  const b = await s.devLogin('device_000b');
  active.set(a.user.id, [
    { id: 'game00000001', mode: 'ranked' },
    { id: 'game00000002', mode: 'ai' },
  ]);

  // 一局排位（a 胜）与两局人机（a 一胜一负）
  const gid = insertRanked(s.repos, a.user.id, b.user.id, T0);
  s.repos.games.finish(gid, { winner: 1, reason: 'resign' }, T0 + 1);
  s.repos.stats.applyRanked({ gameId: gid, winnerId: a.user.id, loserId: b.user.id }, T0 + 1);
  for (const winner of [1, 2]) {
    const id = gameId();
    s.repos.games.insert({ id, mode: 'ai', size: 9, komi: 7.5, blackId: a.user.id, whiteId: null, aiLevel: 'k5', createdAt: T0 });
    s.repos.games.finish(id, { winner, reason: 'score', scoreBlack: 50, scoreWhite: 38.5 }, T0 + 2);
  }

  const r = await s.api('GET', '/api/me', { token: a.token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, {
    user: { id: a.user.id, nickname: '', avatarUrl: '' },
    needProfile: true,
    stats: { games: 1, wins: 1, losses: 0, draws: 0, winrate: 1, curStreak: 1, maxStreak: 1 },
    ai: { games: 2, wins: 1 },
    activeGameIds: ['game00000001', 'game00000002'],
  });
  const rb = await s.api('GET', '/api/me', { token: b.token });
  assert.deepEqual(rb.json.stats, { games: 1, wins: 0, losses: 1, draws: 0, winrate: 0, curStreak: 0, maxStreak: 0 });
  assert.deepEqual(rb.json.activeGameIds, []);
});

test('GET /api/me：getActiveGames 出错不影响返回', async (t) => {
  const s = await startHttp({
    config: DEV,
    getActiveGames: () => {
      throw new Error('boom');
    },
  });
  t.after(s.close);
  const a = await s.devLogin('device_000a');
  const r = await s.api('GET', '/api/me', { token: a.token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.activeGameIds, []);
});

// ---------- 资料 ----------

test('PUT /api/me/profile：去首尾空白、按码点计长度、禁止控制字符', async (t) => {
  const s = await startHttp({ config: DEV });
  t.after(s.close);
  const { token } = await s.devLogin('device_0001');
  const put = (nickname) => s.api('PUT', '/api/me/profile', { token, body: { nickname } });

  const ok = await put('  小明  ');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { user: { id: 1, nickname: '小明', avatarUrl: '' } });
  assert.equal((await s.api('GET', '/api/me', { token })).json.needProfile, false);

  const emoji16 = String.fromCodePoint(0x1f600).repeat(16); // 16 个码点、32 个 UTF-16 单元
  assert.equal((await put(emoji16)).status, 200);
  assert.equal((await put('一二三四五六七八九十一二三四五六')).status, 200);
  assert.equal((await put('a')).status, 200);
  // 组合 emoji（含零宽连接符）允许
  const family = [0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467].map((c) => String.fromCodePoint(c)).join('');
  assert.equal((await put(family)).json.user.nickname, family);

  const bad = [
    '',
    '   ',
    '一二三四五六七八九十一二三四五六七',
    String.fromCodePoint(0x1f600).repeat(17),
    'a' + String.fromCharCode(0) + 'b',
    'a' + String.fromCharCode(7) + 'b',
    'tab' + String.fromCharCode(9) + 'in',
    'nl' + String.fromCharCode(10) + 'in',
    'del' + String.fromCharCode(0x7f),
    'c1' + String.fromCharCode(0x85),
    'rtl' + String.fromCharCode(0x202e) + 'x',
    'zw' + String.fromCharCode(0x200b) + 'x',
    'ls' + String.fromCharCode(0x2028) + 'x',
    'bom' + String.fromCharCode(0xfeff) + 'x',
    'lone' + String.fromCharCode(0xd800),
    123,
    null,
    ['a'],
  ];
  for (const nickname of bad) {
    const r = await put(nickname);
    assert.equal(r.status, 400, JSON.stringify(nickname));
    assert.equal(r.json.error.code, 'bad_request');
  }
  assert.equal((await s.api('PUT', '/api/me/profile', { token, body: {} })).status, 400);
  assert.equal(s.repos.users.findById(1).nickname, family);
});

// ---------- 头像 ----------

test('POST /api/me/avatar：上传 PNG，静态访问，替换为 JPEG 时删除旧文件', async (t) => {
  const s = await startHttp({ config: DEV });
  t.after(s.close);
  const { token } = await s.devLogin('device_0001');

  const up = await uploadAvatar(s, token, PNG_BYTES, { type: 'application/octet-stream', filename: 'tmp_1' });
  assert.equal(up.status, 200);
  const m = /^https:\/\/go\.example\.com\/avatars\/([a-z0-9]+\.png)$/.exec(up.json.user.avatarUrl);
  assert.ok(m, up.json.user.avatarUrl);
  const first = m[1];
  const firstPath = path.join(s.config.avatarDir, first);
  assert.deepEqual(fs.readFileSync(firstPath), PNG_BYTES);
  assert.equal(s.repos.users.findById(1).avatar, first);
  assert.equal((await s.api('GET', '/api/me', { token })).json.user.avatarUrl, up.json.user.avatarUrl);

  const img = await fetch(`${s.base}/avatars/${first}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(img.headers.get('content-length'), String(PNG_BYTES.length));
  assert.match(img.headers.get('cache-control'), /max-age=\d+/);
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG_BYTES);
  const head = await rawRequest(s.port, 'HEAD', `/avatars/${first}`);
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);

  // 客户端声称是 PNG，实际是 JPEG：按魔数存成 .jpg
  const up2 = await uploadAvatar(s, token, JPEG_BYTES, { type: 'image/png', filename: 'x.png' });
  assert.equal(up2.status, 200);
  const second = /\/avatars\/([a-z0-9]+\.jpg)$/.exec(up2.json.user.avatarUrl)[1];
  assert.notEqual(second, first);
  assert.equal(fs.existsSync(firstPath), false, '旧头像应被删除');
  const img2 = await fetch(`${s.base}/avatars/${second}`);
  assert.equal(img2.headers.get('content-type'), 'image/jpeg');
  assert.equal((await fetch(`${s.base}/avatars/${first}`)).status, 404);
  assert.deepEqual(fs.readdirSync(s.config.avatarDir), [second]);
});

test('POST /api/me/avatar：非图片、超大、缺字段、非 multipart、未登录', async (t) => {
  const s = await startHttp({ config: DEV, limits: { avatarBurst: 100 } });
  t.after(s.close);
  const { token } = await s.devLogin('device_0001');

  const txt = await uploadAvatar(s, token, Buffer.from('not an image at all'), { type: 'image/png' });
  assert.equal(txt.status, 400);
  assert.equal(txt.json.error.code, 'bad_request');
  const gif = await uploadAvatar(s, token, Buffer.from('GIF89a......'), { type: 'image/gif' });
  assert.equal(gif.status, 400);
  const empty = await uploadAvatar(s, token, Buffer.alloc(0));
  assert.equal(empty.status, 400);

  const huge = Buffer.concat([PNG_BYTES, Buffer.alloc(2 * 1024 * 1024)]);
  const big = await uploadAvatar(s, token, huge);
  assert.equal(big.status, 413);
  assert.equal(big.json.error.code, 'too_large');
  // 正好 2MB 可以
  const exact = pngOf({ total: 2 * 1024 * 1024 });
  assert.equal(exact.length, 2 * 1024 * 1024);
  assert.equal((await uploadAvatar(s, token, exact)).status, 200);

  // 结构不完整：PNG 没有 IEND、JPEG 没有帧头 / 没有 EOI、只有魔数
  const truncated = await uploadAvatar(s, token, PNG_BYTES.subarray(0, PNG_BYTES.length - 12));
  assert.equal(truncated.status, 400);
  assert.match(truncated.json.error.msg, /不完整|损坏/);
  const noSof = Buffer.concat([JPEG_BYTES.subarray(0, 20), JPEG_BYTES.subarray(33)]);
  assert.equal((await uploadAvatar(s, token, noSof, { type: 'image/jpeg' })).status, 400);
  assert.equal((await uploadAvatar(s, token, JPEG_BYTES.subarray(0, JPEG_BYTES.length - 2), { type: 'image/jpeg' })).status, 400);
  assert.equal((await uploadAvatar(s, token, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))).status, 400);
  // 宽高超过 2048：解压炸弹（文件很小、解码后极大）
  const bomb = await uploadAvatar(s, token, pngOf({ width: 30000, height: 30000 }));
  assert.equal(bomb.status, 400);
  assert.match(bomb.json.error.msg, /尺寸/);
  assert.equal((await uploadAvatar(s, token, jpegOf(4000, 100), { type: 'image/jpeg' })).status, 400);
  assert.equal((await uploadAvatar(s, token, pngOf({ width: 2048, height: 2048 }))).status, 200);

  const wrongField = await uploadAvatar(s, token, PNG_BYTES, { field: 'image' });
  assert.equal(wrongField.status, 400);
  assert.match(wrongField.json.error.msg, /file/);

  const json = await s.api('POST', '/api/me/avatar', { token, body: { file: 'x' } });
  assert.equal(json.status, 415);
  const broken = await s.api('POST', '/api/me/avatar', {
    token,
    raw: 'garbage',
    headers: { 'content-type': 'multipart/form-data; boundary=zzz' },
  });
  assert.equal(broken.status, 400);

  const anon = await uploadAvatar(s, null, PNG_BYTES);
  assert.equal(anon.status, 401);
  // 失败的上传不留文件（只有最后一次成功上传的那张）
  assert.equal(fs.readdirSync(s.config.avatarDir).length, 1);
  assert.equal((await s.api('GET', '/healthz')).status, 200);
});

test('POST /api/me/avatar：wx.uploadFile 风格的原始 multipart', async (t) => {
  const s = await startHttp({ config: DEV });
  t.after(s.close);
  const { token } = await s.devLogin('device_0001');
  const b = '----WebKitFormBoundaryWX12345';
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="user"\r\n\r\n1\r\n`),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="wxfile://tmp_abc.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    JPEG_BYTES,
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  const r = await s.api('POST', '/api/me/avatar', { token, raw: body, headers: { 'content-type': `multipart/form-data; boundary=${b}` } });
  assert.equal(r.status, 200);
  assert.match(r.json.user.avatarUrl, /\/avatars\/[a-z0-9]+\.jpg$/);
});

test('GET /avatars/：严格文件名，拒绝路径穿越', async (t) => {
  const s = await startHttp({ config: DEV });
  t.after(s.close);
  fs.mkdirSync(s.config.avatarDir, { recursive: true });
  fs.writeFileSync(path.join(s.config.avatarDir, 'abc123.png'), PNG_BYTES);
  fs.writeFileSync(path.join(s.config.avatarDir, 'UPPER.png'), PNG_BYTES);
  fs.writeFileSync(path.join(s.config.avatarDir, 'x.gif'), PNG_BYTES);
  fs.mkdirSync(path.join(s.config.avatarDir, 'dir.png'));
  fs.writeFileSync(path.join(s.config.dataDir, 'secret.png'), 'secret');
  fs.writeFileSync(path.join(s.config.dataDir, 'gamego.db'), 'db');

  assert.equal((await rawRequest(s.port, 'GET', '/avatars/abc123.png')).status, 200);
  const attempts = [
    '/avatars/../secret.png',
    '/avatars/..%2Fsecret.png',
    '/avatars/%2e%2e%2fsecret.png',
    '/avatars/..%5Csecret.png',
    '/avatars/..\\secret.png',
    '/avatars/%2E%2E/gamego.db',
    '/avatars/../gamego.db',
    '/avatars//etc/passwd',
    '/avatars/UPPER.png',
    '/avatars/x.gif',
    '/avatars/abc123.PNG',
    '/avatars/abc123.png%00.png',
    '/avatars/dir.png',
    '/avatars/missing.png',
    '/avatars/',
    '/avatars/a/b.png',
  ];
  for (const p of attempts) {
    const r = await rawRequest(s.port, 'GET', p);
    assert.equal(r.status, 404, p);
    assert.ok(!r.body.toString().includes('secret'), p);
  }
});

test('请求体：分块传输（无 Content-Length）超限也返回 413；客户端中途断开不影响服务', async (t) => {
  const http = require('node:http');
  const s = await startHttp({ config: DEV });
  t.after(s.close);

  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: s.port, method: 'POST', path: '/api/auth/dev-login', headers: { 'content-type': 'application/json' } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('error', (err) => (err.code === 'ECONNRESET' || err.code === 'EPIPE' ? resolve('reset') : reject(err)));
    req.write('{"deviceId":"abcdefgh","pad":"');
    for (let i = 0; i < 20; i++) req.write('x'.repeat(1024));
    req.end('"}');
  });
  assert.ok(status === 413 || status === 'reset', String(status));

  // 上传到一半断开
  const { token } = await s.devLogin('device_0001');
  await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: s.port,
      method: 'POST',
      path: '/api/me/avatar',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'multipart/form-data; boundary=abc',
        'content-length': 100000,
      },
    });
    req.on('error', () => resolve());
    req.write('--abc\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\n\r\n');
    setTimeout(() => {
      req.destroy();
      resolve();
    }, 50);
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await s.api('GET', '/healthz')).status, 200);
  assert.equal(s.repos.users.findById(1).avatar, '');
});

test('POST /api/me/avatar：同一用户并发上传，最后只保留一个文件', async (t) => {
  const s = await startHttp({ config: DEV });
  t.after(s.close);
  const { token } = await s.devLogin('device_0001');
  const results = await Promise.all([uploadAvatar(s, token, PNG_BYTES), uploadAvatar(s, token, JPEG_BYTES), uploadAvatar(s, token, PNG_BYTES)]);
  for (const r of results) assert.equal(r.status, 200);
  const files = fs.readdirSync(s.config.avatarDir);
  assert.equal(files.length, 1);
  assert.equal(s.repos.users.findById(1).avatar, files[0]);
});

// ---------- 排行榜 ----------

test('GET /api/leaderboard：三种榜、我的名次、上榜局数、参数校验', async (t) => {
  const s = await startHttp({ config: { ...DEV, minGamesWinrate: 2 } });
  t.after(s.close);
  const a = await s.devLogin('device_000a');
  const b = await s.devLogin('device_000b');
  const c = await s.devLogin('device_000c');
  s.repos.users.updateProfile(a.user.id, { nickname: '甲', avatar: 'aa11.png' }, T0);
  let now = T0;
  const play = (w, l) => {
    const id = insertRanked(s.repos, w, l, (now += 1000));
    s.repos.stats.applyRanked({ gameId: id, winnerId: w, loserId: l }, now);
  };
  play(a.user.id, b.user.id);
  play(a.user.id, b.user.id);
  play(b.user.id, c.user.id);

  const streak = await s.api('GET', '/api/leaderboard?type=streak', { token: c.token });
  assert.equal(streak.status, 200);
  assert.deepEqual(streak.json, {
    type: 'streak',
    items: [
      { rank: 1, userId: a.user.id, nickname: '甲', avatarUrl: 'https://go.example.com/avatars/aa11.png', value: 2, games: 2, wins: 2 },
      { rank: 2, userId: b.user.id, nickname: '', avatarUrl: '', value: 1, games: 3, wins: 1 },
    ],
    me: { rank: null, value: 0, games: 1, wins: 0, need: 0 },
    minGames: 2,
  });

  const def = await s.api('GET', '/api/leaderboard', { token: a.token });
  assert.equal(def.json.type, 'streak');
  assert.equal(def.json.me.rank, 1);

  const max = await s.api('GET', '/api/leaderboard?type=maxStreak&limit=1', { token: b.token });
  assert.deepEqual(
    max.json.items.map((it) => it.userId),
    [a.user.id],
  );
  assert.deepEqual(max.json.me, { rank: 2, value: 1, games: 3, wins: 1, need: 0 });

  const wr = await s.api('GET', '/api/leaderboard?type=winrate', { token: c.token });
  assert.deepEqual(
    wr.json.items.map((it) => [it.userId, it.value]),
    [
      [a.user.id, 1],
      [b.user.id, 1 / 3],
    ],
  );
  assert.deepEqual(wr.json.me, { rank: null, value: 0, games: 1, wins: 0, need: 1 });

  assert.equal((await s.api('GET', '/api/leaderboard?type=elo', { token: a.token })).status, 400);
  assert.equal((await s.api('GET', '/api/leaderboard?limit=abc', { token: a.token })).status, 400);
  assert.equal((await s.api('GET', '/api/leaderboard?limit=-1', { token: a.token })).status, 400);
  const clamped = await s.api('GET', '/api/leaderboard?limit=100000', { token: a.token });
  assert.equal(clamped.status, 200);
});

// ---------- 对局列表与棋谱 ----------

function seedGames(repos, me, opp) {
  const ids = {};
  // 排位：me 执白获胜（数子）
  ids.ranked = insertRanked(repos, opp, me, T0 + 1000);
  repos.games.finish(ids.ranked, { moves: [40, 41, -1, -1], dead: [41], winner: 2, reason: 'score', scoreBlack: 30, scoreWhite: 51.5, cause: 'agreed' }, T0 + 1500);
  // 好友：作废
  ids.friend = gameId();
  repos.games.insert({ id: ids.friend, mode: 'friend', size: 13, komi: 7.5, blackId: me, whiteId: opp, createdAt: T0 + 2000 });
  repos.games.finish(ids.friend, { winner: 0, reason: 'abort', cause: 'first_move' }, T0 + 2500);
  // 人机：me 执黑认输
  ids.ai = gameId();
  repos.games.insert({ id: ids.ai, mode: 'ai', size: 19, komi: 7.5, blackId: me, whiteId: null, aiLevel: 'k5', moves: [60], createdAt: T0 + 3000 });
  repos.games.finish(ids.ai, { winner: 2, reason: 'resign' }, T0 + 3500);
  // 人机：未知难度 id
  ids.ai2 = gameId();
  repos.games.insert({ id: ids.ai2, mode: 'ai', size: 9, komi: 7, blackId: null, whiteId: me, aiLevel: 'dan9', createdAt: T0 + 4000 });
  repos.games.finish(ids.ai2, { winner: 0, reason: 'score', scoreBlack: 40, scoreWhite: 40 }, T0 + 4500);
  // 进行中：不出现在列表里
  ids.playing = insertRanked(repos, me, opp, T0 + 5000);
  return ids;
}

test('GET /api/games：GameSummary 字段、只含已结束、倒序、游标分页', async (t) => {
  const s = await startHttp({ config: DEV });
  t.after(s.close);
  const me = await s.devLogin('device_00me');
  const opp = await s.devLogin('device_0opp');
  s.repos.users.updateProfile(opp.user.id, { nickname: '对手', avatar: 'bb22.jpg' }, T0);
  const ids = seedGames(s.repos, me.user.id, opp.user.id);

  const r = await s.api('GET', '/api/games', { token: me.token });
  assert.equal(r.status, 200);
  assert.equal(r.json.next, null);
  assert.deepEqual(
    r.json.items.map((g) => g.id),
    [ids.ai2, ids.ai, ids.friend, ids.ranked],
  );
  const [ai2, ai, friend, ranked] = r.json.items;
  assert.deepEqual(ranked, {
    id: ids.ranked,
    mode: 'ranked',
    size: 9,
    status: 'ended',
    myColor: 2,
    opponent: { id: opp.user.id, nickname: '对手', avatarUrl: 'https://go.example.com/avatars/bb22.jpg' },
    winner: 2,
    reason: 'score',
    cause: 'agreed',
    resultText: 'W+21.5',
    myResult: 'win',
    moveCount: 4,
    createdAt: T0 + 1000,
    endedAt: T0 + 1500,
  });
  assert.equal(friend.myColor, 1);
  assert.equal(friend.cause, 'first_move', '作废的细分原因');
  assert.equal(ai.cause, null);
  assert.equal(friend.myResult, 'void');
  assert.equal(friend.resultText, 'Void');
  assert.deepEqual(ai.opponent, { ai: true, level: 'k5', levelName: '5级' });
  assert.equal(ai.myResult, 'loss');
  assert.equal(ai.resultText, 'W+R');
  assert.equal(ai.moveCount, 1);
  assert.deepEqual(ai2.opponent, { ai: true, level: 'dan9', levelName: 'dan9' });
  assert.equal(ai2.myColor, 2);
  assert.equal(ai2.myResult, 'draw');

  // 分页
  const p1 = await s.api('GET', '/api/games?limit=3', { token: me.token });
  assert.equal(p1.json.items.length, 3);
  assert.equal(p1.json.next, T0 + 2000);
  const p2 = await s.api('GET', `/api/games?limit=3&before=${p1.json.next}`, { token: me.token });
  assert.deepEqual(
    p2.json.items.map((g) => g.id),
    [ids.ranked],
  );
  assert.equal(p2.json.next, null);
  const exact = await s.api('GET', '/api/games?limit=4', { token: me.token });
  assert.equal(exact.json.next, null);

  // 对手视角
  const o = await s.api('GET', '/api/games', { token: opp.token });
  assert.deepEqual(
    o.json.items.map((g) => [g.id, g.myColor, g.myResult]),
    [
      [ids.friend, 2, 'void'],
      [ids.ranked, 1, 'loss'],
    ],
  );
  assert.deepEqual(o.json.items[1].opponent, { id: me.user.id, nickname: '', avatarUrl: '' });

  assert.equal((await s.api('GET', '/api/games?before=abc', { token: me.token })).status, 400);
  assert.equal((await s.api('GET', '/api/games?limit=0', { token: me.token })).json.items.length, 1);
});

test('GET /api/games/:id：GameRecord，只有参与者能看', async (t) => {
  const s = await startHttp({ config: DEV });
  t.after(s.close);
  const me = await s.devLogin('device_00me');
  const opp = await s.devLogin('device_0opp');
  const other = await s.devLogin('device_other');
  s.repos.users.updateProfile(opp.user.id, { nickname: '对手', avatar: 'bb22.jpg' }, T0);
  s.repos.users.updateProfile(me.user.id, { nickname: '我' }, T0);
  const ids = seedGames(s.repos, me.user.id, opp.user.id);

  const r = await s.api('GET', `/api/games/${ids.ranked}`, { token: me.token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, {
    id: ids.ranked,
    mode: 'ranked',
    size: 9,
    status: 'ended',
    myColor: 2,
    opponent: { id: opp.user.id, nickname: '对手', avatarUrl: 'https://go.example.com/avatars/bb22.jpg' },
    winner: 2,
    reason: 'score',
    cause: 'agreed',
    resultText: 'W+21.5',
    myResult: 'win',
    moveCount: 4,
    createdAt: T0 + 1000,
    endedAt: T0 + 1500,
    komi: 7.5,
    moves: [40, 41, -1, -1],
    dead: [41],
    players: {
      1: { userId: opp.user.id, nickname: '对手', avatarUrl: 'https://go.example.com/avatars/bb22.jpg' },
      2: { userId: me.user.id, nickname: '我', avatarUrl: '' },
    },
    scoreBlack: 30,
    scoreWhite: 51.5,
  });

  const ai = await s.api('GET', `/api/games/${ids.ai}`, { token: me.token });
  assert.deepEqual(ai.json.players, {
    1: { userId: me.user.id, nickname: '我', avatarUrl: '' },
    2: { ai: true, level: 'k5', nickname: 'AI · 5级', avatarUrl: '' },
  });
  assert.deepEqual(ai.json.dead, []);
  assert.equal(ai.json.scoreBlack, null);

  // 进行中的对局参与者也能看（status 为 playing，myResult 为 null）
  const playing = await s.api('GET', `/api/games/${ids.playing}`, { token: me.token });
  assert.equal(playing.status, 200);
  assert.equal(playing.json.status, 'playing');
  assert.equal(playing.json.myResult, null);

  for (const p of [`/api/games/${ids.ranked}`, `/api/games/${ids.ai}`]) {
    const r2 = await s.api('GET', p, { token: other.token });
    assert.equal(r2.status, 404, p);
    assert.equal(r2.json.error.code, 'not_found');
  }
  assert.equal((await s.api('GET', '/api/games/nonexistent01', { token: me.token })).status, 404);
  assert.equal((await s.api('GET', '/api/games/%2e%2e', { token: me.token })).status, 404);
  assert.equal((await s.api('GET', `/api/games/${'x'.repeat(100)}`, { token: me.token })).status, 404);
});

// ---------- AI 难度 ----------

test('GET /api/ai/levels：来自 ai.levels()/ai.available()，无需登录', async (t) => {
  const s = await startHttp();
  t.after(s.close);
  const r = await s.api('GET', '/api/ai/levels');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { available: true, levels: [{ id: 'k5', name: '5级', desc: '' }] });

  const off = await startHttp({
    ai: { available: () => false, levels: () => [{ id: 'k1', name: '1级', desc: '较强', extra: 1 }] },
  });
  t.after(off.close);
  assert.deepEqual((await off.api('GET', '/api/ai/levels')).json, {
    available: false,
    levels: [{ id: 'k1', name: '1级', desc: '较强' }],
  });

  const none = await startHttp({ ai: null });
  t.after(none.close);
  assert.deepEqual((await none.api('GET', '/api/ai/levels')).json, { available: false, levels: [] });

  const broken = await startHttp({
    ai: {
      available: () => true,
      levels: () => {
        throw new Error('boom');
      },
    },
  });
  t.after(broken.close);
  const b = await broken.api('GET', '/api/ai/levels');
  assert.equal(b.status, 500);
  assert.deepEqual(b.json, { error: { code: 'internal', msg: '服务器内部错误' } });
});
