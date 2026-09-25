'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../../miniprogram/pages/play/model');
const { replayMoves } = require('../../miniprogram/pages/play/moves');
const { scoreArea } = require('../../miniprogram/utils/engine/score');

const PASS = -1;
const T0 = 1_000_000;

// 假的 displayClock：记录调用参数，文本为剩余基本时间的整秒数
function makeClock() {
  const calls = [];
  const displayClock = (clock, elapsed, timeControl) => {
    calls.push({ clock, elapsed, timeControl });
    const left = clock.mainMs - elapsed;
    return { text: String(Math.ceil(left / 1000)), sub: clock.periodsLeft ? `读秒 ${clock.periodsLeft} 次` : '', urgent: left < 10000, timeout: left <= 0 };
  };
  return { calls, displayClock };
}

function tc() {
  return { mainMs: 180000, periods: 3, periodMs: 20000 };
}

function clocks(running, b = 180000, w = 180000) {
  return {
    1: { mainMs: b, periodsLeft: 3, periodMs: 20000 },
    2: { mainMs: w, periodsLeft: 3, periodMs: 20000 },
    running,
  };
}

function snap(over) {
  return Object.assign(
    {
      id: 'g1',
      mode: 'ranked',
      size: 9,
      komi: 7.5,
      players: {
        1: { userId: 1, nickname: '小黑', avatarUrl: '' },
        2: { userId: 2, nickname: '小白', avatarUrl: 'http://x/a.png' },
      },
      myColor: 1,
      moves: [],
      status: 'playing',
      toPlay: 1,
      timeControl: tc(),
      clocks: clocks(1),
      scoring: null,
      result: null,
      presence: { 1: true, 2: true },
      aiThinking: false,
      canUndo: false,
    },
    over || {}
  );
}

function aiSnap(over) {
  return snap(
    Object.assign(
      {
        mode: 'ai',
        players: {
          1: { userId: 1, nickname: '小黑', avatarUrl: '' },
          2: { ai: true, level: 'k5', nickname: 'AI · 5级', avatarUrl: '' },
        },
        timeControl: null,
        clocks: null,
      },
      over || {}
    )
  );
}

// 人机对局、玩家执白：AI 在黑方
function aiWhiteSnap(over) {
  return aiSnap(
    Object.assign(
      {
        myColor: 2,
        players: {
          1: { ai: true, level: 'k5', nickname: 'AI · 5级', avatarUrl: '' },
          2: { userId: 1, nickname: '小白', avatarUrl: '' },
        },
      },
      over || {}
    )
  );
}

function scoringData(moves, dead, over) {
  const state = replayMoves(9, 7.5, moves);
  const s = scoreArea(state.board, 7.5, dead);
  return Object.assign(
    {
      pending: false,
      source: 'katago',
      version: 1,
      dead: s.dead,
      owner: s.owner,
      black: s.black,
      white: s.white,
      winner: s.winner,
      accepted: { 1: false, 2: false },
      deadline: 180000,
    },
    over || {}
  );
}

function move(n, idx, extra) {
  return Object.assign({ t: 'game.move', gameId: 'g1', n, idx, color: n % 2 ? 1 : 2, captured: [] }, extra || {});
}

function view(model, now = T0) {
  return M.viewData(model, now, { displayClock: makeClock().displayClock });
}

// ---------------- fromSnapshot ----------------

test('fromSnapshot：空棋盘，轮到我（黑）', () => {
  const m = M.fromSnapshot(snap(), T0);
  assert.equal(m.cells.length, 81);
  assert.ok(m.cells.every((c) => c === 0));
  assert.equal(m.lastIdx, -1);
  assert.equal(m.status, 'playing');
  assert.equal(M.isMyTurn(m), true);
  const v = view(m);
  assert.equal(v.loaded, true);
  assert.equal(v.boardDisabled, false);
  assert.equal(v.top.nickname, '小白');
  assert.equal(v.top.color, 2);
  assert.equal(v.bottom.isMe, true);
  assert.equal(v.bottom.color, 1);
  assert.equal(v.btn.pass, true);
  assert.equal(v.btn.confirm, false);
  assert.equal(v.btn.showUndo, false);
  assert.equal(v.moveText, '开局');
  assert.equal(v.infoText, '排位赛 · 9 路 · 贴 7.5 目 · 3 分 + 3×20 秒');
  assert.match(v.statusText, /60 秒/);
});

test('fromSnapshot：重放着手序列，提子与最后一手（跳过 pass）', () => {
  // 黑 1，白 0（角），黑 9 提掉白 0；白 pass
  const m = M.fromSnapshot(snap({ moves: [1, 0, 9, PASS], toPlay: 1 }), T0);
  assert.equal(m.cells[0], 0);
  assert.equal(m.cells[1], 1);
  assert.equal(m.cells[9], 1);
  assert.equal(m.state.captures[1], 1);
  assert.equal(m.lastIdx, 9);
  const v = view(m);
  assert.equal(v.bottom.captures, 1);
  assert.equal(v.top.captures, 0);
  assert.equal(v.moveText, '第 4 手');
  assert.match(v.statusText, /对手停了一手/);
});

test('fromSnapshot：数据校验失败抛出 bad_snapshot', () => {
  const bad = [
    null,
    snap({ id: '' }),
    snap({ mode: 'blitz' }),
    snap({ size: 25 }),
    snap({ size: 9.5 }),
    snap({ myColor: 3 }),
    snap({ moves: 'x' }),
    snap({ status: 'paused' }),
    snap({ moves: [40, 40] }), // 非法着手
    snap({ moves: [81] }), // 越界
    snap({ status: 'ended', result: null }),
  ];
  for (const s of bad) {
    assert.throws(() => M.fromSnapshot(s, T0), (err) => err.code === 'bad_snapshot', JSON.stringify(s && s.moves));
  }
});

test('fromSnapshot：继续对局后的序列（两次 pass 之后还有着手）能正确重放', () => {
  const m = M.fromSnapshot(snap({ moves: [40, PASS, PASS, 41], toPlay: 1 }), T0);
  assert.equal(m.status, 'playing');
  assert.equal(m.cells[41], 2);
  assert.equal(m.state.status, 'playing');
  // 刚继续、还没落子：序列以两次 pass 结尾但服务端状态为 playing
  const r = M.fromSnapshot(snap({ moves: [40, PASS, PASS], toPlay: 2, myColor: 2 }), T0);
  assert.equal(r.state.status, 'playing');
  assert.equal(M.isMyTurn(r), true);
  const next = M.applyEvent(r, move(4, 50), T0 + 1);
  assert.equal(next.cells[50], 2);
});

test('fromSnapshot：AI 一方恒在线；presence false 的真人离线', () => {
  const m = M.fromSnapshot(aiSnap({ presence: { 1: true, 2: false } }), T0);
  assert.equal(m.presence[2], true);
  const p = M.fromSnapshot(snap({ presence: { 1: true, 2: false } }), T0);
  assert.equal(p.presence[2], false);
  assert.equal(view(p).top.online, false);
});

test('fromSnapshot：终局快照带数子结果时显示死子与地盘', () => {
  const moves = [40, 41, PASS, PASS];
  const sc = scoringData(moves, [41], { accepted: { 1: true, 2: true }, deadline: null });
  const m = M.fromSnapshot(
    snap({
      moves,
      status: 'ended',
      clocks: clocks(null),
      scoring: sc,
      result: { winner: 1, reason: 'score', black: sc.black, white: sc.white, text: 'B+73.5', label: '黑胜 73.5 目', counted: true },
    }),
    T0
  );
  const v = view(m);
  assert.equal(v.phase, 'ended');
  assert.deepEqual(v.marks.dead, [41]);
  assert.equal(v.marks.owner.length, 81);
  assert.equal(v.boardDisabled, true);
  assert.equal(v.end.title, '你赢了');
  assert.equal(v.end.label, '黑胜 73.5 目');
  assert.equal(v.end.scoreText, '黑 81 点 · 白 7.5 点');
  assert.deepEqual(v.end.lines, ['本局已计入排行榜']);
  assert.equal(v.btn.resign, false);
  assert.equal(v.btn.again, true);
});

