'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, createPage, createWx, createSocket, settle } = require('./play-harness');

const PASS = -1;

function snapshot(over) {
  return Object.assign(
    {
      id: 'g1',
      mode: 'ranked',
      size: 9,
      komi: 7.5,
      players: {
        1: { userId: 1, nickname: '小黑', avatarUrl: '' },
        2: { userId: 2, nickname: '小白', avatarUrl: '' },
      },
      myColor: 1,
      moves: [],
      status: 'playing',
      toPlay: 1,
      timeControl: { mainMs: 180000, periods: 3, periodMs: 20000 },
      clocks: {
        1: { mainMs: 180000, periodsLeft: 3, periodMs: 20000 },
        2: { mainMs: 180000, periodsLeft: 3, periodMs: 20000 },
        running: 1,
      },
      scoring: null,
      result: null,
      presence: { 1: true, 2: true },
      aiThinking: false,
      canUndo: false,
    },
    over || {}
  );
}

function aiSnapshot(over) {
  return snapshot(
    Object.assign(
      {
        mode: 'ai',
        players: { 1: { userId: 1, nickname: '小黑', avatarUrl: '' }, 2: { ai: true, level: 'k5', nickname: 'AI · 5级', avatarUrl: '' } },
        timeControl: null,
        clocks: null,
      },
      over || {}
    )
  );
}

const timersEnabled = new WeakSet();

// 启动对局页：onLoad + onShow，并返回同步请求（未回复）
async function setup(t, { query = { id: 'g1' }, modalConfirm, me } = {}) {
  // 同一个测试里可能启动多个页面：假时钟只启用一次
  if (!timersEnabled.has(t)) {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_000_000 });
    timersEnabled.add(t);
  }
  const socket = createSocket();
  const wx = createWx({ modalConfirm });
  global.wx = wx;
  const auth = { logins: 0, ensureLogin() { this.logins += 1; return Promise.resolve({ id: 1 }); }, getUser: () => ({ id: 1 }) };
  const clock = {
    displayClock(c, elapsed) {
      return { text: String(Math.ceil((c.mainMs - elapsed) / 1000)), sub: '', urgent: false, timeout: false };
    },
  };
  const api = {
    calls: [],
    request(opts) {
      this.calls.push(opts);
      if (opts.path === '/api/me' && me) return Promise.resolve(me);
      return Promise.reject({ code: 'not_found', msg: 'no route' });
    },
  };
  const def = loadPage('pages/play/play', {
    'utils/net/socket': socket,
    'utils/net/auth': auth,
    'utils/net/api': api,
    'utils/clock': { displayClock: clock.displayClock },
  });
  const page = createPage(def);
  page.onLoad(query);
  page.onShow();
  await settle();
  t.after(() => {
    global.wx = wx;
    if (!page.unloaded) page.onUnload();
    delete global.wx;
  });
  return { page, socket, wx, auth, api };
}

async function loaded(t, snap, opts) {
  const env = await setup(t, opts);
  const req = env.socket.take('game.sync');
  assert.ok(req, '应发出 game.sync');
  assert.deepEqual(req.params, { gameId: 'g1' });
  req.resolve({ game: snap || snapshot() });
  await settle();
  return env;
}

test('加载：登录、连接、订阅推送、同步快照并渲染', async (t) => {
  const { page, socket, wx, auth } = await loaded(t);
  assert.equal(auth.logins, 1);
  assert.equal(socket.connects, 1);
  for (const type of ['game.move', 'game.undo', 'game.ai', 'game.scoring', 'game.resumed', 'game.end', 'game.presence', 'status', 'ready', 'kicked']) {
    assert.equal(socket.count(type), 1, type);
  }
  assert.equal(page.data.loading, false);
  assert.equal(page.data.loaded, true);
  assert.equal(page.data.cells.length, 81);
  assert.equal(page.data.top.nickname, '小白');
  assert.equal(page.data.bottom.clock.text, '180');
  assert.deepEqual(wx.named('setNavigationBarTitle')[0].title, '排位赛');
  assert.deepEqual(wx.named('setKeepScreenOn')[0].keepScreenOn, true);
});

