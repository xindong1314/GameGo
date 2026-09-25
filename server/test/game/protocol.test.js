'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMessage, TYPES } = require('../../src/ws/protocol');
const { buildSettings } = require('../../src/game/settings');

function bad(msg) {
  const r = parseMessage(msg);
  assert.equal(r.ok, false, `应当拒绝：${JSON.stringify(msg)}`);
  assert.equal(r.err.code, 'bad_request');
  return r;
}

test('协议：所有消息类型都有定义', () => {
  assert.deepEqual([...TYPES].sort(), [
    'ai.start',
    'game.move',
    'game.pass',
    'game.resign',
    'game.score.accept',
    'game.score.resume',
    'game.score.toggle',
    'game.sync',
    'game.undo',
    'hello',
    'match.cancel',
    'match.join',
    'ping',
    'room.create',
    'room.get',
    'room.join',
    'room.leave',
  ]);
});

test('协议：合法消息只保留声明的参数', () => {
  assert.deepEqual(parseMessage({ t: 'hello', rid: 1, extra: 'x' }), { ok: true, t: 'hello', rid: 1, params: {} });
  assert.deepEqual(parseMessage({ t: 'ping' }), { ok: true, t: 'ping', rid: undefined, params: {} });
  assert.deepEqual(parseMessage({ t: 'game.move', rid: 7, gameId: 'abcdefghij12', n: 1, idx: 360 }).params, {
    gameId: 'abcdefghij12',
    n: 1,
    idx: 360,
  });
  assert.deepEqual(parseMessage({ t: 'ai.start', rid: 0, size: 19, level: 'd1', color: 'random' }).params, {
    size: 19,
    level: 'd1',
    color: 'random',
  });
  assert.equal(parseMessage({ t: 'room.get', rid: 1, code: '012345' }).ok, true);
  assert.equal(parseMessage({ t: 'game.score.accept', rid: 1, gameId: 'abcdefghij12', version: 3 }).ok, true);
  // game.score.toggle 的 version 可选（FS-2）：不带时 params 里没有，带了就原样给出
  assert.deepEqual(parseMessage({ t: 'game.score.toggle', rid: 1, gameId: 'abcdefghij12', idx: 10 }).params, { gameId: 'abcdefghij12', idx: 10 });
  assert.deepEqual(parseMessage({ t: 'game.score.toggle', rid: 1, gameId: 'abcdefghij12', idx: 10, version: 4 }).params, {
    gameId: 'abcdefghij12',
    idx: 10,
    version: 4,
  });
});

test('协议：消息本身不合法', () => {
  assert.equal(bad(null).rid, undefined);
  assert.equal(bad([1, 2]).rid, undefined);
  assert.equal(bad('hello').rid, undefined);
  assert.equal(bad({ rid: 3 }).rid, 3);
  assert.equal(bad({ t: 5, rid: 3 }).rid, 3);
  assert.equal(bad({ t: 'x'.repeat(40), rid: 3 }).rid, 3);
  assert.match(bad({ t: 'game.teleport', rid: 3 }).err.msg, /未知/);
  assert.match(bad({ t: 'constructor', rid: 3 }).err.msg, /未知/);
  assert.match(bad({ t: '__proto__', rid: 3 }).err.msg, /未知/);
});

test('协议：rid 必须是非负整数；能带回的原样带回', () => {
  assert.equal(bad({ t: 'hello', rid: -1 }).rid, -1);
  assert.equal(bad({ t: 'hello', rid: 1.5 }).rid, 1.5);
  assert.equal(bad({ t: 'hello', rid: 'abc' }).rid, 'abc');
  assert.equal(bad({ t: 'hello', rid: { a: 1 } }).rid, undefined);
  assert.equal(bad({ t: 'hello', rid: 'x'.repeat(100) }).rid, undefined);
});

test('协议：参数类型与范围', () => {
  bad({ t: 'match.join', rid: 1 });
  bad({ t: 'match.join', rid: 1, size: '9' });
  bad({ t: 'match.join', rid: 1, size: 10 });
  bad({ t: 'room.create', rid: 1, size: 9, color: 'BLACK' });
  bad({ t: 'room.create', rid: 1, size: 9 });
  bad({ t: 'room.get', rid: 1, code: 123456 });
  bad({ t: 'room.join', rid: 1, code: '12345' });
  bad({ t: 'room.join', rid: 1, code: '1234567' });
  bad({ t: 'room.join', rid: 1, code: '12a456' });
  bad({ t: 'ai.start', rid: 1, size: 9, color: 'black', level: '' });
  bad({ t: 'ai.start', rid: 1, size: 9, color: 'black', level: 'a b' });
  bad({ t: 'ai.start', rid: 1, size: 9, color: 'black', level: 5 });
  bad({ t: 'game.sync', rid: 1, gameId: 'ABCDEFGHIJ12' });
  bad({ t: 'game.sync', rid: 1, gameId: 'short' });
  bad({ t: 'game.sync', rid: 1 });
  const g = 'abcdefghij12';
  bad({ t: 'game.move', rid: 1, gameId: g, n: 0, idx: 1 });
  bad({ t: 'game.move', rid: 1, gameId: g, n: 1, idx: 361 });
  bad({ t: 'game.move', rid: 1, gameId: g, n: 1, idx: -1 });
  bad({ t: 'game.move', rid: 1, gameId: g, n: 1.5, idx: 1 });
  bad({ t: 'game.move', rid: 1, gameId: g, n: '1', idx: 1 });
  bad({ t: 'game.move', rid: 1, gameId: g, n: 1 });
  bad({ t: 'game.pass', rid: 1, gameId: g });
  bad({ t: 'game.score.toggle', rid: 1, gameId: g, idx: NaN });
  bad({ t: 'game.score.toggle', rid: 1, gameId: g, idx: 3, version: '3' });
  bad({ t: 'game.score.toggle', rid: 1, gameId: g, idx: 3, version: null });
  bad({ t: 'game.score.accept', rid: 1, gameId: g, version: -1 });
  bad({ t: 'game.score.accept', rid: 1, gameId: g });
  const r = bad({ t: 'game.move', rid: 9, gameId: g, n: 1, idx: 'x' });
  assert.equal(r.rid, 9);
  assert.equal(r.err.extra.field, 'idx');
});

test('设置：缺省用默认值，给了但不合法直接报错', () => {
  const s = buildSettings({});
  assert.equal(s.komi, 7.5);
  assert.deepEqual(s.timeControls[19], { mainMs: 600000, periods: 3, periodMs: 30000 });
  assert.equal(s.abandonMs, 90000);
  assert.equal(s.minMovesRanked, 10);
  assert.equal(s.publicBaseUrl, '');
  assert.deepEqual(s.sizes, [9, 13, 19]);
  assert.equal(buildSettings({ publicBaseUrl: 'https://x.com///' }).publicBaseUrl, 'https://x.com');
  assert.equal(buildSettings({ minMovesRanked: 0 }).minMovesRanked, 0);
  assert.throws(() => buildSettings({ abandonMs: 0 }), TypeError);
  assert.throws(() => buildSettings({ abandonMs: -5 }), TypeError);
  assert.throws(() => buildSettings({ komi: 'x' }), TypeError);
  assert.throws(() => buildSettings({ timeControls: { 9: { mainMs: 0, periods: 0, periodMs: 0 } } }), TypeError);
  assert.throws(() => buildSettings({ aiRetryDelaysMs: [1, -1] }), TypeError);
  assert.ok(Object.isFrozen(s));
});
