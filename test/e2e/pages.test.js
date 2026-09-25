'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { prerequisites, startE2EServer, createClient, waitUntil, sleep, loginAs, openPlay, quickMatch } = require('./harness');

// 端到端：人机设置页 → 人机对局（AI 落子、悔棋、数子、再来一局）；好友房页（创建/受邀/加入）；
// 首页进行中提示、排行榜页、我的页、复盘页读真实数据；账号在另一设备登录（kicked）。

const skip = prerequisites();

async function waitNav(client, api, since, prefix, timeout = 8000) {
  const nav = await client.control.waitFor(api, { since, filter: (a) => a && a.url && a.url.startsWith(prefix), timeout });
  return nav.url;
}

test('人机：设置页 → 对局页（AI 应手、悔棋、pass 后 AI pass、数子确认）→ 再来一局；复盘页与我的页', { skip: skip || false, timeout: 60000 }, async (t) => {
  const srv = await startE2EServer({});
  srv.ai.set({ dead: [] });
  const C = createClient(srv, 'C', { login: 'fail' });
  t.after(async () => {
    C.shutdown();
    await srv.close();
  });
  await loginAs(C, 'Carol');

  // ---------- 人机设置页：难度来自服务端 ----------
  const setup = C.open('pages/ai/ai', { size: '9' });
  await waitUntil(() => setup.data.state === 'ok', { what: '难度列表' });
  assert.deepEqual(setup.data.levels.map((l) => l.id), ['k10', 'k5', 'd1']);
  assert.equal(setup.data.levels[1].name, '5级');
  assert.equal(setup.data.size, 9);
  setup.onPickLevel({ currentTarget: { dataset: { id: 'k5' } } });
  setup.onPickColor({ currentTarget: { dataset: { color: 'black' } } });
  const since = C.control.calls.length;
  await setup.onStart();
  const url = await waitNav(C, 'redirectTo', since, '/pages/play/play');
  assert.match(url, /^\/pages\/play\/play\?id=[0-9a-z]{12}&color=black$/);
  C.close(setup);

  // ---------- 对局页 ----------
  const page = await openPlay(C, url);
  const d0 = page.data;
  assert.equal(d0.infoText, '人机对局 · 9 路 · 贴 7.5 目');
  assert.equal(d0.top.isAi, true);
  assert.equal(d0.top.nickname, 'AI · 5级');
  assert.equal(d0.top.online, true);
  assert.equal(d0.top.clock, null, '人机不计时');
  assert.equal(d0.bottom.clock, null);
  assert.equal(d0.btn.showUndo, true);
  assert.equal(d0.btn.undo, false, '还没下棋不能悔');
  assert.equal(d0.boardDisabled, false);

  async function humanMove(idx) {
    const n = page.model.moves.length + 1;
    await sleep(35);
    page.onPick({ detail: { idx } });
    page.onConfirm();
    await waitUntil(() => page.model.moves.length === n + 1 && !page.model.aiThinking, { what: `AI 应第 ${n} 手` });
    return page.model.moves[n];
  }
  const r1 = await humanMove(40);
  assert.equal(page.data.cells[40], 1);
  assert.equal(page.data.cells[r1], 2);
  assert.equal(page.data.lastIdx, r1);
  assert.equal(page.data.top.thinking, false);
  assert.equal(page.data.btn.undo, true);
  assert.equal(page.data.statusText, '轮到你落子：触摸棋盘选点');
  await humanMove(30);
  assert.equal(page.model.moves.length, 4);

  // 悔棋：回到 [40, r1]
  await sleep(35);
  page.onUndo();
  await waitUntil(() => page.model.moves.length === 2 && !page.model.pending, { what: '悔棋' });
  assert.deepEqual(page.model.moves, [40, r1]);
  assert.equal(page.data.cells[30], 0);
  assert.equal(page.data.boardDisabled, false);

  // pass → AI pass → 数子（AI 自动同意，不能点选）
  await sleep(35);
  page.onPass();
  await waitUntil(() => page.data.phase === 'scoring' && page.data.scoring && !page.data.scoring.pending, { what: '人机数子' });
  const sc = page.data.scoring;
  assert.equal(sc.oppAccepted, true);
  assert.equal(sc.meAccepted, false);
  assert.equal(sc.deadlineText, '');
  assert.equal(sc.tip, '确认后按此结果终局；有异议可"继续对局"');
  assert.equal(page.data.boardDisabled, true, '人机对局不能点选死子');
  assert.equal(page.data.btn.undo, true, '数子阶段可以悔棋');
  assert.ok(page.data.marks && page.data.marks.owner.length === 81);

  // 继续对局 → 回到对局，再 pass → 数子（这次死子判断失败，如 AI_FALLBACK / KataGo 超时）→ 玩家自己点选死子 → 同意
  await sleep(35);
  page.onResume();
  await waitUntil(() => page.data.phase === 'playing' && !page.model.pending, { what: '继续对局' });
  assert.equal(page.data.bottom.active, true, '继续对局后轮到最先 pass 的一方（玩家）');
  // 局面要变一下（局面不变时服务端复用上次的死子判断），这次死子判断失败
  await humanMove(30);
  srv.ai.set({ judgeFail: true });
  await sleep(35);
  page.onPass();
  await waitUntil(() => page.data.phase === 'scoring' && page.data.scoring && !page.data.scoring.pending, { what: '再次数子' });
  assert.equal(page.model.scoring.source, 'manual');
  assert.equal(page.data.scoring.tip, '未能自动判断死子，请点击死棋标记，再点"同意"终局');
  assert.equal(page.data.boardDisabled, false, '人机对局死子判断失败时可以点选');
  assert.deepEqual(page.data.marks.dead, []);
  assert.match(page.data.scoring.leadText, /白胜/, '不标死子时 AI 的死子算活');
  // 把 AI 的棋子都点成死子
  const whiteStones = page.data.cells.map((c, i) => (c === 2 ? i : -1)).filter((i) => i >= 0);
  assert.ok(whiteStones.includes(r1));
  for (const idx of whiteStones) {
    if (page.data.marks.dead.includes(idx)) continue;
    const before = page.data.marks.dead.length;
    await sleep(35);
    page.onBoardTap({ detail: { idx } });
    await waitUntil(() => page.data.marks.dead.length > before && !page.model.pending, { what: '人机点选死子' });
  }
  assert.deepEqual(page.data.marks.dead.slice().sort((a, b) => a - b), whiteStones);
  assert.equal(page.data.scoring.oppAccepted, true, 'AI 一方保持已同意');
  assert.equal(page.data.scoring.leadText, '按当前结果：黑胜 73.5 目');
  await sleep(35);
  page.onAccept();
  await waitUntil(() => page.data.phase === 'ended' && page.data.end, { what: '人机终局' });
  assert.equal(page.data.end.label, '黑胜 73.5 目');
  const aiRec = await C.api.request({ method: 'GET', path: `/api/games/${page.model.id}` });
  assert.deepEqual(aiRec.dead.slice().sort((a, b) => a - b), whiteStones, '点选的死子写进棋谱');
  assert.deepEqual(page.data.end.lines, ['人机对局不计入排行榜']);
  assert.equal(page.data.end.showAgain, true);
  assert.equal(page.data.btn.undo, false);
  const gameId = page.model.id;
  const finalMoves = page.model.moves.slice();
  assert.deepEqual([finalMoves.slice(2, 4), finalMoves.slice(-2)], [[-1, -1], [-1, -1]], '继续对局后的着手序列里有两组 pass');

  // 再来一局：同难度同执子
  const since2 = C.control.calls.length;
  page.onAgain();
  const url2 = await waitNav(C, 'redirectTo', since2, '/pages/play/play');
  assert.match(url2, /&color=black$/);
  assert.notEqual(new URL(`http://x${url2}`).searchParams.get('id'), gameId);
  C.close(page);
  const aiCall = srv.ai.calls.chooseMove[srv.ai.calls.chooseMove.length - 1];
  assert.equal(aiCall.level, 'k5');

  // ---------- 复盘页：读真实棋谱（含继续对局的着手序列）----------
  const rp = C.open('pages/replay/replay', { id: gameId });
  await waitUntil(() => rp.data.loaded, { what: '复盘加载' });
  assert.equal(rp.data.loadError, '');
  assert.equal(rp.data.error, '');
  assert.equal(rp.data.k, finalMoves.length);
  assert.equal(rp.data.total, finalMoves.length);
  assert.equal(rp.data.white.nickname, 'AI · 5级');
  assert.equal(rp.data.black.nickname, 'Carol');
  assert.ok(rp.data.marks, '数子终局显示死子与地盘');
  rp.onFirst();
  assert.equal(rp.data.k, 0);
  C.close(rp);

  // ---------- 我的页 ----------
  const me = C.open('pages/me/me');
  await waitUntil(() => me.data.state === 'ok' && me.data.listState === 'ok', { what: '我的页' });
  assert.equal(me.data.user.nickname, 'Carol');
  assert.match(me.data.aiText, /^共 1 局 · 胜 [01] 局$/);
  assert.equal(me.data.statsDetail, '还没有排位赛记录，去快速匹配下一盘吧');
  assert.equal(me.data.games.length, 1);
  assert.equal(me.data.games[0].id, gameId);
  assert.equal(me.data.games[0].badge, '人机');
  assert.equal(me.data.games[0].opponentName, 'AI · 5级');
  assert.equal(me.data.games[0].meta, `9路 · 执黑 · ${finalMoves.length}手`);
  assert.equal(me.data.activeIds.length, 1, '再来一局开的新人机对局在进行中');
  assert.equal(me.data.noMore, true);

  // 重新登录：服务端立即作废本机旧令牌，换一个新的（同一账号）
  const oldToken = C.auth.getToken();
  const since3 = C.control.calls.length;
  me.onRelogin();
  await C.control.waitFor('reLaunch', { since: since3, timeout: 8000 });
  const newToken = C.auth.getToken();
  assert.ok(newToken && newToken !== oldToken, '换了新令牌');
  assert.equal(C.auth.getUser().nickname, 'Carol', '同一账号');
  const statusWith = (tok) => fetch(`${srv.url}/api/me`, { headers: { Authorization: `Bearer ${tok}` } }).then((r) => r.status);
  assert.equal(await statusWith(oldToken), 401, '旧令牌已作废');
  assert.equal(await statusWith(newToken), 200);
  C.close(me);

  assert.deepEqual(srv.errors(), []);
  assert.deepEqual(C.errors(), []);
});