test('对局编号无效：直接报错，不订阅', async (t) => {
  const { page, socket } = await setup(t, { query: { id: '../x' } });
  assert.equal(page.data.loadError, '对局编号无效');
  assert.equal(socket.total(), 0);
  assert.equal(socket.requests.length, 0);
});

test('同步失败显示错误，可重试', async (t) => {
  const { page, socket } = await setup(t);
  socket.take('game.sync').reject({ code: 'not_player', msg: 'x' });
  await settle();
  assert.equal(page.data.loadError, '你不是这局的棋手');
  page.onRetry();
  await settle();
  socket.take('game.sync').resolve({ game: snapshot() });
  await settle();
  assert.equal(page.data.loadError, '');
  assert.equal(page.data.loaded, true);
  // 快照格式错误
  const env2 = await setup(t);
  env2.socket.take('game.sync').resolve({ game: snapshot({ moves: [40, 40] }) });
  await settle();
  assert.match(env2.page.data.loadError, /对局数据异常/);
  const env3 = await setup(t);
  env3.socket.take('game.sync').resolve({});
  await settle();
  assert.equal(env3.page.data.loadError, '服务器返回的对局数据为空');
});

test('对手落子推送：更新棋盘并震动；其他对局的推送忽略', async (t) => {
  const { page, socket, wx } = await loaded(t, snapshot({ myColor: 2, toPlay: 1 }));
  socket.emit('game.move', { t: 'game.move', gameId: 'other', n: 1, idx: 40, color: 1, captured: [] });
  assert.equal(page.data.cells[40], 0);
  socket.emit('game.move', { t: 'game.move', gameId: 'g1', n: 1, idx: 40, color: 1, captured: [], clocks: snapshot().clocks });
  assert.equal(page.data.cells[40], 1);
  assert.equal(page.data.lastIdx, 40);
  assert.equal(wx.named('vibrateShort').length, 1);
  assert.equal(socket.pending('game.sync'), 0);
});

test('推送序号不连续 → 重新同步；并发的同步合并', async (t) => {
  const { page, socket } = await loaded(t);
  socket.emit('game.move', { gameId: 'g1', n: 5, idx: 40, color: 1, captured: [] });
  socket.emit('game.move', { gameId: 'g1', n: 6, idx: 41, color: 2, captured: [] });
  await settle();
  assert.equal(socket.pending('game.sync'), 1, '同步进行中不重复发');
  socket.take('game.sync').resolve({ game: snapshot({ moves: [40, 41], toPlay: 1 }) });
  await settle();
  assert.equal(socket.pending('game.sync'), 1, '合并为一次额外同步');
  socket.take('game.sync').resolve({ game: snapshot({ moves: [40, 41], toPlay: 1 }) });
  await settle();
  assert.equal(socket.pending('game.sync'), 0);
  assert.equal(page.data.cells[41], 2);
});

test('选点、确定落子：发送 game.move，推送到达后轮到对手', async (t) => {
  const { page, socket } = await loaded(t);
  page.onPick({ detail: { idx: 40 } });
  assert.deepEqual(page.data.preview, { idx: 40, ok: true, color: 1 });
  assert.equal(page.data.btn.confirm, true);
  page.onConfirm();
  await settle();
  const req = socket.take('game.move');
  assert.deepEqual(req.params, { gameId: 'g1', n: 1, idx: 40 });
  assert.equal(page.data.btn.confirm, false);
  assert.equal(page.data.boardDisabled, true);
  page.onConfirm();
  await settle();
  assert.equal(socket.pending('game.move'), 0, '提交中不能重复落子');
  socket.emit('game.move', { gameId: 'g1', n: 1, idx: 40, color: 1, captured: [] });
  req.resolve();
  await settle();
  assert.equal(page.data.cells[40], 1);
  assert.equal(page.data.preview, null);
  assert.equal(page.data.statusText, '等待对手落子…');
});

