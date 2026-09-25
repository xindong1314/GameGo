'use strict';
// 模拟 `katago analysis` 进程的小脚本，给 test/ai/katago.test.js 测进程管理用。
// 用法：node fake-katago.js analysis -config x -model y
// 与真实 KataGo 一样：stderr 打日志并在就绪时打印 "Started, ready to begin handling requests"，
// stdin 每行一个 JSON 请求，stdout 每行一个 JSON 响应。
//
// 环境变量：
//   FAKE_KATAGO_FAIL_START     =1 时这次启动在就绪前以退出码 2 退出
//   FAKE_KATAGO_NEVER_READY    =1 时永不打印就绪行（但进程不退出）
//   FAKE_KATAGO_STARTUP_DELAY_MS  就绪前等待的毫秒数
//   FAKE_KATAGO_IGNORE_STDIN_END  =1 时 stdin 关闭后也不退出（测 shutdown 的强制结束）
//
// 请求里的 fake 字段控制这个请求的行为（真实 KataGo 会对未知字段回 warning，这里不回）：
//   { hang: true }        不回结果（被 terminate 时回 noResults）
//   { crash: code }       立即以 code 退出
//   { delayMs: n }        n 毫秒后回结果
//   { error: msg, field } 回带 id 的错误
//   { idless: true }      回没有 id 的错误，之后不再回这个请求
//   { warning: true }     先回一条 warning 再回结果
//   { partial: n }        先回 n 条 isDuringSearch:true 的中间结果
//   { garbage: true }     先输出一行非 JSON 内容
//   { freeze: true }      之后不再处理任何输入（模拟卡死）
//   { stats: true }       回 { stats: { actions, pid } }（actions 为收到的 action 请求）
// 默认结果：{ id, isDuringSearch: false, turnNumber, echo: 请求（去掉 id）, pid }

const readline = require('node:readline');

if (!process.argv.includes('analysis')) {
  // 被测试运行器当成测试文件直接执行时什么也不做
  process.exit(0);
}

const env = process.env;

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const log = (line) => process.stderr.write(`2026-09-25 00:00:00+0800: ${line}\n`);

const actions = [];
const hanging = new Set();
let frozen = false;

log('Running with following config:');
log(`fake katago pid ${process.pid}`);

if (env.FAKE_KATAGO_FAIL_START === '1') {
  log('ERROR: fake startup failure');
  process.exitCode = 2;
  // 让 stderr 写完再退出
  setTimeout(() => process.exit(2), 20);
} else if (env.FAKE_KATAGO_NEVER_READY === '1') {
  log('Loading model (forever)...');
  setInterval(() => {}, 1000);
} else {
  setTimeout(() => {
    log('Started, ready to begin handling requests');
    serve();
  }, Number(env.FAKE_KATAGO_STARTUP_DELAY_MS || 0));
}

function finish(q) {
  out({ id: q.id, isDuringSearch: false, turnNumber: (q.moves || []).length, echo: { ...q, id: undefined }, pid: process.pid });
}

function handle(line) {
  let q;
  try {
    q = JSON.parse(line);
  } catch {
    out({ error: `could not parse input line as json request: ${line}` });
    return;
  }
  if (typeof q.id !== 'string') {
    out({ error: 'Request must have a string "id" field' });
    return;
  }
  if (q.action !== undefined) {
    actions.push({ action: q.action, terminateId: q.terminateId });
    if (q.action === 'terminate') {
      out({ action: 'terminate', id: q.id, terminateId: q.terminateId });
      if (hanging.delete(q.terminateId)) out({ id: q.terminateId, isDuringSearch: false, noResults: true, turnNumber: 0 });
    } else if (q.action === 'terminate_all') {
      out({ action: 'terminate_all', id: q.id });
      for (const id of hanging) out({ id, isDuringSearch: false, noResults: true, turnNumber: 0 });
      hanging.clear();
    } else if (q.action === 'query_version') {
      out({ action: 'query_version', id: q.id, version: 'fake', git_hash: '0' });
    } else {
      out({ error: "'action' field must be 'query_version' or 'query_models' or 'clear_cache' or 'terminate' or 'terminate_all'" });
    }
    return;
  }
  const f = q.fake || {};
  if (f.freeze) {
    frozen = true;
    return;
  }
  if (f.crash !== undefined) {
    process.exit(f.crash);
  }
  if (f.stats) {
    out({ id: q.id, isDuringSearch: false, turnNumber: 0, stats: { actions, pid: process.pid } });
    return;
  }
  if (f.garbage) process.stdout.write('this is not json\n');
  if (f.error) {
    out({ error: f.error, field: f.field || 'moves', id: q.id });
    return;
  }
  if (f.idless) {
    out({ error: 'some error without id' });
    return;
  }
  if (f.warning) out({ id: q.id, field: 'fooBar', warning: 'Unexpected or unused field, do you have a typo?' });
  if (f.hang) {
    hanging.add(q.id);
    return;
  }
  for (let i = 0; i < (f.partial || 0); i++) out({ id: q.id, isDuringSearch: true, turnNumber: 0, rootInfo: { visits: i + 1 } });
  if (f.delayMs) setTimeout(() => finish(q), f.delayMs);
  else finish(q);
}

function serve() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!frozen && line.trim()) handle(line);
  });
  rl.on('close', () => {
    if (env.FAKE_KATAGO_IGNORE_STDIN_END === '1') {
      setInterval(() => {}, 1000);
      return;
    }
    setTimeout(() => process.exit(0), 10);
  });
}