test('好友房：房主创建 → 受邀者查看并加入 → 双方进入对局；首页进行中提示；排行榜页；另一设备登录顶号', { skip: skip || false, timeout: 60000 }, async (t) => {
  const srv = await startE2EServer({ config: { minGamesWinrate: 1 } });
  const O = createClient(srv, 'O', { login: 'code' });
  const G = createClient(srv, 'G', { login: 'fail' });
  const extra = [];
  t.after(async () => {
    for (const c of [O, G, ...extra]) c.shutdown();
    await srv.close();
  });
  await loginAs(O, 'Owner');
  await loginAs(G, 'Guest');

  // ---------- 好友房 ----------
  const sinceO = O.control.calls.length;
  const room = O.open('pages/room/room', { create: '1', size: '9', color: 'white' });
  await waitUntil(() => room.data.view === 'waiting', { what: '房主等待' });
  const code = room.data.room.code;
  assert.match(code, /^\d{6}$/);
  assert.equal(room.data.room.colorText, '你执白');
  assert.equal(room.data.room.ownerName, 'Owner');
  assert.match(room.data.expireText, /^(30:00|29:5\d)$/);
  assert.deepEqual(room.onShareAppMessage(), { title: 'Owner 邀你下一盘围棋（9路）', path: `/pages/room/room?code=${code}` });

  // 房主点自己分享的卡片回到小程序（热启动 reLaunch）：旧页卸载、新页用同一房号打开，房间必须还在
  O.close(room);
  await sleep(100);
  const room2 = O.open('pages/room/room', { code });
  await waitUntil(() => room2.data.view === 'waiting', { what: '房主回到等待界面' });
  assert.equal(room2.data.room.code, code);
  assert.equal(room2.data.room.colorText, '你执白');

  const sinceG = G.control.calls.length;
  const invite = G.open('pages/room/room', { code });
  await waitUntil(() => invite.data.view === 'invite', { what: '受邀界面' });
  assert.equal(invite.data.room.ownerName, 'Owner');
  assert.equal(invite.data.room.colorText, '你执黑先行');
  await invite.onJoin();
  const urlG = await waitNav(G, 'redirectTo', sinceG, '/pages/play/play');
  const urlO = await waitNav(O, 'redirectTo', sinceO, '/pages/play/play');
  assert.equal(urlG, urlO);
  O.close(room2);
  G.close(invite);
  const po = await openPlay(O, urlO);
  const pg = await openPlay(G, urlG);
  assert.equal(po.model.myColor, 2);
  assert.equal(pg.model.myColor, 1);
  assert.match(po.data.infoText, /^好友对局 · 9 路/);

  // 首页：有进行中的对局时显示提示
  const idx = O.open('pages/index/index');
  await waitUntil(() => idx.data.banners.length === 1 && idx.data.loginState === 'ok', { what: '首页提示' });
  assert.equal(idx.data.banners[0].kind, 'game');
  assert.equal(idx.data.banners[0].url, urlO);
  assert.equal(idx.data.banners[0].text, '你有一局好友对局正在进行，点击返回');
  assert.equal(idx.data.user.nickname, 'Owner');
  O.close(idx);

  // 黑下一手后认输（好友对局不计排行）
  await sleep(35);
  pg.onPick({ detail: { idx: 40 } });
  pg.onConfirm();
  await waitUntil(() => po.model.moves.length === 1, { what: '第 1 手' });
  await sleep(35);
  pg.onResign();
  for (const p of [po, pg]) await waitUntil(() => p.data.end, { what: '好友对局终局' });
  assert.equal(po.data.end.title, '你赢了');
  assert.deepEqual(po.data.end.lines, ['好友对局不计入排行榜']);
  assert.equal(po.data.end.showAgain, false);
  O.close(po);
  G.close(pg);

  // ---------- 排行榜页：排位赛（10 手后认输，计入）----------
  const s1 = O.control.calls.length;
  const s2 = G.control.calls.length;
  const m1 = O.open('pages/match/match', { size: '9' });
  const m2 = G.open('pages/match/match', { size: '9' });
  const u1 = await waitNav(O, 'redirectTo', s1, '/pages/play/play');
  const u2 = await waitNav(G, 'redirectTo', s2, '/pages/play/play');
  assert.equal(u1, u2);
  assert.notEqual(u1, urlO);
  O.close(m1);
  G.close(m2);
  const q1 = await openPlay(O, u1);
  const q2 = await openPlay(G, u2);
  const by = { [q1.model.myColor]: q1, [q2.model.myColor]: q2 };
  const seq = [40, 41, 30, 31, 20, 21, 10, 11, 0, 1];
  for (let n = 1; n <= seq.length; n++) {
    const p = by[n % 2 === 1 ? 1 : 2];
    await sleep(35);
    p.onPick({ detail: { idx: seq[n - 1] } });
    p.onConfirm();
    await waitUntil(() => q1.model.moves.length === n && q2.model.moves.length === n, { what: `第 ${n} 手` });
  }
  await sleep(35);
  q2.onResign(); // G 认输，O 赢
  for (const p of [q1, q2]) await waitUntil(() => p.data.end && p.model.stats, { what: '排位终局' });
  assert.deepEqual(q1.data.end.lines, ['当前连胜 1 局', '最高连胜 1 局 · 排位 1 局 · 胜率 100%']);

  const lb = G.open('pages/leaderboard/leaderboard', { type: 'winrate' });
  await waitUntil(() => lb.data.state === 'ok', { what: '胜率榜' });
  assert.deepEqual(
    lb.data.rows.map((r) => [r.rank, r.nickname, r.valueText, r.subText, r.isMe]),
    [
      [1, 'Owner', '100%', '1 胜 / 1 局', false],
      [2, 'Guest', '0%', '0 胜 / 1 局', true],
    ],
  );
  assert.deepEqual(lb.data.mine, { ranked: true, rankText: '第 2 名', valueText: '0%', note: '0 胜 / 1 局' });
  assert.equal(lb.data.hint, '只统计排位赛（快速匹配），至少 1 局才能上胜率榜');
  lb.onTab({ currentTarget: { dataset: { type: 'streak' } } });
  await waitUntil(() => lb.data.type === 'streak' && lb.data.state === 'ok', { what: '连胜榜' });
  assert.deepEqual(lb.data.rows.map((r) => [r.rank, r.nickname, r.valueText]), [[1, 'Owner', '1 连胜']]);
  assert.deepEqual(lb.data.mine, { ranked: false, rankText: '未上榜', valueText: '', note: '当前没有连胜，赢一局排位即可上榜' });
  G.close(lb);
  O.close(q1);
  G.close(q2);

  // ---------- 另一设备登录同一账号：旧连接被顶，不自动重连 ----------
  // 先开一局人机，让对局页有内容
  const { gameId } = await O.socket.request('ai.start', { size: 9, level: 'k10', color: 'black' });
  const ap = await openPlay(O, `/pages/play/play?id=${gameId}`);
  assert.equal(ap.data.banner, '');
  const O2 = createClient(srv, 'O2', { login: 'fail' });
  extra.push(O2);
  O2.control.storage.set('gg.deviceId', JSON.stringify(O.auth.getDeviceId()));
  const u = await O2.auth.ensureLogin();
  assert.equal(u.id, O.auth.getUser().id, '同一 deviceId 是同一账号');
  await O2.socket.connect();
  await waitUntil(() => ap.data.banner === '账号已在其他设备登录，点此重新连接', { what: '被顶号' });
  assert.equal(O.socket.getStatus(), 'closed');
  assert.equal(ap.data.boardDisabled, true);
  await sleep(1300);
  assert.equal(O.socket.getStatus(), 'closed', '被顶号后不自动重连');
  assert.equal(O2.socket.getStatus(), 'open');
  // 回到首页（匹配/房间页的被顶号弹窗就是这样做的）：首页不自动重连，显示提示条
  const home = O.open('pages/index/index');
  await waitUntil(() => home.data.kicked === true, { what: '首页显示被顶号提示' });
  await sleep(300);
  assert.equal(O.socket.getStatus(), 'closed', '首页不自动重连（不去顶另一台设备）');
  assert.equal(O2.socket.getStatus(), 'open');
  assert.deepEqual(home.data.banners, []);
  O.close(home);
  // 用户点横幅：重新连接（这次顶掉 O2）
  ap.onBannerTap();
  await waitUntil(() => ap.data.banner === '' && O.socket.getStatus() === 'open', { what: '手动重连' });
  await waitUntil(() => O2.socket.getStatus() === 'closed', { what: 'O2 被顶' });

  assert.deepEqual(srv.errors(), []);
  for (const c of [O, G]) assert.deepEqual(c.errors(), []);
});

