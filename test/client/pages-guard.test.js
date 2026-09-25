'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const h = require('./pages-harness');

const guard = require(path.join(h.MINI_ROOT, 'utils', 'guard'));

test('errorText：错误码映射、wx 失败信息、服务端中文信息、兜底', () => {
  assert.equal(guard.errorText({ code: 'offline' }), '网络未连接，请检查网络后重试');
  assert.equal(guard.errorText({ code: 'room_not_found', msg: 'room not found' }), '房间不存在或已失效');
  assert.equal(guard.errorText({ errMsg: 'request:fail timeout' }), '请求超时，请稍后重试');
  assert.equal(guard.errorText({ errMsg: 'uploadFile:fail ssl hand shake error' }), '网络异常，请检查网络后重试');
  assert.equal(guard.errorText({ code: 'bad_nickname', msg: '昵称包含敏感词' }), '昵称包含敏感词');
  assert.equal(guard.errorText({ code: 'weird', msg: 'something english' }, '保存失败'), '保存失败');
  assert.equal(guard.errorText(new Error('boom')), '操作失败，请稍后重试');
  assert.equal(guard.errorText(null, '兜底'), '兜底');
  assert.equal(guard.errorText('中文错误'), '中文错误');
  assert.equal(guard.errorText('english'), '操作失败，请稍后重试');
  assert.equal(guard.errorText({ code: 'toString' }), '操作失败，请稍后重试', '不会命中原型链上的键');
  assert.equal(guard.errorText({ msg: '很长'.repeat(30) }, '兜底'), '兜底', '过长的服务端信息不直接展示');
});

test('errorText：服务端的具体中文说明优先于按错误码的通用提示；网络层与笼统的错误用本地提示', () => {
  assert.equal(guard.errorText({ code: 'bad_request', msg: '昵称不能包含控制字符' }), '昵称不能包含控制字符');
  assert.equal(guard.errorText({ code: 'bad_request', msg: '头像只支持 PNG 或 JPEG 图片', status: 400 }), '头像只支持 PNG 或 JPEG 图片');
  assert.equal(guard.errorText({ code: 'bad_request', msg: 'bad json' }), '请求参数有误', '英文信息仍用通用提示');
  assert.equal(guard.errorText({ code: 'in_game', msg: '你还有一局棋没下完' }), '你还有一局棋没下完');
  assert.equal(guard.errorText({ code: 'offline', msg: '未连接到服务器' }), '网络未连接，请检查网络后重试');
  assert.equal(guard.errorText({ code: 'timeout', msg: '服务器响应超时' }), '请求超时，请稍后重试');
  assert.equal(guard.errorText({ code: 'kicked', msg: '账号已在其他设备登录' }), '账号已在其他设备登录');
  assert.equal(guard.errorText({ code: 'internal', msg: '服务器内部错误' }), '服务器开小差了，请稍后再试');
  assert.equal(guard.errorText({ code: 'login_unavailable', msg: '服务器未配置微信登录，也未开启开发登录' }), '服务器未配置微信登录，也未开启开发登录');
});

test('profileUrl 对 redirect 编码', () => {
  assert.equal(guard.profileUrl(''), '/pages/profile/profile');
  assert.equal(guard.profileUrl('/pages/room/room?create=1&size=9&color=black'),
    '/pages/profile/profile?redirect=%2Fpages%2Froom%2Froom%3Fcreate%3D1%26size%3D9%26color%3Dblack');
});

test('requireProfile：已有昵称 → true，不跳转', async () => {
  const wx = h.createFakeWx();
  const auth = h.createFakeAuth({ user: { id: 1, nickname: '甲' } });
  const ok = await guard.createGuard({ auth, wxApi: wx }).requireProfile({ redirect: '/pages/ai/ai' });
  assert.equal(ok, true);
  assert.equal(auth.loginCalls, 1);
  assert.equal(wx.count('navigateTo'), 0);
});

test('requireProfile：没有昵称 → 打开资料页（带编码后的 redirect）并返回 false', async () => {
  const wx = h.createFakeWx();
  const auth = h.createFakeAuth({ user: { id: 1, nickname: '' } });
  const ok = await guard.createGuard({ auth, wxApi: wx }).requireProfile({ redirect: '/pages/match/match?size=9' });
  assert.equal(ok, false);
  assert.equal(wx.last('navigateTo').url, '/pages/profile/profile?redirect=' + encodeURIComponent('/pages/match/match?size=9'));
});

test('requireProfile：不传 redirect 时资料页不带参数', async () => {
  const wx = h.createFakeWx();
  const auth = h.createFakeAuth({ user: { id: 1, nickname: '' } });
  assert.equal(await guard.createGuard({ auth, wxApi: wx }).requireProfile(), false);
  assert.equal(wx.last('navigateTo').url, '/pages/profile/profile');
});

test('requireProfile：登录失败 → 提示并返回 false', async () => {
  const wx = h.createFakeWx();
  const auth = h.createFakeAuth({ loginError: { code: 'wx_login_failed', msg: 'x' } });
  const orig = console.error;
  console.error = () => {};
  try {
    assert.equal(await guard.createGuard({ auth, wxApi: wx }).requireProfile({ redirect: '/pages/ai/ai' }), false);
  } finally {
    console.error = orig;
  }
  assert.deepEqual(wx.toasts(), ['微信登录失败，请稍后重试']);
  assert.equal(wx.count('navigateTo'), 0);
});

test('requireProfile：auth 没有 needProfile 时按昵称判断；打开资料页失败时提示', async () => {
  const wx = h.createFakeWx();
  wx.failNext.navigateTo = true;
  const auth = { ensureLogin: async () => ({ id: 1, nickname: '' }) };
  const orig = console.error;
  console.error = () => {};
  try {
    assert.equal(await guard.createGuard({ auth, wxApi: wx }).requireProfile(), false);
  } finally {
    console.error = orig;
  }
  assert.deepEqual(wx.toasts(), ['请先设置头像和昵称']);
});

test('默认导出的 requireProfile 使用 utils/net/auth 与全局 wx', async () => {
  const env = h.createEnv({ user: { id: 1, nickname: '' } });
  h.setMocks({ 'net/auth': env.auth });
  global.wx = env.wx;
  assert.equal(await guard.requireProfile({ redirect: '/pages/leaderboard/leaderboard' }), false);
  assert.equal(env.wx.last('navigateTo').url, '/pages/profile/profile?redirect=' + encodeURIComponent('/pages/leaderboard/leaderboard'));
  env.auth.user = { id: 1, nickname: '有了' };
  assert.equal(await guard.requireProfile(), true);
});
