'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./pages-harness');

function setup(t, opts = {}) {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const env = h.createEnv({ user: opts.user === undefined ? { id: 1, nickname: '', avatarUrl: '' } : opts.user, loginError: opts.loginError, stackDepth: opts.stackDepth });
  env.api.route('PUT /api/me/profile', (o) => ({ user: { ...env.auth.user, nickname: o.data.nickname } }));
  env.api.uploadImpl = () => Promise.resolve({ user: { ...env.auth.user, avatarUrl: 'http://srv/avatars/abc.png' } });
  if (opts.privacy) env.wx.privacy = opts.privacy;
  const page = h.loadPage('profile/profile', env);
  return { env, page };
}

const REDIRECT = '/pages/match/match?size=9';

test('资料页：首次设置——预填、提示文字、隐私授权', async (t) => {
  const { env, page } = setup(t, { privacy: { needAuthorization: true, privacyContractName: '《围棋隐私指引》' } });
  page.onLoad({ redirect: encodeURIComponent(REDIRECT) });
  await h.flush();
  assert.equal(page.data.ready, true);
  assert.equal(page.data.firstTime, true);
  assert.equal(page.data.nickname, '');
  assert.equal(page.data.needPrivacy, true);
  assert.equal(page.data.privacyName, '《围棋隐私指引》');
  page.onOpenPrivacy();
  assert.equal(env.wx.count('openPrivacyContract'), 1);
  page.onAgreePrivacy();
  assert.equal(page.data.needPrivacy, false);
});

test('资料页：修改资料——预填已有头像昵称', async (t) => {
  const { page } = setup(t, { user: { id: 1, nickname: '老李', avatarUrl: 'http://srv/a.png' } });
  page.onLoad({});
  await h.flush();
  assert.equal(page.data.firstTime, false);
  assert.equal(page.data.nickname, '老李');
  assert.equal(page.data.count, 2);
  assert.equal(page.data.avatarSrc, 'http://srv/a.png');
  assert.equal(page.data.needPrivacy, false);
});

test('资料页：选择头像、输入昵称、审核不通过清空', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({});
  await h.flush();
  page.onChooseAvatar({ detail: {} });
  assert.deepEqual(env.wx.toasts(), ['未获取到头像，请重试']);
  page.onChooseAvatar({ detail: { avatarUrl: 'wxfile://tmp_1.png' } });
  assert.equal(page.data.avatarSrc, 'wxfile://tmp_1.png');
  assert.equal(page.data.avatarChanged, true);
  page.onNicknameInput({ detail: { value: '棋' } });
  page.onNicknameBlur({ detail: { value: ' 棋圣 ' } });
  assert.equal(page.data.nickname, ' 棋圣 ');
  assert.equal(page.data.count, 2);
  page.onNicknameReview({ detail: { pass: true, timeout: false } });
  assert.equal(page.data.nickname, ' 棋圣 ');
  page.onNicknameReview({ detail: { pass: false, timeout: true } });
  assert.equal(page.data.nickname, ' 棋圣 ', '审核超时不清空');
  page.onNicknameReview({ detail: { pass: false, timeout: false } });
  assert.equal(page.data.nickname, '');
  assert.equal(env.wx.toasts()[1], '昵称未通过微信安全检测，请换一个');
  page.onNicknameInput({});
  assert.equal(page.data.nickname, '');
});

test('资料页：开发者工具游客模式用普通输入框，昵称审核结果不清空输入；真实 AppID 仍用 type="nickname"', async (t) => {
  const tourist = setup(t);
  tourist.env.wx.getAccountInfoSync = () => ({ miniProgram: { appId: 'touristappid' } });
  tourist.page.onLoad({});
  await h.flush();
  assert.equal(tourist.page.data.touristMode, true);
  assert.equal(tourist.page.data.nicknameType, 'text');
  tourist.page.onNicknameBlur({ detail: { value: '棋手' } });
  tourist.page.onNicknameReview({ detail: { pass: false, timeout: false } });
  assert.equal(tourist.page.data.nickname, '棋手', '游客模式没有真实审核，不清空');
  await tourist.page.onSubmit({ detail: { value: { nickname: '棋手' } } });
  assert.equal(tourist.env.auth.user.nickname, '棋手');

  const real = setup(t);
  real.env.wx.getAccountInfoSync = () => ({ miniProgram: { appId: 'wx0123456789abcdef' } });
  real.page.onLoad({});
  await h.flush();
  assert.equal(real.page.data.touristMode, false);
  assert.equal(real.page.data.nicknameType, 'nickname');

  // 旧基础库没有 getAccountInfoSync，或调用抛错：按真实 AppID 处理
  const old = setup(t);
  old.env.wx.getAccountInfoSync = () => { throw new Error('not supported'); };
  old.page.onLoad({});
  await h.flush();
  assert.equal(old.page.data.nicknameType, 'nickname');
});

