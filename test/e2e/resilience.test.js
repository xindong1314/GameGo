'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  prerequisites,
  startE2EServer,
  createClient,
  waitUntil,
  sleep,
  loginAs,
  quickMatch,
  openPlay,
  move,
} = require('./harness');

// 端到端：服务端进程重启（客户端自动重连 → hello → game.sync 恢复）；
// 令牌失效（WebSocket 握手 401 → 客户端用 REST 校验令牌 → 重新登录 → 再连上）。

const skip = prerequisites();

test('服务端重启：两个对局页自动重连并恢复排位赛，继续下完；人机对局也能恢复', { skip: skip || false, timeout: 60000 }, async (t) => {
  const srv = await startE2EServer({});
  srv.ai.set({ dead: [] });
  const A = createClient(srv, 'A');
  const B = createClient(srv, 'B', { login: 'fail' });
  t.after(async () => {
    A.shutdown();
    B.shutdown();
    await srv.close();
  });
  await loginAs(A, 'Ann');
  await loginAs(B, 'Ben');
  const [ua, ub] = await Promise.all([quickMatch(A, 9), quickMatch(B, 9)]);
  assert.equal(ua, ub);
  const pa = await openPlay(A, ua);
  const pb = await openPlay(B, ub);
  const pages = { [pa.model.myColor]: pa, [pb.model.myColor]: pb };
  const seq = [40, 41, 30, 31, 20, 21, 10, 11, 0, 1, 60, 61];
  for (let n = 1; n <= 6; n++) await move(pages, n, seq[n - 1]);

  // ---------- 重启（停机 300ms）----------
  await srv.restart({ downMs: 300 });
  for (const p of [pa, pb]) {
    await waitUntil(() => p.data.banner === '连接中断，正在重连…' || p.model.connection !== 'open', { what: '看到断线' });
  }
  for (const p of [pa, pb]) {
    await waitUntil(() => p.data.banner === '' && p.model.connection === 'open', { timeout: 10000, what: '自动重连' });
  }
  assert.deepEqual(pa.model.moves, seq.slice(0, 6));
  assert.deepEqual(pb.model.moves, seq.slice(0, 6));
  assert.equal(pages[1].data.boardDisabled, false, '重连后轮到黑');
  assert.equal(pages[2].data.boardDisabled, true);
  assert.equal(pages[1].data.top.online, true);
  for (let n = 7; n <= seq.length; n++) await move(pages, n, seq[n - 1]);
  await sleep(35);
  pages[2].onResign();
  for (const p of [pa, pb]) await waitUntil(() => p.data.end && p.model.stats, { what: '终局' });
  assert.equal(pages[1].data.end.title, '你赢了');
  assert.deepEqual(pages[1].data.end.lines, ['当前连胜 1 局', '最高连胜 1 局 · 排位 1 局 · 胜率 100%']);
  A.close(pa);
  B.close(pb);

  // ---------- 人机对局中重启 ----------
  const { gameId } = await A.socket.request('ai.start', { size: 9, level: 'k10', color: 'black' });
  const ap = await openPlay(A, `/pages/play/play?id=${gameId}&color=black`);
  await sleep(35);
  ap.onPick({ detail: { idx: 40 } });
  ap.onConfirm();
  await waitUntil(() => ap.model.moves.length === 2 && !ap.model.aiThinking, { what: 'AI 应手' });
  await srv.restart();
  await waitUntil(() => ap.model.connection !== 'open', { what: '看到断线' });
  await waitUntil(() => ap.model.connection === 'open' && ap.data.banner === '', { timeout: 10000, what: '人机重连' });
  assert.equal(ap.model.moves.length, 2);
  await sleep(35);
  ap.onPick({ detail: { idx: 30 } });
  ap.onConfirm();
  await waitUntil(() => ap.model.moves.length === 4 && !ap.model.aiThinking, { what: '重启后 AI 应手' });
  await sleep(35);
  ap.onResign();
  await waitUntil(() => ap.data.end, { what: '人机终局' });
  assert.equal(ap.data.end.title, '你输了');

  assert.deepEqual(srv.errors(), []);
  assert.deepEqual(A.errors(), []);
  assert.deepEqual(B.errors(), []);
});

