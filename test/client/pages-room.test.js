'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./pages-harness');

const ME = { id: 1, nickname: '小明', avatarUrl: '' };

function room(over = {}) {
  return {
    code: '135790',
    owner: { userId: 1, nickname: '小明', avatarUrl: '' },
    size: 9,
    color: 'black',
    status: 'waiting',
    expiresIn: 1800000,
    ...over,
  };
}

const GUEST_ROOM = room({ code: '246810', owner: { userId: 7, nickname: '老王', avatarUrl: 'http://x/w.png' }, size: 13, color: 'white' });

function setup(t, opts = {}) {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  if (opts.timers !== false) t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 5000000 });
  const env = h.createEnv({ user: opts.user === undefined ? ME : opts.user, stackDepth: opts.stackDepth });
  env.socket.respond('room.create', (p) => ({ room: room({ size: p.size, color: p.color }) }));
  env.socket.respond('room.get', (p) => {
    if (p.code === GUEST_ROOM.code) return { room: GUEST_ROOM };
    if (p.code === '135790') return { room: room() };
    throw { code: 'room_not_found', msg: 'no room' };
  });
  env.socket.respond('room.join', () => ({ gameId: 'friend000001' }));
  env.socket.respond('room.leave', () => undefined);
  const page = h.loadPage('room/room', env);
  return { env, page };
}

// ---------- 房主 ----------

test('好友房（创建）：创建房间并显示房号、执子、倒计时、分享卡片', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({ create: '1', size: '9', color: 'black' });
  assert.equal(page.data.view, 'loading');
  await h.flush();
  assert.deepEqual(env.socket.sent('room.create')[0].params, { size: 9, color: 'black' });
  assert.equal(page.data.view, 'waiting');
  assert.deepEqual(page.data.room.digits.map((x) => x.d), ['1', '3', '5', '7', '9', '0']);
  assert.equal(page.data.room.colorText, '你执黑先行');
  assert.equal(page.data.expireText, '30:00');
  t.mock.timers.tick(61000);
  assert.equal(page.data.expireText, '28:59');
  assert.deepEqual(page.onShareAppMessage({ from: 'button' }), {
    title: '小明 邀你下一盘围棋（9路）',
    path: '/pages/room/room?code=135790',
  });
  page.onCopy();
  assert.equal(env.wx.last('setClipboardData').data, '135790');
  for (const ev of ['game.start', 'room.update', 'ready', 'status', 'kicked']) assert.equal(env.socket.listenerCount(ev), 1, ev);
});

test('好友房（创建）：好友加入 game.start → redirectTo 对局页，离开时不关房', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({ create: '1', size: '19', color: 'random' });
  await h.flush();
  env.socket.emit('game.start', { gameId: 'friend000001', mode: 'friend' });
  assert.equal(env.wx.last('redirectTo').url, '/pages/play/play?id=friend000001');
  env.socket.emit('game.start', { gameId: 'friend000001', mode: 'friend' });
  assert.equal(env.wx.count('redirectTo'), 1);
  page.onUnload();
  await h.flush();
  assert.equal(env.socket.sent('room.leave').length, 0);
  assert.equal(env.socket.totalListeners(), 0);
});

test('好友房（创建）：取消房间 → room.leave + 返回；卸载不重复关', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({ create: '1' });
  await h.flush();
  page.onCancel();
  await h.flush();
  assert.equal(env.socket.sent('room.leave').length, 1);
  assert.equal(env.wx.count('navigateBack'), 1);
  page.onUnload();
  await h.flush();
  assert.equal(env.socket.sent('room.leave').length, 1);
});

test('好友房（创建）：直接离开等待页不关闭房间（房间保留，首页可回到房间；只有"取消房间"才关）', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({ create: '1' });
  await h.flush();
  page.onUnload();
  await h.flush();
  assert.equal(env.socket.sent('room.leave').length, 0);
  assert.equal(env.socket.totalListeners(), 0);
});

