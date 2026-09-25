'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prerequisites, startE2EServer, createClient, waitUntil, sleep, loginAs, quickMatch, openPlay, move } = require('./harness');

// 端到端：真实服务端 + 两个模拟客户端（真实的 utils/net/{auth,api,socket}、pages/profile|match|play 与 model/clock，
// wx 由真实网络实现）。这是客户端与服务端说同一种协议的证明。

const skip = prerequisites();

// 9 路剧本（与 server/test/integration 相同）：第 27 手黑 19 提白 10；白 20 留在黑地里。
const SCRIPT = [4, 5, 13, 14, 22, 23, 31, 32, 40, 41, 49, 50, 58, 59, 67, 68, 76, 77, 72, 10, 1, 20, 9, 7, 11, 16, 19];
const CAPTURE_N = 27;

// 1×1 PNG
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a0b5fd6a0000000049454e44ae426082',
  'hex',
);

// 资料页：选头像（可选）+ 提交昵称 → 跳到 redirect
async function setupProfile(client, { nickname, avatarPath, redirect }) {
  const since = client.control.calls.length;
  const page = client.open('pages/profile/profile', { redirect: encodeURIComponent(redirect) });
  await waitUntil(() => page.data.ready, { what: `${client.name} 资料页就绪` });
  assert.equal(page.data.firstTime, true);
  if (avatarPath) page.onChooseAvatar({ detail: { avatarUrl: avatarPath } });
  await page.onSubmit({ detail: { value: { nickname } } });
  const nav = await client.control.waitFor('redirectTo', { since });
  assert.equal(nav.url, redirect);
  client.close(page);
  return nav.url;
}

// 匹配页：等 match.found → redirectTo 对局页；返回对局页地址里的 gameId
async function matchId(client, size) {
  const url = await quickMatch(client, size);
  const id = decodeURIComponent(url.split('id=')[1]);
  assert.match(id, /^[0-9a-z]{12}$/);
  return { id };
}

const openPlayById = (client, id) => openPlay(client, `/pages/play/play?id=${id}`);

// 某一方在自己的对局页上落子（选点 → 确定）或停一手，等双方页面都收到这一手
async function act(byColor, n, idx) {
  const color = n % 2 === 1 ? 1 : 2;
  const me = byColor[color];
  const opp = byColor[3 - color];
  await sleep(35); // 服务端每连接每秒 ≤ 20 条
  if (idx === -1) {
    assert.equal(me.page.data.btn.pass, true, `第 ${n} 手：可以停一手`);
    me.page.onPass();
  } else {
    me.page.onPick({ detail: { idx } });
    assert.deepEqual(me.page.data.preview, { idx, ok: true, color }, `第 ${n} 手预览`);
    assert.equal(me.page.data.btn.confirm, true, `第 ${n} 手：确定按钮可用`);
    // 对方此时不能落子：选点无效、按钮不可用
    opp.page.onPick({ detail: { idx } });
    assert.equal(opp.page.data.preview, null);
    assert.equal(opp.page.data.btn.confirm, false);
    assert.equal(opp.page.data.btn.pass, false);
    assert.equal(opp.page.data.boardDisabled, true);
    me.page.onConfirm();
    assert.equal(me.page.data.statusText, '提交中…');
  }
  await waitUntil(() => me.page.model.moves.length === n && opp.page.model.moves.length === n, { what: `第 ${n} 手同步` });
}

function clockShape(c) {
  assert.ok(c && typeof c === 'object', '有读秒显示');
  assert.deepEqual(Object.keys(c).sort(), ['sub', 'text', 'timeout', 'urgent']);
  assert.equal(typeof c.text, 'string');
  assert.equal(c.timeout, false);
}