test('落子成功但推送丢失：3 秒后主动同步', async (t) => {
  const { page, socket } = await loaded(t);
  page.onPick({ detail: { idx: 40 } });
  page.onConfirm();
  await settle();
  socket.take('game.move').resolve();
  await settle();
  assert.equal(socket.pending('game.sync'), 0);
  t.mock.timers.tick(3000);
  await settle();
  assert.equal(socket.pending('game.sync'), 1);
  socket.take('game.sync').resolve({ game: snapshot({ moves: [40], toPlay: 2 }) });
  await settle();
  assert.equal(page.data.cells[40], 1);
  assert.equal(page.data.statusText, '等待对手落子…');
});

test('落子被判非法：中文提示并重新同步', async (t) => {
  const { page, socket } = await loaded(t);
  page.onPick({ detail: { idx: 40 } });
  page.onConfirm();
  await settle();
  socket.take('game.move').reject({ code: 'illegal', msg: 'ko' });
  await settle();
  assert.equal(page.data.hint, '打劫，暂不能回提');
  assert.equal(page.data.preview, null);
  assert.equal(socket.pending('game.sync'), 1);
});

test('断线与重连：显示横幅，ready 后自动同步；被顶号可手动重连', async (t) => {
  const { page, socket } = await loaded(t);
  socket.emit('status', 'closed');
  assert.equal(page.data.banner, '连接中断，正在重连…');
  assert.equal(page.data.btn.pass, false);
  socket.emit('status', 'connecting');
  socket.emit('status', 'open');
  socket.emit('ready', { activeGames: [{ id: 'g1', mode: 'ranked' }] });
  await settle();
  // 重新连上但还没拿到最新快照：仍显示"正在重连"、不能操作（断线期间可能错过推送）
  assert.equal(page.data.banner, '连接中断，正在重连…');
  assert.equal(page.data.btn.pass, false);
  assert.equal(socket.pending('game.sync'), 1);
  socket.take('game.sync').resolve({ game: snapshot({ moves: [40], toPlay: 2 }) });
  await settle();
  assert.equal(page.data.banner, '');
  assert.equal(page.data.cells[40], 1);

  socket.emit('kicked', { reason: 'replaced' });
  socket.emit('status', 'closed');
  assert.match(page.data.banner, /其他设备/);
  page.onBannerTap();
  assert.equal(socket.connects, 2);
  assert.equal(page.data.banner, '连接中断，正在重连…');
});

test('计时：可见时每秒刷新读秒，隐藏时停止，终局后停止', async (t) => {
  const { page, socket } = await loaded(t);
  assert.equal(page.data.bottom.clock.text, '180');
  const before = page.setDataCalls.length;
  t.mock.timers.tick(1000);
  assert.equal(page.data.bottom.clock.text, '179');
  const patch = page.setDataCalls[page.setDataCalls.length - 1];
  assert.deepEqual(Object.keys(patch), ['bottom'], '只提交变化的字段');
  assert.equal(page.setDataCalls.length, before + 1);
  page.onHide();
  t.mock.timers.tick(5000);
  assert.equal(page.data.bottom.clock.text, '179');
  page.onShow();
  assert.equal(page.data.bottom.clock.text, '174');
  socket.emit('game.end', { gameId: 'g1', result: { winner: 2, reason: 'resign', counted: false } });
  assert.equal(page.data.phase, 'ended');
  assert.equal(page.data.end.title, '你输了');
  const n = page.setDataCalls.length;
  t.mock.timers.tick(5000);
  assert.equal(page.setDataCalls.length, n, '终局后不再刷新');
  assert.equal(page.ticker, null);
});

test('认输需二次确认', async (t) => {
  const { page, socket, wx } = await loaded(t, snapshot(), { modalConfirm: true });
  page.onResign();
  await settle();
  assert.equal(wx.named('showModal').length, 1);
  assert.deepEqual(socket.take('game.resign').params, { gameId: 'g1' });
  const env = await loaded(t, snapshot(), { modalConfirm: false });
  env.page.onResign();
  await settle();
  assert.equal(env.socket.pending('game.resign'), 0);
});