test('好友房（创建）：房主点自己分享的卡片（热启动 reLaunch 到 ?code=）→ 旧页卸载、新页回到等待界面，房间还在', async (t) => {
  const { env } = setup(t);
  let open = false;
  env.socket.respond('room.create', (p) => {
    open = true;
    return { room: room({ size: p.size, color: p.color }) };
  });
  env.socket.respond('room.leave', () => {
    open = false;
  });
  env.socket.respond('room.get', () => {
    if (open) return { room: room() };
    throw { code: 'room_not_found', msg: '房间不存在或已过期' };
  });
  const a = h.loadPage('room/room', env);
  a.onLoad({ create: '1', size: '9', color: 'black' });
  a.onShow();
  await h.flush();
  assert.equal(a.data.view, 'waiting');
  const share = a.onShareAppMessage({ from: 'button' });
  a.onHide(); // 切到微信聊天
  a.onUnload(); // 点卡片：reLaunch
  const b = h.loadPage('room/room', env);
  b.onLoad(Object.fromEntries(new URLSearchParams(share.path.split('?')[1])));
  b.onShow();
  await h.flush();
  assert.deepEqual(env.socket.calls.map((c) => c.t), ['room.create', 'room.get']);
  assert.equal(b.data.view, 'waiting');
  assert.equal(b.data.room.code, '135790');
  assert.equal(b.data.canRecreate, false);
});

test('好友房（创建）：等待时屏幕常亮，离开 / 切后台 / 开局时恢复', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({ create: '1' });
  page.onShow();
  await h.flush();
  const on = () => env.wx.all('setKeepScreenOn').map((c) => c.arg.keepScreenOn);
  assert.equal(on().pop(), true);
  page.onHide();
  assert.equal(on().pop(), false);
  page.onShow();
  assert.equal(on().pop(), true);
  env.socket.emit('game.start', { gameId: 'friend000001', mode: 'friend' });
  assert.equal(on().pop(), false);
  page.onUnload();
  assert.equal(on().pop(), false);
});

test('好友房（创建）：创建过程中离开 → 建好后立即关闭', async (t) => {
  const { env, page } = setup(t);
  const d = h.deferred();
  env.socket.respond('room.create', () => d.promise);
  page.onLoad({ create: '1' });
  await h.flush();
  page.onUnload();
  d.resolve({ room: room() });
  await h.flush();
  assert.equal(env.socket.sent('room.leave').length, 1);
  assert.equal(page.data.view, 'loading');
});

test('好友房（创建）：房间过期推送 → 关闭界面，可重新创建', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({ create: '1', size: '13', color: 'white' });
  await h.flush();
  env.socket.emit('room.update', { room: room({ code: '000000', status: 'closed' }) });
  assert.equal(page.data.view, 'waiting', '其他房间的推送忽略');
  env.socket.emit('room.update', { room: room({ status: 'waiting', expiresIn: 60000 }) });
  assert.equal(page.data.expireText, '01:00', '房间状态更新时刷新倒计时');
  env.socket.emit('room.update', { room: room({ status: 'closed' }) });
  assert.equal(page.data.view, 'closed');
  assert.equal(page.data.canRecreate, true);
  assert.deepEqual(page.onShareAppMessage(), { title: '来下一盘围棋吧', path: '/pages/index/index' });
  page.onUnload();
  await h.flush();
  assert.equal(env.socket.sent('room.leave').length, 0, '已关闭的房间离开时不再关闭');
});

test('好友房（创建）：关闭后重新创建沿用路数与执子', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({ create: '1', size: '13', color: 'white' });
  await h.flush();
  env.socket.emit('room.update', { room: room({ status: 'closed' }) });
  page.onRecreate();
  await h.flush();
  assert.deepEqual(env.socket.sent('room.create').map((c) => c.params), [{ size: 13, color: 'white' }, { size: 13, color: 'white' }]);
  assert.equal(page.data.view, 'waiting');
});

test('好友房（创建）：推送丢失时本地倒计时兜底关闭', async (t) => {
  const { page } = setup(t);
  page.onLoad({ create: '1' });
  await h.flush();
  page.setExpire(2000);
  t.mock.timers.tick(3000);
  assert.equal(page.data.view, 'waiting', '过期后留几秒宽限');
  assert.equal(page.data.expireText, '00:00');
  t.mock.timers.tick(5000);
  assert.equal(page.data.view, 'closed');
});

test('好友房（创建）：失败显示错误并可重试', async (t) => {
  const { env, page } = setup(t);
  let fail = true;
  env.socket.respond('room.create', (p) => {
    if (fail) throw { code: 'rate_limited', msg: 'slow down' };
    return { room: room({ size: p.size }) };
  });
  page.onLoad({ create: '1' });
  await h.flush();
  assert.equal(page.data.view, 'error');
  assert.equal(page.data.errorText, '操作太频繁，请稍后再试');
  assert.equal(page.data.canRetry, true);
  fail = false;
  page.onRetry();
  await h.flush();
  assert.equal(page.data.view, 'waiting');
});