test('fromSnapshot：缺少 label/text 时用引擎生成', () => {
  const m = M.fromSnapshot(snap({ status: 'ended', result: { winner: 2, reason: 'resign', black: null, white: null } }), T0);
  assert.equal(m.result.label, '白中盘胜（对方认输）');
  assert.equal(m.result.text, 'W+R');
  assert.equal(m.result.counted, false);
  assert.equal(view(m).end.title, '你输了');
  assert.equal(view(m).marks, null);
});

// ---------------- game.move ----------------

test('game.move：n 连续时落子，更新读秒与接收时刻，清除预览与提示', () => {
  let m = M.fromSnapshot(snap({ myColor: 2, moves: [1, 0], toPlay: 1, clocks: clocks(1) }), T0);
  m = Object.assign({}, m, { hint: 'x' });
  const before = m;
  const next = M.applyEvent(m, move(3, 9, { captured: [0], clocks: clocks(2, 170000, 175000) }), T0 + 500);
  assert.notEqual(next, before);
  assert.deepEqual(next.moves, [1, 0, 9]);
  assert.equal(next.cells[9], 1);
  assert.equal(next.cells[0], 0);
  assert.equal(next.lastIdx, 9);
  assert.equal(next.toPlay, 2);
  assert.equal(next.clocksAt, T0 + 500);
  assert.equal(next.clocks[1].mainMs, 170000);
  assert.equal(next.clocks.running, 2);
  assert.equal(next.hint, '');
  assert.equal(M.isMyTurn(next), true);
  // 原模型不变
  assert.deepEqual(before.moves, [1, 0]);
  assert.equal(before.cells[9], 0);
  assert.equal(before.state.board.get(9), 0);
  assert.equal(before.cells[0], 2);
});

test('game.move：序号不连续、颜色不符、非法、提子数不符、坐标无效 → 重新同步', () => {
  const m = M.fromSnapshot(snap({ moves: [40, 41], toPlay: 1 }), T0);
  assert.deepEqual(M.applyEvent(m, move(4, 50), T0), { resync: true });
  assert.deepEqual(M.applyEvent(m, move(2, 50), T0), { resync: true });
  assert.deepEqual(M.applyEvent(m, move(3, 50, { color: 2 }), T0), { resync: true });
  assert.deepEqual(M.applyEvent(m, move(3, 40), T0), { resync: true }); // 已有子
  assert.deepEqual(M.applyEvent(m, move(3, 50, { captured: [1] }), T0), { resync: true });
  assert.deepEqual(M.applyEvent(m, move(3, 81), T0), { resync: true });
  assert.deepEqual(M.applyEvent(m, move(3, 1.5), T0), { resync: true });
  assert.deepEqual(M.applyEvent(m, move(0, 50), T0), { resync: true });
});

test('game.move：重复推送（本地已有这一手）直接忽略', () => {
  const m = M.fromSnapshot(snap({ moves: [40, 41], toPlay: 1 }), T0);
  assert.equal(M.applyEvent(m, move(2, 41), T0), m);
  assert.equal(M.applyEvent(m, move(1, 40), T0), m);
});

test('其他对局、未知类型、空事件都不改变模型', () => {
  const m = M.fromSnapshot(snap(), T0);
  assert.equal(M.applyEvent(m, Object.assign(move(1, 40), { gameId: 'other' }), T0), m);
  assert.equal(M.applyEvent(m, { t: 'game.whatever', gameId: 'g1' }, T0), m);
  assert.equal(M.applyEvent(m, null, T0), m);
});

test('game.move：数子阶段或终局后收到新着手 → 重新同步', () => {
  const s = M.fromSnapshot(snap({ moves: [PASS, PASS], status: 'scoring', clocks: clocks(null), scoring: { pending: true } }), T0);
  assert.deepEqual(M.applyEvent(s, move(3, 40), T0), { resync: true });
  const e = M.fromSnapshot(snap({ status: 'ended', result: { winner: 2, reason: 'resign' } }), T0);
  assert.deepEqual(M.applyEvent(e, move(1, 40), T0), { resync: true });
});

// ---------------- 选点与落子 ----------------

test('pick：只在轮到自己时出预览；非法点给出中文原因', () => {
  // 打劫：白不能立即回提 10
  const ko = M.fromSnapshot(snap({ myColor: 2, moves: [1, 2, 9, 10, 19, 12, 80, 20, 11], toPlay: 2 }), T0);
  let m = M.pick(ko, 10);
  assert.deepEqual(m.preview, { idx: 10, ok: false, color: 2 });
  assert.equal(m.hint, '打劫，暂不能回提');
  m = M.pick(m, 1);
  assert.equal(m.hint, '此处已有子');
  m = M.pick(m, 30);
  assert.deepEqual(m.preview, { idx: 30, ok: true, color: 2 });
  assert.equal(m.hint, '');
  assert.equal(M.pick(m, 30), m, '同一点重复 pick 不产生新模型');
  // 自杀
  const su = M.fromSnapshot(snap({ moves: [40, 1, 41, 9], toPlay: 1 }), T0);
  assert.equal(M.pick(su, 0).hint, '禁止自杀');
  // 不是自己回合
  const notMine = M.fromSnapshot(snap({ moves: [40], toPlay: 2 }), T0);
  assert.equal(M.pick(notMine, 30), notMine);
  // 越界 / 非整数
  assert.equal(M.pick(ko, 81), ko);
  assert.equal(M.pick(ko, '3'), ko);
});

test('确定落子：生成 game.move 请求，提交中禁用按钮，推送到达后解除', () => {
  let m = M.fromSnapshot(snap({ moves: [] }), T0);
  const none = M.startMove(m);
  assert.equal(none.req, null);
  assert.equal(none.model.hint, '请先在棋盘上选点');

  m = M.pick(m, 40);
  let v = view(m);
  assert.equal(v.btn.confirm, true);
  assert.deepEqual(v.preview, { idx: 40, ok: true, color: 1 });
  assert.match(v.statusText, /确定/);

  const r = M.startMove(m);
  assert.deepEqual(r.req, { t: 'game.move', params: { gameId: 'g1', n: 1, idx: 40 } });
  m = r.model;
  assert.equal(m.pending, 'move');
  v = view(m);
  assert.equal(v.btn.confirm, false);
  assert.equal(v.btn.pass, false);
  assert.equal(v.btn.resign, false);
  assert.equal(v.boardDisabled, true);
  assert.deepEqual(v.preview, { idx: 40, ok: true, color: 1 }, '提交中保留预览子');
  assert.equal(v.statusText, '提交中…');
  assert.equal(M.pick(m, 41), m, '提交中不响应选点');

  // 回复先到：解除 pending，但仍在等推送，不能再次落子
  m = M.requestDone(m, 'move');
  assert.equal(m.pending, null);
  assert.equal(M.awaitingMove(m), true);
  assert.equal(M.isMyTurn(m), false);
  assert.equal(view(m).btn.pass, false);
  assert.equal(M.startPass(m).req, null);

  // 推送到达
  m = M.applyEvent(m, move(1, 40, { clocks: clocks(2) }), T0 + 100);
  assert.equal(M.awaitingMove(m), false);
  assert.equal(m.expectN, 0);
  assert.equal(m.preview, null);
  assert.equal(M.isMyTurn(m), false);
  v = view(m);
  assert.equal(v.statusText, '等待对手落子…');
  assert.equal(v.top.active, true);
  assert.equal(v.bottom.active, false);
});

test('推送先于回复到达：落子生效，回复到达后解除 pending', () => {
  let m = M.startMove(M.pick(M.fromSnapshot(snap(), T0), 40)).model;
  m = M.applyEvent(m, move(1, 40), T0);
  assert.equal(m.pending, 'move');
  assert.equal(m.expectN, 0);
  m = M.requestDone(m, 'move');
  assert.equal(m.pending, null);
  assert.equal(M.requestDone(m, 'move'), m, '重复的完成不改变模型');
});

test('startMove：落子前重新检查合法性', () => {
  const ko = M.fromSnapshot(snap({ myColor: 2, moves: [1, 2, 9, 10, 19, 12, 80, 20, 11], toPlay: 2 }), T0);
  const m = Object.assign({}, ko, { preview: { idx: 10, ok: true, color: 2 } });
  const r = M.startMove(m);
  assert.equal(r.req, null);
  assert.equal(r.model.preview.ok, false);
  assert.equal(r.model.hint, '打劫，暂不能回提');
});