test('数子阶段：点选死子发 toggle，原生 tap 忽略；同意带版本号', async (t) => {
  const { page, socket } = await loaded(
    t,
    snapshot({
      moves: [40, 41, PASS, PASS],
      status: 'scoring',
      toPlay: 1,
      clocks: null,
      scoring: { pending: false, source: 'katago', version: 3, dead: [41], owner: new Array(81).fill(1), black: 81, white: 7.5, winner: 1, accepted: { 1: false, 2: false }, deadline: 120000 },
    })
  );
  assert.equal(page.data.phase, 'scoring');
  assert.deepEqual(page.data.marks.dead, [41]);
  page.onBoardTap({ detail: { x: 10, y: 10 } });
  await settle();
  assert.equal(socket.pending('game.score.toggle'), 0);
  page.onBoardTap({ detail: { idx: 41 } });
  await settle();
  const toggle = socket.take('game.score.toggle');
  assert.deepEqual(toggle.params, { gameId: 'g1', idx: 41 });
  toggle.resolve();
  await settle();
  page.onAccept();
  await settle();
  assert.deepEqual(socket.take('game.score.accept').params, { gameId: 'g1', version: 3 });
  page.onResume();
  await settle();
  assert.equal(socket.pending('game.score.resume'), 0, '同意请求进行中');
});

test('再来一局：排位跳转匹配页；人机调用 ai.start 后跳转新对局；失败提示', async (t) => {
  const end = { gameId: 'g1', result: { winner: 1, reason: 'resign', counted: true } };
  const ranked = await loaded(t, snapshot({ size: 13 }));
  ranked.socket.emit('game.end', end);
  ranked.page.onAgain();
  assert.deepEqual(ranked.wx.named('redirectTo')[0], { url: '/pages/match/match?size=13' });

  const ai = await loaded(t, aiSnapshot(), { query: { id: 'g1', color: 'random' } });
  ai.socket.emit('game.end', end);
  ai.page.onAgain();
  await settle();
  const req = ai.socket.take('ai.start');
  assert.deepEqual(req.params, { size: 9, level: 'k5', color: 'random' });
  assert.equal(ai.page.data.btn.again, false);
  req.resolve({ gameId: 'g2' });
  await settle();
  assert.deepEqual(ai.wx.named('redirectTo')[0], { url: '/pages/play/play?id=g2&color=random' });
  assert.equal(ai.wx.named('hideLoading').length, 1);

  const fail = await loaded(t, aiSnapshot());
  fail.socket.emit('game.end', end);
  fail.page.onAgain();
  await settle();
  fail.socket.take('ai.start').reject({ code: 'ai_unavailable', msg: 'x' });
  await settle();
  assert.deepEqual(fail.wx.named('showToast')[0], { title: 'AI 暂时不可用', icon: 'none' });
  assert.equal(fail.page.data.btn.again, true);

  const friend = await loaded(t, snapshot({ mode: 'friend' }));
  friend.socket.emit('game.end', end);
  assert.equal(friend.page.data.end.showAgain, false);
  friend.page.onHome();
  assert.deepEqual(friend.wx.named('reLaunch')[0], { url: '/pages/index/index' });
  friend.page.onReplay();
  assert.deepEqual(friend.wx.named('navigateTo')[0], { url: '/pages/replay/replay?id=g1' });
});

test('再来一局：开局请求期间别的页面被打开到上面（如开局通知）→ 不 redirectTo（否则会关掉那个页面）', async (t) => {
  const end = { gameId: 'g1', result: { winner: 1, reason: 'resign', counted: true } };
  const ai = await loaded(t, aiSnapshot(), { query: { id: 'g1', color: 'black' } });
  const stack = [{ route: 'pages/index/index' }, ai.page];
  global.getCurrentPages = () => stack.slice();
  t.after(() => {
    delete global.getCurrentPages;
  });
  ai.socket.emit('game.end', end);
  ai.page.onAgain();
  await settle();
  const req = ai.socket.take('ai.start');
  stack.push({ route: 'pages/play/play', options: { id: 'friend000001' } });
  req.resolve({ gameId: 'g2' });
  await settle();
  assert.equal(ai.wx.named('redirectTo').length, 0);
  assert.equal(ai.wx.named('hideLoading').length, 1);
  assert.equal(ai.page.model.pending, null);
  // 仍在栈顶时照常跳转
  stack.pop();
  ai.page.onAgain();
  await settle();
  ai.socket.take('ai.start').resolve({ gameId: 'g3' });
  await settle();
  assert.deepEqual(ai.wx.named('redirectTo')[0], { url: '/pages/play/play?id=g3&color=black' });
});

