'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LEVELS, LEVEL_IDS, getLevel, kyuFor, publicLevels, SIZE_KYU_OFFSET, MAX_KYU } = require('../../src/ai/levels');

test('levels: 与设计文档 7.5 的难度表一致', () => {
  assert.deepEqual(
    LEVELS.map((l) => [l.id, l.name, l.kind, l.kyu]),
    [
      ['k18', '入门', 'rank', 18],
      ['k12', '初级', 'rank', 12],
      ['k8', '中级', 'rank', 8],
      ['k4', '中高级', 'rank', 4],
      ['k1', '高级', 'rank', 1],
      ['d3', '业余 3 段', 'rank', -2],
      ['d5', '业余高段', 'policy', undefined],
      ['max', '最强', 'search', undefined],
    ],
  );
  assert.equal(getLevel('d5').openingMoves, 22);
  assert.equal(getLevel('max').maxVisits, 300);
  assert.equal(getLevel('max').maxTimeSec, 8);
  assert.equal(getLevel('nope'), null);
  assert.equal(LEVEL_IDS.size, 8);
  assert.ok(Object.isFrozen(LEVELS) && Object.isFrozen(LEVELS[0]));
});

test('levels: 描述都注明 19 路的大致水平', () => {
  for (const l of LEVELS) {
    assert.match(l.desc, /19 路/, l.id);
    assert.ok(l.desc.length > 5 && l.name.length > 0);
  }
  assert.match(getLevel('k18').desc, /约 18 级/);
  assert.match(getLevel('k1').desc, /约 1 级/);
  assert.match(getLevel('d3').desc, /约业余 3 段/);
});

test('levels: publicLevels 只给 id/name/desc，且是副本', () => {
  const pub = publicLevels();
  assert.equal(pub.length, 8);
  for (const l of pub) assert.deepEqual(Object.keys(l), ['id', 'name', 'desc']);
  pub[0].name = 'changed';
  assert.equal(publicLevels()[0].name, '入门');
});

test('levels: 小棋盘的级位修正（13 路 +5，9 路 +10，上限 30）', () => {
  assert.deepEqual(SIZE_KYU_OFFSET, { 9: 10, 13: 5, 19: 0 });
  assert.equal(MAX_KYU, 30);
  assert.equal(kyuFor(getLevel('k8'), 19), 8);
  assert.equal(kyuFor(getLevel('k8'), 13), 13);
  assert.equal(kyuFor(getLevel('k8'), 9), 18);
  assert.equal(kyuFor(getLevel('d3'), 9), 8);
  assert.equal(kyuFor(getLevel('d3'), 13), 3);
  assert.equal(kyuFor(getLevel('k18'), 13), 23);
  assert.equal(kyuFor(getLevel('k18'), 9), 28);
  assert.equal(kyuFor({ id: 'weak', kind: 'rank', kyu: 25 }, 9), 30, '上限 30');
  assert.throws(() => kyuFor(getLevel('max'), 19), /不是 rank 档/);
});
