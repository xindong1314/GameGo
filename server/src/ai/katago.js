'use strict';
const childProcess = require('node:child_process');
const readline = require('node:readline');
const { EventEmitter } = require('node:events');
const { AiError, unavailable, SILENT } = require('./common');

// KataGoEngine：管理一个 `katago analysis -config <cfg> -model <model>` 子进程（设计文档 7.2 / 7.4）。
//
// - 协议：stdin 每行一个 JSON 请求，stdout 每行一个 JSON 响应（按字符串 id 匹配），stderr 只是日志
//   （只从中找就绪行 "Started, ready to begin handling requests"，其余按 debug 级别记录）。
// - 响应处理：warning 只记 debug；isDuringSearch 中间结果忽略；带 id 的 error → 该请求 reject；
//   没有 id 的 error（非法 JSON、未知 action）只能记日志，对应请求靠超时兜底；
//   noResults（被 terminate 的请求）→ reject。
// - 每个请求都有超时：到时发 {action:'terminate', terminateId} 并 reject。连续 hangTimeouts 个请求超时，
//   而且这些请求发出之后 stdout 再没有任何输出 → 认为进程卡死，杀掉重启。只是忙（请求在 KataGo 内部排队、
//   别的请求照常出结果）时的超时不算，否则会误杀正在为其他对局搜索的进程。
// - 进程退出（崩溃/被杀）→ 所有已发出的请求 reject，按指数退避（1s、2s、4s…最多 30s）自动重启；
//   进程稳定运行 stableMs 以上再退出时退避从 1s 重新开始。
// - 连续 maxStartupFailures 次启动失败（或可执行文件不存在等明显的配置错误）→ available() 变为 false，
//   排队中的请求立即失败，之后每 slowRetryMs 慢速重试一次，成功后恢复可用。
// - 进程未就绪（启动中、重启退避中）时请求先排队，就绪后再发送；排队时间计入该请求的超时。
// - shutdown()：发 terminate_all、关闭 stdin，等待退出，超时则 kill；主进程 'exit' 时也会杀掉所有仍存活的子进程。
//   （主进程被强杀时这些都来不及做，但 stdin 管道随之关闭，KataGo 会自己退出：Windows 实测空闲约 0.5 秒、搜索中约 1 秒。）
// - 任何 KataGo 问题都不会抛到调用方之外：不发 'error' 事件，流错误都已监听。
//
// 用法：
//   const eng = new KataGoEngine({ path, model, config, logger });
//   eng.start().catch(...)                      // 可选：提前启动；不调用时第一次 query 会自动启动
//   const res = await eng.query({ boardXSize: 9, ... }, { timeoutMs: 10000 });
//   eng.available() / eng.state / eng.stats
//   await eng.shutdown();
// query 不支持多于一项的 analyzeTurns 以外的多响应场景；analyzeTurns 有多项时 resolve 为按 turnNumber 排序的数组。
//
// 事件（仅供观察/测试，不含 'error'）：'spawn' {pid}、'ready' {pid}、'exit' {code, signal, ready, restartInMs}、'unavailable'。

const READY_LINE = 'Started, ready to begin handling requests';

const DEFAULTS = Object.freeze({
  startupTimeoutMs: 60000, // 从启动到出现就绪行的最长时间（大模型在慢机器上加载较慢）
  queryTimeoutMs: 30000, // query 未指定 timeoutMs 时的默认超时
  backoffInitialMs: 1000,
  backoffMaxMs: 30000,
  maxStartupFailures: 4, // 连续启动失败这么多次后标记为不可用（1+2+4 秒退避，约 10 秒内判定）
  slowRetryMs: 60000, // 标记不可用后的重试间隔
  stableMs: 60000, // 进程运行超过这么久再退出，退避从头开始
  shutdownGraceMs: 3000, // shutdown 时等待进程自行退出的时间，超时 kill
  killWaitMs: 3000, // kill 后等待退出的时间，超时 SIGKILL
  hangTimeouts: 2, // 连续这么多个请求超时、且它们发出后 stdout 再无任何输出 → 判定卡死并重启
  stderrTailLines: 30, // 启动失败时在日志里附上的 stderr 末尾行数
});

const FATAL_SPAWN_CODES = new Set(['ENOENT', 'EACCES', 'ENOEXEC', 'EPERM', 'EISDIR']);