test('请求失败：中文提示、是否需要重新同步', () => {
  const base = M.startMove(M.pick(M.fromSnapshot(snap(), T0), 40)).model;
  const cases = [
    [{ code: 'illegal', msg: 'illegal move: ko' }, '打劫，暂不能回提', true],
    [{ code: 'illegal', msg: 'suicide' }, '禁止自杀', true],
    [{ code: 'illegal', msg: 'occupied' }, '此处已有子', true],
    [{ code: 'illegal', msg: '' }, '这里不能落子', true],
    // 服务端的真实格式：中文 msg + err.reason
    [{ code: 'illegal', msg: '打劫，不能立即提回', reason: 'ko' }, '打劫，暂不能回提', true],
    [{ code: 'illegal', msg: '这里已经有棋子了', reason: 'occupied' }, '此处已有子', true],
    [{ code: 'illegal', msg: '禁止自杀', reason: 'suicide' }, '禁止自杀', true],
    [{ code: 'illegal', msg: '这里不让下' }, '这里不让下', true],
    [{ code: 'bad_request', msg: '没有这个难度' }, '没有这个难度', false],
    [{ code: 'bad_request', msg: 'bad' }, '请求无效', false],
    [{ code: 'not_your_turn', msg: 'x' }, '还没轮到你', true],
    [{ code: 'stale', msg: 'x' }, '局面已更新，已重新同步', true],
    [{ code: 'offline' }, '网络未连接，请稍后再试', false],
    [{ code: 'timeout' }, '请求超时，请重试', true],
    [{ code: 'rate_limited' }, '操作太频繁，请稍后再试', false],
    [{ code: 'weird', msg: '服务器说不行' }, '服务器说不行', false],
    [new Error('boom'), 'boom', false],
    [undefined, '操作失败，请重试', false],
  ];
  for (const [err, hint, resync] of cases) {
    const f = M.requestFailed(base, 'move', err);
    assert.equal(f.model.hint, hint, JSON.stringify(err));
    assert.equal(f.resync, resync, JSON.stringify(err));
    assert.equal(f.model.pending, null);
    assert.equal(f.model.expectN, 0);
    assert.equal(M.isMyTurn(f.model), true);
  }
  // 非法：清除预览；离线：保留预览便于重试
  assert.equal(M.requestFailed(base, 'move', { code: 'illegal' }).model.preview, null);
  assert.notEqual(M.requestFailed(base, 'move', { code: 'offline' }).model.preview, null);
  assert.equal(M.errorText({ code: 'stale' }, 'accept'), '数子结果已变化，请重新确认');
  assert.equal(M.errorText({ code: 'nothing_to_undo' }), '没有可以悔的棋');
});

test('停一手：请求带序号；两次 pass 后进入数子（等待死子判断）', () => {
  let m = M.fromSnapshot(snap({ moves: [40, 41, PASS], toPlay: 2, myColor: 2, clocks: clocks(2) }), T0);
  assert.match(view(m).statusText, /对手停了一手/);
  const r = M.startPass(m);
  assert.deepEqual(r.req, { t: 'game.pass', params: { gameId: 'g1', n: 4 } });
  m = M.requestDone(r.model, 'pass');
  m = M.applyEvent(m, move(4, PASS, { clocks: clocks(null, 170000, 160000) }), T0 + 1000);
  assert.equal(m.status, 'scoring');
  assert.equal(m.scoring, null);
  const v = view(m, T0 + 5000);
  assert.equal(v.phase, 'scoring');
  assert.equal(v.scoring.pending, true);
  assert.equal(v.statusText, '正在判断死子…');
  assert.equal(v.boardDisabled, true);
  assert.equal(v.btn.accept, false);
  assert.equal(v.btn.resume, true);
  assert.equal(v.btn.resign, true);
  assert.equal(v.btn.pass, false);
  assert.equal(v.marks, null);
});

// ---------------- 数子阶段 ----------------

function scoringModel(over) {
  const moves = [40, 41, PASS, PASS];
  let m = M.fromSnapshot(snap({ moves: [40, 41, PASS], toPlay: 2, myColor: 1, clocks: clocks(2) }), T0);
  m = M.applyEvent(m, move(4, PASS, { clocks: clocks(null) }), T0);
  m = M.applyEvent(m, { t: 'game.scoring', gameId: 'g1', scoring: { pending: true, accepted: {} } }, T0);
  m = M.applyEvent(m, { t: 'game.scoring', gameId: 'g1', scoring: scoringData(moves, [41], over) }, T0 + 1000);
  return m;
}

test('game.scoring：显示死子/地盘、点数、双方确认状态与倒计时', () => {
  const m = scoringModel();
  const v = view(m, T0 + 1000 + 25000);
  assert.equal(v.phase, 'scoring');
  assert.deepEqual(v.marks.dead, [41]);
  assert.equal(v.marks.owner[0], 1);
  assert.equal(v.scoring.pending, false);
  assert.equal(v.scoring.blackText, '81 点');
  assert.equal(v.scoring.whiteText, '7.5 点');
  assert.equal(v.scoring.leadText, '按当前结果：黑胜 73.5 目');
  assert.equal(v.scoring.deadlineText, '2:35 后自动计分');
  assert.equal(v.scoring.meAcceptText, '未同意');
  assert.match(v.scoring.tip, /点击棋子/);
  assert.equal(v.boardDisabled, false, '真人对局可点选死子');
  assert.equal(v.btn.accept, true);
  assert.equal(v.statusText, '双方确认数子结果');
  // 倒计时不为负
  assert.equal(view(m, T0 + 999999).scoring.deadlineText, '0:00 后自动计分');
});

test('数子阶段：本地局面不是两次 pass 之后收到 game.scoring → 重新同步', () => {
  const m = M.fromSnapshot(snap({ moves: [40] }), T0);
  assert.deepEqual(M.applyEvent(m, { t: 'game.scoring', gameId: 'g1', scoring: { pending: true } }, T0), { resync: true });
  assert.deepEqual(M.applyEvent(scoringModel(), { t: 'game.scoring', gameId: 'g1', scoring: null }, T0), { resync: true });
});

test('点选死子：真人对局发 toggle；空点提示；判断中/人机不可点', () => {
  const m = scoringModel();
  const r = M.tapPoint(m, 41);
  assert.deepEqual(r.req, { t: 'game.score.toggle', params: { gameId: 'g1', idx: 41 } });
  assert.equal(r.model.pending, 'toggle');
  assert.equal(view(r.model).boardDisabled, true, '点选请求未完成时不能再点');
  assert.equal(M.tapPoint(r.model, 40).req, null);
  const empty = M.tapPoint(m, 0);
  assert.equal(empty.req, null);
  assert.equal(empty.model.hint, '点击棋子可切换死活');
  assert.equal(M.tapPoint(m, 99).req, null);
  // 判断中
  let p = M.fromSnapshot(snap({ moves: [40, 41, PASS, PASS], status: 'scoring', clocks: clocks(null), scoring: { pending: true } }), T0);
  assert.equal(M.tapPoint(p, 41).req, null);
  // 对局中 tap 无效
  p = M.fromSnapshot(snap({ moves: [40] }), T0);
  assert.equal(M.tapPoint(p, 40).req, null);
});

test('同意：带版本号；成功后在推送前也不能重复同意；版本变化后可再次同意', () => {
  let m = scoringModel();
  const r = M.startAccept(m);
  assert.deepEqual(r.req, { t: 'game.score.accept', params: { gameId: 'g1', version: 1 } });
  m = M.requestDone(r.model, 'accept');
  assert.equal(m.acceptSent, 1);
  let v = view(m);
  assert.equal(v.btn.accept, false);
  assert.equal(v.scoring.acceptText, '已同意');
  assert.equal(v.scoring.tip, '你已同意，等待对手确认…');
  assert.equal(M.startAccept(m).req, null);
  // 推送：对手点选了死子，version 2，双方确认清零
  m = M.applyEvent(m, { t: 'game.scoring', gameId: 'g1', scoring: scoringData([40, 41, PASS, PASS], [], { version: 2 }) }, T0 + 2000);
  assert.equal(m.acceptSent, null);
  v = view(m);
  assert.equal(v.btn.accept, true);
  assert.deepEqual(v.marks.dead, []);
  // 对手已同意
  m = M.applyEvent(m, { t: 'game.scoring', gameId: 'g1', scoring: scoringData([40, 41, PASS, PASS], [], { version: 2, accepted: { 1: false, 2: true } }) }, T0 + 3000);
  v = view(m);
  assert.equal(v.scoring.oppAcceptText, '已同意');
  assert.match(v.scoring.tip, /^对手已同意/);
  // 版本过期
  const f = M.requestFailed(M.startAccept(m).model, 'accept', { code: 'stale' });
  assert.equal(f.resync, true);
  assert.equal(f.model.hint, '数子结果已变化，请重新确认');
});