test('资料页：昵称校验失败不发请求', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({});
  await h.flush();
  await page.onSubmit({ detail: { value: { nickname: '   ' } } });
  assert.deepEqual(env.wx.toasts(), ['请输入昵称']);
  await page.onSubmit({ detail: { value: { nickname: '一二三四五六七八九十一二三四五六七' } } });
  assert.equal(env.wx.toasts()[1], '昵称最多 16 个字');
  assert.equal(env.api.calls.length, 0);
  assert.equal(env.api.uploads.length, 0);
});

test('资料页：保存——先上传头像再提交昵称，更新 auth，跳到 redirect', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({ redirect: encodeURIComponent(REDIRECT) });
  await h.flush();
  page.onChooseAvatar({ detail: { avatarUrl: 'wxfile://tmp_2.png' } });
  page.onNicknameInput({ detail: { value: '不一样' } });
  // 表单值（微信异步填入的昵称）优先
  await page.onSubmit({ detail: { value: { nickname: '  新名字 ' } } });
  assert.deepEqual(env.api.uploads, ['wxfile://tmp_2.png']);
  const put = env.api.callsTo('PUT /api/me/profile');
  assert.equal(put.length, 1);
  assert.deepEqual(put[0].data, { nickname: '新名字' });
  assert.equal(env.auth.user.nickname, '新名字');
  assert.equal(env.auth.user.avatarUrl, 'http://srv/avatars/abc.png');
  assert.equal(env.auth.setUserCalls.length, 2);
  assert.equal(env.wx.count('showLoading'), 1);
  assert.equal(env.wx.count('hideLoading'), 1);
  assert.equal(env.wx.last('redirectTo').url, REDIRECT);
  assert.equal(env.wx.count('navigateBack'), 0);
});

test('资料页：没有 redirect 时返回上一页；页面栈只有一页时回首页', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({});
  await h.flush();
  await page.onSubmit({ detail: { value: { nickname: '甲' } } });
  assert.equal(env.wx.count('navigateBack'), 1);

  const s2 = setup(t, { stackDepth: 1 });
  s2.page.onLoad({});
  await h.flush();
  await s2.page.onSubmit({ detail: { value: { nickname: '乙' } } });
  assert.equal(s2.env.wx.last('reLaunch').url, '/pages/index/index');
});

test('资料页：redirect 跳转失败时退回上一页', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({ redirect: REDIRECT });
  await h.flush();
  env.wx.failNext.redirectTo = true;
  await page.onSubmit({ detail: { value: { nickname: '甲' } } });
  assert.equal(env.wx.count('navigateBack'), 1);
});

test('资料页：非法 redirect 被忽略', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({ redirect: 'https://evil.example.com' });
  await h.flush();
  assert.equal(page.data.firstTime, true, '没有昵称仍算首次设置');
  await page.onSubmit({ detail: { value: { nickname: '甲' } } });
  assert.equal(env.wx.count('redirectTo'), 0);
  assert.equal(env.wx.count('navigateBack'), 1);
});

test('资料页：只换头像时不提交昵称；什么都没改时直接返回', async (t) => {
  const { env, page } = setup(t, { user: { id: 1, nickname: '老李', avatarUrl: '' } });
  page.onLoad({});
  await h.flush();
  page.onChooseAvatar({ detail: { avatarUrl: 'wxfile://tmp_3.png' } });
  await page.onSubmit({ detail: { value: { nickname: '老李' } } });
  assert.equal(env.api.uploads.length, 1);
  assert.equal(env.api.callsTo('PUT /api/me/profile').length, 0);

  const s2 = setup(t, { user: { id: 1, nickname: '老李', avatarUrl: '' } });
  s2.page.onLoad({});
  await h.flush();
  await s2.page.onSubmit({ detail: {} });
  assert.equal(s2.env.api.uploads.length, 0);
  assert.equal(s2.env.api.calls.length, 0);
  assert.equal(s2.env.wx.count('navigateBack'), 1);
});

test('资料页：昵称提交失败 → 提示、可重试，且不重复上传头像', async (t) => {
  const { env, page } = setup(t);
  let fail = true;
  env.api.route('PUT /api/me/profile', (o) => {
    if (fail) throw { code: 'bad_request', msg: '昵称包含敏感词' };
    return { user: { ...env.auth.user, nickname: o.data.nickname } };
  });
  page.onLoad({});
  await h.flush();
  page.onChooseAvatar({ detail: { avatarUrl: 'wxfile://tmp_4.png' } });
  await page.onSubmit({ detail: { value: { nickname: '甲' } } });
  assert.equal(env.wx.toasts().pop(), '昵称包含敏感词', '展示服务端给出的具体原因');
  assert.equal(page.data.saving, false);
  assert.equal(page.data.avatarChanged, false, '头像已上传成功');
  assert.equal(env.wx.count('hideLoading'), 1);
  assert.equal(env.wx.count('navigateBack'), 0);
  fail = false;
  await page.onSubmit({ detail: { value: { nickname: '甲' } } });
  assert.equal(env.api.uploads.length, 1);
  assert.equal(env.wx.count('navigateBack'), 1);
});

