'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const childProcess = require('node:child_process');
const { KataGoEngine } = require('../../src/ai/katago');
const { captureLogger, waitFor, rejectsWith } = require('./helpers');

// 用 fixtures/fake-katago.js（一个说 KataGo 分析协议的 node 小脚本）测进程管理：
// 就绪、按 id 匹配、warning/中间结果/错误、超时与 terminate、崩溃重启与退避、启动失败、卡死、关闭。

const FAKE = path.join(__dirname, 'fixtures', 'fake-katago.js');

// perStart(n) → 第 n 次启动（从 1 数）额外的环境变量
function makeEngine(t, { env = {}, perStart, ...opts } = {}) {
  const logger = captureLogger();
  let starts = 0;
  const spawnTimes = [];
  const spawn = (cmd, args, options) => {
    starts += 1;
    spawnTimes.push(Date.now());
    const extra = perStart ? perStart(starts) : {};
    return childProcess.spawn(cmd, args, { ...options, env: { ...options.env, ...extra } });
  };
  const eng = new KataGoEngine({
    path: process.execPath,
    argsPrefix: [FAKE],
    model: 'fake-model.bin.gz',
    config: 'fake.cfg',
    env: { ...process.env, ...env },
    logger,
    spawn,
    backoffInitialMs: 40,
    backoffMaxMs: 200,
    startupTimeoutMs: 5000,
    shutdownGraceMs: 500,
    killWaitMs: 500,
    slowRetryMs: 300,
    ...opts,
  });
  t.after(() => eng.shutdown());
  return { eng, logger, spawnTimes, starts: () => starts };
}

test('katago: 启动就绪、命令行参数、按 id 匹配乱序返回的结果', async (t) => {
  const { eng, logger } = makeEngine(t);
  assert.equal(eng.state, 'idle');
  assert.equal(eng.available(), true);
  await eng.start();
  assert.equal(eng.state, 'ready');
  assert.equal(eng.isReady(), true);
  assert.ok(eng.pid > 0);
  assert.ok(logger.logs.debug.some((l) => l.includes('Started, ready to begin handling requests')), 'stderr 按 debug 记录');
  assert.ok(logger.logs.debug.some((l) => l.includes('analysis -config fake.cfg -model fake-model.bin.gz')));

  // 慢的先发、快的后发：结果按 id 各归各位
  const slow = eng.query({ tag: 'slow', moves: [['B', 'D4']], fake: { delayMs: 150 } });
  const fast = eng.query({ tag: 'fast', fake: { delayMs: 10 } });
  const [a, b] = await Promise.all([slow, fast]);
  assert.equal(a.echo.tag, 'slow');
  assert.equal(a.turnNumber, 1);
  assert.equal(b.echo.tag, 'fast');
  assert.notEqual(a.id, b.id);
  assert.equal(typeof a.id, 'string', 'id 必须是字符串');

  // action 请求也按 id 返回
  const v = await eng.query({ action: 'query_version' });
  assert.equal(v.version, 'fake');
  // start() 在已就绪时直接 resolve
  await eng.start();
  assert.equal(eng.stats.starts, 1);
});

test('katago: 未调用 start 时第一次 query 自动启动，请求排队到就绪后发送', async (t) => {
  const { eng } = makeEngine(t, { env: { FAKE_KATAGO_STARTUP_DELAY_MS: '150' } });
  const r = await eng.query({ tag: 'lazy' });
  assert.equal(r.echo.tag, 'lazy');
  assert.equal(eng.stats.starts, 1);
});

test('katago: warning 与 isDuringSearch 中间结果被忽略，非 JSON 输出被忽略', async (t) => {
  const { eng, logger } = makeEngine(t);
  await eng.start();
  const r = await eng.query({ tag: 'x', fake: { warning: true, partial: 3, garbage: true } });
  assert.equal(r.echo.tag, 'x');
  assert.equal(r.isDuringSearch, false);
  assert.ok(logger.logs.debug.some((l) => l.includes('KataGo 警告') && l.includes('fooBar')));
  assert.ok(logger.logs.debug.some((l) => l.includes('非 JSON')));
  assert.deepEqual(logger.logs.warn, []);
});