test('好友房（创建）：服务器返回异常数据 → 错误界面', async (t) => {
  const { env, page } = setup(t);
  env.socket.respond('room.create', () => ({ room: { code: 'x' } }));
  page.onLoad({ create: '1' });
  await h.flush();
  assert.equal(page.data.view, 'error');
  assert.equal(page.data.errorText, '服务器返回的房间数据异常');
});

test('好友房（创建）：已有对局 → 弹窗并可回到对局', async (t) => {
  const { env, page } = setup(t);
  env.socket.respond('room.create', () => {
    throw { code: 'in_game' };
  });
  env.socket.respond('hello', () => ({ activeGames: [{ id: 'rank00000001', mode: 'ranked' }] }));
  page.onLoad({ create: '1' });
  await h.flush();
  assert.equal(page.data.view, 'error');
  assert.equal(page.data.canRetry, false);
  assert.equal(env.wx.last('showModal').confirmText, '返回对局');
  assert.equal(env.wx.last('redirectTo').url, '/pages/play/play?id=rank00000001');
});

test('好友房（创建）：重连后房间仍在 → 继续等待；断线期间已开局 → 进入对局', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({ create: '1' });
  await h.flush();
  env.socket.emit('ready', { activeGames: [], room: room({ expiresIn: 120000 }), matching: null });
  await h.flush();
  assert.equal(page.data.view, 'waiting');
  assert.equal(page.data.expireText, '02:00');
  env.socket.emit('ready', { activeGames: [{ id: 'friend000009', mode: 'friend' }], room: null, matching: null });
  assert.equal(env.wx.last('redirectTo').url, '/pages/play/play?id=friend000009');
});

test('好友房（创建）：重连后 hello 里没有房间 → 用 room.get 确认', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({ create: '1' });
  await h.flush();
  // 房间其实还在（hello 与 room.create 先后顺序导致）
  env.socket.emit('ready', { activeGames: [], room: null, matching: null });
  await h.flush();
  assert.equal(env.socket.sent('room.get').length, 1);
  assert.equal(page.data.view, 'waiting');
  // 房间确实没了
  env.socket.respond('room.get', () => {
    throw { code: 'room_not_found' };
  });
  env.socket.emit('ready', { activeGames: [], room: null, matching: null });
  await h.flush();
  assert.equal(page.data.view, 'closed');
  assert.equal(page.data.canRecreate, true);
});

test('好友房（创建）：房主离线时好友加入、对局已作废 → 回来时说明原因，而不是只说"房间已关闭"', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({ create: '1', size: '9', color: 'black' });
  await h.flush();
  env.socket.respond('room.get', () => {
    throw { code: 'room_not_found' };
  });
  const summary = { id: 'friend000004', mode: 'friend', size: 9, myColor: 1, reason: 'abort', myResult: 'void', moveCount: 0, createdAt: Date.now() + 60000 };
  env.api.route('GET /api/games', () => ({ items: [summary], next: null }));
  env.socket.emit('ready', { activeGames: [], room: null, matching: null });
  await h.flush();
  assert.equal(env.api.calls[0].path, '/api/games?limit=1');
  assert.equal(page.data.view, 'closed');
  assert.equal(page.data.closedText, '好友加入后，你没有在 60 秒内落下第一手，对局已作废');
  assert.equal(page.data.canRecreate, true);
});

test('好友房（创建）：房间消失，最近一局与本房间无关 → 普通提示', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({ create: '1', size: '9', color: 'black' });
  await h.flush();
  env.socket.respond('room.get', () => {
    throw { code: 'room_not_found' };
  });
  // 开这个房间之前很久的对局
  env.api.route('GET /api/games', () => ({ items: [{ id: 'friend000005', mode: 'friend', size: 9, myColor: 1, reason: 'abort', myResult: 'void', moveCount: 0, createdAt: Date.now() - 3600000 }] }));
  env.socket.emit('ready', { activeGames: [], room: null, matching: null });
  await h.flush();
  assert.equal(page.data.view, 'closed');
  assert.equal(page.data.closedText, '房间已关闭，可以重新创建');
});

test('好友房（创建）：确认房间时网络错误 → 保持等待', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({ create: '1' });
  await h.flush();
  env.socket.respond('room.get', () => {
    throw { code: 'timeout' };
  });
  env.socket.emit('ready', { activeGames: [], room: null, matching: null });
  await h.flush();
  assert.equal(page.data.view, 'waiting');
});