test('好友房：房主离开等待页后房间保留（首页提示）；好友加入时房主在首页收到提示并进入对局', { skip: skip || false, timeout: 60000 }, async (t) => {
  const srv = await startE2EServer({});
  const O = createClient(srv, 'O', { login: 'code' });
  const G = createClient(srv, 'G', { login: 'fail' });
  t.after(async () => {
    for (const c of [O, G]) c.shutdown();
    await srv.close();
  });
  await loginAs(O, 'Owner');
  await loginAs(G, 'Guest');
  O.launch();

  const room = O.open('pages/room/room', { create: '1', size: '9', color: 'black' });
  await waitUntil(() => room.data.view === 'waiting', { what: '房主等待' });
  const code = room.data.room.code;
  O.close(room); // 房主点返回
  await sleep(100);

  // 首页提示房间还在等待
  const home = O.open('pages/index/index');
  await waitUntil(() => home.data.banners.some((b) => b.kind === 'room'), { what: '首页房间提示' });
  assert.equal(home.data.banners.find((b) => b.kind === 'room').url, `/pages/room/room?code=${code}`);

  // 好友加入：房主在首页收到"好友已加入"并进入对局
  const sinceO = O.control.calls.length;
  const sinceG = G.control.calls.length;
  const invite = G.open('pages/room/room', { code });
  await waitUntil(() => invite.data.view === 'invite', { what: '受邀界面' });
  await invite.onJoin();
  const urlG = await waitNav(G, 'redirectTo', sinceG, '/pages/play/play');
  const modal = await O.control.waitFor('showModal', { since: sinceO, filter: (a) => a && a.title === '好友已加入', timeout: 8000 });
  assert.equal(modal.showCancel, false);
  const urlO = await waitNav(O, 'navigateTo', sinceO, '/pages/play/play');
  assert.equal(urlO, urlG);
  G.close(invite);
  O.close(home);

  // 房主执黑：进入对局后可以落第一手
  const po = await openPlay(O, urlO);
  assert.equal(po.model.myColor, 1);
  assert.equal(po.model.mode, 'friend');
  assert.equal(po.data.btn.pass, true);

  assert.deepEqual(srv.errors(), []);
  for (const c of [O, G]) assert.deepEqual(c.errors(), []);
});

