'use strict';

// 交叉验证夹具生成器：用 JS 引擎（小程序端）跑大量随机对局，把每一步操作及其结果写成 JSON，
// 由 Java 端的 CrossValidationTest 逐步重放并断言结果完全一致。
//
// 用法（在仓库根目录）：
//   node server-java/src/test/resources/engine/gen-fixtures.js
// 输出：同目录下的 cross-validation.json。固定种子，结果确定，可反复生成。
//
// 夹具格式（每局一行，便于 diff）：
//   { size, komi, autoScore, ops: [...], cells }        cells 为终局棋盘（每点一位数字）
// 对局操作（play / pass / undo / resign / resume / finish）之后记录：
//   r   结果："ok" 或拒绝原因；undo 为 true/false
//   d   棋盘变化 [idx, color, idx, color, ...]（相对上一次对局操作之后的棋盘）
//   s   [toPlay, ko, captures[黑], captures[白], consecutivePasses, status 首字母, history 长度]
//   h   history 最后一项 [color, idx, captured, koBefore, koAfter, passesBefore]（操作被拒绝或 history 为空时省略）
//   res 当前结果 [winner, reason, black, white]（为 null 时省略）
// 检查操作（不改变对局状态）：can / grp / score / area / toggle / text / replay，字段见下方代码。

const fs = require('fs');
const path = require('path');

const ENGINE = path.join(__dirname, '../../../../../miniprogram/utils/engine');
const { Board, EMPTY, BLACK, WHITE } = require(path.join(ENGINE, 'board'));
const { tryPlay, canPlay } = require(path.join(ENGINE, 'rules'));
const game = require(path.join(ENGINE, 'game'));
const { score, scoreArea, toggleDead } = require(path.join(ENGINE, 'score'));
const coords = require(path.join(ENGINE, 'coords'));
const record = require(path.join(ENGINE, 'record'));

const SEED = 20260926;
const OUT = path.join(__dirname, 'cross-validation.json');

// ---------- 可复现的伪随机数 ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const randInt = (n) => Math.floor(rnd() * n);
const pick = (arr) => arr[randInt(arr.length)];
const chance = (p) => rnd() < p;

const STATUS_CODE = { playing: 'p', scoring: 's', ended: 'e' };
const KOMIS = [7.5, 7.5, 6.5, 5.5, 0, 0.5, 7, 3.75, 0.25, 0.35, 2.05, -2.5, -0.25, 184.45];
const NAMES = [null, '', '小明', 'Alice', 'a]b', 'back\\slash', '黑方]\\x', 'Bob Smith', '白'];
const DATES = [null, '', '2026-09-26', '2026-01-01]x'];

// ---------- 序列化 ----------
const stateArr = (s) => [
  s.toPlay,
  s.ko,
  s.captures[BLACK],
  s.captures[WHITE],
  s.consecutivePasses,
  STATUS_CODE[s.status],
  s.history.length,
];
const moveArr = (m) => [m.color, m.idx, m.captured.slice(), m.koBefore, m.koAfter, m.passesBefore];
const resultArr = (r) => (r == null ? null : [r.winner, r.reason, r.black, r.white]);
const cellsStr = (b) => Array.from(b.cells).join('');
const scoreArr = (s) => [s.black, s.white, s.winner, s.blackStones, s.whiteStones, s.blackArea, s.whiteArea];

// ---------- 选点策略 ----------
function stonesOf(board) {
  const out = [];
  for (let i = 0; i < board.cells.length; i++) if (board.cells[i] !== EMPTY) out.push(i);
  return out;
}
function emptiesOf(board) {
  const out = [];
  for (let i = 0; i < board.cells.length; i++) if (board.cells[i] === EMPTY) out.push(i);
  return out;
}

// 所有棋块（按 color 过滤），附带气
function groupsOf(board, color) {
  const seen = new Uint8Array(board.cells.length);
  const out = [];
  for (let i = 0; i < board.cells.length; i++) {
    if (seen[i] || board.cells[i] === EMPTY) continue;
    const g = board.group(i);
    g.stones.forEach((s) => (seen[s] = 1));
    if (color == null || g.color === color) out.push(g);
  }
  return out;
}

// 四周全被占的空点：自杀或提子的候选
function eyePoints(board) {
  return emptiesOf(board).filter((i) => board.neighbors(i).every((nb) => board.cells[nb] !== EMPTY));
}