test('好友房：错误界面在重连后自动重试', async (t) => {
  const { env, page } = setup(t);
  let fail = true;
  env.socket.respond('room.create', (p) => {
    if (fail) throw { code: 'offline' };
    return { room: room({ size: p.size }) };
  });
  page.onLoad({ create: '1' });
  await h.flush();
  assert.equal(page.data.view, 'error');
  fail = false;
  env.socket.emit('ready', { activeGames: [], room: null, matching: null });
  await h.flush();
  assert.equal(page.data.view, 'waiting');
});

test('好友房：复制失败时提示', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({ create: '1' });
  await h.flush();
  env.wx.failNext.setClipboardData = true;
  page.onCopy();
  assert.deepEqual(env.wx.toasts(), ['复制失败，请手动记下房号']);
});

// ---------- 受邀者 ----------

test('好友房（受邀）：显示房主信息，加入后进入对局', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({ code: '246810' });
  await h.flush();
  assert.equal(page.data.view, 'invite');
  assert.equal(page.data.room.ownerName, '老王');
  assert.equal(page.data.room.ownerAvatar, 'http://x/w.png');
  assert.equal(page.data.room.sizeText, '13 路');
  assert.equal(page.data.room.colorText, '你执黑先行');
  assert.equal(page.onShareAppMessage().path, '/pages/room/room?code=246810');
  await page.onJoin();
  await h.flush();
  assert.deepEqual(env.socket.sent('room.join')[0].params, { code: '246810' });
  assert.equal(env.wx.last('redirectTo').url, '/pages/play/play?id=friend000001');
  page.onUnload();
  await h.flush();
  assert.equal(env.socket.sent('room.leave').length, 0, '受邀者离开不关房');
});

test('好友房（受邀）：打开的是自己的房间 → 显示等待界面', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({ code: '135790' });
  await h.flush();
  assert.equal(page.data.view, 'waiting');
  assert.equal(page.data.room.colorText, '你执黑先行');
  assert.equal(env.socket.sent('room.create').length, 0);
});

test('好友房（受邀）：房间已不存在但我正在这个房间开的好友对局里（点卡片回来）→ 直接进入对局', async (t) => {
  const { env, page } = setup(t, { user: { id: 9, nickname: '老王' } });
  env.socket.respond('hello', () => ({ activeGames: [{ id: 'friend000001', mode: 'friend' }], room: null, matching: null }));
  page.onLoad({ code: '135799' });
  await h.flush();
  assert.equal(env.wx.last('redirectTo').url, '/pages/play/play?id=friend000001');
  assert.notEqual(page.data.view, 'closed');
});

test('好友房（受邀）：加入的回应因断线丢失 → 重连后发现已开局，进入对局', async (t) => {
  const { env, page } = setup(t);
  let started = false;
  env.socket.respond('room.get', () => {
    if (started) throw { code: 'room_not_found', msg: 'x' };
    return { room: GUEST_ROOM };
  });
  env.socket.respond('room.join', () => {
    started = true;
    throw { code: 'offline', msg: '连接已断开' };
  });
  // 断线期间 hello 等不到回应
  env.socket.respond('hello', () => {
    throw { code: 'offline' };
  });
  page.onLoad({ code: '246810' });
  await h.flush();
  await page.onJoin();
  await h.flush();
  assert.equal(page.data.view, 'invite');
  assert.equal(page.data.joining, false);
  assert.equal(env.wx.count('redirectTo'), 0);
  env.socket.emit('ready', { activeGames: [{ id: 'friend000001', mode: 'friend' }], room: null, matching: null });
  await h.flush();
  assert.equal(env.wx.last('redirectTo').url, '/pages/play/play?id=friend000001');
});

test('好友房（受邀）：加入超时（连接还在）→ 立即查询，已开局则进入对局', async (t) => {
  const { env, page } = setup(t);
  env.socket.respond('room.join', () => {
    throw { code: 'timeout', msg: '服务器响应超时' };
  });
  env.socket.respond('hello', () => ({ activeGames: [{ id: 'friend000002', mode: 'friend' }], room: null, matching: null }));
  page.onLoad({ code: '246810' });
  await h.flush();
  await page.onJoin();
  await h.flush();
  assert.equal(env.wx.last('redirectTo').url, '/pages/play/play?id=friend000002');
});

test('好友房（受邀）：加入时房间已不存在，但上一次加入其实成功了 → 进入对局', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({ code: '246810' });
  await h.flush();
  env.socket.respond('room.join', () => {
    throw { code: 'room_not_found' };
  });
  env.socket.respond('hello', () => ({ activeGames: [{ id: 'friend000003', mode: 'friend' }] }));
  await page.onJoin();
  await h.flush();
  assert.equal(env.wx.last('redirectTo').url, '/pages/play/play?id=friend000003');
});