test('同意后服务端清零确认（重启/再次数子，version 仍为 1）：以服务端 accepted 为准，可以再次同意', () => {
  const moves = [40, 41, PASS, PASS];
  let m = scoringModel();
  m = M.requestDone(M.startAccept(m).model, 'accept');
  // 自己的确认推送到达
  m = M.applyEvent(m, { t: 'game.scoring', gameId: 'g1', scoring: scoringData(moves, [41], { accepted: { 1: true, 2: false } }) }, T0 + 1500);
  assert.equal(m.acceptSent, 1);
  assert.equal(view(m).btn.accept, false);
  // 服务端重启后重新给出建议：version 1，确认清零（推送路径）
  const pushed = M.applyEvent(m, { t: 'game.scoring', gameId: 'g1', scoring: scoringData(moves, [41], { accepted: { 1: false, 2: false } }) }, T0 + 5000);
  assert.equal(pushed.acceptSent, null);
  assert.equal(view(pushed).btn.accept, true);
  assert.equal(view(pushed).scoring.meAccepted, false);
  assert.deepEqual(M.startAccept(pushed).req, { t: 'game.score.accept', params: { gameId: 'g1', version: 1 } });
  // 同样的情况经重新同步（快照路径）
  const synced = M.fromSnapshot(
    snap({ moves, status: 'scoring', toPlay: 1, clocks: clocks(null), scoring: scoringData(moves, [41], { accepted: { 1: false, 2: false } }) }),
    T0 + 5000,
    m,
  );
  assert.equal(synced.acceptSent, null);
  assert.equal(view(synced).btn.accept, true);
  // 快照里仍是已同意：保持不能重复同意
  const still = M.fromSnapshot(
    snap({ moves, status: 'scoring', toPlay: 1, clocks: clocks(null), scoring: scoringData(moves, [41], { accepted: { 1: true, 2: false } }) }),
    T0 + 5000,
    m,
  );
  assert.equal(view(still).btn.accept, false);
});

test('manual 来源提示手动点选', () => {
  const m = scoringModel({ source: 'manual', dead: [] });
  assert.match(view(m).scoring.tip, /未能自动判断/);
});

// 人机对局、玩家执黑，两次 pass 后处于数子阶段（AI 一方自动同意，没有时限）
function aiScoringModel(over) {
  const moves = [40, 41, PASS, PASS];
  return M.fromSnapshot(
    aiSnap({ moves, status: 'scoring', toPlay: 1, canUndo: true, scoring: scoringData(moves, [], Object.assign({ deadline: null, accepted: { 1: false, 2: true }, resumesLeft: null }, over || {})) }),
    T0,
  );
}

test('人机对局死子判断失败（manual）：可以点选死子，提示手动标记；AI 判断的（katago）仍不可点选', () => {
  const m = aiScoringModel({ source: 'manual' });
  let v = view(m);
  assert.equal(v.boardDisabled, false, '人机 manual 可点选');
  assert.equal(v.scoring.tip, '未能自动判断死子，请点击死棋标记，再点"同意"终局');
  assert.deepEqual(v.scoring.notes, [], '人机对局没有时限与次数限制说明');
  assert.equal(v.btn.resume, true);
  const r = M.tapPoint(m, 41);
  assert.deepEqual(r.req, { t: 'game.score.toggle', params: { gameId: 'g1', idx: 41 } });
  assert.equal(view(r.model).boardDisabled, true, '点选请求未完成时不能再点');
  // 服务端推送点选后的结果：AI 一方保持已同意，玩家可以同意
  let s = M.requestDone(r.model, 'toggle');
  s = M.applyEvent(s, { t: 'game.scoring', gameId: 'g1', scoring: scoringData([40, 41, PASS, PASS], [41], { source: 'manual', version: 2, deadline: null, accepted: { 1: false, 2: true }, resumesLeft: null }) }, T0 + 1000);
  v = view(s);
  assert.deepEqual(v.marks.dead, [41]);
  assert.equal(v.scoring.leadText, '按当前结果：黑胜 73.5 目');
  assert.equal(v.btn.accept, true);
  assert.deepEqual(M.startAccept(s).req, { t: 'game.score.accept', params: { gameId: 'g1', version: 2 } });
  // 空点：提示点棋子
  assert.equal(M.tapPoint(m, 0).model.hint, '点击棋子可切换死活');

  const k = aiScoringModel({ source: 'katago' });
  v = view(k);
  assert.equal(v.boardDisabled, true);
  assert.equal(v.scoring.tip, '确认后按此结果终局；有异议可"继续对局"');
  assert.equal(M.tapPoint(k, 41).req, null);
  // 判断中也不能点
  const p = M.fromSnapshot(aiSnap({ moves: [40, 41, PASS, PASS], status: 'scoring', toPlay: 1, scoring: { pending: true, source: 'manual' } }), T0);
  assert.equal(M.tapPoint(p, 41).req, null);
  assert.equal(view(p).boardDisabled, true);
});

test('继续对局次数（resumesLeft）：用完后按钮不可用并说明原因；对手的次数不影响我；人机不限', () => {
  const moves = [40, 41, PASS, PASS];
  // 我（黑）已用过
  let m = scoringModel({ resumesLeft: { 1: 0, 2: 1 } });
  assert.deepEqual(m.scoring.resumesLeft, { 1: 0, 2: 1 });
  let v = view(m);
  assert.equal(v.btn.resume, false);
  assert.equal(v.scoring.notes[0], '你已用过"继续对局"，请确认数子结果或等待自动计分');
  assert.equal(v.btn.accept, true, '仍然可以同意');
  const r = M.startResume(m);
  assert.equal(r.req, null, '不发请求');
  assert.equal(r.model.hint, '你已用过"继续对局"，请确认数子结果或等待自动计分');
  // 判断死子期间同样不可用
  const pend = M.fromSnapshot(snap({ moves, status: 'scoring', toPlay: 1, clocks: clocks(null), scoring: { pending: true, resumesLeft: { 1: 0, 2: 1 } } }), T0);
  assert.equal(view(pend).btn.resume, false);
  // 对手用过、我没用过
  m = scoringModel({ resumesLeft: { 1: 1, 2: 0 } });
  v = view(m);
  assert.equal(v.btn.resume, true);
  assert.deepEqual(v.scoring.notes, ['时限到仍未达成一致时，单方面的修改不会生效']);
  assert.deepEqual(M.startResume(m).req, { t: 'game.score.resume', params: { gameId: 'g1' } });
  // 数据缺失或格式不对：不限（由服务端把关）
  for (const bad of [undefined, null, { 1: 'x', 2: 1 }, { 1: -1, 2: 1 }]) {
    const b = scoringModel({ resumesLeft: bad });
    assert.equal(b.scoring.resumesLeft, null, JSON.stringify(bad));
    assert.equal(view(b).btn.resume, true);
  }
  // 人机对局：resumesLeft 为 null，随时可以继续
  assert.equal(view(aiScoringModel()).btn.resume, true);
});

test('对手不在线时不能继续对局（服务端会拒绝）：按钮不可用并说明会自动计分；对手回来后恢复', () => {
  let m = scoringModel({ resumesLeft: { 1: 1, 2: 1 } });
  m = M.applyEvent(m, { t: 'game.presence', gameId: 'g1', color: 2, online: false }, T0 + 2000);
  let v = view(m);
  assert.equal(v.btn.resume, false);
  assert.equal(v.scoring.notes[0], '对手不在线，不能继续对局，时限到后自动计分');
  assert.equal(M.startResume(m).req, null);
  assert.equal(M.startResume(m).model.hint, '对手不在线，不能继续对局，时限到后自动计分');
  m = M.applyEvent(m, { t: 'game.presence', gameId: 'g1', color: 2, online: true }, T0 + 3000);
  v = view(m);
  assert.equal(v.btn.resume, true);
  assert.deepEqual(v.scoring.notes, ['时限到仍未达成一致时，单方面的修改不会生效']);
});