function chooseMove(state) {
  const b = state.board;
  const n = b.n;
  const me = state.toPlay;
  const foe = me === BLACK ? WHITE : BLACK;
  if (state.ko !== null && chance(0.3)) return state.ko; // 立即回提劫：应被拒绝
  if (chance(0.25)) {
    // 在副本上试下，优先挑能形成劫（提一子且成为劫点）的着手，用来制造劫争
    const kos = [];
    for (const i of eyePoints(b)) {
      const r = tryPlay(b.clone(), me, state.ko, i);
      if (r.ok && r.koAfter !== null) kos.push(i);
    }
    if (kos.length) return pick(kos);
  }
  const roll = rnd();
  if (roll < 0.03) return pick([-1, -7, n * n, n * n + 3, 1000]); // 越界
  if (roll < 0.1) {
    const stones = stonesOf(b);
    if (stones.length) return pick(stones); // 已有子
  }
  if (roll < 0.26) {
    const eyes = eyePoints(b);
    if (eyes.length) return pick(eyes); // 自杀 / 提子候选
  }
  if (roll < 0.5) {
    // 战斗：提对方叫吃的块、长出自己叫吃的块、叫吃对方两气的块
    const foeAtari = groupsOf(b, foe).filter((g) => g.liberties.length === 1);
    const myAtari = groupsOf(b, me).filter((g) => g.liberties.length === 1);
    const foeTwo = groupsOf(b, foe).filter((g) => g.liberties.length === 2);
    const pool = [];
    if (foeAtari.length) pool.push(pick(foeAtari).liberties[0], pick(foeAtari).liberties[0]);
    if (myAtari.length) pool.push(pick(myAtari).liberties[0]);
    if (foeTwo.length) pool.push(pick(pick(foeTwo).liberties));
    if (pool.length) return pick(pool);
  }
  if (roll < 0.8) {
    // 贴着已有的棋子下
    const stones = stonesOf(b);
    if (stones.length) {
      const nbs = b.neighbors(pick(stones)).filter((i) => b.cells[i] === EMPTY);
      if (nbs.length) return pick(nbs);
    }
  }
  const empties = emptiesOf(b);
  return empties.length ? pick(empties) : randInt(n * n);
}

// 随机死子集合：若干整块 + 杂项（越界、空点、重复）
function randomDead(board) {
  let dead = [];
  const groups = groupsOf(board, null);
  const k = randInt(Math.min(4, groups.length + 1));
  for (let j = 0; j < k; j++) dead.push(...pick(groups).stones);
  if (chance(0.3) && dead.length) dead.push(pick(dead)); // 重复
  if (chance(0.3)) dead.push(pick([-1, -9, board.n * board.n, board.n * board.n + 40]));
  if (chance(0.3)) {
    const e = emptiesOf(board);
    if (e.length) dead.push(pick(e));
  }
  if (chance(0.2)) dead.push(randInt(board.n * board.n));
  // 打乱顺序
  for (let i = dead.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [dead[i], dead[j]] = [dead[j], dead[i]];
  }
  return dead;
}

function randomProbeIdx(board) {
  const n2 = board.n * board.n;
  const r = rnd();
  if (r < 0.08) return pick([-1, -5, n2, n2 + 11]);
  if (r < 0.6) {
    const s = stonesOf(board);
    if (s.length) return pick(s);
  }
  return randInt(n2);
}

function randomResult() {
  const winner = pick([0, 1, 2, 1, 2, 3]);
  const reason = pick(['score', 'score', 'resign', 'timeout', 'abort', 'disconnect']);
  const withPoints = reason === 'score' ? chance(0.85) : chance(0.2);
  if (!withPoints) return { winner, reason };
  const black = pick([randInt(200), randInt(200) + 0.5, randInt(100) + 0.25, randInt(100) + 0.35, rnd() * 100]);
  const white = pick([randInt(200), randInt(200) + 0.5, randInt(100) + 0.75, randInt(100) + 0.05, rnd() * 100]);
  return chance(0.1) ? { winner, reason, black } : { winner, reason, black, white };
}

// ---------- 单局 ----------
let totalOps = 0;
let gameOps = 0;
const stats = { captures: 0, koSet: 0, koReject: 0, suicide: 0, occupied: 0, invalid: 0, scoring: 0, ended: 0, resumes: 0, undos: 0, replayErrors: 0 };

