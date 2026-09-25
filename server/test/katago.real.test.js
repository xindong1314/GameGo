'use strict';
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const { createAiService } = require('../src/ai/service');
const { replayMoves, isLegal } = require('../src/ai/common');
const { LEVELS } = require('../src/ai/levels');
const engine = require('../src/engine');
const { captureLogger } = require('./ai/helpers');

// 真实 KataGo 的集成测试。只有设置了 KATAGO_PATH、KATAGO_MODEL、KATAGO_CONFIG 三个环境变量时才运行，否则跳过。
// 例（Windows，PowerShell）：
//   $env:KATAGO_PATH='C:/katago/katago.exe'; $env:KATAGO_MODEL='C:/katago/kata1-b10c128-s1141046784-d204142634.txt.gz'
//   $env:KATAGO_CONFIG='katago/analysis.cfg'; node --test test/katago.real.test.js
// 相对路径与服务端一样按 server/ 目录解析。

const { KATAGO_PATH, KATAGO_MODEL, KATAGO_CONFIG } = process.env;
const enabled = Boolean(KATAGO_PATH && KATAGO_MODEL && KATAGO_CONFIG);
const BLACK = 1;
const WHITE = 2;
const g = (pts, size) => pts.map((p) => (p === 'pass' ? -1 : engine.coords.gtpToIdx(p, size)));
const col = (c) => [1, 2, 3, 4, 5, 6, 7, 8, 9].map((r) => `${c}${r}`);
const interleave = (a, b) => a.flatMap((x, i) => [x, b[i]]);

