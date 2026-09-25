'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Emitter, createEmitter } = require('../../miniprogram/utils/net/emitter');
const { createLogger } = require('./wx-mock');

test('on / emit 传递参数，返回是否有监听器', () => {
  const e = createEmitter();
  const got = [];
  e.on('x', (a, b) => got.push([a, b]));
  assert.equal(e.emit('x', 1, 2), true);
  assert.equal(e.emit('y', 1), false);
  assert.deepEqual(got, [[1, 2]]);
  assert.ok(e instanceof Emitter);
});

test('on 返回的取消函数与 off 都能取消订阅', () => {
  const e = new Emitter();
  let a = 0;
  let b = 0;
  const fa = () => { a += 1; };
  const fb = () => { b += 1; };
  const unsubA = e.on('x', fa);
  e.on('x', fb);
  e.emit('x');
  unsubA();
  assert.equal(e.off('x', fb), true);
  assert.equal(e.off('x', fb), false);
  e.emit('x');
  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.equal(e.listenerCount('x'), 0);
});

test('once 只触发一次，也能用原函数 off 掉', () => {
  const e = new Emitter();
  let n = 0;
  const fn = () => { n += 1; };
  e.once('x', fn);
  e.emit('x');
  e.emit('x');
  assert.equal(n, 1);

  e.once('y', fn);
  assert.equal(e.off('y', fn), true);
  e.emit('y');
  assert.equal(n, 1);

  const unsub = e.once('z', fn);
  unsub();
  e.emit('z');
  assert.equal(n, 1);
});

test('监听器抛错不影响其他监听器，错误写入日志', () => {
  const logger = createLogger();
  const e = new Emitter({ logger });
  const got = [];
  e.on('x', () => { throw new Error('boom'); });
  e.on('x', () => got.push('ok'));
  e.emit('x');
  assert.deepEqual(got, ['ok']);
  assert.equal(logger.count('error'), 1);
});

test('分发过程中增删监听器不影响本轮', () => {
  const e = new Emitter();
  const got = [];
  const second = () => got.push('second');
  e.on('x', () => {
    got.push('first');
    e.off('x', second);
    e.on('x', () => got.push('third'));
  });
  e.on('x', second);
  e.emit('x');
  assert.deepEqual(got, ['first', 'second']);
  got.length = 0;
  e.emit('x');
  assert.deepEqual(got, ['first', 'third']);
});

test('参数校验：事件名与监听器必须合法；off 必须给出监听器', () => {
  const e = new Emitter();
  assert.throws(() => e.on('', () => {}), TypeError);
  assert.throws(() => e.on('x', null), TypeError);
  assert.throws(() => e.off('x'), TypeError);
  assert.throws(() => e.once('x', 1), TypeError);
});

test('clear 清空一个或全部事件', () => {
  const e = new Emitter();
  e.on('a', () => {});
  e.on('b', () => {});
  e.clear('a');
  assert.equal(e.listenerCount('a'), 0);
  assert.equal(e.listenerCount('b'), 1);
  e.clear();
  assert.equal(e.listenerCount('b'), 0);
});
