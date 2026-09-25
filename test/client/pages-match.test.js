'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./pages-harness');

function setup(t, opts = {}) {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1000000 });
  const env = h.createEnv(opts);
  env.socket.respond('match.join', (p) => ({ size: p.size }));
  env.socket.respond('match.cancel', () => undefined);
  const page = h.loadPage('match/match', env);
  return { env, page };
}

test('匹配：加入队列、订阅推送、计时', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({ size: '13' });
  assert.equal(page.data.size, 13);
  assert.equal(page.data.status, 'joining');
  assert.equal(env.socket.connectCalls, 1);
  await h.flush();
  assert.deepEqual(env.socket.sent('match.join').map((c) => c.params), [{ size: 13 }]);
  assert.equal(page.data.status, 'waiting');
  for (const ev of ['match.found', 'ready', 'status', 'kicked']) assert.equal(env.socket.listenerCount(ev), 1, ev);

  assert.equal(page.data.elapsedText, '0:00');
  t.mock.timers.tick(5000);
  assert.equal(page.data.elapsedText, '0:05');
  assert.equal(page.data.showAiHint, false);
  t.mock.timers.tick(55000);
  assert.equal(page.data.elapsedText, '1:00');
  assert.equal(page.data.showAiHint, true);
});

test('匹配：非法路数按 19 路', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({ size: '15' });
  await h.flush();
  assert.deepEqual(env.socket.sent('match.join')[0].params, { size: 19 });
});

test('匹配：match.found → redirectTo 对局页，离开时不再取消', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({ size: '9' });
  await h.flush();
  env.socket.emit('match.found', { gameId: 'bad id!' });
  assert.equal(env.wx.count('redirectTo'), 0, '非法 gameId 忽略');
  env.socket.emit('match.found', { gameId: 'game00000001' });
  assert.equal(env.wx.last('redirectTo').url, '/pages/play/play?id=game00000001');
  assert.equal(page.data.status, 'matched');
  env.socket.emit('match.found', { gameId: 'game00000001' });
  assert.equal(env.wx.count('redirectTo'), 1, '重复推送只跳一次');
  const before = page.data.elapsedText;
  t.mock.timers.tick(10000);
  assert.equal(page.data.elapsedText, before, '匹配成功后停止计时');
  page.onUnload();
  await h.flush();
  assert.equal(env.socket.sent('match.cancel').length, 0);
  assert.equal(env.socket.totalListeners(), 0, '卸载后取消所有订阅');
});

test('匹配：取消按钮发 match.cancel 并返回；卸载时不重复取消', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({ size: '19' });
  await h.flush();
  page.onCancel();
  await h.flush();
  assert.equal(env.socket.sent('match.cancel').length, 1);
  assert.equal(env.wx.count('navigateBack'), 1);
  page.onUnload();
  await h.flush();
  assert.equal(env.socket.sent('match.cancel').length, 1);
});

test('匹配：直接离开页面（返回键）时取消匹配', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({ size: '19' });
  await h.flush();
  page.onUnload();
  await h.flush();
  assert.equal(env.socket.sent('match.cancel').length, 1);
});

test('匹配：取消失败只记录日志，不影响返回', async (t) => {
  const { env, page } = setup(t);
  env.socket.respond('match.cancel', () => {
    throw { code: 'offline' };
  });
  page.onLoad({});
  await h.flush();
  page.onCancel();
  await h.flush();
  assert.equal(env.wx.count('navigateBack'), 1);
});

test('匹配：页面栈只有一页时取消回到首页', async (t) => {
  const { env, page } = setup(t, { stackDepth: 1 });
  page.onLoad({});
  await h.flush();
  page.onCancel();
  assert.equal(env.wx.last('reLaunch').url, '/pages/index/index');
});