test('资料页：头像上传失败 → 提示，不提交昵称', async (t) => {
  const { env, page } = setup(t);
  env.api.uploadImpl = () => Promise.reject({ errMsg: 'uploadFile:fail timeout' });
  page.onLoad({});
  await h.flush();
  page.onChooseAvatar({ detail: { avatarUrl: 'wxfile://tmp_5.png' } });
  await page.onSubmit({ detail: { value: { nickname: '甲' } } });
  assert.equal(env.wx.toasts().pop(), '请求超时，请稍后重试');
  assert.equal(env.api.callsTo('PUT /api/me/profile').length, 0);
  assert.equal(page.data.avatarChanged, true);
});

test('资料页：服务器返回缺少 user → 视为失败', async (t) => {
  const { env, page } = setup(t);
  env.api.route('PUT /api/me/profile', () => ({}));
  page.onLoad({});
  await h.flush();
  await page.onSubmit({ detail: { value: { nickname: '甲' } } });
  assert.equal(env.wx.toasts().pop(), '服务器返回数据异常');
  assert.equal(env.wx.count('navigateBack'), 0);
});

test('资料页：保存中不重复提交', async (t) => {
  const { env, page } = setup(t);
  const d = h.deferred();
  env.api.route('PUT /api/me/profile', () => d.promise);
  page.onLoad({});
  await h.flush();
  const p1 = page.onSubmit({ detail: { value: { nickname: '甲' } } });
  await h.flush();
  await page.onSubmit({ detail: { value: { nickname: '甲' } } });
  assert.equal(env.api.callsTo('PUT /api/me/profile').length, 1);
  d.resolve({ user: { id: 1, nickname: '甲' } });
  await p1;
  assert.equal(env.wx.count('navigateBack'), 1);
});

test('资料页：登录失败显示错误，重试后可保存', async (t) => {
  const { env, page } = setup(t, { loginError: { code: 'offline' } });
  page.onLoad({});
  await h.flush();
  assert.equal(page.data.ready, false);
  assert.equal(page.data.loadError, '网络未连接，请检查网络后重试');
  await page.save('甲');
  assert.deepEqual(env.wx.toasts(), ['请先重新登录']);
  env.auth.loginError = null;
  page.onRetry();
  await h.flush();
  assert.equal(page.data.ready, true);
  assert.equal(page.data.loadError, '');
});

test('资料页：登录完成前保存提示稍候；没有隐私接口的旧基础库也能用', async (t) => {
  const { env, page } = setup(t);
  delete env.wx.getPrivacySetting;
  delete env.wx.openPrivacyContract;
  const d = h.deferred();
  env.auth.ensureLogin = () => d.promise;
  page.onLoad({});
  await page.save('甲');
  assert.deepEqual(env.wx.toasts(), ['正在登录，请稍候']);
  page.onOpenPrivacy();
  d.resolve({ id: 1, nickname: '' });
  await h.flush();
  assert.equal(page.data.ready, true);
});

test('资料页：本地 setUser 抛错不影响保存成功', async (t) => {
  const { env, page } = setup(t);
  env.auth.setUser = () => {
    throw new TypeError('setUser：尚未登录');
  };
  page.onLoad({});
  await h.flush();
  await page.onSubmit({ detail: { value: { nickname: '甲' } } });
  assert.equal(env.wx.count('navigateBack'), 1);
  assert.deepEqual(env.wx.toasts(), ['已保存']);
});

test('资料页：保存期间别的页面被打开到上面（好友房开局通知进入了对局页）→ 保存完不跳转，不会把对局页关掉', async (t) => {
  for (const redirect of [undefined, REDIRECT]) {
    const { env, page } = setup(t, { user: { id: 1, nickname: '旧名', avatarUrl: '' } });
    page.onLoad(redirect ? { redirect } : {});
    await h.flush();
    const upload = h.deferred();
    env.api.uploadImpl = () => upload.promise;
    page.onChooseAvatar({ detail: { avatarUrl: 'wxfile://tmp_3.png' } });
    const saving = page.onSubmit({ detail: { value: { nickname: '新名' } } });
    await h.flush();
    assert.equal(page.data.saving, true);
    env.stack.push({ route: 'pages/play/play', options: { id: 'friend000001' } });
    upload.resolve({ user: { id: 1, nickname: '旧名', avatarUrl: 'http://srv/avatars/b.png' } });
    await saving;
    assert.equal(env.auth.user.nickname, '新名', '照常保存');
    assert.equal(env.wx.count('navigateBack'), 0, String(redirect));
    assert.equal(env.wx.count('redirectTo'), 0, String(redirect));
    assert.equal(env.wx.count('hideLoading'), 1);
    assert.equal(page.data.saving, false, '回到本页时可以再操作');
    // 用户回到本页后再点保存（没有改动）：直接返回
    env.stack.pop();
    await page.onSubmit({ detail: { value: { nickname: '新名' } } });
    assert.equal(env.wx.count(redirect ? 'redirectTo' : 'navigateBack'), 1);
  }
});