// 所有存活的子进程；主进程退出时统一杀掉。只注册一个 'exit' 监听，避免每个实例各加一个。
const LIVE = new Set();
let exitHookInstalled = false;
function trackChild(child) {
  LIVE.add(child);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', () => {
      for (const c of LIVE) {
        try {
          c.kill();
        } catch {
          // 进程已不存在
        }
      }
    });
  }
}

function katagoError(msg) {
  const field = msg.field ? `（字段 ${msg.field}）` : '';
  return new AiError('katago_error', `KataGo 拒绝请求${field}：${msg.error}`, { katago: msg, field: msg.field });
}

class KataGoEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    const { path, model, config, args = [], argsPrefix = [], env, cwd, logger, spawn, ...tunables } = options;
    if (!path || !model || !config) throw new TypeError('KataGoEngine: 需要 path、model、config');
    this.path = path;
    this.model = model;
    this.config = config;
    this.args = args.slice();
    this.argsPrefix = argsPrefix.slice();
    this.env = env;
    this.cwd = cwd;
    this.logger = logger || SILENT;
    this.spawnFn = spawn || childProcess.spawn;
    this.opts = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
      if (tunables[k] !== undefined) {
        if (!Number.isFinite(tunables[k]) || tunables[k] < 0) throw new TypeError(`KataGoEngine: ${k} 必须是非负数`);
        this.opts[k] = tunables[k];
      }
    }

    this.state = 'idle'; // idle | starting | ready | waiting（退避中）| stopped
    this.gaveUp = false;
    this.run = null; // 当前（或最近一次）进程的运行记录
    this.queue = []; // 等待进程就绪的请求
    this.pending = new Map(); // 已发给当前进程、等待结果的请求
    this.terminated = new Set(); // 已超时并发了 terminate 的 id：迟到的结果安静丢弃
    this.seq = 0;
    this.startupFailures = 0;
    this.restartStreak = 0;
    this.consecutiveTimeouts = 0;
    this.outputSeq = 0; // 从 stdout 读到的行数（判断卡死用：请求发出后这个数有没有变）
    this.restartTimer = null;
    this.attemptWaiters = [];
    this.shutdownPromise = null;
    this.stats = { starts: 0, readies: 0, crashes: 0, startupFailures: 0, timeouts: 0, hangs: 0 };
  }

  get pid() {
    return this.run && this.run.child && !this.run.gone ? this.run.child.pid : undefined;
  }

  // 未关闭且没有因为反复启动失败而放弃。启动中 / 重启退避中也算可用（请求会排队等待就绪）。
  available() {
    return this.state !== 'stopped' && !this.gaveUp;
  }

  isReady() {
    return this.state === 'ready';
  }

  // 启动（已启动则等待当前这次启动的结果）。resolve：进程就绪；reject：这次启动失败（之后仍会自动重试）。
  start() {
    if (this.state === 'stopped') return Promise.reject(unavailable('KataGo 已关闭'));
    if (this.state === 'ready') return Promise.resolve();
    const p = new Promise((resolve, reject) => this.attemptWaiters.push({ resolve, reject }));
    if (this.state === 'idle') this._launch();
    return p;
  }

  // 发一个请求（分析请求或 action）。id 由这里分配，obj.id 会被覆盖。
  query(obj, { timeoutMs } = {}) {
    if (this.state === 'stopped') return Promise.reject(unavailable('KataGo 已关闭'));
    if (this.gaveUp) return Promise.reject(unavailable('KataGo 不可用（启动失败）'));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return Promise.reject(new TypeError('query 需要一个对象'));
    const ms = timeoutMs === undefined || timeoutMs === null ? this.opts.queryTimeoutMs : timeoutMs;
    if (!Number.isFinite(ms) || ms <= 0) return Promise.reject(new TypeError('timeoutMs 必须是正数'));
    const id = `q${++this.seq}`;
    let line;
    try {
      line = JSON.stringify({ ...obj, id });
    } catch (err) {
      return Promise.reject(err);
    }
    const expected = Array.isArray(obj.analyzeTurns) && obj.analyzeTurns.length > 1 ? obj.analyzeTurns.length : 1;
    return new Promise((resolve, reject) => {
      const entry = { id, line, expected, results: [], isAction: typeof obj.action === 'string', done: false, timer: null, resolve, reject };
      entry.timer = setTimeout(() => this._onTimeout(entry, ms), ms);
      if (this.state === 'idle') this._launch();
      if (this.state === 'ready') this._send(entry);
      else this.queue.push(entry);
    });
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.state = 'stopped';
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const err = unavailable('KataGo 已关闭');
    for (const e of this.queue.splice(0)) this._settle(e, err);
    for (const e of [...this.pending.values()]) this._settle(e, err);
    for (const w of this.attemptWaiters.splice(0)) w.reject(err);
    const run = this.run;
    this.shutdownPromise = new Promise((resolve) => {
      if (!run || run.gone || !run.child) {
        resolve();
        return;
      }
      const child = run.child;
      const { shutdownGraceMs, killWaitMs } = this.opts;
      const timers = [];
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        for (const t of timers) clearTimeout(t);
        resolve();
      };
      run.goneWaiters.push(finish);
      try {
        // 先中止所有进行中的搜索，再关闭 stdin：KataGo 处理完手头的请求后自行退出
        child.stdin.write(`${JSON.stringify({ id: 'shutdown', action: 'terminate_all' })}\n`);
        child.stdin.end();
      } catch {
        // stdin 已关闭，交给下面的 kill
      }
      timers.push(
        setTimeout(() => {
          this.logger.warn(`KataGo（pid ${child.pid}）没有在 ${shutdownGraceMs}ms 内退出，强制结束`);
          this._killChild(child);
        }, shutdownGraceMs),
      );
      timers.push(setTimeout(() => this._killChild(child, 'SIGKILL'), shutdownGraceMs + killWaitMs));
      // 无论如何不让关闭流程卡住
      timers.push(setTimeout(finish, shutdownGraceMs + 2 * killWaitMs));
    });
    return this.shutdownPromise;
  }

  // ---------- 进程管理 ----------

  _launch() {
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.state = 'starting';
    this.stats.starts++;
    const run = {
      child: null,
      ready: false,
      gone: false,
      startedAt: Date.now(),
      readyAt: 0,
      stderrTail: [],
      startupError: null,
      startupTimer: null,
      closeFallback: null,
      goneWaiters: [],
    };
    this.run = run;
    const args = [...this.argsPrefix, 'analysis', '-config', this.config, '-model', this.model, ...this.args];
    let child;
    try {
      child = this.spawnFn(this.path, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: this.env,
        cwd: this.cwd,
      });
    } catch (err) {
      run.startupError = err;
      this._onGone(run, { code: null, signal: null });
      return;
    }
    run.child = child;
    trackChild(child);
    this.logger.debug(`KataGo 启动中：${this.path} ${args.join(' ')}`);

    child.on('error', (err) => {
      if (!run.ready && !run.startupError) run.startupError = err;
      this.logger.warn(`KataGo 进程错误：${err.message}`);
      // 可执行文件不存在等情况下 'exit' 不一定会触发
      if (child.pid === undefined) this._onGone(run, { code: null, signal: null });
    });
    child.on('exit', (code, signal) => {
      // 优先等 'close'（stdout 读完）；个别情况下 'close' 不来，1 秒后兜底
      run.closeFallback = setTimeout(() => this._onGone(run, { code, signal }), 1000);
    });
    child.on('close', (code, signal) => this._onGone(run, { code, signal }));
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      if (stream) stream.on('error', (err) => this.logger.debug(`KataGo 管道错误：${err.message}`));
    }
    if (child.stdout) {
      readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
        if (this.run === run && !run.gone) this._onStdout(line);
      });
    }
    if (child.stderr) {
      readline.createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', (line) => this._onStderr(run, line));
    }
    run.startupTimer = setTimeout(() => {
      if (run.ready || run.gone) return;
      run.startupError = new Error(`${this.opts.startupTimeoutMs}ms 内没有就绪`);
      this._killChild(child);
    }, this.opts.startupTimeoutMs);
    if (child.pid !== undefined) this.emit('spawn', { pid: child.pid });
  }

  _killChild(child, signal) {
    try {
      child.kill(signal);
    } catch {
      // 进程已退出
    }
  }

  _onStderr(run, line) {
    if (!run.ready) {
      run.stderrTail.push(line);
      if (run.stderrTail.length > this.opts.stderrTailLines) run.stderrTail.shift();
      if (line.includes(READY_LINE)) this._onReady(run);
    }
    this.logger.debug(`[katago] ${line}`);
  }

  _onReady(run) {
    if (run.gone || this.run !== run || this.state === 'stopped') return;
    run.ready = true;
    run.readyAt = Date.now();
    clearTimeout(run.startupTimer);
    this.state = 'ready';
    this.startupFailures = 0;
    this.consecutiveTimeouts = 0;
    this.stats.readies++;
    if (this.gaveUp) {
      this.gaveUp = false;
      this.logger.info('KataGo 恢复可用');
    }
    this.logger.info(`KataGo 已就绪（pid ${run.child.pid}，启动用时 ${run.readyAt - run.startedAt}ms）`);
    for (const w of this.attemptWaiters.splice(0)) w.resolve();
    for (const e of this.queue.splice(0)) this._send(e);
    this.emit('ready', { pid: run.child.pid });
  }

  _onGone(run, { code, signal }) {
    if (run.gone) return;
    run.gone = true;
    clearTimeout(run.startupTimer);
    clearTimeout(run.closeFallback);
    if (run.child) LIVE.delete(run.child);
    for (const w of run.goneWaiters.splice(0)) w();
    if (this.run !== run) return;

    const how = signal ? `信号 ${signal}` : `退出码 ${code}`;
    this.terminated.clear();
    this.consecutiveTimeouts = 0;
    // 已发给这个进程的请求不会再有结果
    for (const e of [...this.pending.values()]) this._settle(e, new AiError('katago_error', `KataGo 进程已退出（${how}）`));

    if (this.state === 'stopped') {
      this.logger.info(`KataGo 已退出（${how}）`);
      this.emit('exit', { code, signal, ready: run.ready, restartInMs: null });
      return;
    }

    if (!run.ready) {
      this.startupFailures++;
      this.stats.startupFailures++;
      const reason = run.startupError ? run.startupError.message : `启动过程中退出（${how}）`;
      const err = new AiError('ai_unavailable', `KataGo 启动失败：${reason}`, { stderr: run.stderrTail.slice() });
      const tail = run.stderrTail.length ? `\n  ${run.stderrTail.join('\n  ')}` : '';
      this.logger.warn(`${err.message}（第 ${this.startupFailures} 次）${tail}`);
      for (const w of this.attemptWaiters.splice(0)) w.reject(err);
      const fatal = Boolean(run.startupError && FATAL_SPAWN_CODES.has(run.startupError.code));
      if (!this.gaveUp && (fatal || this.startupFailures >= this.opts.maxStartupFailures)) {
        this.gaveUp = true;
        this.logger.error(
          `KataGo 无法启动（连续 ${this.startupFailures} 次失败），AI 标记为不可用；之后每 ${Math.round(this.opts.slowRetryMs / 1000)} 秒重试一次`,
        );
        for (const e of this.queue.splice(0)) this._settle(e, unavailable('KataGo 不可用（启动失败）'));
        this.emit('unavailable');
      }
    } else {
      this.stats.crashes++;
      this.logger.warn(`KataGo 进程意外退出（${how}），将自动重启`);
      if (Date.now() - run.readyAt >= this.opts.stableMs) this.restartStreak = 0;
    }

    this.restartStreak++;
    const delay = this.gaveUp
      ? this.opts.slowRetryMs
      : Math.min(this.opts.backoffMaxMs, this.opts.backoffInitialMs * 2 ** (this.restartStreak - 1));
    this.state = 'waiting';
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.state === 'waiting') this._launch();
    }, delay);
    // 不因为等待重启而阻止进程退出（服务端有 HTTP 服务器保持运行）
    if (typeof this.restartTimer.unref === 'function') this.restartTimer.unref();
    this.emit('exit', { code, signal, ready: run.ready, restartInMs: delay });
  }

  // ---------- 请求 ----------

  _send(entry) {
    if (entry.done) return;
    entry.outputSeqAtSend = this.outputSeq;
    this.pending.set(entry.id, entry);
    this._writeLine(entry.line);
  }

  _writeLine(line) {
    const run = this.run;
    if (!run || run.gone || !run.child) return;
    try {
      run.child.stdin.write(`${line}\n`);
    } catch (err) {
      // 进程正在退出；已发出的请求会在退出处理里 reject
      this.logger.debug(`写入 KataGo 失败：${err.message}`);
    }
  }

  _settle(entry, err, value) {
    if (entry.done) return;
    entry.done = true;
    clearTimeout(entry.timer);
    this.pending.delete(entry.id);
    if (err) entry.reject(err);
    else entry.resolve(value);
  }

  _onTimeout(entry, ms) {
    if (entry.done) return;
    this.stats.timeouts++;
    const qi = this.queue.indexOf(entry);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      this._settle(entry, new AiError('timeout', `KataGo 在 ${ms}ms 内没有就绪`));
      return;
    }
    const sent = this.pending.has(entry.id);
    this._settle(entry, new AiError('timeout', `KataGo 请求超时（${ms}ms）`));
    if (!sent) return;
    this.logger.warn(`KataGo 请求 ${entry.id} 超时（${ms}ms）`);
    if (!entry.isAction) {
      this.terminated.add(entry.id);
      this._writeLine(JSON.stringify({ id: `t${++this.seq}`, action: 'terminate', terminateId: entry.id }));
    }
    // 只有"发出之后 KataGo 再也没有任何输出"的超时才算卡死的迹象。
    // 负载高时请求在 KataGo 内部排队，几个同时发出的请求会在同一时刻一起超时，
    // 但期间别的请求照常出结果——这不是卡死，不能因此杀掉进程（会连带杀掉其他对局正在进行的搜索）。
    if (this.outputSeq !== entry.outputSeqAtSend) return;
    this.consecutiveTimeouts++;
    const run = this.run;
    if (this.consecutiveTimeouts >= this.opts.hangTimeouts && run && !run.gone && run.child) {
      this.stats.hangs++;
      this.consecutiveTimeouts = 0;
      this.logger.warn(`KataGo 连续 ${this.opts.hangTimeouts} 个请求超时且没有任何输出，判定为卡死，重启进程`);
      this._killChild(run.child);
      const child = run.child;
      setTimeout(() => {
        if (!run.gone) this._killChild(child, 'SIGKILL');
      }, this.opts.killWaitMs).unref();
    }
  }

  _onStdout(line) {
    const text = line.trim();
    if (!text) return;
    this.outputSeq++;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      this.logger.debug(`KataGo 输出了非 JSON 内容：${text.slice(0, 200)}`);
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    this.consecutiveTimeouts = 0;

    const id = typeof msg.id === 'string' ? msg.id : null;
    if (id === null) {
      if (msg.error !== undefined) this.logger.warn(`KataGo 报错（没有 id，对应的请求将超时）：${msg.error}`);
      else this.logger.debug(`忽略没有 id 的 KataGo 输出：${text.slice(0, 200)}`);
      return;
    }
    const entry = this.pending.get(id);
    if (!entry) {
      if (this.terminated.has(id)) {
        if (msg.isDuringSearch !== true) this.terminated.delete(id);
        this.logger.debug(`丢弃已超时请求 ${id} 的迟到结果`);
      } else if (msg.error !== undefined) {
        this.logger.warn(`KataGo 报错（${id}）：${msg.error}`);
      } else {
        this.logger.debug(`忽略 KataGo 输出（id=${id}）`);
      }
      return;
    }
    if (msg.error !== undefined) {
      this._settle(entry, katagoError(msg));
      return;
    }
    if (msg.warning !== undefined) {
      this.logger.debug(`KataGo 警告（${id}${msg.field ? `，字段 ${msg.field}` : ''}）：${msg.warning}`);
      return;
    }
    if (entry.isAction) {
      this._settle(entry, null, msg);
      return;
    }
    if (msg.isDuringSearch === true) return;
    if (msg.noResults === true) {
      this._settle(entry, new AiError('katago_error', 'KataGo 没有返回结果（请求被中止）', { katago: msg }));
      return;
    }
    entry.results.push(msg);
    if (entry.results.length >= entry.expected) {
      const res = entry.expected === 1 ? entry.results[0] : entry.results.slice().sort((a, b) => a.turnNumber - b.turnNumber);
      this._settle(entry, null, res);
    }
  }
}

module.exports = { KataGoEngine, READY_LINE, DEFAULTS };
