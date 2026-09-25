'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLogger, silentLogger } = require('../../src/logger');
const engine = require('../../src/engine');
const {
  publicUser,
  playerInfo,
  aiPlayerInfo,
  avatarUrl,
  publicStats,
  AVATAR_FILE_RE,
} = require('../../src/util/public-user');

function sink() {
  const lines = [];
  return { lines, write: (s) => lines.push(s) };
}

test('createLogger：带时间戳与级别，按级别过滤，warn/error 写 stderr', () => {
  const out = sink();
  const err = sink();
  const clock = () => new Date(Date.UTC(2026, 8, 25, 1, 2, 3, 4));
  const log = createLogger({ level: 'info', stdout: out, stderr: err, clock });
  log.debug('不应输出');
  log.info('你好 %s %d', 'a', 5);
  log.warn('警告');
  log.error('错误', new Error('boom'));
  assert.equal(out.lines.length, 1);
  assert.equal(out.lines[0], '2026-09-25T01:02:03.004Z INFO  你好 a 5\n');
  assert.equal(err.lines.length, 2);
  assert.match(err.lines[0], /^2026-09-25T01:02:03\.004Z WARN  警告\n$/);
  assert.match(err.lines[1], /ERROR 错误 Error: boom/);
  assert.match(err.lines[1], /misc\.test\.js/); // 带堆栈

  const dbg = sink();
  createLogger({ level: 'debug', stdout: dbg, stderr: dbg }).debug('x');
  assert.equal(dbg.lines.length, 1);
  const e = sink();
  const quiet = createLogger({ level: 'error', stdout: e, stderr: e });
  quiet.warn('w');
  quiet.info('i');
  quiet.error('only');
  assert.equal(e.lines.length, 1);
  assert.equal(createLogger({ level: 'WARN' }).level, 'warn');
  assert.equal(createLogger().level, 'info');
});

test('createLogger：未知级别抛错；输出流异常不影响调用方', () => {
  assert.throws(() => createLogger({ level: 'verbose' }), /未知的日志级别/);
  const log = createLogger({
    stdout: {
      write() {
        throw new Error('closed');
      },
    },
  });
  assert.doesNotThrow(() => log.info('x'));
});

test('silentLogger 什么都不输出', () => {
  for (const k of ['debug', 'info', 'warn', 'error']) assert.equal(silentLogger[k]('x'), undefined);
});

test('engine.js：按模块与扁平两种方式导出共用引擎', () => {
  for (const ns of ['board', 'rules', 'game', 'score', 'coords', 'record']) assert.ok(engine[ns], ns);
  assert.equal(engine.BLACK, 1);
  assert.equal(engine.WHITE, 2);
  assert.equal(engine.PASS, -1);
  assert.equal(typeof engine.createGame, 'function');
  assert.equal(engine.game.createGame, engine.createGame);
  assert.equal(engine.record.replay, engine.replay);
  assert.equal(engine.coords.idxToGtp(0, 19), 'A19');
  assert.equal(engine.scoreArea, engine.score.scoreArea);
  assert.equal(engine.toggleDead, engine.score.toggleDead);

  // score 既可调用也是命名空间
  const s = engine.replay(9, 7.5, [40, -1, -1]);
  assert.equal(s.status, 'scoring');
  const a = engine.score(s.board, 7.5);
  const b = engine.score.score(s.board, 7.5);
  assert.deepEqual(a, b);
  assert.equal(a.black, 81);
  const area = engine.score.scoreArea(s.board, 7.5, [40]);
  assert.deepEqual(area.dead, [40]);
  assert.equal(engine.resultText({ winner: 1, reason: 'resign' }), 'B+R');
});

test('publicUser / playerInfo：只暴露 id、昵称、头像地址', () => {
  const u = { id: 7, openid: 'secret-openid', nickname: '小明', avatar: 'abc123.png', createdAt: 1, lastLoginAt: 2 };
  assert.deepEqual(publicUser(u, 'https://go.example.com/'), {
    id: 7,
    nickname: '小明',
    avatarUrl: 'https://go.example.com/avatars/abc123.png',
  });
  assert.deepEqual(playerInfo(u, 'https://go.example.com'), {
    userId: 7,
    nickname: '小明',
    avatarUrl: 'https://go.example.com/avatars/abc123.png',
  });
  assert.deepEqual(publicUser({ ...u, avatar: '', nickname: '' }, 'https://x'), { id: 7, nickname: '', avatarUrl: '' });
  assert.throws(() => publicUser(null, 'x'), TypeError);
  assert.throws(() => playerInfo(undefined, 'x'), TypeError);
  assert.equal(avatarUrl('', 'https://x'), '');
  assert.equal(avatarUrl('a.jpg', ''), '/avatars/a.jpg');
});

test('aiPlayerInfo 与 publicStats', () => {
  assert.deepEqual(aiPlayerInfo('k5', '5级'), { ai: true, level: 'k5', nickname: 'AI · 5级', avatarUrl: '' });
  assert.deepEqual(aiPlayerInfo('k5'), { ai: true, level: 'k5', nickname: 'AI · k5', avatarUrl: '' });
  assert.deepEqual(aiPlayerInfo(null), { ai: true, level: '', nickname: 'AI', avatarUrl: '' });
  assert.deepEqual(publicStats({ games: 4, wins: 3, losses: 1, draws: 0, curStreak: 2, maxStreak: 3, curStreakAt: 5 }), {
    games: 4,
    wins: 3,
    losses: 1,
    draws: 0,
    winrate: 0.75,
    curStreak: 2,
    maxStreak: 3,
  });
  assert.deepEqual(publicStats(null), { games: 0, wins: 0, losses: 0, draws: 0, winrate: 0, curStreak: 0, maxStreak: 0 });
});

test('头像文件名规则', () => {
  for (const ok of ['abc.png', '0a9f.jpg', 'a1.png']) assert.ok(AVATAR_FILE_RE.test(ok), ok);
  for (const bad of ['ABC.png', 'a.jpeg', 'a.gif', '../a.png', 'a/b.png', '.png', 'a.png.png', 'a_b.png', 'a.PNG']) {
    assert.ok(!AVATAR_FILE_RE.test(bad), bad);
  }
});