test('好友房（受邀）：房间不存在 / 已关闭', async (t) => {
  const { page } = setup(t);
  page.onLoad({ code: '999999' });
  await h.flush();
  assert.equal(page.data.view, 'closed');
  assert.equal(page.data.closedText, '房间不存在或已失效');
  assert.equal(page.data.canRecreate, false);

  const s2 = setup(t, { timers: false });
  s2.env.socket.respond('room.get', () => ({ room: { ...GUEST_ROOM, status: 'closed' } }));
  s2.page.onLoad({ code: '246810' });
  await h.flush();
  assert.equal(s2.page.data.view, 'closed');
  assert.equal(s2.page.data.closedText, '房间已关闭');
});

test('好友房（受邀）：获取失败显示错误并可重试', async (t) => {
  const { env, page } = setup(t);
  let fail = true;
  env.socket.respond('room.get', () => {
    if (fail) throw { code: 'timeout' };
    return { room: GUEST_ROOM };
  });
  page.onLoad({ code: '246810' });
  await h.flush();
  assert.equal(page.data.view, 'error');
  assert.equal(page.data.errorText, '请求超时，请稍后重试');
  fail = false;
  page.onRetry();
  await h.flush();
  assert.equal(page.data.view, 'invite');
});

test('好友房（受邀）：未设置昵称 → 先去资料页，回来后自动加入', async (t) => {
  const { env, page } = setup(t, { user: { id: 3, nickname: '' } });
  page.onLoad({ code: '246810' });
  await h.flush();
  assert.equal(page.data.view, 'invite');
  await page.onJoin();
  assert.equal(env.wx.last('navigateTo').url, '/pages/profile/profile');
  assert.equal(env.socket.sent('room.join').length, 0);
  page.onShow(); // 资料页未保存就返回：不加入
  await h.flush();
  assert.equal(env.socket.sent('room.join').length, 0);
  await page.onJoin();
  env.auth.user = { id: 3, nickname: '新人' };
  page.onShow();
  await h.flush();
  assert.equal(env.socket.sent('room.join').length, 1);
  assert.equal(env.wx.last('redirectTo').url, '/pages/play/play?id=friend000001');
});

test('好友房（受邀）：加入时的各种错误', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({ code: '246810' });
  await h.flush();

  env.socket.respond('room.join', () => {
    throw { code: 'rate_limited' };
  });
  await page.onJoin();
  await h.flush();
  assert.deepEqual(env.wx.toasts(), ['操作太频繁，请稍后再试']);
  assert.equal(page.data.joining, false);
  assert.equal(page.data.view, 'invite');

  env.socket.respond('room.join', () => ({}));
  await page.onJoin();
  await h.flush();
  assert.equal(env.wx.toasts()[1], '服务器返回数据异常');

  env.socket.respond('room.join', () => {
    throw { code: 'room_not_found' };
  });
  await page.onJoin();
  await h.flush();
  assert.equal(page.data.view, 'closed');
  assert.equal(page.data.closedText, '房间已开局或已失效');
});

test('好友房（受邀）：加入时提示是自己的房间 → 重新加载为等待界面', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({ code: '246810' });
  await h.flush();
  env.socket.respond('room.join', () => {
    throw { code: 'own_room' };
  });
  env.socket.respond('room.get', () => ({ room: { ...GUEST_ROOM, owner: { userId: 1, nickname: '小明' } } }));
  await page.onJoin();
  await h.flush();
  assert.equal(page.data.view, 'waiting');
});

test('好友房（受邀）：加入时已有对局 → 弹窗', async (t) => {
  const { env, page } = setup(t);
  env.wx.modalResponse = { confirm: false, cancel: true };
  page.onLoad({ code: '246810' });
  await h.flush();
  env.socket.respond('room.join', () => {
    throw { code: 'in_game' };
  });
  env.socket.respond('hello', () => ({ activeGames: [] }));
  await page.onJoin();
  await h.flush();
  assert.equal(env.wx.last('showModal').confirmText, '知道了');
  assert.equal(page.data.view, 'error');
  assert.equal(env.wx.count('redirectTo'), 0);
});