describe('KataGo 真实引擎', { skip: enabled ? false : '未设置 KATAGO_PATH / KATAGO_MODEL / KATAGO_CONFIG' }, () => {
  let ai;
  let logger;

  before(async () => {
    const config = loadConfig({ KATAGO_PATH, KATAGO_MODEL, KATAGO_CONFIG }, { envFile: null });
    assert.ok(config.katago, 'KataGo 配置');
    logger = captureLogger();
    ai = createAiService({ config: { ...config, aiMinThinkMs: 0 }, logger });
    assert.equal(ai.kind, 'katago');
    assert.equal(ai.available(), true, '启动中也视为可用');
    await ai.engine.start();
    assert.equal(ai.engine.isReady(), true);
  });

  after(async () => {
    if (!ai) return;
    await ai.shutdown();
    assert.equal(ai.engine.pid, undefined, 'KataGo 进程已退出');
    assert.equal(ai.available(), false);
  });

  test('协议：query_version、带 id 的错误、没有 id 的错误（靠超时结束）', async () => {
    const v = await ai.engine.query({ action: 'query_version' });
    assert.match(v.version, /^\d+\.\d+/);
    await assert.rejects(
      ai.engine.query({ boardXSize: 9, boardYSize: 9, rules: 'chinese', komi: 7.5, moves: [['B', 'E5'], ['W', 'E5']], maxVisits: 1 }),
      (err) => err.code === 'katago_error' && /Illegal move/.test(err.message),
    );
    await assert.rejects(ai.engine.query({ action: 'no_such_action' }, { timeoutMs: 1500 }), (err) => err.code === 'timeout');
    assert.ok(logger.logs.warn.some((l) => l.includes('没有 id')));
    // 引擎仍然正常
    const r = await ai.engine.query({ boardXSize: 9, boardYSize: 9, rules: 'chinese', komi: 7.5, moves: [], maxVisits: 1, includePolicy: true });
    assert.equal(r.policy.length, 82);
  });

  test('负载高时同一时刻一起超时的排队请求不会被当成卡死，进程不被杀', async () => {
    // 回归：10 个 1 秒的搜索同时发出，分析线程只有几个，其余在 KataGo 内部排队、1.5 秒时在同一个定时器回调里一起超时。
    // 期间先到的请求照常出结果，所以这不是卡死；以前会把正在搜索的进程杀掉重启。
    const pid = ai.engine.pid;
    const before = { ...ai.engine.stats };
    const q = {
      boardXSize: 19,
      boardYSize: 19,
      rules: 'chinese',
      komi: 7.5,
      moves: [['B', 'Q16'], ['W', 'D4']],
      maxVisits: 100000,
      overrideSettings: { maxTime: 1 },
    };
    const res = await Promise.allSettled(Array.from({ length: 10 }, () => ai.engine.query(q, { timeoutMs: 1500 })));
    const ok = res.filter((r) => r.status === 'fulfilled').length;
    const timedOut = res.filter((r) => r.status === 'rejected' && r.reason.code === 'timeout').length;
    assert.equal(ok + timedOut, 10, JSON.stringify(res.map((r) => r.status === 'rejected' && r.reason.message)));
    assert.ok(ok >= 1, '先发出的请求应当正常返回');
    assert.equal(ai.engine.stats.hangs, before.hangs, `不应判定为卡死（超时 ${timedOut} 个）`);
    assert.equal(ai.engine.stats.crashes, before.crashes);
    assert.equal(ai.engine.pid, pid, '还是原来的进程');
    const r = await ai.engine.query({ ...q, boardXSize: 9, boardYSize: 9, moves: [], maxVisits: 1, includePolicy: true });
    assert.equal(r.policy.length, 82);
    assert.equal(ai.engine.pid, pid);
  });

  test('每个难度在 9/13/19 路都给出合法着手', async () => {
    const positions = [
      { size: 9, moves: g(['E5', 'C4', 'G4'], 9) },
      { size: 9, moves: g(['E5', 'C4'], 9) },
      { size: 13, moves: g(['D4', 'K10', 'D10', 'K4'], 13) },
      { size: 19, moves: g(['Q16', 'D4', 'Q4'], 19) },
    ];
    for (const { size, moves } of positions) {
      const color = moves.length % 2 === 0 ? BLACK : WHITE;
      const state = replayMoves(size, 7.5, moves);
      for (const level of LEVELS) {
        const t0 = Date.now();
        const r = await ai.chooseMove({ size, komi: 7.5, moves, color, level: level.id, humanJustPassed: false });
        const ms = Date.now() - t0;
        const label = `${size} 路 ${moves.length} 手 ${level.id}：${JSON.stringify(r)}（${ms}ms）`;
        assert.equal(r.resign, false, label);
        assert.notEqual(r.move, -1, `开局不应 pass：${label}`);
        assert.ok(isLegal(state, color, r.move), label);
        assert.ok(r.info && r.info.winrate >= 0 && r.info.winrate <= 1 && r.info.visits >= 1, label);
        assert.ok(ms < 20000, label);
      }
    }
  });

  test('局面已定、人停一手后：最强档与弱档（终局检查）都 pass', async () => {
    // 白墙 E 列、黑墙 F 列：白 45 目 + 7.5，黑 36 目；黑（人）刚 pass，轮到白（AI）
    const moves = [...g(interleave(col('F'), col('E')), 9), -1];
    assert.equal(moves.length, 19);
    for (const level of ['max', 'k18', 'd5']) {
      const r = await ai.chooseMove({ size: 9, komi: 7.5, moves, color: WHITE, level, humanJustPassed: true });
      assert.deepEqual([r.move, r.resign], [-1, false], `${level}：${JSON.stringify(r)}`);
      assert.ok(r.info.winrate > 0.9, `白方大优：${JSON.stringify(r.info)}`);
      assert.ok(r.info.scoreLead > 5, `白方大优：${JSON.stringify(r.info)}`);
    }
  });

  test('局面已定但对方死子还留在 AI 地里、人停一手后：各档都直接 pass，不先去提死子（回归）', async () => {
    // 黑墙 E 列 + 白地里的黑死子 H5；白墙 F 列 + 黑地里的白死子 B5。数子（提掉死子）黑 45、白 36 + 7.5 → 黑胜 1.5。
    // 黑（人）刚 pass，轮到白（AI）。以前 friendlyPassOk:false 的搜索总想先把地里的死子提掉（按 Tromp-Taylor 死子不提就算活子），
    // AI 要跟着人 pass 好几次才 pass（实测最强档 4 手、d5 5 手、k8 9 手，k18 下了 30 手都没 pass）。
    const moves = [...g(interleave([...col('E'), 'H5'], [...col('F'), 'B5']), 9), -1];
    assert.equal(moves.length, 21);
    for (const level of ['k18', 'k8', 'd5', 'max']) {
      const r = await ai.chooseMove({ size: 9, komi: 7.5, moves, color: WHITE, level, humanJustPassed: true });
      assert.deepEqual([r.move, r.resign], [-1, false], `${level}：${JSON.stringify(r)}`);
    }
    // 之后数子：两颗死子都判出，黑胜 1.5
    const end = [...moves, -1];
    const d = await ai.judgeDead({ size: 9, komi: 7.5, moves: end });
    assert.deepEqual(d.dead, g(['H5', 'B5'], 9).sort((a, b) => a - b));
    const s = engine.score.scoreArea(replayMoves(9, 7.5, end).board, 7.5, d.dead);
    assert.equal(engine.record.resultText({ winner: s.winner, reason: 'score', black: s.black, white: s.white }), 'B+1.5');
  });

  test('judgeDead：终局 9 路找出明显的死子，数子结果正确', async () => {
    // 黑：C、D 两列墙 + 白地里的死子 J5；白：E、G 两列墙 + 黑地里的死子 B5；然后双方 pass
    const black = [...col('D'), ...col('C'), 'J5'];
    const white = [...col('E'), ...col('G'), 'B5'];
    const moves = [...g(interleave(black, white), 9), -1, -1];
    const state = replayMoves(9, 7.5, moves);
    assert.equal(state.status, 'scoring');
    const t0 = Date.now();
    const r = await ai.judgeDead({ size: 9, komi: 7.5, moves });
    assert.equal(r.source, 'katago');
    assert.deepEqual(r.dead, g(['B5', 'J5'], 9).sort((a, b) => a - b), `死子：${JSON.stringify(r.dead)}（${Date.now() - t0}ms）`);
    const s = engine.score.scoreArea(state.board, 7.5, r.dead);
    // 黑：A~D 四列 36；白：E~J 五列 45 + 贴目 7.5 → 白胜 16.5
    assert.deepEqual([s.black, s.white, s.winner], [36, 52.5, WHITE]);
    assert.equal(engine.record.resultText({ winner: s.winner, reason: 'score', black: s.black, white: s.white }), 'W+16.5');
  });

  test('judgeDead：没有死子的终局返回空数组，按数子法黑胜 1.5', async () => {
    const moves = [...g(interleave(col('E'), col('F')), 9), -1, -1];
    const state = replayMoves(9, 7.5, moves);
    const r = await ai.judgeDead({ size: 9, komi: 7.5, moves });
    assert.deepEqual(r, { dead: [], source: 'katago' });
    const s = engine.score.scoreArea(state.board, 7.5, r.dead);
    assert.deepEqual([s.black, s.white, s.winner], [45, 43.5, BLACK]);
  });

  // 终局局面：黑白两串棋子交替落下（少的一方用 pass 补齐），最后双方 pass。
  // 地都做成 2 列宽的"走廊"，死子在走廊里没有做活的空间（地太宽时 KataGo 会认为里面的子还能活，不算终局）。
  function finished(size, black, white) {
    const n = Math.max(black.length, white.length);
    const seq = [];
    for (let i = 0; i < n; i++) seq.push(black[i] || 'pass', white[i] || 'pass');
    while (seq[seq.length - 1] === 'pass' && seq[seq.length - 2] === 'pass') seq.splice(-2, 2);
    seq.push('pass', 'pass');
    if (seq[seq.length - 3] === 'pass') seq.pop(); // 已有一次 pass 在前，补一次即可
    return seq.map((p) => (p === 'pass' ? -1 : engine.coords.gtpToIdx(p, size)));
  }
  const cols = (letters, size) => letters.split('').flatMap((c) => Array.from({ length: size }, (_, i) => `${c}${i + 1}`));

  const JUDGE_CASES = [
    {
      name: '9 路：黑白双方的多子死块',
      size: 9,
      black: [...cols('CDE', 9), 'H3', 'H2', 'J7'],
      white: [...cols('FG', 9), 'B7', 'B6', 'A2'],
      dead: ['A2', 'B6', 'B7', 'H2', 'H3', 'J7'],
      result: 'B+1.5', // 黑 A~E 45，白 F~J 36 + 7.5
    },
    {
      name: '9 路：中间一列单官未收，没有死子',
      size: 9,
      black: cols('D', 9),
      white: cols('F', 9),
      dead: [],
      result: 'W+7.5', // 黑 36，白 36 + 7.5，E 列无主
    },
    {
      name: '9 路：左上角双活（各有一只眼、共用一口气），双活的子不判死',
      size: 9,
      black: ['B9', 'C9', 'J9', 'A8', 'B8', 'C8', 'D8', 'J8', 'E7', 'F7', 'G7', 'H7', 'J7', ...cols('E', 6)],
      white: ['E9', 'F9', 'H9', 'E8', 'F8', 'G8', 'H8', 'A7', 'B7', 'C7', 'D7', ...cols('D', 6)],
      dead: [],
      result: 'B+0.5', // 黑 19 子 + A9 + F1~J6 24 = 44；白 17 子 + G9 + A1~C6 18 + 7.5 = 43.5；D9 无主
    },
    {
      name: '13 路：黑白双方的死子',
      size: 13,
      black: [...cols('CDL', 13), 'G9', 'H9', 'G8', 'H3'],
      white: [...cols('EFJK', 13), 'B10', 'B11', 'N4'],
      dead: ['B10', 'B11', 'G8', 'G9', 'H3', 'H9', 'N4'],
      result: 'B+5.5', // 黑 A~D、L~N 共 7 列 91，白 E~K 6 列 78 + 7.5
    },
    {
      name: '19 路：黑白双方的死子',
      size: 19,
      black: [...cols('CDLMP', 19), 'G10', 'H10', 'G9', 'S3', 'T17'],
      white: [...cols('EFJKQR', 19), 'B16', 'B15', 'O5'],
      dead: ['B15', 'B16', 'G10', 'G9', 'H10', 'O5', 'S3', 'T17'],
      result: 'W+26.5', // 黑 A~D、L~P 共 9 列 171，白 E~K、Q~T 共 10 列 190 + 7.5
    },
  ];

  for (const c of JUDGE_CASES) {
    test(`judgeDead：${c.name}`, async () => {
      const moves = finished(c.size, c.black, c.white);
      const state = replayMoves(c.size, 7.5, moves);
      assert.equal(state.status, 'scoring', '构造的局面应以两次 pass 结束');
      const r = await ai.judgeDead({ size: c.size, komi: 7.5, moves });
      const got = r.dead.map((i) => engine.coords.idxToGtp(i, c.size)).sort();
      assert.deepEqual(got, c.dead.slice().sort());
      const s = engine.score.scoreArea(state.board, 7.5, r.dead);
      assert.equal(engine.record.resultText({ winner: s.winner, reason: 'score', black: s.black, white: s.white }), c.result);
    });
  }

  test('弱档不会凭 1 次评估认输一盘搜索认为还有机会的棋（回归）', async () => {
    // 19 路自对弈中 k8（白）在第 164 手认输的局面：1 次评估判白胜率 1.1%、落后 26 目（19 路门槛 25 目），
    // 400 次搜索却是胜率 17%、落后 11.5 目。1 次评估每次随机取一种对称变换，8 种里约一半会满足认输条件，
    // 所以每次先清掉 KataGo 的缓存再问，问 6 次；旧代码（只看 1 次评估）几乎必然会认输一次，现在要搜索核实，不应认输。
    const moves = g(
      (
        'C17 R16 Q4 C4 F4 P16 C6 D5 E7 E3 K17 M17 D11 E6 B4 R3 R4 Q3 P4 C15 D16 B3 P3 F6 K15 D13 E4 D9 C9 C16 E16 B17 H5 H3 ' +
        'G4 S6 C18 C10 C11 J5 J7 B10 F7 G7 F10 B11 E2 H4 D7 B5 S3 H7 G2 G5 C3 D10 D3 G9 R11 E14 L6 G16 R14 R9 P10 S5 F15 H11 ' +
        'H12 J16 F5 H6 G11 S2 A4 C5 S4 K16 R7 Q8 F14 J11 O16 Q6 N17 L17 R10 O15 P8 O7 P7 N2 M3 O5 F9 E11 M9 N16 O17 G12 N3 ' +
        'N14 H17 Q9 S9 S8 Q7 J9 R18 F13 G17 P17 B2 N10 D6 J17 E5 O8 P9 A5 B6 F16 J12 F17 H16 H18 E15 B18 D14 F12 M16 H15 H14 ' +
        'L11 G14 M13 F18 G18 P18 A2 L12 Q14 C14 Q18 B15 S10 N15 Q19 S11 S7 T9 E18 B1 B16 J14 K12 K13 M11 Q17 M15 B14 G6 B19'
      ).split(' '),
      19,
    );
    assert.equal(moves.length, 163);
    const state = replayMoves(19, 7.5, moves);
    let checked = 0;
    for (let i = 0; i < 6; i++) {
      await ai.engine.query({ action: 'clear_cache' });
      const before = logger.logs.info.length;
      const r = await ai.chooseMove({ size: 19, komi: 7.5, moves, color: WHITE, level: 'k8', humanJustPassed: false });
      assert.equal(r.resign, false, `第 ${i + 1} 次：${JSON.stringify(r)}`);
      assert.ok(isLegal(state, WHITE, r.move), `第 ${i + 1} 次：${JSON.stringify(r)}`);
      if (logger.logs.info.slice(before).some((l) => l.includes('搜索不支持'))) checked++;
    }
    // 只作记录，不断言（取决于随机的对称变换）
    logger.logs.info.push(`认输回归：6 次里 ${checked} 次触发了核实搜索`);
  });

  // 放在最后：会让 KataGo 重启一次
  test('KataGo 进程被杀：进行中的请求立即失败，自动重启后继续服务', async () => {
    const pid = ai.engine.pid;
    const moves = g(['Q16', 'D4', 'Q4', 'D16'], 19);
    const inFlight = ai.chooseMove({ size: 19, komi: 7.5, moves, color: BLACK, level: 'max' }).then(
      () => null,
      (err) => err,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    process.kill(pid);
    const t0 = Date.now();
    const err = await inFlight;
    assert.ok(err, '被杀时进行中的请求应当失败');
    assert.equal(err.code, 'katago_error');
    assert.ok(Date.now() - t0 < 5000, '不用等到超时');
    assert.equal(ai.available(), true, '重启期间仍视为可用');
    const r = await ai.chooseMove({ size: 19, komi: 7.5, moves, color: BLACK, level: 'd3' });
    assert.ok(isLegal(replayMoves(19, 7.5, moves), BLACK, r.move));
    assert.notEqual(ai.engine.pid, pid);
    assert.equal(ai.engine.stats.crashes, 1);
  });
});