function runGame(size) {
  const komi = pick(KOMIS);
  const autoScore = chance(0.35);
  const state = game.createGame({ size, komi, autoScore });
  const ops = [];
  const maxOps = { 9: 200, 13: 260, 19: 320 }[size];
  let prev = new Int8Array(size * size);
  let myOps = 0; // 本局已做的对局操作数

  function emit(op) {
    ops.push(op);
    totalOps += 1;
  }

  // 执行一次对局操作并记录结果
  function gameOp(op, run) {
    const r = run();
    op.r = typeof r === 'boolean' ? r : r.ok ? 'ok' : r.reason;
    const d = [];
    const cells = state.board.cells;
    for (let i = 0; i < cells.length; i++) if (cells[i] !== prev[i]) d.push(i, cells[i]);
    prev = Int8Array.from(cells);
    op.d = d;
    op.s = stateArr(state);
    // 被拒绝的操作不改动 history，不重复记录
    const changed = op.r === 'ok' || op.r === true;
    if (changed && state.history.length) op.h = moveArr(state.history[state.history.length - 1]);
    if (state.result) op.res = resultArr(state.result);
    emit(op);
    gameOps += 1;
    myOps += 1;
    if (op.o === 'play' && op.r === 'ok') {
      const last = state.history[state.history.length - 1];
      if (last.captured.length) stats.captures += 1;
      if (last.koAfter !== null) stats.koSet += 1;
    }
    if (op.r === 'ko') stats.koReject += 1;
    if (op.r === 'suicide') stats.suicide += 1;
    if (op.r === 'occupied') stats.occupied += 1;
    if (op.r === 'invalid') stats.invalid += 1;
    if (op.o === 'resume' && op.r === 'ok') stats.resumes += 1;
    if (op.o === 'undo' && op.r === true) stats.undos += 1;
    return op.r;
  }

  const doPlay = (idx) => gameOp({ o: 'play', i: idx }, () => game.play(state, idx));
  const doPass = () => gameOp({ o: 'pass' }, () => game.pass(state));
  const doUndo = () => gameOp({ o: 'undo' }, () => game.undo(state));
  const doResume = () => gameOp({ o: 'resume' }, () => game.resume(state));
  const doResign = () => {
    const c = pick([null, null, BLACK, WHITE, 7, 0]);
    return gameOp({ o: 'resign', c }, () => game.resign(state, c === null ? undefined : c));
  };
  const doFinish = () => {
    const res = randomResult();
    return gameOp({ o: 'finish', fin: resultArr(Object.assign({ black: null, white: null }, res)) }, () =>
      game.finish(state, res)
    );
  };

  // ---- 检查操作 ----
  function probeCan() {
    const b = state.board;
    const c = pick([state.toPlay, state.toPlay, state.toPlay === BLACK ? WHITE : BLACK, 0, 3]);
    const k = pick([null, state.ko, state.ko, randInt(b.n * b.n)]);
    const i = chance(0.3) && state.ko !== null ? state.ko : chooseMove(state);
    const before = cellsStr(b);
    const r = canPlay(b, c, k, i);
    if (cellsStr(b) !== before) throw new Error('canPlay 改动了棋盘');
    emit({ o: 'can', c, k, i, r: r.ok ? 'ok' : r.reason });
  }
  function probeGroup() {
    const b = state.board;
    const i = randomProbeIdx(b);
    const g = b.group(i);
    emit({ o: 'grp', i, nb: b.neighbors(i), g: g ? [g.color, g.stones, g.liberties] : null });
  }
  // full 为 false 时只做 score + 一次 scoreArea，控制夹具体积
  function scoreChecks(full) {
    const b = state.board;
    emit({ o: 'score', k: state.komi, r: scoreArr(score(b, state.komi)) });
    if (!full) {
      const dead = randomDead(b);
      const a = scoreArea(b, state.komi, dead);
      emit({ o: 'area', k: state.komi, dead, r: scoreArr(a), own: a.owner.join(''), dd: a.dead });
      return;
    }
    const rounds = 1 + randInt(2);
    for (let j = 0; j < rounds; j++) {
      const dead = chance(0.1) ? null : randomDead(b);
      const a = scoreArea(b, state.komi, dead);
      emit({ o: 'area', k: state.komi, dead, r: scoreArr(a), own: a.owner.join(''), dd: a.dead });
    }
    // 点击切换死活若干次，最后按结果计分
    let dead = chance(0.7) ? [] : randomDead(b);
    const clicks = 2 + randInt(5);
    for (let j = 0; j < clicks; j++) {
      const i = randomProbeIdx(b);
      const next = toggleDead(b, dead, i);
      emit({ o: 'toggle', dead, i, r: next });
      dead = next;
    }
    const a = scoreArea(b, state.komi, dead);
    emit({ o: 'area', k: state.komi, dead, r: scoreArr(a), own: a.owner.join(''), dd: a.dead });
  }
  function textChecks() {
    const res = state.result;
    const moves = record.movesOf(state);
    const sgf = {
      size: state.size,
      komi: state.komi,
      moves,
      blackName: pick(NAMES),
      whiteName: pick(NAMES),
      result: res,
      date: pick(DATES),
    };
    emit({
      o: 'text',
      res: resultArr(res),
      t: record.resultText(res),
      l: record.resultLabel(res),
      pb: sgf.blackName,
      pw: sgf.whiteName,
      dt: sgf.date,
      sgf: record.toSgf(sgf),
    });
  }
  function replayCheck() {
    let moves = record.movesOf(state);
    const auto = chance(0.3);
    if (chance(0.4) && moves.length) {
      // 篡改一手，制造非法序列（也可能碰巧仍然合法）
      moves = moves.slice();
      const at = randInt(moves.length);
      moves[at] = pick([moves[Math.max(0, at - 1)], moves[Math.max(0, at - 2)], randInt(size * size), -1, size * size]);
      if (chance(0.3)) moves = moves.slice(0, at + 1 + randInt(5));
    }
    const op = { o: 'replay', auto, moves };
    try {
      const s = record.replay(size, state.komi, moves, { autoScore: auto });
      op.cells = cellsStr(s.board);
      op.s = stateArr(s);
      op.res = resultArr(s.result);
      op.mv = record.movesOf(s).length;
    } catch (e) {
      op.err = [e.moveIndex, e.reason, e.message];
      stats.replayErrors += 1;
    }
    emit(op);
  }

  let lastStatus = state.status;
  while (myOps < maxOps) {
    const st = state.status;
    if (st !== lastStatus) {
      // 刚进入数子阶段或终局：做一轮计分与文本检查
      if (st === 'scoring') {
        stats.scoring += 1;
        scoreChecks(chance(0.3));
      } else if (st === 'ended') {
        stats.ended += 1;
        scoreChecks(chance(0.3));
        if (chance(0.4)) textChecks();
        if (chance(0.15)) replayCheck();
      }
      lastStatus = st;
    }
    const progress = myOps / maxOps;
    const r = rnd();
    if (st === 'playing') {
      const passP = 0.03 + progress * 0.12 + (state.consecutivePasses ? 0.25 : 0);
      if (r < 0.78) doPlay(chooseMove(state));
      else if (r < 0.78 + passP) doPass();
      else if (r < 0.86) {
        const k = 1 + randInt(3);
        for (let j = 0; j < k; j++) doUndo();
      } else if (r < 0.875) doResign();
      else if (r < 0.885) doFinish();
      else if (r < 0.895) doResume();
      else if (r < 0.94) probeCan();
      else if (r < 0.97) probeGroup();
      else if (r < 0.988) {
        emit({ o: 'score', k: state.komi, r: scoreArr(score(state.board, state.komi)) });
      } else replayCheck();
    } else if (st === 'scoring') {
      if (r < 0.4) doResume();
      else if (r < 0.62) doUndo();
      else if (r < 0.7) doPlay(chooseMove(state));
      else if (r < 0.75) doPass();
      else if (r < 0.85) doFinish();
      else if (r < 0.93) doResign();
      else if (r < 0.97) probeCan();
      else replayCheck();
    } else {
      if (r < 0.7) {
        const k = 1 + randInt(3);
        for (let j = 0; j < k; j++) doUndo();
      } else if (r < 0.75) doPlay(chooseMove(state));
      else if (r < 0.8) doPass();
      else if (r < 0.85) doResign();
      else if (r < 0.9) doFinish();
      else if (r < 0.95) doResume();
      else probeGroup();
    }
  }
  // 收尾：计分、文本、重放
  scoreChecks(true);
  textChecks();
  replayCheck();
  return { size, komi, autoScore, ops, cells: cellsStr(state.board) };
}