test('服务端拒绝继续对局（wrong_phase）：显示服务端的具体原因，重新同步后仍保留，按钮随新快照不可用', () => {
  const moves = [40, 41, PASS, PASS];
  const m = scoringModel({ resumesLeft: { 1: 1, 2: 1 } });
  const msg = '你已经用过"继续对局"了，请确认数子结果或等待自动计分';
  const f = M.requestFailed(M.startResume(m).model, 'resume', { code: 'wrong_phase', msg });
  assert.equal(f.model.hint, msg);
  assert.equal(f.model.pending, null);
  assert.equal(f.resync, true, '本地状态与服务端不一致：重新同步拿到最新的次数与在线状态');
  const synced = M.fromSnapshot(
    snap({ moves, status: 'scoring', toPlay: 1, clocks: clocks(null), scoring: scoringData(moves, [41], { resumesLeft: { 1: 0, 2: 1 } }) }),
    T0 + 1000,
    f.model,
  );
  const v = view(synced);
  assert.equal(v.hint, msg, '同步后提示保留');
  assert.equal(v.btn.resume, false);
  assert.equal(M.errorText({ code: 'wrong_phase', msg: '对手不在线，不能继续对局，请等待自动计分' }, 'resume'), '对手不在线，不能继续对局，请等待自动计分');
  assert.equal(M.errorText({ code: 'wrong_phase', msg: '对局已结束' }, 'move'), '对局已结束');
  assert.equal(M.errorText({ code: 'wrong_phase', msg: 'phase' }), '当前阶段不能这样操作', '没有中文说明时用通用提示');
  assert.equal(M.errorText({ code: 'not_found', msg: '对局不存在' }), '对局不存在');
  assert.equal(M.errorText({ code: 'not_found' }), '对局不存在或已结束');
});

test('真人对局数子：说明时限到时单方面的修改不会生效；判断死子期间不显示', () => {
  const m = scoringModel();
  assert.deepEqual(view(m).scoring.notes, ['时限到仍未达成一致时，单方面的修改不会生效']);
  const pend = M.fromSnapshot(snap({ moves: [40, 41, PASS, PASS], status: 'scoring', toPlay: 1, clocks: clocks(null), scoring: { pending: true } }), T0);
  assert.deepEqual(view(pend).scoring.notes, []);
});

test('继续对局：game.resumed 回到对局，轮到最先 pass 的一方，重新计时', () => {
  let m = scoringModel();
  const r = M.startResume(m);
  assert.deepEqual(r.req, { t: 'game.score.resume', params: { gameId: 'g1' } });
  assert.equal(view(r.model).statusText, '正在恢复对局…');
  m = M.requestDone(r.model, 'resume');
  m = M.applyEvent(m, { t: 'game.resumed', gameId: 'g1', toPlay: 1, clocks: clocks(1, 150000) }, T0 + 5000);
  assert.equal(m.status, 'playing');
  assert.equal(m.scoring, null);
  assert.equal(m.toPlay, 1);
  assert.equal(M.isMyTurn(m), true);
  assert.equal(m.clocksAt, T0 + 5000);
  assert.equal(m.clocksFrozenAt, null);
  const v = view(m);
  assert.equal(v.marks, null);
  assert.equal(v.btn.pass, true);
  // 继续后可以正常落子（序列中两次 pass 之后接着下）
  m = M.applyEvent(m, move(5, 50), T0 + 6000);
  assert.equal(m.cells[50], 1);
  assert.deepEqual(m.moves, [40, 41, PASS, PASS, 50]);
  // 重复的 resumed 推送忽略
  assert.equal(M.applyEvent(m, { t: 'game.resumed', gameId: 'g1', toPlay: 1 }, T0), m);
});

test('game.resumed：轮到方与本地不符 → 重新同步', () => {
  const m = scoringModel();
  assert.deepEqual(M.applyEvent(m, { t: 'game.resumed', gameId: 'g1', toPlay: 2, clocks: clocks(2) }, T0), { resync: true });
});

// ---------------- 终局 ----------------

test('game.end：排位赛显示连胜变化；冻结读秒；按钮', () => {
  const { displayClock, calls } = makeClock();
  let m = M.fromSnapshot(snap({ moves: [40], toPlay: 2, clocks: clocks(2, 100000, 60000) }), T0);
  m = M.applyEvent(
    m,
    {
      t: 'game.end',
      gameId: 'g1',
      result: { winner: 1, reason: 'resign', black: null, white: null, text: 'B+R', label: '黑中盘胜（对方认输）', counted: true },
      stats: { 1: { games: 12, wins: 8, losses: 4, draws: 0, winrate: 8 / 12, curStreak: 3, maxStreak: 3 }, 2: { games: 5, wins: 1, losses: 4, draws: 0, winrate: 0.2, curStreak: 0, maxStreak: 1 } },
    },
    T0 + 30000
  );
  assert.equal(m.status, 'ended');
  const v = M.viewData(m, T0 + 90000, { displayClock });
  assert.equal(v.phase, 'ended');
  assert.equal(v.end.title, '你赢了');
  assert.equal(v.end.tone, 'win');
  assert.equal(v.end.label, '黑中盘胜（对方认输）');
  assert.equal(v.end.scoreText, '');
  assert.deepEqual(v.end.lines, ['当前连胜 3 局（个人最高）', '最高连胜 3 局 · 排位 12 局 · 胜率 66.7%']);
  assert.equal(v.end.showAgain, true);
  assert.equal(v.btn.resign, false);
  assert.equal(v.btn.pass, false);
  assert.equal(v.btn.again, true);
  assert.equal(v.boardDisabled, true);
  assert.equal(v.statusText, '');
  // 白方读秒冻结在终局时刻：已走 30 秒
  const white = calls.filter((c) => c.clock.mainMs === 60000);
  assert.equal(white[white.length - 1].elapsed, 30000);
  assert.equal(v.top.clock.text, '30');
  // 重复的 end 推送：没有新信息时不变
  assert.equal(M.applyEvent(m, { t: 'game.end', gameId: 'g1', result: { winner: 1, reason: 'resign' } }, T0), m);
});

test('终局文案：输棋、和棋、作废、不计入、友谊赛与人机', () => {
  const end = (over, result, stats) => {
    let m = M.fromSnapshot(snap(over), T0);
    m = M.applyEvent(m, { t: 'game.end', gameId: 'g1', result, stats }, T0);
    return view(m).end;
  };
  let e = end({}, { winner: 2, reason: 'timeout', counted: true }, { 1: { games: 3, wins: 1, winrate: 1 / 3, curStreak: 0, maxStreak: 2 } });
  assert.equal(e.title, '你输了');
  assert.equal(e.label, '白胜（对方超时）');
  assert.deepEqual(e.lines, ['连胜中断', '最高连胜 2 局 · 排位 3 局 · 胜率 33.3%']);
  e = end({}, { winner: 0, reason: 'score', black: 40, white: 40, counted: true }, { 1: { games: 3, wins: 1, curStreak: 1, maxStreak: 2 } });
  assert.equal(e.title, '和棋');
  assert.equal(e.lines[0], '和棋，连胜保持 1 局');
  e = end({}, { winner: 0, reason: 'abort', counted: false });
  assert.equal(e.title, '对局作废');
  assert.equal(e.tone, 'void');
  assert.deepEqual(e.lines, ['对局作废，不计入排行榜']);
  e = end({}, { winner: 1, reason: 'resign', counted: false });
  assert.deepEqual(e.lines, ['手数不足，本局不计入排行榜']);
  // 服务端给出没计入的原因 / 结果还在保存
  e = end({}, { winner: 1, reason: 'resign', counted: false, uncounted: 'short' });
  assert.deepEqual(e.lines, ['手数不足，本局不计入排行榜']);
  e = end({}, { winner: 1, reason: 'score', black: 50, white: 31, counted: false, uncounted: 'pair_limit' });
  assert.deepEqual(e.lines, ['与同一对手 24 小时内计入排行的局数已满，本局不计入']);
  e = end({}, { winner: 1, reason: 'score', black: 50, white: 31, counted: false, pending: true });
  assert.deepEqual(e.lines, ['结果正在保存，稍后计入排行榜']);
  // 作废原因：服务端给出 cause 时按它说明，否则按对局情况推断
  e = end({ moves: [40, 41, PASS, PASS], toPlay: 1 }, { winner: 0, reason: 'abort', counted: false, cause: 'score_dispute' });
  assert.equal(e.label, '数子有争议，时限内未达成一致');
  e = end({ moves: [40, 41], toPlay: 1 }, { winner: 0, reason: 'abort', counted: false, cause: 'arrival' });
  assert.equal(e.label, '有一方长时间没有回到对局');
  e = end({ moves: [40, 41], toPlay: 1 }, { winner: 0, reason: 'abort', counted: false, cause: 'something_new' });
  assert.equal(e.label, '你离线太久，且手数太少', '未知原因：按对局情况推断');
  e = end({ mode: 'friend' }, { winner: 1, reason: 'resign' });
  assert.deepEqual(e.lines, ['好友对局不计入排行榜']);
  assert.equal(e.showAgain, false);
  e = end({ mode: 'ai', players: aiSnap().players, timeControl: null, clocks: null }, { winner: 1, reason: 'resign' });
  assert.deepEqual(e.lines, ['人机对局不计入排行榜']);
  // 无效结果 → 重新同步
  const m = M.fromSnapshot(snap(), T0);
  assert.deepEqual(M.applyEvent(m, { t: 'game.end', gameId: 'g1', result: { winner: 5, reason: 'x' } }, T0), { resync: true });
});

