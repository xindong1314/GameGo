'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../../miniprogram/pages/replay/model');

const PASS = -1;

function record(over) {
  return Object.assign(
    {
      id: 'g1',
      mode: 'ranked',
      size: 9,
      myColor: 1,
      opponent: { id: 2, nickname: '小白', avatarUrl: '' },
      winner: 1,
      reason: 'resign',
      resultText: 'B+R',
      myResult: 'win',
      moveCount: 3,
      createdAt: new Date(2026, 8, 25, 9, 5).getTime(),
      endedAt: new Date(2026, 8, 25, 9, 30).getTime(),
      komi: 7.5,
      moves: [1, 0, 9],
      dead: null,
      players: {
        1: { userId: 1, nickname: '小黑', avatarUrl: 'http://x/1.png' },
        2: { userId: 2, nickname: '小白', avatarUrl: '' },
      },
      scoreBlack: null,
      scoreWhite: null,
    },
    over || {}
  );
}

test('fromRecord：预先算好每一手之后的局面（含提子）', () => {
  const m = R.fromRecord(record());
  assert.equal(m.total, 3);
  assert.equal(m.frames.length, 4);
  assert.ok(m.frames[0].cells.every((c) => c === 0));
  assert.equal(m.frames[2].cells[0], 2);
  assert.equal(m.frames[3].cells[0], 0, '第 3 手提掉白子');
  assert.equal(m.frames[3].captures[1], 1);
  assert.equal(m.frames[3].lastIdx, 9);
  assert.equal(m.error, '');
});

test('viewAt：手数夹在 [0, total]，文案、提子与前后可用', () => {
  const m = R.fromRecord(record());
  let v = R.viewAt(m, 0);
  assert.equal(v.k, 0);
  assert.equal(v.moveText, '开局');
  assert.equal(v.lastIdx, -1);
  assert.equal(v.canPrev, false);
  assert.equal(v.canNext, true);
  assert.ok(Array.isArray(v.cells), '传给 setData 的是普通数组');
  v = R.viewAt(m, 2);
  assert.equal(v.moveText, '第 2 手 · 白 A9');
  assert.equal(v.cells[0], 2);
  v = R.viewAt(m, 99);
  assert.equal(v.k, 3);
  assert.equal(v.moveText, '第 3 手 · 黑 A8');
  assert.deepEqual(v.captures, { 1: 1, 2: 0 });
  assert.equal(v.canNext, false);
  assert.equal(v.marks, null, '非数子终局不标死子');
  assert.equal(v.finalText, '');
  assert.equal(R.viewAt(m, -5).k, 0);
  assert.equal(R.viewAt(m, 1.6).k, 2);
  assert.equal(R.clampMove(m, 'abc'), 3);
  assert.equal(R.clampMove(m, '1'), 1);
});

test('pass 的一手：文案为停一手，最后一手标记保持上一颗子', () => {
  const m = R.fromRecord(record({ moves: [40, PASS, 41] }));
  const v = R.viewAt(m, 2);
  assert.equal(v.moveText, '第 2 手 · 白 停一手');
  assert.equal(v.lastIdx, 40);
});

test('数子终局：最后一手显示死子与地盘，以及双方点数', () => {
  const moves = [40, 41, PASS, PASS];
  const m = R.fromRecord(record({ moves, reason: 'score', dead: [41], scoreBlack: 81, scoreWhite: 7.5, resultText: 'B+73.5' }));
  const last = R.viewAt(m, m.total);
  assert.deepEqual(last.marks.dead, [41]);
  assert.equal(last.marks.owner.length, 81);
  assert.equal(last.marks.owner[41], 1);
  assert.equal(last.finalText, '黑 81 点 · 白 7.5 点（白含贴目 7.5）');
  assert.equal(R.viewAt(m, 3).marks, null);
  const h = R.headerView(m);
  assert.equal(h.resultLabel, '黑胜 73.5 目');
});

test('继续对局后的棋谱可以复盘', () => {
  const m = R.fromRecord(record({ moves: [40, PASS, PASS, 41, 50] }));
  assert.equal(m.error, '');
  assert.equal(m.total, 5);
  assert.equal(R.viewAt(m, 5).cells[50], 1);
});

