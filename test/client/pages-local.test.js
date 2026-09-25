'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./pages-harness');

test('本地对弈：选择路数与贴目后进入 v1 对局页', () => {
  const env = h.createEnv();
  const page = h.loadPage('local/local', env);
  assert.equal(page.data.size, 19);
  assert.equal(page.data.komi, '7.5');
  page.onPickSize({ currentTarget: { dataset: { size: '9' } } });
  page.onKomiInput({ detail: { value: '6.5' } });
  page.onStart();
  assert.equal(env.wx.last('navigateTo').url, '/pages/game/game?size=9&komi=6.5');
});

test('本地对弈：贴目不是数字时提示', () => {
  const env = h.createEnv();
  const page = h.loadPage('local/local', env);
  page.onKomiInput({ detail: { value: 'abc' } });
  page.onStart();
  assert.deepEqual(env.wx.toasts(), ['贴目请输入数字']);
  assert.equal(env.wx.count('navigateTo'), 0);
});