test('再来一局：排位重新匹配；人机同设置开局；好友返回首页', () => {
  const endResult = { t: 'game.end', gameId: 'g1', result: { winner: 1, reason: 'resign' } };
  let m = M.applyEvent(M.fromSnapshot(snap({ size: 13 }), T0), endResult, T0);
  assert.deepEqual(M.startAgain(m).action, { type: 'navigate', method: 'redirectTo', url: '/pages/match/match?size=13' });

  m = M.applyEvent(M.fromSnapshot(aiWhiteSnap({ toPlay: 1 }), T0), endResult, T0);
  let r = M.startAgain(m);
  assert.deepEqual(r.action, { type: 'request', t: 'ai.start', params: { size: 9, level: 'k5', color: 'white' } });
  assert.equal(r.model.pending, 'again');
  assert.equal(view(r.model).btn.again, false);
  assert.deepEqual(M.startAgain(m, { aiColor: 'random' }).action.params.color, 'random');
  assert.equal(M.startAgain(r.model).action, null, '已在开局中');
  const failed = M.requestFailed(r.model, 'again', { code: 'ai_unavailable' });
  assert.equal(failed.model.hint, 'AI 暂时不可用');
  assert.equal(failed.model.pending, null);
  // 人机对局但没有 level 信息 → 去人机设置页
  const noLevel = aiSnap();
  noLevel.players[2] = { ai: true, nickname: 'AI' };
  m = M.applyEvent(M.fromSnapshot(noLevel, T0), endResult, T0);
  assert.deepEqual(M.startAgain(m).action, { type: 'navigate', method: 'redirectTo', url: '/pages/ai/ai' });

  m = M.applyEvent(M.fromSnapshot(snap({ mode: 'friend' }), T0), endResult, T0);
  assert.deepEqual(M.startAgain(m).action, { type: 'navigate', method: 'reLaunch', url: '/pages/index/index' });
  // 未终局
  assert.equal(M.startAgain(M.fromSnapshot(snap(), T0)).action, null);
});

// ---------------- 认输 ----------------

test('认输：对局中与数子阶段都可以；终局后不行', () => {
  const m = M.fromSnapshot(snap({ moves: [40], toPlay: 2 }), T0);
  assert.deepEqual(M.startResign(m).req, { t: 'game.resign', params: { gameId: 'g1' } });
  assert.deepEqual(M.startResign(scoringModel()).req, { t: 'game.resign', params: { gameId: 'g1' } });
  const e = M.fromSnapshot(snap({ status: 'ended', result: { winner: 2, reason: 'resign' } }), T0);
  assert.equal(M.startResign(e).req, null);
});

// ---------------- 读秒 ----------------

test('读秒：行棋方按接收时刻倒数，另一方不走；人机无读秒', () => {
  const { displayClock, calls } = makeClock();
  const m = M.fromSnapshot(snap({ clocks: clocks(1, 100000, 50000) }), T0);
  const v = M.viewData(m, T0 + 3400, { displayClock });
  assert.equal(v.bottom.clock.text, '97');
  assert.equal(v.top.clock.text, '50');
  assert.equal(v.bottom.clock.sub, '读秒 3 次');
  assert.deepEqual(
    calls.map((c) => c.elapsed),
    [0, 3400]
  );
  // 时钟在接收之前（本地时间回拨）不出现负数
  const back = M.viewData(m, T0 - 5000, { displayClock });
  assert.equal(back.bottom.clock.text, '100');
  // 没有 displayClock / 人机对局
  assert.equal(M.viewData(m, T0, {}).bottom.clock, null);
  const ai = M.fromSnapshot(aiSnap(), T0);
  assert.equal(M.viewData(ai, T0, { displayClock }).bottom.clock, null);
  // 数子阶段快照：冻结
  const s = M.fromSnapshot(snap({ moves: [PASS, PASS], status: 'scoring', clocks: clocks(1, 100000), scoring: { pending: true } }), T0);
  assert.equal(M.viewData(s, T0 + 60000, { displayClock }).bottom.clock.text, '100');
  // 格式不对的读秒数据视为无读秒
  assert.equal(M.fromSnapshot(snap({ clocks: { 1: {}, 2: {} } }), T0).clocks, null);
});

test('读秒紧急与超时标记透传；超时显示"超时"；完整读秒周期传给 displayClock', () => {
  const { displayClock, calls } = makeClock();
  const m = M.fromSnapshot(snap({ clocks: clocks(1, 5000) }), T0);
  let v = M.viewData(m, T0 + 4000, { displayClock });
  assert.equal(v.bottom.clock.urgent, true);
  assert.equal(v.bottom.clock.timeout, false);
  assert.deepEqual(calls[calls.length - 1].timeControl, tc());
  v = M.viewData(m, T0 + 6000, { displayClock });
  assert.deepEqual(v.bottom.clock, { text: '超时', sub: '', urgent: true, timeout: true });
  assert.equal(M.errorText({ code: 'kicked' }), '账号已在其他设备登录');
});

// ---------------- 在线状态与 AI ----------------

test('game.presence：对手离线提示；AI 一方忽略', () => {
  let m = M.fromSnapshot(snap({ moves: [40], toPlay: 2 }), T0);
  m = M.applyEvent(m, { t: 'game.presence', gameId: 'g1', color: 2, online: false }, T0);
  let v = view(m);
  assert.equal(v.top.online, false);
  assert.equal(v.statusText, '对手已离线，等待其重连…');
  assert.equal(M.applyEvent(m, { t: 'game.presence', gameId: 'g1', color: 2, online: false }, T0), m);
  assert.equal(M.applyEvent(m, { t: 'game.presence', gameId: 'g1', color: 7, online: true }, T0), m);
  m = M.applyEvent(m, { t: 'game.presence', gameId: 'g1', color: 2, online: true }, T0);
  v = view(m);
  assert.equal(v.top.online, true);
  const ai = M.fromSnapshot(aiSnap(), T0);
  assert.equal(M.applyEvent(ai, { t: 'game.presence', gameId: 'g1', color: 2, online: false }, T0), ai);
});

test('人机对局：AI 思考中提示；AI 落子后清除；悔棋按钮', () => {
  let m = M.fromSnapshot(aiSnap(), T0);
  let v = view(m);
  assert.equal(v.btn.showUndo, true);
  assert.equal(v.btn.undo, false);
  assert.equal(v.top.isAi, true);
  m = M.applyEvent(M.pick(m, 40), move(1, 40), T0);
  assert.equal(m.canUndo, true);
  m = M.applyEvent(m, { t: 'game.ai', gameId: 'g1', thinking: true }, T0);
  v = view(m);
  assert.equal(v.statusText, 'AI 思考中…');
  assert.equal(v.top.thinking, true);
  assert.equal(v.btn.undo, true, 'AI 思考中也可以悔棋');
  assert.equal(v.boardDisabled, true);
  assert.equal(M.applyEvent(m, { t: 'game.ai', gameId: 'g1', thinking: true }, T0), m);
  m = M.applyEvent(m, move(2, 41), T0);
  assert.equal(m.aiThinking, false);
  assert.equal(M.isMyTurn(m), true);
  // 真人对局忽略 game.ai
  const p = M.fromSnapshot(snap(), T0);
  assert.equal(M.applyEvent(p, { t: 'game.ai', gameId: 'g1', thinking: true }, T0), p);
});