test('人机对局：AI 思考提示与悔棋', async (t) => {
  const { page, socket } = await loaded(t, aiSnapshot({ moves: [40, 41], toPlay: 1, canUndo: true }));
  assert.equal(page.data.btn.showUndo, true);
  assert.equal(page.data.btn.undo, true);
  assert.equal(page.data.bottom.clock, null);
  page.onUndo();
  await settle();
  socket.take('game.undo').resolve();
  socket.emit('game.undo', { gameId: 'g1', moves: [] });
  await settle();
  assert.equal(page.data.cells[40], 0);
  assert.equal(page.data.btn.undo, false);
  socket.emit('game.ai', { gameId: 'g1', thinking: true });
  assert.equal(page.data.top.thinking, true);
});

test('卸载：取消全部订阅、停止计时、关闭常亮；之后的推送与回复不再处理', async (t) => {
  const { page, socket, wx } = await loaded(t);
  page.onPick({ detail: { idx: 40 } });
  page.onConfirm();
  await settle();
  const req = socket.take('game.move');
  page.onUnload();
  assert.equal(socket.total(), 0);
  assert.equal(page.ticker, null);
  const keep = wx.named('setKeepScreenOn');
  assert.equal(keep[keep.length - 1].keepScreenOn, false);
  const n = page.setDataCalls.length;
  req.resolve();
  await settle();
  t.mock.timers.tick(10000);
  await settle();
  assert.equal(page.setDataCalls.length, n);
  assert.equal(socket.pending('game.sync'), 0);
});

test('重新同步失败时提示，恢复后清除；自己的落子推送不震动', async (t) => {
  const { page, socket, wx } = await loaded(t);
  socket.emit('game.move', { gameId: 'g1', n: 3, idx: 40, color: 1, captured: [] });
  await settle();
  socket.take('game.sync').reject({ code: 'offline', msg: 'x' });
  await settle();
  assert.equal(page.data.hint, '同步失败：网络未连接，请稍后再试');
  socket.emit('ready', {});
  await settle();
  socket.take('game.sync').resolve({ game: snapshot() });
  await settle();
  assert.equal(page.data.hint, '');
  socket.emit('game.move', { gameId: 'g1', n: 1, idx: 40, captured: [] });
  assert.equal(page.data.cells[40], 1);
  assert.equal(wx.named('vibrateShort').length, 0);
});

test('首次加载按 socket.getStatus() 初始化连接状态', async (t) => {
  const env = await setup(t);
  env.socket.getStatus = () => 'connecting';
  env.socket.take('game.sync').resolve({ game: snapshot() });
  await settle();
  assert.equal(env.page.data.banner, '连接中断，正在重连…');
  env.socket.getStatus = () => 'open';
  env.socket.emit('ready', {});
  await settle();
  // ready 触发重新同步，同步成功后按 socket 的实际状态显示为已连接
  assert.equal(env.page.data.banner, '连接中断，正在重连…');
  env.socket.take('game.sync').resolve({ game: snapshot() });
  await settle();
  assert.equal(env.page.data.banner, '');
});

test('重连后的同步失败：保持"正在重连"并在 2 秒后重试', async (t) => {
  const { page, socket } = await loaded(t);
  socket.emit('status', 'closed');
  socket.emit('status', 'open');
  socket.emit('ready', {});
  await settle();
  socket.take('game.sync').reject({ code: 'timeout', msg: '请求超时' });
  await settle();
  assert.equal(page.data.banner, '连接中断，正在重连…');
  assert.equal(socket.pending('game.sync'), 0);
  t.mock.timers.tick(2000);
  await settle();
  assert.equal(socket.pending('game.sync'), 1, '2 秒后重试同步');
  socket.take('game.sync').resolve({ game: snapshot() });
  await settle();
  assert.equal(page.data.banner, '');
});

