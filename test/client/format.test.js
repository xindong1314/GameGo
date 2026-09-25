'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const f = require('../../miniprogram/utils/format');

test('formatWinrate', () => {
  assert.equal(f.formatWinrate(0.6234), '62.3%');
  assert.equal(f.formatWinrate(0), '0.0%');
  assert.equal(f.formatWinrate(1), '100.0%');
  assert.equal(f.formatWinrate(0.5, 0), '50%');
  assert.equal(f.formatWinrate(0.12345, 2), '12.35%');
  assert.equal(f.formatWinrate(null), '--');
  assert.equal(f.formatWinrate(NaN), '--');
  assert.equal(f.formatWinrate('0.5'), '--');
});

test('formatDuration', () => {
  assert.equal(f.formatDuration(0), '00:00');
  assert.equal(f.formatDuration(999), '00:00');
  assert.equal(f.formatDuration(5 * 60000 + 7000), '05:07');
  assert.equal(f.formatDuration(3600000 + 2 * 60000 + 3000), '1:02:03');
  assert.equal(f.formatDuration(-5), '00:00');
  assert.equal(f.formatDuration(undefined), '00:00');
});

test('formatWaited', () => {
  assert.equal(f.formatWaited(35400), '35 秒');
  assert.equal(f.formatWaited(125000), '2 分 05 秒');
  assert.equal(f.formatWaited(null), '0 秒');
});

test('formatDate：今年省略年份，往年带年份（本地时区）', () => {
  const now = new Date(2026, 8, 25, 20, 0).getTime();
  assert.equal(f.formatDate(new Date(2026, 8, 25, 14, 3).getTime(), now), '09-25 14:03');
  assert.equal(f.formatDate(new Date(2026, 0, 2, 3, 4).getTime(), now), '01-02 03:04');
  assert.equal(f.formatDate(new Date(2025, 11, 31, 23, 59).getTime(), now), '2025-12-31 23:59');
  assert.equal(f.formatDate(0, now), '');
  assert.equal(f.formatDate(null, now), '');
  assert.equal(f.formatDate('x'), '');
  // 默认 now 为当前时间
  assert.match(f.formatDate(Date.now()), /^\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('resultForMe / myResultOf：Result 对象', () => {
  const win = { winner: 1, reason: 'score', black: 190, white: 171 };
  assert.equal(f.resultForMe(win, 1), '胜');
  assert.equal(f.resultForMe(win, 2), '负');
  assert.equal(f.resultForMe({ winner: 2, reason: 'resign' }, 2), '胜');
  assert.equal(f.resultForMe({ winner: 0, reason: 'score' }, 1), '和');
  assert.equal(f.resultForMe({ winner: 0, reason: 'abort' }, 1), '作废');
  assert.equal(f.resultForMe({ winner: 1, reason: 'abort' }, 1), '作废');
  assert.equal(f.resultForMe(null, 1), '');
  assert.equal(f.resultForMe(win, null), ''); // 旁观者无法判断
  assert.equal(f.myResultOf(win, 1), 'win');
  assert.equal(f.myResultOf({ winner: 3 }, 1), '');
});

test('resultForMe：GameSummary.myResult 字符串', () => {
  assert.equal(f.resultForMe('win'), '胜');
  assert.equal(f.resultForMe('loss'), '负');
  assert.equal(f.resultForMe('draw'), '和');
  assert.equal(f.resultForMe('void'), '作废');
  assert.equal(f.resultForMe('other'), '');
  assert.equal(f.myResultOf('loss'), 'loss');
});

test('sizeLabel / colorLabel / modeLabel', () => {
  assert.equal(f.sizeLabel(19), '19路');
  assert.equal(f.sizeLabel('9'), '9路');
  assert.equal(f.sizeLabel(0), '');
  assert.equal(f.sizeLabel('abc'), '');
  assert.equal(f.colorLabel(1), '黑');
  assert.equal(f.colorLabel('white'), '白');
  assert.equal(f.colorLabel('random'), '随机');
  assert.equal(f.colorLabel(3), '');
  assert.equal(f.modeLabel('ranked'), '排位赛');
  assert.equal(f.modeLabel('friend'), '好友对局');
  assert.equal(f.modeLabel('ai'), '人机对局');
  assert.equal(f.modeLabel('x'), '');
});

test('formatPoints / leaderboardValue', () => {
  assert.equal(f.formatPoints(184), '184');
  assert.equal(f.formatPoints(3.5), '3.5');
  assert.equal(f.formatPoints(0.30000000000000004), '0.3');
  assert.equal(f.formatPoints(null), '');
  assert.equal(f.leaderboardValue('streak', 5), '5 连胜');
  assert.equal(f.leaderboardValue('maxStreak', 12), '12 连胜');
  assert.equal(f.leaderboardValue('winrate', 0.625), '62.5%');
  assert.equal(f.leaderboardValue('winrate', null), '--');
  assert.equal(f.leaderboardValue('streak', undefined), '--');
  assert.deepEqual(f.LEADERBOARD_TYPES, ['streak', 'maxStreak', 'winrate']);
});

test('initialOf / avatarColor', () => {
  assert.equal(f.initialOf('棋圣'), '棋');
  assert.equal(f.initialOf('  alice'), 'A');
  assert.equal(f.initialOf('😀abc'), '😀');
  assert.equal(f.initialOf(''), '?');
  assert.equal(f.initialOf(null), '?');
  assert.equal(f.avatarColor('棋圣'), f.avatarColor('棋圣'));
  assert.match(f.avatarColor(''), /^#[0-9a-f]{6}$/);
});

test('errorText：中文 msg 优先，其次按错误码翻译', () => {
  assert.equal(f.errorText({ code: 'in_game', msg: 'already in game' }), '你有一局对局正在进行');
  assert.equal(f.errorText({ code: 'bad_request', msg: '昵称需为 1~16 个字符' }), '昵称需为 1~16 个字符');
  assert.equal(f.errorText({ code: 'illegal', msg: 'illegal move: ko' }), '打劫，暂不能回提');
  assert.equal(f.errorText({ code: 'illegal', msg: 'suicide' }), '禁止自杀');
  assert.equal(f.errorText({ code: 'illegal', msg: '' }), '此处不能落子');
  assert.equal(f.errorText({ code: 'weird', msg: 'something odd' }), 'something odd');
  assert.equal(f.errorText({ code: 'weird' }), '操作失败，请重试');
  assert.equal(f.errorText(new Error('boom'), 'x'), 'boom');
  assert.equal(f.errorText(null, '失败'), '失败');
  assert.equal(f.errorText('直接的文字'), '直接的文字');
  assert.equal(f.errorText({ code: 'offline', msg: 'x' }), '未连接到服务器，请稍后再试');
});