test('katago: 带 id 的错误响应 → reject（katago_error，带原始消息）', async (t) => {
  const { eng } = makeEngine(t);
  await eng.start();
  const err = await rejectsWith(eng.query({ fake: { error: 'Illegal move 1: E5', field: 'moves' } }));
  assert.equal(err.code, 'katago_error');
  assert.match(err.message, /Illegal move 1: E5/);
  assert.match(err.message, /moves/);
  assert.equal(err.katago.error, 'Illegal move 1: E5');
  // 进程不受影响
  assert.equal((await eng.query({ tag: 'after' })).echo.tag, 'after');
});

test('katago: 没有 id 的错误只记日志，请求靠超时结束并发送 terminate', async (t) => {
  const { eng, logger } = makeEngine(t);
  await eng.start();
  const err = await rejectsWith(eng.query({ fake: { idless: true } }, { timeoutMs: 150 }));
  assert.equal(err.code, 'timeout');
  assert.ok(logger.logs.warn.some((l) => l.includes('没有 id') && l.includes('some error without id')));
  const s = await eng.query({ fake: { stats: true } });
  assert.equal(s.stats.actions.filter((a) => a.action === 'terminate').length, 1);
});

test('katago: 单请求超时 → reject 并对该 id 发 terminate，迟到的结果被安静丢弃', async (t) => {
  const { eng, logger } = makeEngine(t);
  await eng.start();
  const hung = eng.query({ fake: { hang: true } }, { timeoutMs: 120 });
  const err = await rejectsWith(hung);
  assert.equal(err.code, 'timeout');
  assert.match(err.message, /超时/);
  const s = await eng.query({ fake: { stats: true } });
  const term = s.stats.actions.filter((a) => a.action === 'terminate');
  assert.equal(term.length, 1);
  assert.match(term[0].terminateId, /^q\d+$/);
  // fake 对被 terminate 的请求回了 noResults：只记 debug
  await waitFor(() => logger.logs.debug.some((l) => l.includes('迟到')), { what: '迟到结果日志' });
  assert.ok(!logger.logs.warn.some((l) => l.includes('报错')));
  assert.equal(eng.stats.timeouts, 1);
  assert.equal(eng.isReady(), true, '一次超时不会重启进程');
  assert.equal(eng.stats.starts, 1);
});

test('katago: 进程崩溃 → 进行中的请求 reject，自动重启后继续可用', async (t) => {
  const { eng, logger } = makeEngine(t);
  await eng.start();
  const pid1 = eng.pid;
  const waiting = eng.query({ fake: { hang: true } }, { timeoutMs: 5000 });
  const crash = eng.query({ fake: { crash: 3 } }, { timeoutMs: 5000 });
  const [e1, e2] = await Promise.all([rejectsWith(waiting), rejectsWith(crash)]);
  assert.equal(e1.code, 'katago_error');
  assert.match(e1.message, /进程已退出（退出码 3）/);
  assert.equal(e2.code, 'katago_error');
  assert.equal(eng.available(), true, '重启期间仍视为可用');
  assert.ok(logger.logs.warn.some((l) => l.includes('意外退出')));

  // 重启期间发的请求排队，就绪后照常完成
  const r = await eng.query({ tag: 'after-crash' });
  assert.equal(r.echo.tag, 'after-crash');
  assert.notEqual(eng.pid, pid1);
  assert.equal(eng.stats.crashes, 1);
  assert.equal(eng.stats.starts, 2);
});

test('katago: 连续崩溃时重启间隔指数增长（有上限）', async (t) => {
  const { eng, spawnTimes } = makeEngine(t, { backoffInitialMs: 60, backoffMaxMs: 240 });
  const delays = [];
  eng.on('exit', (e) => delays.push(e.restartInMs));
  await eng.start();
  for (let i = 0; i < 4; i++) {
    await rejectsWith(eng.query({ fake: { crash: 1 } }, { timeoutMs: 5000 }));
    await waitFor(() => eng.isReady(), { what: `第 ${i + 1} 次重启` });
  }
  assert.deepEqual(delays, [60, 120, 240, 240]);
  // 实际间隔不小于退避值
  for (let i = 1; i < spawnTimes.length; i++) assert.ok(spawnTimes[i] - spawnTimes[i - 1] >= delays[i - 1] - 5);
});