test('好友房（受邀）：加入请求期间收到 game.start → 只跳一次', async (t) => {
  const { env, page } = setup(t);
  const d = h.deferred();
  env.socket.respond('room.join', () => d.promise);
  page.onLoad({ code: '246810' });
  await h.flush();
  page.onJoin();
  await h.flush();
  assert.equal(page.data.joining, true);
  page.onJoin();
  await h.flush();
  assert.equal(env.socket.sent('room.join').length, 1, '加入中不重复请求');
  env.socket.emit('game.start', { gameId: 'friend000001', mode: 'friend' });
  d.resolve({ gameId: 'friend000001' });
  await h.flush();
  assert.equal(env.wx.count('redirectTo'), 1);
});

test('好友房（受邀）：重连后静默刷新房间，房间没了则显示关闭', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({ code: '246810' });
  await h.flush();
  env.socket.emit('ready', { activeGames: [], room: null, matching: null });
  await h.flush();
  assert.equal(env.socket.sent('room.get').length, 2);
  assert.equal(page.data.view, 'invite');
  env.socket.respond('room.get', () => {
    throw { code: 'timeout' };
  });
  env.socket.emit('ready', { activeGames: [], room: null, matching: null });
  await h.flush();
  assert.equal(page.data.view, 'invite', '静默刷新失败保持原样');
  env.socket.respond('room.get', () => {
    throw { code: 'room_not_found' };
  });
  env.socket.emit('ready', { activeGames: [], room: null, matching: null });
  await h.flush();
  assert.equal(page.data.view, 'closed');
});

// ---------- 输入房号 ----------

test('好友房（输入房号）：清洗输入、校验、查找房间', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({});
  assert.equal(page.data.view, 'entry');
  assert.equal(page.data.entryError, '');
  assert.equal(page.onCodeInput({ detail: { value: '24a68 10' } }), '246810');
  assert.equal(page.data.codeInput, '246810');
  page.onCodeInput({ detail: { value: '123' } });
  page.onSubmitCode();
  assert.equal(page.data.entryError, '请输入 6 位数字房号');
  assert.equal(env.socket.sent('room.get').length, 0);
  page.onCodeInput({ detail: { value: '246810' } });
  assert.equal(page.data.entryError, '');
  page.onSubmitCode();
  await h.flush();
  assert.equal(page.data.view, 'invite');
  assert.deepEqual(page.onShareAppMessage(), { title: '老王 邀你下一盘围棋（13路）', path: '/pages/room/room?code=246810' });
});

test('好友房（输入房号）：房间不存在时可以重新输入', async (t) => {
  const { page } = setup(t);
  page.onLoad({});
  page.onCodeInput({ detail: { value: '999999' } });
  page.onSubmitCode();
  await h.flush();
  assert.equal(page.data.view, 'closed');
  assert.equal(page.data.fromEntry, true);
  page.onReenter();
  assert.equal(page.data.view, 'entry');
  assert.equal(page.data.codeInput, '');
});

test('好友房：链接里的房号无效时提示手动输入', (t) => {
  const { page } = setup(t);
  page.onLoad({ code: '12ab' });
  assert.equal(page.data.view, 'entry');
  assert.match(page.data.entryError, /无效/);
});

test('好友房：被顶号 → 回首页；返回首页按钮', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({ create: '1' });
  await h.flush();
  env.socket.emit('kicked', { reason: 'replaced' });
  await h.flush();
  assert.equal(env.wx.last('reLaunch').url, '/pages/index/index');
  page.onUnload();
  await h.flush();
  assert.equal(env.socket.sent('room.leave').length, 0);
  page.onHome();
  assert.equal(env.wx.count('reLaunch'), 2);
});

test('好友房：跳转对局失败 → 显示"进入对局"按钮', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({ create: '1' });
  await h.flush();
  env.wx.failNext.redirectTo = true;
  env.socket.emit('game.start', { gameId: 'friend000002' });
  assert.equal(page.data.view, 'started');
  page.openGame();
  assert.equal(env.wx.count('redirectTo'), 2);
});

test('好友房：状态推送更新断线提示；非法推送忽略', async (t) => {
  const { env, page } = setup(t);
  page.onLoad({ create: '1' });
  await h.flush();
  env.socket.emit('status', 'connecting');
  assert.equal(page.data.netStatus, 'connecting');
  env.socket.emit('status', null);
  assert.equal(page.data.netStatus, 'connecting');
  env.socket.emit('game.start', null);
  env.socket.emit('room.update', null);
  env.socket.emit('room.update', {});
  assert.equal(page.data.view, 'waiting');
  assert.equal(env.wx.count('redirectTo'), 0);
});
