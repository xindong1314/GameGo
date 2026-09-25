'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./pages-harness');

const LEVELS = {
  available: true,
  levels: [
    { id: 'k15', name: '15 级', desc: '入门' },
    { id: 'k5', name: '5 级', desc: '业余' },
    { id: 'd1', name: '初段', desc: '有一定棋力' },
  ],
};

function setup(t, opts = {}) {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const env = h.createEnv(opts);
  env.api.route('GET /api/ai/levels', () => opts.levels || LEVELS);
  env.socket.respond('ai.start', () => ({ gameId: 'aigame000001' }));
  if (opts.storage) Object.assign(env.wx.storage, opts.storage);
  const page = h.loadPage('ai/ai', env);
  return { env, page };
}

test('人机设置：加载难度并默认选第一档', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({});
  assert.equal(page.data.state, 'loading');
  await h.flush();
  assert.equal(page.data.state, 'ok');
  assert.equal(page.data.levels.length, 3);
  assert.equal(page.data.levelId, 'k15');
  assert.equal(page.data.size, 19);
  assert.equal(page.data.color, 'random');
  assert.equal(env.api.callsTo('GET /api/ai/levels').length, 1);
});

test('人机设置：恢复上次的设置；query 里的路数优先', async (t) => {
  const { page } = setup(t, { storage: { 'ai.settings': { size: 13, level: 'k5', color: 'white' } } });
  page.onLoad({ size: '9' });
  await h.flush();
  assert.equal(page.data.size, 9);
  assert.equal(page.data.levelId, 'k5');
  assert.equal(page.data.color, 'white');
});

test('人机设置：开始 → ai.start → redirectTo 对局页，并记住设置', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({});
  await h.flush();
  page.onPickSize({ currentTarget: { dataset: { size: '13' } } });
  page.onPickLevel({ currentTarget: { dataset: { id: 'd1' } } });
  page.onPickLevel({ currentTarget: { dataset: { id: 'nope' } } });
  page.onPickColor({ currentTarget: { dataset: { color: 'black' } } });
  page.onPickColor({ currentTarget: { dataset: { color: 'purple' } } });
  assert.equal(page.data.levelId, 'd1');
  assert.equal(page.data.color, 'black');
  await page.onStart();
  const start = env.socket.sent('ai.start');
  assert.equal(start.length, 1);
  assert.deepEqual(start[0].params, { size: 13, level: 'd1', color: 'black' });
  assert.equal(env.socket.connectCalls, 1);
  assert.equal(env.wx.last('redirectTo').url, '/pages/play/play?id=aigame000001&color=black', '执子设置带给对局页（再来一局沿用）');
  assert.deepEqual(env.wx.storage['ai.settings'], { size: 13, level: 'd1', color: 'black' });
  assert.equal(page.data.starting, true, '跳转中保持按钮禁用');
  await page.onStart();
  assert.equal(env.socket.sent('ai.start').length, 1, '不会重复开局');
});

test('人机设置：AI 不可用 → 显示不可用状态，不能开始', async (t) => {
  const { env, page } = setup(t, { levels: { available: false, levels: LEVELS.levels } });
  page.onLoad({});
  await h.flush();
  assert.equal(page.data.state, 'unavailable');
  page.onPickLevel({ currentTarget: { dataset: { id: 'd1' } } });
  assert.equal(page.data.levelId, 'k15', '不可用时不能改难度');
  await page.onStart();
  assert.deepEqual(env.wx.toasts(), ['AI 暂不可用']);
  assert.equal(env.socket.sent('ai.start').length, 0);
});

test('人机设置：难度加载失败 → 错误状态，重试成功', async (t) => {
  const { env, page } = setup(t);
  let fail = true;
  env.api.route('GET /api/ai/levels', () => {
    if (fail) throw { code: 'network', msg: 'x' };
    return LEVELS;
  });
  page.onLoad({});
  await h.flush();
  assert.equal(page.data.state, 'error');
  assert.equal(page.data.errorText, '网络异常，请检查网络后重试');
  await page.onStart();
  assert.deepEqual(env.wx.toasts(), ['请先选择难度']);
  fail = false;
  page.onRetry();
  await h.flush();
  assert.equal(page.data.state, 'ok');
});