test('令牌失效：WebSocket 握手被拒（401）→ 客户端校验令牌、重新登录后连上并恢复对局页', { skip: skip || false, timeout: 60000 }, async (t) => {
  const srv = await startE2EServer({});
  const A = createClient(srv, 'A', { login: 'fail' });
  t.after(async () => {
    A.shutdown();
    await srv.close();
  });
  await loginAs(A, 'Ann');
  const { gameId } = await A.socket.request('ai.start', { size: 9, level: 'k10', color: 'black' });
  const page = await openPlay(A, `/pages/play/play?id=${gameId}`);
  const oldToken = A.auth.getToken();

  // 服务端吊销令牌，然后网络断开
  assert.equal(srv.app.repos.sessions.revoke(oldToken), true);
  A.control.dropSocket();
  await waitUntil(() => page.model.connection !== 'open', { what: '断线' });
  await waitUntil(() => page.model.connection === 'open' && page.data.banner === '', { timeout: 15000, what: '重新登录后重连' });
  const newToken = A.auth.getToken();
  assert.notEqual(newToken, oldToken, '换了新令牌');
  assert.equal(A.auth.getUser().nickname, 'Ann', '同一 deviceId → 同一账号');
  const paths = A.control.named('request').map((r) => new URL(r.url).pathname);
  assert.ok(paths.includes('/api/me'), '用 REST 校验过令牌');
  assert.equal(paths.filter((p) => p === '/api/auth/dev-login').length, 2, '重新登录了一次');
  // 令牌只在握手的 Authorization 头里（服务端按头鉴权），不进 URL（URL 会写进 nginx 与代理的日志）
  const conns = A.control.named('connectSocket');
  assert.ok(conns.length >= 2);
  for (const c of conns) {
    assert.equal(c.url, srv.wsUrl);
    assert.match(c.header && c.header.Authorization, /^Bearer [0-9a-f]{64}$/);
  }
  assert.equal(conns[0].header.Authorization, `Bearer ${oldToken}`);
  assert.equal(conns[conns.length - 1].header.Authorization, `Bearer ${newToken}`);
  // 对局照常进行
  await sleep(35);
  page.onPick({ detail: { idx: 40 } });
  page.onConfirm();
  await waitUntil(() => page.model.moves.length === 2, { what: '重连后落子' });
  assert.deepEqual(srv.errors(), []);
});

test('读秒与超时：极短用时下客户端读秒显示与服务端一致，超时终局（手数不足不计入）', { skip: skip || false, timeout: 60000 }, async (t) => {
  const srv = await startE2EServer({ config: { timeControls: { 13: { mainMs: 1000, periods: 2, periodMs: 1500 } } } });
  const A = createClient(srv, 'A');
  const B = createClient(srv, 'B', { login: 'fail' });
  t.after(async () => {
    A.shutdown();
    B.shutdown();
    await srv.close();
  });
  await loginAs(A, 'Ann');
  await loginAs(B, 'Ben');
  const [ua] = await Promise.all([quickMatch(A, 13), quickMatch(B, 13)]);
  const pa = await openPlay(A, ua);
  const pb = await openPlay(B, ua);
  const P = { [pa.model.myColor]: pa, [pb.model.myColor]: pb };
  assert.equal(P[1].data.infoText, '排位赛 · 13 路 · 贴 7.5 目 · 1 秒 + 2×2 秒');
  assert.equal(P[1].data.bottom.clock.text, '00:01');
  assert.equal(P[1].data.bottom.clock.sub, '读秒 2 次');

  // 黑方等进入读秒（基本时间 1 秒用完）再落子：读秒次数不减，周期重置
  // 主动刷新页面（不等每秒一次的计时器），刚进入读秒就落子：离第一次读秒用完还有约 1.4 秒余量
  await waitUntil(
    () => {
      P[1].render();
      return P[1].data.bottom.clock.sub === '读秒 2 次' && /^\d$/.test(P[1].data.bottom.clock.text);
    },
    { what: '黑方进入读秒' },
  );
  await sleep(100);
  await move(P, 1, 84);
  const c1 = P[2].model.clocks[1];
  assert.deepEqual({ mainMs: c1.mainMs, periodsLeft: c1.periodsLeft, periodMs: c1.periodMs }, { mainMs: 0, periodsLeft: 2, periodMs: 1500 });
  assert.deepEqual(P[2].data.top.clock, { text: '2', sub: '读秒 2 次', urgent: true, timeout: false });

  // 白方不下：基本 1 秒 + 第一次读秒用完后，显示剩 1 次（客户端推算，与服务端快照一致）
  await sleep(1000 + 1500 + 300);
  pa.render(); // 页面每秒刷新一次读秒；这里立即刷新，不等计时器
  pb.render();
  assert.equal(P[2].data.bottom.clock.sub, '读秒 1 次', '白方自己的读秒');
  assert.equal(P[1].data.top.clock.sub, '读秒 1 次', '黑方看到的白方读秒');
  // 再过一个读秒周期 → 服务端判白超时
  for (const p of [pa, pb]) await waitUntil(() => p.data.end, { timeout: 4000, what: '超时终局' });
  assert.equal(P[1].data.end.title, '你赢了');
  assert.equal(P[1].data.end.label, '黑胜（对方超时）');
  assert.deepEqual(P[1].data.end.lines, ['手数不足，本局不计入排行榜']);
  assert.equal(P[2].data.end.title, '你输了');
  assert.deepEqual(srv.errors(), []);
});