test('停一手：真人对局先确认（对手刚停一手时说明将进入数子），取消则不发；人机对局直接停', async (t) => {
  const { page, socket, wx } = await loaded(t, snapshot({ moves: [40, PASS], toPlay: 1 }), { modalConfirm: false });
  page.onPass();
  await settle();
  assert.equal(wx.named('showModal').length, 1);
  assert.match(wx.named('showModal')[0].content, /对手已停一手/);
  assert.equal(socket.pending('game.pass'), 0, '取消：不发请求');

  const env = await loaded(t, snapshot({ moves: [40], toPlay: 2, myColor: 2 }), { modalConfirm: true });
  env.page.onPass();
  await settle();
  assert.match(env.wx.named('showModal')[0].content, /轮到对手/);
  assert.deepEqual(env.socket.take('game.pass').params, { gameId: 'g1', n: 2 });

  // 没轮到自己：不弹窗，直接给提示
  const env2 = await loaded(t, snapshot({ moves: [40], toPlay: 2 }), { modalConfirm: true });
  env2.page.onPass();
  await settle();
  assert.equal(env2.wx.named('showModal').length, 0);
  assert.equal(env2.page.data.hint, '还没轮到你');

  const ai = await loaded(t, aiSnapshot(), { modalConfirm: true });
  ai.page.onPass();
  await settle();
  assert.equal(ai.wx.named('showModal').length, 0);
  assert.deepEqual(ai.socket.take('game.pass').params, { gameId: 'g1', n: 1 });
});

test('排位赛在断线期间结束（结果来自快照，没有统计）→ 用 GET /api/me 补上连胜与胜率', async (t) => {
  const me = { user: { id: 1 }, stats: { games: 7, wins: 5, losses: 2, draws: 0, winrate: 5 / 7, curStreak: 4, maxStreak: 4 } };
  const ended = snapshot({
    moves: [40, 41, 42, 43, 44, 45, 46, 47, 48, 49],
    status: 'ended',
    toPlay: 1,
    clocks: null,
    result: { winner: 1, reason: 'resign', black: null, white: null, text: 'B+R', label: '黑中盘胜（对方认输）', counted: true },
  });
  const { page, api } = await loaded(t, ended, { me });
  await settle();
  assert.deepEqual(api.calls, [{ method: 'GET', path: '/api/me' }]);
  assert.deepEqual(page.data.end.lines, ['当前连胜 4 局（个人最高）', '最高连胜 4 局 · 排位 7 局 · 胜率 71.4%']);
  // 不计入 / 非排位：不请求
  const env2 = await loaded(t, snapshot(Object.assign({}, ended, { result: Object.assign({}, ended.result, { counted: false }) })), { me });
  await settle();
  assert.equal(env2.api.calls.length, 0);
});

test('排位 game.end 推送没带统计 → 同样用 GET /api/me 补上；带了统计则不请求', async (t) => {
  const me = { stats: { games: 2, wins: 1, losses: 1, draws: 0, winrate: 0.5, curStreak: 0, maxStreak: 1 } };
  const moves = [40, 41, 42, 43, 44, 45, 46, 47, 48, 49];
  const { page, socket, api } = await loaded(t, snapshot({ moves, toPlay: 1 }), { me });
  socket.emit('game.end', { gameId: 'g1', result: { winner: 2, reason: 'resign', black: null, white: null, counted: true } });
  await settle();
  assert.deepEqual(api.calls.map((c) => c.path), ['/api/me']);
  assert.deepEqual(page.data.end.lines, ['连胜中断', '最高连胜 1 局 · 排位 2 局 · 胜率 50%']);

  const env = await loaded(t, snapshot({ moves, toPlay: 1 }), { me });
  env.socket.emit('game.end', {
    gameId: 'g1',
    result: { winner: 1, reason: 'resign', black: null, white: null, counted: true },
    stats: { 1: { games: 3, wins: 2, losses: 1, draws: 0, winrate: 2 / 3, curStreak: 1, maxStreak: 1 } },
  });
  await settle();
  assert.equal(env.api.calls.length, 0);
});