test('人机设置：开局时服务端报 ai_unavailable', async (t) => {
  const { env, page } = setup(t);
  env.socket.respond('ai.start', () => {
    throw { code: 'ai_unavailable', msg: 'no ai' };
  });
  page.onLoad({});
  await h.flush();
  await page.onStart();
  assert.equal(page.data.state, 'unavailable');
  assert.equal(page.data.starting, false);
  assert.deepEqual(env.wx.toasts(), ['AI 暂不可用，请稍后再试']);
  assert.equal(env.wx.count('redirectTo'), 0);
});

test('人机设置：开局失败（网络/数据异常）可再次尝试', async (t) => {
  const { env, page } = setup(t);
  env.socket.respond('ai.start', () => ({}));
  page.onLoad({});
  await h.flush();
  await page.onStart();
  assert.deepEqual(env.wx.toasts(), ['服务器返回数据异常']);
  assert.equal(page.data.starting, false);
  env.socket.respond('ai.start', () => {
    throw { code: 'offline' };
  });
  await page.onStart();
  assert.equal(env.wx.toasts()[1], '网络未连接，请检查网络后重试');
  env.socket.respond('ai.start', () => ({ gameId: 'aigame000002' }));
  await page.onStart();
  assert.equal(env.wx.last('redirectTo').url, '/pages/play/play?id=aigame000002&color=random');
});

test('人机设置：未设置昵称 → 去资料页，不开局', async (t) => {
  const { env, page } = setup(t, { user: { id: 1, nickname: '' } });
  page.onLoad({});
  await h.flush();
  await page.onStart();
  assert.equal(env.wx.last('navigateTo').url, '/pages/profile/profile');
  assert.equal(env.socket.sent('ai.start').length, 0);
  assert.equal(page.data.starting, false);
});

test('人机设置：跳转对局页失败 → 恢复按钮并提示', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({});
  await h.flush();
  env.wx.failNext.redirectTo = true;
  await page.onStart();
  assert.equal(page.data.starting, false);
  assert.deepEqual(env.wx.toasts(), ['打开对局失败，请重试']);
});

test('人机设置：已有进行中的人机对局 → 先确认；点"开新局"才作废旧局', async (t) => {
  const { env, page } = setup(t);
  env.socket.respond('hello', () => ({ activeGames: [{ id: 'aigame000009', mode: 'ai' }], room: null, matching: null }));
  page.onLoad({});
  await h.flush();
  env.wx.modalResponse = { confirm: true, cancel: false };
  await page.onStart();
  const modal = env.wx.last('showModal');
  assert.equal(modal.confirmText, '开新局');
  assert.equal(modal.cancelText, '回到那盘');
  assert.equal(env.socket.sent('ai.start').length, 1);
  assert.equal(env.wx.last('redirectTo').url, '/pages/play/play?id=aigame000001&color=random');
});

test('人机设置：已有进行中的人机对局，选"回到那盘"（或返回键关掉弹窗）→ 不开新局，回到旧局', async (t) => {
  const { env, page } = setup(t);
  env.socket.respond('hello', () => ({ activeGames: [{ id: 'aigame000009', mode: 'ai' }] }));
  page.onLoad({});
  await h.flush();
  env.wx.modalResponse = { confirm: false, cancel: true };
  await page.onStart();
  assert.equal(env.socket.sent('ai.start').length, 0);
  assert.equal(env.wx.last('redirectTo').url, '/pages/play/play?id=aigame000009');
});

test('人机设置：没有进行中的对局 → 直接开局，不弹窗', async (t) => {
  const { env, page } = setup(t);
  env.socket.respond('hello', () => ({ activeGames: [] }));
  page.onLoad({});
  await h.flush();
  await page.onStart();
  assert.equal(env.wx.count('showModal'), 0);
  assert.equal(env.socket.sent('ai.start').length, 1);
});