test('两个真实客户端：登录 → 资料 → 快速匹配 → 对局（提子、读秒、pass、数子点选、确认）→ 终局统计 → 第二局断线重连', { skip: skip || false, timeout: 60000 }, async (t) => {
  const srv = await startE2EServer({});
  srv.ai.set({ dead: [] }); // 死子建议为空：由玩家点选白 20
  const A = createClient(srv, 'A', { login: 'code' }); // wx.login 成功 → /auth/login 503 → dev-login
  const B = createClient(srv, 'B', { login: 'fail' }); // wx.login 失败 → dev-login
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gamego-e2e-avatar-'));
  t.after(async () => {
    A.shutdown();
    B.shutdown();
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ---------- 登录 ----------
  const ua = await A.auth.ensureLogin();
  assert.equal(ua.nickname, '');
  assert.equal(A.auth.needProfile(), true);
  assert.deepEqual(
    A.control.named('request').map((r) => new URL(r.url).pathname),
    ['/api/auth/login', '/api/auth/dev-login'],
    'A：先微信登录，503 wx_not_configured 后改走 dev-login',
  );
  const ub = await B.auth.ensureLogin();
  assert.deepEqual(B.control.named('request').map((r) => new URL(r.url).pathname), ['/api/auth/dev-login']);
  assert.notEqual(ua.id, ub.id);
  assert.match(A.auth.getToken(), /^[0-9a-f]{64}$/);

  // ---------- 资料：A 选头像 + 昵称，B 只填昵称（真实资料页）----------
  const avatarFile = path.join(tmp, 'wxfile_tmp_avatar.png');
  fs.writeFileSync(avatarFile, PNG);
  await setupProfile(A, { nickname: 'Alice', avatarPath: avatarFile, redirect: '/pages/match/match?size=9' });
  await setupProfile(B, { nickname: 'Bob', redirect: '/pages/match/match?size=9' });
  assert.equal(A.auth.getUser().nickname, 'Alice');
  assert.match(A.auth.getUser().avatarUrl, new RegExp(`^${srv.url}/avatars/[0-9a-f]{24}\\.png$`));
  assert.equal(A.auth.needProfile(), false);
  const img = await fetch(A.auth.getUser().avatarUrl);
  assert.equal(img.status, 200);
  assert.ok(Buffer.from(await img.arrayBuffer()).equals(PNG));
  const meA = await A.api.request({ method: 'GET', path: '/api/me' });
  assert.equal(meA.needProfile, false);
  assert.equal(meA.user.nickname, 'Alice');

  // ---------- 快速匹配（真实匹配页）----------
  const [ma, mb] = await Promise.all([matchId(A, 9), matchId(B, 9)]);
  assert.equal(ma.id, mb.id);
  const gameId = ma.id;
  const pa = await openPlayById(A, gameId);
  const pb = await openPlayById(B, gameId);
  const byColor = {};
  for (const [c, page] of [[A, pa], [B, pb]]) byColor[page.model.myColor] = { client: c, page };
  assert.ok(byColor[1] && byColor[2], '一黑一白');
  const black = byColor[1];
  const white = byColor[2];

  // 初始视图
  const bv = black.page.data;
  assert.equal(bv.infoText, '排位赛 · 9 路 · 贴 7.5 目 · 3 分 + 3×20 秒');
  assert.equal(bv.phase, 'playing');
  assert.equal(bv.bottom.isMe, true);
  assert.equal(bv.bottom.active, true);
  assert.equal(bv.top.active, false);
  assert.equal(bv.top.nickname, white.client.auth.getUser().nickname);
  assert.equal(bv.boardDisabled, false);
  assert.equal(bv.btn.pass, true);
  assert.equal(bv.btn.confirm, false, '未选点时不能确定');
  assert.equal(bv.btn.showUndo, false);
  assert.match(bv.statusText, /轮到你/);
  clockShape(bv.bottom.clock);
  clockShape(bv.top.clock);
  assert.equal(bv.top.clock.text, '03:00');
  assert.equal(bv.top.clock.sub, '读秒 3 次');
  const wv = white.page.data;
  assert.equal(wv.boardDisabled, true);
  assert.equal(wv.btn.pass, false);
  assert.equal(wv.statusText, '等待对手落子…');
  assert.equal(wv.top.online, true);
  // 不是自己回合：确定 → 提示
  white.page.onConfirm();
  assert.equal(white.page.data.hint, '还没轮到你');
  // 头像地址经快照传到对手页面
  const alice = byColor[1].client === A ? black : white;
  const other = alice === black ? white : black;
  assert.equal(other.page.data.top.avatarUrl, A.auth.getUser().avatarUrl);

  // ---------- 剧本对局 ----------
  for (let n = 1; n <= SCRIPT.length; n++) {
    await act(byColor, n, SCRIPT[n - 1]);
    if (n === 1) {
      // 黑下完：黑方的钟停、白方的钟走
      await waitUntil(() => white.page.data.bottom.active && !black.page.data.bottom.active);
      assert.equal(black.page.data.lastIdx, SCRIPT[0]);
      assert.equal(white.page.data.cells[SCRIPT[0]], 1);
    }
  }
  // 提子：黑提白 10
  for (const p of [black, white]) {
    assert.equal(p.page.data.cells[10], 0, '白 10 已被提走');
    assert.equal(p.page.data.cells[20], 2, '白 20 还在');
  }
  assert.equal(black.page.data.bottom.captures, 1);
  assert.equal(white.page.data.top.captures, 1);
  assert.equal(white.page.data.bottom.captures, 0);
  assert.equal(black.page.data.moveText, `第 ${CAPTURE_N} 手`);
  clockShape(white.page.data.bottom.clock);
  assert.match(white.page.data.bottom.clock.text, /^0[0-3]:\d\d$/);

  // 白停一手 → 黑方看到提示；黑也停 → 数子
  await act(byColor, CAPTURE_N + 1, -1);
  assert.equal(black.page.data.statusText, '对手停了一手，轮到你（你也停一手将进入数子）');
  await act(byColor, CAPTURE_N + 2, -1);
  for (const p of [black, white]) {
    await waitUntil(() => p.page.data.phase === 'scoring' && p.page.data.scoring && !p.page.data.scoring.pending, { what: '数子建议' });
    const d = p.page.data;
    assert.deepEqual(d.marks.dead, []);
    assert.equal(d.marks.owner.length, 81);
    assert.equal(d.boardDisabled, false, '真人对局数子阶段可以点选');
    assert.equal(d.btn.accept, true);
    assert.equal(d.btn.resume, true);
    assert.equal(d.btn.pass, false);
    assert.equal(d.btn.confirm, false);
    assert.equal(d.preview, null);
    assert.equal(d.top.clock.timeout, false);
    assert.match(d.scoring.deadlineText, /后自动计分$/);
    assert.match(d.scoring.leadText, /^按当前结果：白胜 /, '不算死子：白胜');
  }

  // 点空点：只提示，不发请求
  const sentBefore = srv.logger.logs.debug.length;
  white.page.onBoardTap({ detail: { idx: 30 } });
  assert.equal(white.page.data.hint, '点击棋子可切换死活');
  void sentBefore;

  // 白方点选自己的白 20 为死子 → 双方看到新版本
  white.page.onBoardTap({ detail: { idx: 20 } });
  for (const p of [black, white]) {
    await waitUntil(() => p.page.data.marks && p.page.data.marks.dead.length === 1, { what: '点选后的死子' });
    const d = p.page.data;
    assert.deepEqual(d.marks.dead, [20]);
    assert.equal(d.marks.owner[20], 1);
    assert.equal(d.scoring.blackText, '45 点');
    assert.equal(d.scoring.whiteText, '43.5 点');
    assert.equal(d.scoring.leadText, '按当前结果：黑胜 1.5 目');
    assert.equal(p.page.model.scoring.version, 2);
  }

  // 黑同意 → 白方看到"对手已同意"；白同意 → 终局
  await sleep(35);
  black.page.onAccept();
  await waitUntil(() => white.page.data.scoring.oppAccepted, { what: '白方看到黑方同意' });
  assert.equal(black.page.data.btn.accept, false);
  assert.equal(black.page.data.scoring.meAcceptText, '已同意');
  assert.match(white.page.data.scoring.tip, /^对手已同意/);
  white.page.onAccept();
  for (const p of [black, white]) {
    await waitUntil(() => p.page.data.phase === 'ended' && p.page.data.end, { what: '终局' });
    await waitUntil(() => p.page.model.stats, { what: '终局统计' });
  }
  const eb = black.page.data.end;
  assert.equal(eb.title, '你赢了');
  assert.equal(eb.tone, 'win');
  assert.equal(eb.label, '黑胜 1.5 目');
  assert.equal(eb.scoreText, '黑 45 点 · 白 43.5 点');
  assert.deepEqual(eb.lines, ['当前连胜 1 局', '最高连胜 1 局 · 排位 1 局 · 胜率 100%']);
  const ew = white.page.data.end;
  assert.equal(ew.title, '你输了');
  assert.deepEqual(ew.lines, ['连胜中断', '最高连胜 0 局 · 排位 1 局 · 胜率 0%']);
  assert.deepEqual(black.page.data.marks.dead, [20], '终局后仍显示死子');
  assert.equal(black.page.data.btn.again, true);
  assert.equal(black.page.data.scoring, null);

  // 棋谱与排行榜（客户端 api）
  const rec = await black.client.api.request({ method: 'GET', path: `/api/games/${gameId}` });
  assert.deepEqual(rec.moves, [...SCRIPT, -1, -1]);
  assert.deepEqual(rec.dead, [20]);
  assert.equal(rec.myResult, 'win');
  const lb = await white.client.api.request({ method: 'GET', path: '/api/leaderboard?type=streak&limit=50' });
  assert.deepEqual(lb.items.map((i) => [i.rank, i.nickname, i.value]), [[1, black.client.auth.getUser().nickname, 1]]);
  assert.equal(lb.me.rank, null);

  // ---------- 第二局：再来一局 → 重新匹配 → 断线重连 ----------
  const winner = black.client;
  const loser = white.client;
  const sinceW = winner.control.calls.length;
  const sinceL = loser.control.calls.length;
  black.page.onAgain();
  white.page.onAgain();
  const againW = await winner.control.waitFor('redirectTo', { since: sinceW });
  const againL = await loser.control.waitFor('redirectTo', { since: sinceL });
  assert.equal(againW.url, '/pages/match/match?size=9');
  assert.equal(againL.url, '/pages/match/match?size=9');
  winner.close(black.page);
  loser.close(white.page);
  const [m2a, m2b] = await Promise.all([matchId(winner, 9), matchId(loser, 9)]);
  assert.equal(m2a.id, m2b.id);
  const g2 = m2a.id;
  assert.notEqual(g2, gameId);
  const qa = await openPlayById(winner, g2);
  const qb = await openPlayById(loser, g2);
  const by2 = {};
  for (const [c, page] of [[winner, qa], [loser, qb]]) by2[page.model.myColor] = { client: c, page };

  const moves2 = [40, 41, 30, 31, 20, 21, 10, 11, 0, 1, 60, 61];
  for (let n = 1; n <= moves2.length; n++) await act(by2, n, moves2[n - 1]);
  // 轮到黑（第 13 手）。白方掉线（底层连接直接断开）
  const mover = by2[1];
  const dropped = by2[2];
  assert.equal(dropped.client.control.dropSocket(), true);
  await waitUntil(() => dropped.page.data.banner === '连接中断，正在重连…', { what: '掉线横幅' });
  assert.equal(dropped.page.data.boardDisabled, true);
  assert.equal(dropped.page.data.btn.resign, false);
  await waitUntil(() => mover.page.data.top.online === false, { what: '对手离线' });
  // 掉线期间黑落子
  await sleep(35);
  mover.page.onPick({ detail: { idx: 50 } });
  mover.page.onConfirm();
  await waitUntil(() => mover.page.model.moves.length === 13, { what: '黑第 13 手' });
  assert.equal(mover.page.data.statusText, '对手已离线，等待其重连…');
  assert.equal(dropped.page.model.moves.length, 12, '掉线的一方还没收到');
  // 自动重连（1 秒退避）→ hello → ready → game.sync
  await waitUntil(() => dropped.page.data.banner === '' && dropped.page.model.moves.length === 13, { timeout: 8000, what: '重连并同步' });
  assert.equal(dropped.page.data.cells[50], 1);
  assert.equal(dropped.page.data.boardDisabled, false, '重连后轮到白');
  assert.equal(dropped.page.data.btn.pass, true);
  assert.equal(dropped.client.socket.getStatus(), 'open');
  await waitUntil(() => mover.page.data.top.online === true, { what: '对手重新上线' });
  // 继续对局
  await act(by2, 14, 51);
  // 让第一局的输家认输（第一局赢家连胜 2）
  const resigner = by2[1].client === loser ? by2[1] : by2[2];
  const champ = resigner === by2[1] ? by2[2] : by2[1];
  await sleep(35);
  resigner.page.onResign();
  for (const p of [champ, resigner]) await waitUntil(() => p.page.data.end && p.page.model.stats, { what: '第二局终局' });
  const e2 = champ.page.data.end;
  assert.equal(e2.title, '你赢了');
  assert.match(e2.label, /中盘胜（对方认输）$/);
  assert.deepEqual(e2.lines, ['当前连胜 2 局（个人最高）', '最高连胜 2 局 · 排位 2 局 · 胜率 100%']);
  assert.equal(resigner.page.data.end.title, '你输了');

  // 结果经快照得到（终局时在后台 / 断线，没收到带统计的 game.end）：对局页用 GET /api/me 补上连胜与胜率
  const reopened = await openPlayById(champ.client, g2);
  await waitUntil(() => reopened.data.end && reopened.data.end.lines.length === 2, { what: '快照终局补上统计' });
  assert.deepEqual(reopened.data.end.lines, e2.lines);
  champ.client.close(reopened);

  // 双方都没有收到服务端错误、客户端没有 console.error
  assert.deepEqual(srv.errors(), []);
  assert.deepEqual(A.errors(), []);
  assert.deepEqual(B.errors(), []);
});

test('数子有异议：继续对局 → 再次双方 pass → AI 不可用时手动数子 → 点选 → 同意；人机设置页显示不可用', { skip: skip || false, timeout: 60000 }, async (t) => {
  const srv = await startE2EServer({});
  srv.ai.set({ available: false });
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
  const pa = await openPlay(A, ua);
  const pb = await openPlay(B, ub);
  const P = { [pa.model.myColor]: pa, [pb.model.myColor]: pb };
  let n = 0;
  for (const idx of SCRIPT) await move(P, ++n, idx);
  await move(P, ++n, -1);
  await move(P, ++n, -1);
  for (const p of [pa, pb]) {
    await waitUntil(() => p.data.phase === 'scoring' && p.data.scoring && !p.data.scoring.pending, { what: '手动数子' });
    assert.equal(p.model.scoring.source, 'manual');
    assert.equal(p.data.scoring.tip, '未能自动判断死子，请点击死棋标记；双方同意后计分');
    assert.deepEqual(p.data.marks.dead, []);
  }
  assert.equal(srv.ai.calls.judgeDead.length, 0, 'AI 不可用时不请求死子判断');

  // 白方不同意 → 继续对局（轮到最先 pass 的白方），读秒重新走
  await sleep(35);
  P[2].onResume();
  for (const p of [pa, pb]) await waitUntil(() => p.data.phase === 'playing', { what: '继续对局' });
  assert.equal(P[2].data.bottom.active, true);
  assert.equal(P[2].data.btn.pass, true);
  assert.equal(P[1].data.boardDisabled, true);
  // 黑方看到的是"对手有异议"，白方（发起者）看到的是普通的轮到自己
  assert.equal(P[1].data.statusText, '对手对数子结果有异议，继续对局：等待对手落子…');
  assert.doesNotMatch(P[2].data.statusText, /有异议/);
  assert.equal(P[2].data.bottom.clock.timeout, false);
  // 继续对局后马上重启服务端：着手序列以两次 pass 结尾而状态是 playing，服务端恢复与客户端快照都要识别为"已继续对局"
  await srv.restart();
  for (const p of [pa, pb]) await waitUntil(() => p.model.connection !== 'open', { what: '断线' });
  for (const p of [pa, pb]) await waitUntil(() => p.model.connection === 'open' && p.data.banner === '', { timeout: 10000, what: '重连' });
  for (const p of [pa, pb]) {
    assert.equal(p.data.phase, 'playing');
    assert.equal(p.model.state.status, 'playing');
    assert.deepEqual(p.model.moves.slice(-2), [-1, -1]);
  }
  assert.equal(P[2].data.bottom.active, true, '重启后仍轮到白');
  // 白在自己地里补一手，黑 pass，白 pass → 再次数子
  await move(P, ++n, 25);
  await move(P, ++n, -1);
  await move(P, ++n, -1);
  for (const p of [pa, pb]) await waitUntil(() => p.data.phase === 'scoring' && p.data.scoring && !p.data.scoring.pending, { what: '再次数子' });
  // 每方每局只能"继续对局"一次（服务端 scoring.resumesLeft）：这次黑方也不同意，继续对局，双方再 pass
  assert.equal(P[1].model.scoring.resumesLeft[1], 1);
  assert.equal(P[1].data.btn.resume, true);
  assert.deepEqual(P[1].data.scoring.notes, ['时限到仍未达成一致时，单方面的修改不会生效']);
  await sleep(35);
  P[1].onResume();
  for (const p of [pa, pb]) await waitUntil(() => p.data.phase === 'playing', { what: '黑方继续对局' });
  await move(P, ++n, -1);
  await move(P, ++n, -1);
  for (const p of [pa, pb]) await waitUntil(() => p.data.phase === 'scoring' && p.data.scoring && !p.data.scoring.pending, { what: '第三次数子' });
  // 黑方用过了：按钮不可用并说明原因，点了也不发请求
  for (const p of [pa, pb]) assert.equal(p.model.scoring.resumesLeft[1], 0);
  assert.equal(P[1].data.btn.resume, false);
  assert.equal(P[1].data.scoring.notes[0], '你已用过"继续对局"，请确认数子结果或等待自动计分');
  P[1].onResume();
  assert.equal(P[1].data.hint, '你已用过"继续对局"，请确认数子结果或等待自动计分');
  assert.equal(P[1].model.pending, null, '不发请求');
  // 白方的按钮与服务端给的次数一致
  assert.equal(P[2].data.btn.resume, P[2].model.scoring.resumesLeft[2] > 0);
  // 黑方点选白 20 为死子，双方同意
  await sleep(35);
  P[1].onBoardTap({ detail: { idx: 20 } });
  for (const p of [pa, pb]) await waitUntil(() => p.data.marks && p.data.marks.dead.length === 1, { what: '点选' });
  await sleep(35);
  P[1].onAccept();
  await waitUntil(() => P[2].data.scoring.oppAccepted, { what: '黑已同意' });
  await sleep(35);
  P[2].onAccept();
  for (const p of [pa, pb]) await waitUntil(() => p.data.end && p.model.stats, { what: '终局' });
  assert.equal(P[1].data.end.label, '黑胜 1.5 目', '数子法：在自己地里补一手不改变点数');
  const rec = await A.api.request({ method: 'GET', path: `/api/games/${pa.model.id}` });
  assert.deepEqual(rec.moves, [...SCRIPT, -1, -1, 25, -1, -1, -1, -1]);
  assert.deepEqual(rec.dead, [20]);

  // AI 不可用：人机设置页显示不可用
  const setup = A.open('pages/ai/ai', {});
  await waitUntil(() => setup.data.state === 'unavailable', { what: '人机不可用' });
  A.close(setup);
  assert.deepEqual(srv.errors(), []);
  assert.deepEqual(A.errors(), []);
  assert.deepEqual(B.errors(), []);
});