// ---------- 独立检查：坐标、结果文本、SGF ----------
function tryCall(fn) {
  try {
    return { v: fn() };
  } catch (e) {
    return { err: true };
  }
}

function coordsCases() {
  const out = [];
  for (const n of [2, 5, 9, 13, 19]) {
    for (let i = -2; i <= n * n; i++) {
      const g = tryCall(() => coords.idxToGtp(i, n));
      const s = tryCall(() => coords.idxToSgf(i, n));
      out.push({ f: 'idxToGtp', a: i, n, ...g });
      out.push({ f: 'idxToSgf', a: i, n, ...s });
      if (g.v !== undefined) out.push({ f: 'gtpToIdx', a: g.v, n, ...tryCall(() => coords.gtpToIdx(g.v, n)) });
      if (s.v !== undefined) out.push({ f: 'sgfToIdx', a: s.v, n, ...tryCall(() => coords.sgfToIdx(s.v, n)) });
    }
  }
  const gtpInputs = ['pass', 'PASS', ' Pass ', 'q16', ' q16 ', 'Q16', 'I5', 'i5', 'K5', 'J9', 'J10', 'A10', 'A0', 'A01', 'A00',
    '', ' ', 'A 1', 'Z1', 'A1\n', ' A1', '﻿A1　', 'T19', 'T20', 'A100', 'AA1', '1A', 'a19', 'H8', 'passx'];
  const sgfInputs = ['', 'tt', 'aa', 'ss', 'st', 'ts', 'jj', 'ii', 'AA', 'a', 'aaa', 'a1', 'za', 'ab', 'ba', 'ee', 'mm', 'rs', ' aa'];
  for (const n of [1, 2, 9, 13, 19, 20]) {
    for (const s of gtpInputs) out.push({ f: 'gtpToIdx', a: s, n, ...tryCall(() => coords.gtpToIdx(s, n)) });
    for (const s of sgfInputs) out.push({ f: 'sgfToIdx', a: s, n, ...tryCall(() => coords.sgfToIdx(s, n)) });
    out.push({ f: 'idxToGtp', a: 0, n, ...tryCall(() => coords.idxToGtp(0, n)) });
    out.push({ f: 'idxToSgf', a: 0, n, ...tryCall(() => coords.idxToSgf(0, n)) });
  }
  return out;
}