test('人机对局悔棋：game.undo 替换着手序列；数子阶段悔棋回到对局', () => {
  let m = M.fromSnapshot(aiSnap({ moves: [40, 41, 50, 51], toPlay: 1, canUndo: true }), T0);
  const r = M.startUndo(m);
  assert.deepEqual(r.req, { t: 'game.undo', params: { gameId: 'g1' } });
  m = M.requestDone(r.model, 'undo');
  m = M.applyEvent(m, { t: 'game.undo', gameId: 'g1', moves: [40, 41] }, T0);
  assert.deepEqual(m.moves, [40, 41]);
  assert.equal(m.cells[50], 0);
  assert.equal(m.lastIdx, 41);
  assert.equal(m.canUndo, true);
  m = M.applyEvent(m, { t: 'game.undo', gameId: 'g1', moves: [] }, T0);
  assert.equal(m.canUndo, false);
  assert.equal(M.startUndo(m).req, null);
  assert.equal(M.startUndo(m).model.hint, '没有可以悔的棋');

  // 数子阶段：玩家 pass、AI pass → 悔棋撤回两手
  let s = M.fromSnapshot(aiSnap({ moves: [40, 41, PASS, PASS], status: 'scoring', toPlay: 1, canUndo: true, scoring: scoringData([40, 41, PASS, PASS], [], { deadline: null, accepted: { 1: false, 2: true } }) }), T0);
  const sv = view(s);
  assert.equal(sv.boardDisabled, true, '人机数子不可点选');
  assert.equal(sv.scoring.oppAcceptText, '已同意');
  assert.equal(sv.scoring.deadlineText, '');
  assert.equal(sv.btn.undo, true);
  assert.equal(M.tapPoint(s, 40).req, null);
  s = M.applyEvent(s, { t: 'game.undo', gameId: 'g1', moves: [40, 41] }, T0);
  assert.equal(s.status, 'playing');
  assert.equal(s.scoring, null);
  assert.equal(M.isMyTurn(s), true);
  // 撤回后序列以两次 pass 结尾（继续对局后再悔棋）也回到对局
  const t = M.applyEvent(s, { t: 'game.undo', gameId: 'g1', moves: [40, 41, PASS, PASS] }, T0);
  assert.equal(t.status, 'playing');
  assert.equal(t.state.status, 'playing');
  // 非法序列 / 真人对局 → 重新同步
  assert.deepEqual(M.applyEvent(s, { t: 'game.undo', gameId: 'g1', moves: [40, 40] }, T0), { resync: true });
  assert.deepEqual(M.applyEvent(M.fromSnapshot(snap(), T0), { t: 'game.undo', gameId: 'g1', moves: [] }, T0), { resync: true });
});

test('人机执白：AI 先行，玩家未下前不能悔棋', () => {
  let m = M.fromSnapshot(aiWhiteSnap({ toPlay: 1, aiThinking: true }), T0);
  m = M.applyEvent(m, move(1, 40), T0);
  assert.equal(m.canUndo, false);
  assert.equal(m.aiThinking, false, 'AI 落子后清除思考状态');
  assert.equal(M.isMyTurn(m), true);
  m = M.applyEvent(m, move(2, 41), T0);
  assert.equal(m.canUndo, true);
});

// ---------------- 连接状态 ----------------

test('断线：显示重连提示，所有操作禁用；被顶号保持 kicked', () => {
  let m = M.pick(M.fromSnapshot(snap(), T0), 40);
  m = M.setConnection(m, 'closed');
  let v = view(m);
  assert.equal(v.banner, '连接中断，正在重连…');
  assert.equal(v.btn.confirm, false);
  assert.equal(v.btn.pass, false);
  assert.equal(v.btn.resign, false);
  assert.equal(v.boardDisabled, true);
  assert.equal(v.bottom.online, false);
  const r = M.startMove(m);
  assert.equal(r.req, null);
  assert.equal(r.model.hint, '网络未连接，请稍候');
  m = M.setConnection(m, 'open');
  v = view(m);
  assert.equal(v.banner, '');
  assert.equal(v.btn.confirm, true);

  m = M.setConnection(m, 'kicked');
  assert.equal(M.setConnection(m, 'closed').connection, 'kicked');
  assert.match(view(m).banner, /其他设备/);
  assert.equal(M.setConnection(m, 'connecting').connection, 'connecting');
  assert.equal(M.setConnection(m, 'bogus'), m);
  assert.equal(M.setConnection(m, 'kicked'), m);
});

// ---------------- 重新同步 ----------------

test('fromSnapshot(prev)：重新同步时保留连接状态、进行中的请求、预览与统计', () => {
  let prev = M.pick(M.fromSnapshot(snap(), T0), 40);
  prev = M.setConnection(prev, 'connecting');
  let next = M.fromSnapshot(snap(), T0 + 10, prev);
  assert.equal(next.connection, 'connecting');
  assert.deepEqual(next.preview, { idx: 40, ok: true, color: 1 });
  // 局面变了：预览丢弃
  next = M.fromSnapshot(snap({ moves: [40, 41], toPlay: 1 }), T0 + 10, prev);
  assert.equal(next.preview, null);
  // 提交中的落子：局面未包含这一手时保留等待
  prev = M.startMove(M.pick(M.fromSnapshot(snap(), T0), 40)).model;
  next = M.fromSnapshot(snap(), T0 + 10, prev);
  assert.equal(next.pending, 'move');
  assert.equal(M.awaitingMove(next), true);
  next = M.fromSnapshot(snap({ moves: [40], toPlay: 2 }), T0 + 10, prev);
  assert.equal(M.awaitingMove(next), false);
  // 回复已到、推送丢失：重新同步后不再卡在等待
  const done = M.requestDone(prev, 'move');
  next = M.fromSnapshot(snap(), T0 + 10, done);
  assert.equal(M.awaitingMove(next), false);
  assert.equal(M.isMyTurn(next), true);
  // 终局统计
  let ended = M.applyEvent(M.fromSnapshot(snap(), T0), { t: 'game.end', gameId: 'g1', result: { winner: 1, reason: 'resign', counted: true }, stats: { 1: { games: 1, wins: 1, curStreak: 1, maxStreak: 1 } } }, T0);
  ended = M.fromSnapshot(snap({ status: 'ended', result: { winner: 1, reason: 'resign', counted: true } }), T0, ended);
  assert.equal(ended.stats[1].curStreak, 1);
  // 不同对局不继承
  const other = M.fromSnapshot(snap({ id: 'g2' }), T0, prev);
  assert.equal(other.pending, null);
});

// ---------------- 杂项 ----------------

test('格式化', () => {
  assert.equal(M.formatCountdown(0), '0:00');
  assert.equal(M.formatCountdown(-5), '0:00');
  assert.equal(M.formatCountdown(59001), '1:00');
  assert.equal(M.formatCountdown(180000), '3:00');
  assert.equal(M.formatCountdown(65000), '1:05');
  assert.equal(M.timeControlText({ mainMs: 600000, periods: 3, periodMs: 30000 }), '10 分 + 3×30 秒');
  assert.equal(M.timeControlText({ mainMs: 90000, periods: 0, periodMs: 0 }), '90 秒');
  assert.equal(M.timeControlText(null), '');
});

test('viewData 在读秒走动时只有读秒字段变化', () => {
  const { diffData } = require('../../miniprogram/pages/play/diff');
  const m = M.fromSnapshot(snap({ moves: [40, 41], toPlay: 1 }), T0);
  const { displayClock } = makeClock();
  const a = M.viewData(m, T0 + 100, { displayClock });
  const b = M.viewData(m, T0 + 2100, { displayClock });
  assert.equal(a.cells, b.cells, '棋盘数组复用同一引用');
  assert.deepEqual(Object.keys(diffData(a, b)), ['bottom']);
  assert.deepEqual(diffData(a, M.viewData(m, T0 + 100, { displayClock })), {});
});