test('katago: 连续启动失败 → 退避重试，达到上限后标记不可用，慢速重试成功后恢复', async (t) => {
  // 前 3 次启动失败，第 4 次成功；上限 2 次
  const { eng, logger } = makeEngine(t, {
    perStart: (n) => ({ FAKE_KATAGO_FAIL_START: n <= 3 ? '1' : '0' }),
    maxStartupFailures: 2,
    slowRetryMs: 250,
  });
  const unavailableEvents = [];
  eng.on('unavailable', () => unavailableEvents.push(Date.now()));

  const first = await rejectsWith(eng.start());
  assert.equal(first.code, 'ai_unavailable');
  assert.match(first.message, /启动失败/);
  assert.ok(first.stderr.some((l) => l.includes('fake startup failure')), '错误里带 stderr 末尾');
  assert.equal(eng.available(), true, '第 1 次失败后仍在重试，视为可用');

  // 排队中的请求在标记不可用时立即失败
  const qErr = await rejectsWith(eng.query({ tag: 'queued' }, { timeoutMs: 5000 }));
  assert.equal(qErr.code, 'ai_unavailable');
  assert.equal(eng.available(), false);
  assert.equal(unavailableEvents.length, 1);
  assert.ok(logger.logs.error.some((l) => l.includes('标记为不可用')));

  // 不可用期间的新请求直接失败
  assert.equal((await rejectsWith(eng.query({ tag: 'x' }))).code, 'ai_unavailable');

  // 慢速重试：第 3 次仍失败，第 4 次成功 → 恢复可用
  await waitFor(() => eng.isReady(), { timeoutMs: 5000, what: '慢速重试后就绪' });
  assert.equal(eng.available(), true);
  assert.equal(eng.stats.startupFailures, 3);
  assert.equal(eng.stats.starts, 4);
  assert.ok(logger.logs.info.some((l) => l.includes('恢复可用')));
  assert.equal((await eng.query({ tag: 'back' })).echo.tag, 'back');
});

test('katago: 启动超时（一直没有就绪行）→ 杀掉进程，计为启动失败', async (t) => {
  const { eng } = makeEngine(t, {
    env: { FAKE_KATAGO_NEVER_READY: '1' },
    startupTimeoutMs: 200,
    maxStartupFailures: 1,
    slowRetryMs: 60000,
  });
  const exits = [];
  eng.on('exit', (e) => exits.push(e));
  const err = await rejectsWith(eng.start());
  assert.match(err.message, /200ms 内没有就绪/);
  assert.equal(eng.available(), false);
  assert.equal(exits.length, 1);
  assert.equal(exits[0].ready, false);
  assert.equal(eng.pid, undefined, '进程已被杀掉');
});

test('katago: 可执行文件不存在 → 立即标记不可用，不抛出、不崩溃', async (t) => {
  const logger = captureLogger();
  const eng = new KataGoEngine({
    path: path.join(__dirname, 'fixtures', 'no-such-katago.exe'),
    model: 'm',
    config: 'c',
    logger,
    slowRetryMs: 60000,
  });
  t.after(() => eng.shutdown());
  const err = await rejectsWith(eng.start());
  assert.equal(err.code, 'ai_unavailable');
  assert.equal(eng.available(), false);
  assert.equal((await rejectsWith(eng.query({}))).code, 'ai_unavailable');
});

test('katago: 进程卡死（不再有任何输出）→ 连续超时后杀掉重启', async (t) => {
  const { eng, logger } = makeEngine(t, { hangTimeouts: 2 });
  await eng.start();
  const pid1 = eng.pid;
  const first = rejectsWith(eng.query({ fake: { freeze: true } }, { timeoutMs: 100 }));
  const second = rejectsWith(eng.query({ tag: 'never answered' }, { timeoutMs: 150 }));
  assert.equal((await first).code, 'timeout');
  assert.equal((await second).code, 'timeout');
  assert.ok(logger.logs.warn.some((l) => l.includes('判定为卡死')));
  await waitFor(() => eng.isReady() && eng.pid !== pid1, { what: '卡死后重启' });
  assert.equal(eng.stats.hangs, 1);
  assert.equal((await eng.query({ tag: 'ok' })).echo.tag, 'ok');
});