function textCases() {
  const out = [];
  const results = [null];
  for (let j = 0; j < 300; j++) results.push(randomResult());
  results.push(
    { winner: 1, reason: 'score', black: 0.25, white: 0 },
    { winner: 1, reason: 'score', black: 0.35, white: 0 },
    { winner: 1, reason: 'score', black: 0.45, white: 0 },
    { winner: 2, reason: 'score', black: 0, white: 2.05 },
    { winner: 2, reason: 'score', black: 0, white: 0.04 },
    { winner: 2, reason: 'score', black: 1.96, white: 0 },
    { winner: 2, reason: 'score', black: 0.1, white: 0.3 },
    { winner: 1, reason: 'score', black: 180, white: 188.5 },
    { winner: 0, reason: 'score', black: 40, white: 40 },
    { winner: 0, reason: 'abort' },
    { winner: 2, reason: 'timeout', black: 1, white: 2 },
    { winner: 1, reason: 'resign' }
  );
  for (const res of results) {
    out.push({ res: resultArr(res && Object.assign({ black: null, white: null }, res)), t: record.resultText(res), l: record.resultLabel(res) });
  }
  return out;
}

function sgfCases() {
  const out = [];
  for (let j = 0; j < 120; j++) {
    const size = pick([9, 13, 19, 5]);
    const moves = [];
    const len = randInt(12);
    for (let k = 0; k < len; k++) moves.push(chance(0.15) ? -1 : randInt(size * size));
    const komi = pick(KOMIS.concat([rnd() * 20 - 5, 1e-7, 12345.65]));
    const res = chance(0.2) ? null : randomResult();
    const args = { size, komi, moves, blackName: pick(NAMES), whiteName: pick(NAMES), result: res, date: pick(DATES) };
    out.push({
      size,
      komi,
      moves,
      pb: args.blackName,
      pw: args.whiteName,
      dt: args.date,
      res: resultArr(res && Object.assign({ black: null, white: null }, res)),
      sgf: record.toSgf(args),
    });
  }
  return out;
}

// ---------- 生成 ----------
const plan = [];
for (let j = 0; j < 40; j++) plan.push(9);
for (let j = 0; j < 25; j++) plan.push(13);
for (let j = 0; j < 20; j++) plan.push(19);
const games = plan.map((size) => runGame(size));

const coordsList = coordsCases();
const texts = textCases();
const sgfs = sgfCases();

const lines = [];
lines.push('{"version":1,"seed":' + SEED + ',');
lines.push('"coords":[');
lines.push(coordsList.map((c) => JSON.stringify(c)).join(',\n'));
lines.push('],"texts":[');
lines.push(texts.map((c) => JSON.stringify(c)).join(',\n'));
lines.push('],"sgfs":[');
lines.push(sgfs.map((c) => JSON.stringify(c)).join(',\n'));
lines.push('],"games":[');
lines.push(games.map((g) => JSON.stringify(g)).join(',\n'));
lines.push(']}');
const text = lines.join('\n') + '\n';
fs.writeFileSync(OUT, text);

console.log(
  JSON.stringify({
    file: path.relative(process.cwd(), OUT),
    bytes: text.length,
    games: games.length,
    gameOps,
    totalOps,
    coords: coordsList.length,
    texts: texts.length,
    sgfs: sgfs.length,
    stats,
  })
);