test('数子阶段服务端重启：确认被清零、建议重新给出（版本又是 1），已同意的一方要能再次同意', { skip: skip || false, timeout: 60000 }, async (t) => {
  const srv = await startE2EServer({});
  srv.ai.set({ dead: [] });
  const A = createClient(srv, 'A');
  const B = createClient(srv, 'B', { login: 'fail' });
  t.after(async () => {
    A.shutdown();
    B.shutdown();
    await srv.close();
  });
  await loginAs(A, 'Ann');
  await loginAs(B, 'Ben');
  const [ua] = await Promise.all([quickMatch(A, 9), quickMatch(B, 9)]);
  const pa = await openPlay(A, ua);
  const pb = await openPlay(B, ua);
  const P = { [pa.model.myColor]: pa, [pb.model.myColor]: pb };
  const seq = [40, 41, 30, 31, 20, 21, 10, 11, 0, 1, -1, -1];
  for (let n = 1; n <= seq.length; n++) await move(P, n, seq[n - 1]);
  for (const p of [pa, pb]) await waitUntil(() => p.data.scoring && !p.data.scoring.pending, { what: '数子建议' });
  assert.equal(P[1].model.scoring.version, 1);
  await sleep(35);
  P[1].onAccept();
  await waitUntil(() => P[2].data.scoring.oppAccepted, { what: '黑已同意' });
  assert.equal(P[1].data.scoring.meAccepted, true);

  await srv.restart();
  for (const p of [pa, pb]) await waitUntil(() => p.model.connection !== 'open', { what: '断线' });
  for (const p of [pa, pb]) {
    await waitUntil(() => p.model.connection === 'open' && p.data.scoring && !p.data.scoring.pending, { timeout: 10000, what: '重连后的数子建议' });
  }
  // 服务端：确认已清零（重新请求了死子建议）
  assert.equal(P[1].model.scoring.version, 1);
  assert.deepEqual(P[1].model.scoring.accepted, { 1: false, 2: false });
  // 客户端必须以服务端为准：黑方显示"未同意"、可以再次同意；白方看到对手未同意
  assert.equal(P[1].data.scoring.meAccepted, false, '黑方的确认已被服务端清零');
  assert.equal(P[1].data.btn.accept, true, '黑方可以再次同意');
  assert.equal(P[2].data.scoring.oppAccepted, false);
  await sleep(35);
  P[1].onAccept();
  await waitUntil(() => P[2].data.scoring.oppAccepted, { what: '黑再次同意' });
  await sleep(35);
  P[2].onAccept();
  for (const p of [pa, pb]) await waitUntil(() => p.data.end, { what: '终局' });
  assert.equal(P[1].data.end.label.startsWith('白胜') || P[1].data.end.label.startsWith('黑胜'), true);
  assert.deepEqual(srv.errors(), []);
});