test('快速匹配：已离开匹配页（改为人机）时才配对成功 → 应用层提示"匹配成功"并进入对局；人机设置页开局时引导回到那一局', { skip: skip || false, timeout: 60000 }, async (t) => {
  const srv = await startE2EServer({});
  const A = createClient(srv, 'A', { login: 'code' });
  const B = createClient(srv, 'B', { login: 'fail' });
  t.after(async () => {
    for (const c of [A, B]) c.shutdown();
    await srv.close();
  });
  await loginAs(A, 'Ann');
  await loginAs(B, 'Ben');
  A.launch();

  // A 在队列里，但匹配页已经不在了（点"改为人机对弈"时 match.cancel 还没到服务端），停在人机设置页
  await A.socket.request('match.join', { size: 9 });
  const setup = A.open('pages/ai/ai', { size: '9' });
  await waitUntil(() => setup.data.state === 'ok', { what: '难度列表' });

  const sinceA = A.control.calls.length;
  const urlB = await quickMatch(B, 9);
  const modal = await A.control.waitFor('showModal', { since: sinceA, filter: (a) => a && a.title === '匹配成功', timeout: 8000 });
  assert.equal(modal.showCancel, false);
  const urlA = await waitNav(A, 'navigateTo', sinceA, '/pages/play/play');
  assert.equal(urlA, urlB);

  // 人机设置页：排位赛进行中不能开人机，引导回到那一局（不发 ai.start）
  const since2 = A.control.calls.length;
  await setup.onStart();
  const m2 = await A.control.waitFor('showModal', { since: since2, filter: (a) => a && a.title === '无法开始人机对局', timeout: 8000 });
  assert.equal(m2.confirmText, '返回对局');
  assert.equal(await waitNav(A, 'redirectTo', since2, '/pages/play/play'), urlA);
  assert.equal(srv.ai.calls.chooseMove.length, 0);
  A.close(setup);

  const pa = await openPlay(A, urlA);
  assert.equal(pa.model.mode, 'ranked');
  assert.equal(pa.model.status, 'playing');

  assert.deepEqual(srv.errors(), []);
  for (const c of [A, B]) assert.deepEqual(c.errors(), []);
});