test('人机设置：排位/好友对局进行中（服务端不允许开人机）→ 不开局，提示并可返回那一局（优先于人机对局的弹窗）', async (t) => {
  const { env, page } = setup(t);
  env.socket.respond('hello', () => ({ activeGames: [{ id: 'aigame000009', mode: 'ai' }, { id: 'rank00000001', mode: 'ranked' }] }));
  page.onLoad({});
  await h.flush();
  env.wx.modalResponse = { confirm: true, cancel: false };
  await page.onStart();
  const modal = env.wx.last('showModal');
  assert.equal(modal.title, '无法开始人机对局');
  assert.equal(modal.content, '你有一局排位赛正在进行，先去完成它吧。');
  assert.equal(modal.confirmText, '返回对局');
  assert.equal(env.wx.count('showModal'), 1);
  assert.equal(env.socket.sent('ai.start').length, 0);
  assert.equal(env.wx.last('redirectTo').url, '/pages/play/play?id=rank00000001');
  // 选"稍后"：留在设置页，什么都不做
  const s2 = setup(t);
  s2.env.socket.respond('hello', () => ({ activeGames: [{ id: 'friend000001', mode: 'friend' }] }));
  s2.page.onLoad({});
  await h.flush();
  s2.env.wx.modalResponse = { confirm: false, cancel: true };
  await s2.page.onStart();
  assert.equal(s2.env.wx.last('showModal').content, '你有一局好友对局正在进行，先去完成它吧。');
  assert.equal(s2.env.socket.sent('ai.start').length, 0);
  assert.equal(s2.env.wx.count('redirectTo'), 0);
  assert.equal(s2.page.data.starting, false);
});

test('人机设置：开局时才报 in_game（刚从匹配页改为人机时正好匹配成功）→ 查出那一局并引导返回', async (t) => {
  const { env, page } = setup(t);
  let hellos = 0;
  // 第一次 hello（开局前）还没有对局，之后有了排位赛
  env.socket.respond('hello', () => {
    hellos += 1;
    return { activeGames: hellos === 1 ? [] : [{ id: 'rank00000002', mode: 'ranked' }] };
  });
  env.socket.respond('ai.start', () => {
    throw { code: 'in_game', msg: '你还有一局棋没下完' };
  });
  page.onLoad({ size: '9' });
  await h.flush();
  env.wx.modalResponse = { confirm: true, cancel: false };
  await page.onStart();
  await h.flush();
  assert.equal(env.socket.sent('ai.start').length, 1);
  assert.equal(env.wx.last('showModal').confirmText, '返回对局');
  assert.equal(env.wx.last('redirectTo').url, '/pages/play/play?id=rank00000002');
  assert.deepEqual(env.wx.toasts(), []);
  // 查不到是哪一局：只提示
  const s2 = setup(t);
  s2.env.socket.respond('ai.start', () => {
    throw { code: 'in_game', msg: '你还有一局棋没下完' };
  });
  s2.page.onLoad({});
  await h.flush();
  await s2.page.onStart();
  assert.deepEqual(s2.env.wx.toasts(), ['你有一局对局正在进行']);
  assert.equal(s2.env.wx.count('redirectTo'), 0);
  assert.equal(s2.page.data.starting, false);
});

test('人机设置：开局请求期间别的页面被打开到上面（开局通知）→ 不 redirectTo（否则会关掉那个页面），恢复按钮', async (t) => {
  const { env, page } = setup(t);
  const start = h.deferred();
  env.socket.respond('ai.start', () => start.promise);
  page.onLoad({});
  await h.flush();
  const p = page.onStart();
  await h.flush();
  assert.equal(page.data.starting, true);
  env.stack.push({ route: 'pages/play/play', options: { id: 'friend000001' } });
  start.resolve({ gameId: 'aigame000003' });
  await p;
  assert.equal(env.wx.count('redirectTo'), 0);
  assert.equal(page.data.starting, false);
  assert.equal(page.started, false);
});