test('与真实的 utils/clock.js 配合', () => {
  const { displayClock } = require('../../miniprogram/utils/clock');
  const m = M.fromSnapshot(snap({ clocks: clocks(1, 65000, 0) }), T0);
  const v = M.viewData(m, T0 + 5000, { displayClock });
  assert.equal(v.bottom.clock.text, '01:00');
  assert.equal(v.bottom.clock.sub, '读秒 3 次');
  assert.equal(v.top.clock.text, '20', '对手基本时间已用完：显示读秒周期');
  const late = M.viewData(m, T0 + 65000 + 20000 * 3 + 1, { displayClock });
  assert.equal(late.bottom.clock.text, '超时');
});

test('同步失败提示：保留局面，下次同步成功后清除；其他提示在同步后保留', () => {
  let m = M.fromSnapshot(snap(), T0);
  m = M.syncFailed(m, { code: 'offline' });
  assert.equal(m.hint, '同步失败：网络未连接，请稍后再试');
  assert.equal(view(m).hint, m.hint);
  const next = M.fromSnapshot(snap({ moves: [40], toPlay: 2 }), T0, m);
  assert.equal(next.hint, '');
  const f = M.requestFailed(M.startMove(M.pick(M.fromSnapshot(snap(), T0), 40)).model, 'move', { code: 'stale' });
  assert.equal(M.fromSnapshot(snap({ moves: [40], toPlay: 2 }), T0, f.model).hint, '局面已更新，已重新同步');
});

// ---------------- 修复回归 ----------------

test('对手选"继续对局"：状态栏说明对手有异议，直到下一手；我自己继续对局时不提示', () => {
  // 对手发起：我没有发 resume
  let m = scoringModel();
  m = M.applyEvent(m, { t: 'game.resumed', gameId: 'g1', toPlay: 1, clocks: clocks(1, 150000) }, T0 + 5000);
  assert.equal(m.resumedByOpp, true);
  assert.equal(view(m).statusText, '对手对数子结果有异议，继续对局：轮到你落子');
  assert.equal(view(M.pick(m, 50)).statusText, '点「确定」落子，或拖动重新选点');
  m = M.applyEvent(m, move(5, 50), T0 + 6000);
  assert.equal(m.resumedByOpp, false);
  assert.equal(view(m).statusText, '等待对手落子…');

  // 我发起：res 先到（requestDone），推送后到
  let mine = scoringModel();
  mine = M.requestDone(M.startResume(mine).model, 'resume');
  mine = M.applyEvent(mine, { t: 'game.resumed', gameId: 'g1', toPlay: 1, clocks: clocks(1, 150000) }, T0 + 5000);
  assert.equal(mine.resumedByOpp, false);
  assert.equal(view(mine).statusText, '对手停了一手，轮到你（你也停一手将进入数子）');
  // 推送先于 res 到达
  let early = M.startResume(scoringModel()).model;
  early = M.applyEvent(early, { t: 'game.resumed', gameId: 'g1', toPlay: 1, clocks: clocks(1) }, T0 + 5000);
  assert.equal(early.resumedByOpp, false);
});

test('对手在我断线期间"继续对局"：重新同步后同样提示；我发起的（回应丢失）不提示', () => {
  const moves = [40, 41, PASS, PASS];
  const playingSnap = snap({ moves, status: 'playing', toPlay: 1, clocks: clocks(1) });
  const synced = M.fromSnapshot(playingSnap, T0 + 5000, scoringModel());
  assert.equal(synced.status, 'playing');
  assert.equal(synced.resumedByOpp, true);
  assert.match(view(synced).statusText, /对手对数子结果有异议/);
  // 再同步一次（没有新着手）：提示保留
  assert.equal(M.fromSnapshot(playingSnap, T0 + 6000, synced).resumedByOpp, true);
  const mine = M.fromSnapshot(playingSnap, T0 + 5000, M.startResume(scoringModel()).model);
  assert.equal(mine.resumedByOpp, false);
  // res 已到、推送丢失，数子阶段内重新同步：保留"是我发起的"
  const sent = M.requestDone(M.startResume(scoringModel()).model, 'resume');
  const stillScoring = M.fromSnapshot(snap({ moves, status: 'scoring', toPlay: 1, clocks: clocks(null), scoring: scoringData(moves, [41]) }), T0 + 5000, sent);
  assert.equal(stillScoring.resumeSent, true);
  const after = M.applyEvent(stillScoring, { t: 'game.resumed', gameId: 'g1', toPlay: 1, clocks: clocks(1) }, T0 + 6000);
  assert.equal(after.resumedByOpp, false);
});

test('对局作废：说明原因（黑方 60 秒未落第一手 / 轮到的一方离线太久 / 人机）', () => {
  const abort = { winner: 0, reason: 'abort', black: null, white: null, counted: false };
  const endOf = (over) => {
    let m = M.fromSnapshot(snap(over), T0);
    m = M.applyEvent(m, { t: 'game.end', gameId: 'g1', result: abort }, T0);
    return view(m).end;
  };
  let e = endOf({});
  assert.equal(e.title, '对局作废');
  assert.equal(e.label, '你没有在 60 秒内落下第一手');
  assert.deepEqual(e.lines, ['对局作废，不计入排行榜']);
  assert.equal(endOf({ myColor: 2 }).label, '对手没有在 60 秒内落下第一手');
  assert.equal(endOf({ moves: [40], toPlay: 2, clocks: clocks(2) }).label, '对手离线太久，且手数太少');
  assert.equal(endOf({ moves: [40], toPlay: 2, myColor: 2, clocks: clocks(2) }).label, '你离线太久，且手数太少');
  assert.equal(endOf({ mode: 'friend', moves: [40, 41], toPlay: 1, clocks: clocks(1) }).label, '你离线太久，且手数太少');
  const ai = endOf({ mode: 'ai', players: aiSnap().players, timeControl: null, clocks: null, moves: [40, 41] });
  assert.equal(ai.label, '可能开了新的人机对局、长时间未下，或 AI 连续出错');
  // 快照路径同样有原因
  const synced = M.fromSnapshot(snap({ status: 'ended', result: abort, clocks: clocks(null) }), T0);
  assert.equal(view(synced).end.label, '你没有在 60 秒内落下第一手');
});

test('数子与终局面板：注明白方点数已含贴目', () => {
  const m = scoringModel();
  assert.equal(view(m).scoring.komiText, '白方点数已含贴目 7.5');
  const pending = M.applyEvent(M.fromSnapshot(snap({ moves: [40, 41, PASS], toPlay: 2, clocks: clocks(2) }), T0), move(4, PASS, { clocks: clocks(null) }), T0);
  assert.equal(view(pending).scoring.komiText, '');
  const ended = M.applyEvent(m, { t: 'game.end', gameId: 'g1', result: { winner: 1, reason: 'score', black: 50, white: 31, counted: true } }, T0 + 2000);
  assert.equal(view(ended).end.komiText, '白方点数已含贴目 7.5');
  const resigned = M.applyEvent(M.fromSnapshot(snap(), T0), { t: 'game.end', gameId: 'g1', result: { winner: 2, reason: 'resign' } }, T0);
  assert.equal(view(resigned).end.komiText, '');
});

test('needsStats / withMyStats：快照得到的排位终局补上我的统计', () => {
  const result = { winner: 1, reason: 'resign', black: null, white: null, counted: true };
  const m = M.fromSnapshot(snap({ moves: [40, 41], status: 'ended', result, clocks: clocks(null) }), T0);
  assert.equal(M.needsStats(m), true);
  assert.deepEqual(view(m).end.lines, ['本局已计入排行榜']);
  const withStats = M.withMyStats(m, { games: 3, wins: 3, losses: 0, draws: 0, winrate: 1, curStreak: 3, maxStreak: 3 });
  assert.equal(M.needsStats(withStats), false);
  assert.deepEqual(view(withStats).end.lines, ['当前连胜 3 局（个人最高）', '最高连胜 3 局 · 排位 3 局 · 胜率 100%']);
  assert.equal(M.withMyStats(withStats, { games: 9 }), withStats, '已有统计不覆盖');
  assert.equal(M.withMyStats(m, null), m);
  assert.equal(M.needsStats(M.fromSnapshot(snap({ status: 'ended', result: { ...result, counted: false }, clocks: clocks(null) }), T0)), false);
  assert.equal(M.needsStats(M.fromSnapshot(snap({ mode: 'friend', status: 'ended', result, clocks: clocks(null) }), T0)), false);
  assert.equal(M.needsStats(M.fromSnapshot(snap(), T0)), false);
});