test('匹配：断线重连后重新加入；服务端仍在排队则不重复加入', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({ size: '9' });
  await h.flush();
  env.socket.emit('status', 'closed');
  assert.equal(page.data.netStatus, 'closed');
  env.socket.emit('status', 'open');
  env.socket.emit('ready', { activeGames: [], room: null, matching: null });
  await h.flush();
  assert.equal(env.socket.sent('match.join').length, 2);
  env.socket.emit('ready', { activeGames: [], room: null, matching: { size: 9 } });
  await h.flush();
  assert.equal(env.socket.sent('match.join').length, 2);
  assert.equal(page.data.status, 'waiting');
  env.socket.emit('ready', { activeGames: [], room: null, matching: { size: 13 } });
  await h.flush();
  assert.equal(env.socket.sent('match.join').length, 3, '队列里的路数不同则重新加入');
});

test('匹配：断线期间已匹配成功 → 重连后直接进入对局', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({});
  await h.flush();
  env.socket.emit('ready', { activeGames: [{ id: 'aigame000001', mode: 'ai' }, { id: 'rank00000001', mode: 'ranked' }], room: null, matching: null });
  assert.equal(env.wx.last('redirectTo').url, '/pages/play/play?id=rank00000001');
  await h.flush();
  assert.equal(env.socket.sent('match.join').length, 1);
});

test('匹配：加入请求未返回时又收到 ready → 等它结束后再加入一次', async (t) => {
  const { env, page } = setup(t);
  const first = h.deferred();
  let n = 0;
  env.socket.respond('match.join', (p) => {
    n += 1;
    return n === 1 ? first.promise : { size: p.size };
  });
  page.onLoad({});
  await h.flush();
  env.socket.emit('ready', { activeGames: [], room: null, matching: null });
  env.socket.emit('ready', { activeGames: [], room: null, matching: null });
  await h.flush();
  assert.equal(env.socket.sent('match.join').length, 1);
  first.resolve({ size: 19 });
  await h.flush();
  assert.equal(env.socket.sent('match.join').length, 2, '合并为一次补发');
  assert.equal(page.data.status, 'waiting');
});

test('匹配：加入失败显示错误，重试成功', async (t) => {
  const { env, page } = setup(t);
  let fail = true;
  env.socket.respond('match.join', (p) => {
    if (fail) throw { code: 'offline', msg: 'x' };
    return { size: p.size };
  });
  page.onLoad({});
  await h.flush();
  assert.equal(page.data.status, 'error');
  assert.equal(page.data.errorText, '网络未连接，请检查网络后重试');
  fail = false;
  page.onRetry();
  assert.equal(page.data.status, 'joining');
  await h.flush();
  assert.equal(page.data.status, 'waiting');
  assert.equal(page.data.errorText, '');
});

test('匹配：已有对局（in_game）→ 弹窗，确认后回到那局，离开时不取消', async (t) => {
  const { env, page } = setup(t);
  env.socket.respond('match.join', () => {
    throw { code: 'in_game', msg: 'in game' };
  });
  env.socket.respond('hello', () => ({ activeGames: [{ id: 'frnd00000001', mode: 'friend' }], room: null, matching: null }));
  page.onLoad({});
  await h.flush();
  const modal = env.wx.last('showModal');
  assert.equal(modal.confirmText, '返回对局');
  assert.equal(env.wx.last('redirectTo').url, '/pages/play/play?id=frnd00000001');
  assert.equal(page.data.status, 'stopped');
  env.socket.emit('ready', { activeGames: [], room: null, matching: null });
  await h.flush();
  assert.equal(env.socket.sent('match.join').length, 1, '停止后不再自动加入');
  page.onUnload();
  await h.flush();
  assert.equal(env.socket.sent('match.cancel').length, 0);
});

test('匹配：in_game 但查不到对局 → 提示后返回', async (t) => {
  const { env, page } = setup(t);
  env.socket.respond('match.join', () => {
    throw { code: 'in_game', msg: 'in game' };
  });
  env.socket.respond('hello', () => {
    throw { code: 'timeout' };
  });
  page.onLoad({});
  await h.flush();
  const modal = env.wx.last('showModal');
  assert.equal(modal.showCancel, false);
  assert.equal(modal.confirmText, '知道了');
  assert.equal(env.wx.count('navigateBack'), 1);
  assert.equal(env.wx.count('redirectTo'), 0);
});