test('katago: 只是忙（发出后仍有别的输出）时同一时刻一起超时的请求不算卡死，不杀进程', async (t) => {
  // 回归：以前只要两个超时之间没有输出就判定卡死。负载高时几个同时发出的请求在 KataGo 内部排队、
  // 在同一个定时器回调里一起超时（terminate 的回执还没来得及读到），健康的进程被杀，其他对局的搜索跟着失败。
  const { eng, logger } = makeEngine(t, { hangTimeouts: 2 });
  await eng.start();
  const pid1 = eng.pid;
  const busy = eng.query({ fake: { delayMs: 30 } }, { timeoutMs: 5000 }); // 发出 30ms 后有结果
  const a = rejectsWith(eng.query({ fake: { hang: true } }, { timeoutMs: 150 }));
  const b = rejectsWith(eng.query({ fake: { hang: true } }, { timeoutMs: 150 }));
  const c = rejectsWith(eng.query({ fake: { hang: true } }, { timeoutMs: 150 }));
  assert.equal((await busy).pid, pid1);
  for (const p of [a, b, c]) assert.equal((await p).code, 'timeout');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(eng.stats.timeouts, 3);
  assert.equal(eng.stats.hangs, 0);
  assert.ok(!logger.logs.warn.some((l) => l.includes('判定为卡死')));
  assert.equal(eng.pid, pid1);
  assert.equal((await eng.query({ tag: 'still alive' })).pid, pid1, '还是原来的进程');
  assert.equal(eng.stats.starts, 1);
});

test('katago: shutdown 关闭 stdin 等进程退出，进行中与之后的请求都 reject，可重复调用', async (t) => {
  const { eng } = makeEngine(t);
  await eng.start();
  const pending = rejectsWith(eng.query({ fake: { hang: true } }, { timeoutMs: 5000 }));
  const exited = new Promise((resolve) => eng.once('exit', resolve));
  const t0 = Date.now();
  const p1 = eng.shutdown();
  const p2 = eng.shutdown();
  assert.equal(p1, p2);
  const err = await pending;
  assert.equal(err.code, 'ai_unavailable');
  await p1;
  const info = await exited;
  assert.equal(info.code, 0, 'stdin 关闭后正常退出，不需要 kill');
  assert.ok(Date.now() - t0 < 450, '不必等到强制结束');
  assert.equal(eng.available(), false);
  assert.equal(eng.state, 'stopped');
  assert.equal((await rejectsWith(eng.query({}))).code, 'ai_unavailable');
  assert.equal((await rejectsWith(eng.start())).code, 'ai_unavailable');
});

test('katago: shutdown 时进程不肯退出 → 超过宽限时间后 kill', async (t) => {
  const { eng, logger } = makeEngine(t, { env: { FAKE_KATAGO_IGNORE_STDIN_END: '1' }, shutdownGraceMs: 200 });
  await eng.start();
  const t0 = Date.now();
  await eng.shutdown();
  const took = Date.now() - t0;
  assert.ok(took >= 190, `应等待宽限时间（${took}ms）`);
  assert.ok(took < 1500, `kill 后很快结束（${took}ms）`);
  assert.ok(logger.logs.warn.some((l) => l.includes('强制结束')));
  assert.equal(eng.pid, undefined);
});

test('katago: 启动中（未就绪）被 shutdown 也能结束', async (t) => {
  const { eng } = makeEngine(t, { env: { FAKE_KATAGO_NEVER_READY: '1' }, shutdownGraceMs: 100 });
  const started = rejectsWith(eng.start());
  const q = rejectsWith(eng.query({ tag: 'queued' }));
  await waitFor(() => eng.pid !== undefined, { what: '进程启动' });
  await eng.shutdown();
  assert.equal((await started).code, 'ai_unavailable');
  assert.equal((await q).code, 'ai_unavailable');
  assert.equal(eng.pid, undefined);
});

test('katago: 构造参数校验', () => {
  assert.throws(() => new KataGoEngine({ model: 'm', config: 'c' }), /path/);
  assert.throws(() => new KataGoEngine({ path: 'k', model: 'm', config: 'c', backoffInitialMs: -1 }), /backoffInitialMs/);
});