test('非法着手：只显示到出错前一手并提示', () => {
  const m = R.fromRecord(record({ moves: [40, 41, 40, 50] }));
  assert.equal(m.total, 2);
  assert.equal(m.error, '棋谱第 3 手数据异常，只能显示到第 2 手');
  assert.equal(R.viewAt(m, 99).k, 2);
  assert.equal(R.headerView(m).error, m.error);
  // 出错时不标死子
  const s = R.fromRecord(record({ moves: [40, 81], reason: 'score', dead: [40] }));
  assert.equal(s.finalMarks, null);
});

test('fromRecord：数据校验', () => {
  for (const bad of [null, record({ size: 0 }), record({ size: 21 }), record({ moves: null })]) {
    assert.throws(() => R.fromRecord(bad), (err) => err.code === 'bad_record');
  }
});

test('headerView：双方信息、结果、我的胜负、日期', () => {
  const h = R.headerView(R.fromRecord(record()));
  assert.equal(h.black.nickname, '小黑');
  assert.equal(h.black.isMe, true);
  assert.equal(h.white.isMe, false);
  assert.equal(h.resultLabel, '黑中盘胜（对方认输）');
  assert.equal(h.myResultText, '胜');
  assert.equal(h.myResultTone, 'win');
  assert.equal(h.infoText, '排位赛 · 9 路 · 贴 7.5 目 · 共 3 手');
  assert.equal(h.dateText, '2026-09-25 09:05');
  assert.equal(h.size, 9);

  const ai = R.headerView(
    R.fromRecord(record({ mode: 'ai', myColor: 2, winner: 1, myResult: undefined, players: { 1: { ai: true, level: 'k5', nickname: 'AI · 5级', avatarUrl: '' }, 2: { userId: 1, nickname: '我自己' } } }))
  );
  assert.equal(ai.black.isAi, true);
  assert.equal(ai.black.nickname, 'AI · 5级');
  assert.equal(ai.white.isMe, true);
  assert.equal(ai.myResultText, '负', '缺少 myResult 时按胜负推算');

  const noPlayers = R.headerView(R.fromRecord(record({ players: undefined, opponent: { ai: true, level: 'k5', levelName: '5级' }, myColor: 2 })));
  assert.equal(noPlayers.white.nickname, '我');
  assert.equal(noPlayers.black.nickname, 'AI · 5级');

  const pending = R.headerView(R.fromRecord(record({ winner: null, reason: null, myResult: undefined, createdAt: undefined })));
  assert.equal(pending.resultLabel, '对局未结束');
  assert.equal(pending.myResultText, '');
  assert.equal(pending.dateText, '');

  const voided = R.headerView(R.fromRecord(record({ winner: 0, reason: 'abort', myResult: 'void', moves: [] })));
  assert.equal(voided.resultLabel, '对局作废');
  assert.equal(voided.myResultText, '作废');
});

test('sgfOf', () => {
  const m = R.fromRecord(record());
  assert.equal(R.sgfOf(m), '(;FF[4]GM[1]CA[UTF-8]AP[GameGo]RU[Chinese]SZ[9]KM[7.5]PB[小黑]PW[小白]DT[2026-09-25]RE[B+R];B[ba];W[aa];B[ab])');
  const s = R.fromRecord(record({ moves: [40, PASS, PASS], reason: 'score', winner: 2, scoreBlack: 1, scoreWhite: 7.5 }));
  assert.match(R.sgfOf(s), /RE\[W\+6\.5\];B\[ee\];W\[\];B\[\]\)$/);
});

test('loadErrorText', () => {
  assert.equal(R.loadErrorText({ code: 'not_found', status: 404 }), '对局不存在');
  assert.equal(R.loadErrorText({ status: 404 }), '对局不存在');
  assert.equal(R.loadErrorText({ code: 'forbidden', status: 403 }), '只能查看自己参与的对局');
  assert.equal(R.loadErrorText({ code: 'offline' }), '网络未连接，请稍后再试');
  assert.equal(R.loadErrorText({ status: 401 }), '登录已失效，请重新进入');
  assert.equal(R.loadErrorText({ code: 'x', msg: '服务器维护中' }), '服务器维护中');
  assert.equal(R.loadErrorText(undefined), '棋谱加载失败，请重试');
  let err;
  try {
    R.fromRecord(null);
  } catch (e) {
    err = e;
  }
  assert.equal(R.loadErrorText(err), '棋谱数据异常：棋谱为空');
});