test('匹配：in_game 弹窗选择"稍后" → 返回上一页', async (t) => {
  const { env, page } = setup(t);
  env.wx.modalResponse = { confirm: false, cancel: true };
  env.socket.respond('match.join', () => {
    throw { code: 'in_game' };
  });
  env.socket.respond('hello', () => ({ activeGames: [{ id: 'rank00000001', mode: 'ranked' }] }));
  page.onLoad({});
  await h.flush();
  assert.equal(env.wx.count('redirectTo'), 0);
  assert.equal(env.wx.count('navigateBack'), 1);
});

test('匹配：改为人机对弈 → 取消匹配并 redirectTo 人机设置（同路数）', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({ size: '13' });
  await h.flush();
  t.mock.timers.tick(61000);
  assert.equal(page.data.showAiHint, true);
  page.onSwitchAi();
  await h.flush();
  assert.equal(env.socket.sent('match.cancel').length, 1);
  assert.equal(env.wx.last('redirectTo').url, '/pages/ai/ai?size=13');
  page.onUnload();
  await h.flush();
  assert.equal(env.socket.sent('match.cancel').length, 1);
});

test('匹配：被顶号 → 停止并回首页', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({});
  await h.flush();
  env.socket.emit('kicked', { reason: 'replaced' });
  await h.flush();
  assert.equal(page.data.status, 'stopped');
  assert.equal(env.wx.last('reLaunch').url, '/pages/index/index');
  env.socket.emit('ready', { activeGames: [], room: null, matching: null });
  await h.flush();
  assert.equal(env.socket.sent('match.join').length, 1);
});

test('匹配：跳转对局页失败 → 提示并可手动进入', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({});
  await h.flush();
  env.wx.failNext.redirectTo = true;
  env.socket.emit('match.found', { gameId: 'game00000009' });
  assert.deepEqual(env.wx.toasts(), ['打开对局失败，请重试']);
  assert.equal(page.data.status, 'matched');
  page.openGame();
  assert.equal(env.wx.last('redirectTo').url, '/pages/play/play?id=game00000009');
  assert.equal(env.wx.count('redirectTo'), 2);
});

test('匹配：连接失败（connect 抛错）不影响页面', async (t) => {
  const { env, page } = setup(t);
  env.socket.connect = () => {
    throw new Error('no network');
  };
  page.onLoad({});
  await h.flush();
  assert.equal(page.data.status, 'waiting');
  env.socket.connect = () => Promise.reject(new Error('later'));
  page.onRetry();
  await h.flush();
  assert.equal(page.data.status, 'waiting');
});

test('匹配：等待时保持屏幕常亮（锁屏会断线、被移出队列）；隐藏、离开、匹配成功、停止时恢复', async (t) => {
  const { env, page } = setup(t);
  const last = () => env.wx.last('setKeepScreenOn').keepScreenOn;
  page.onLoad({ size: '9' });
  page.onShow();
  await h.flush();
  assert.equal(last(), true);
  page.onHide();
  assert.equal(last(), false);
  page.onShow();
  assert.equal(last(), true);
  env.socket.emit('match.found', { gameId: 'game00000001' });
  assert.equal(last(), false, '匹配成功：交给对局页');
  page.onShow(); // 跳转过程中又显示：不再常亮
  assert.equal(last(), false);
  page.onUnload();
  assert.equal(last(), false);

});

for (const act of ['onCancel', 'onSwitchAi', 'kicked']) {
  test(`匹配：${act} 后不再保持屏幕常亮`, async (t) => {
    const { env, page } = setup(t);
    page.onLoad({ size: '9' });
    page.onShow();
    await h.flush();
    assert.equal(env.wx.last('setKeepScreenOn').keepScreenOn, true);
    if (act === 'kicked') env.socket.emit('kicked', { reason: 'replaced' });
    else page[act]();
    assert.equal(env.wx.last('setKeepScreenOn').keepScreenOn, false);
  });
}
