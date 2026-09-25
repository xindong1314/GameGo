'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../../miniprogram/components/goboard/draw');

// 记录绘制调用的假 Canvas 2D 上下文：fill/stroke 时连同当前路径与样式一起记下
class FakeCtx {
  constructor() {
    this.ops = [];
    this.path = [];
    this.fillStyle = '';
    this.strokeStyle = '';
    this.lineWidth = 1;
    this.globalAlpha = 1;
  }
  snapshot(type) {
    this.ops.push({ type, fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth, alpha: this.globalAlpha, path: this.path.slice() });
  }
  clearRect(...a) {
    this.ops.push({ type: 'clearRect', args: a });
  }
  fillRect(...a) {
    this.ops.push({ type: 'fillRect', args: a, fillStyle: this.fillStyle });
  }
  beginPath() {
    this.path = [];
  }
  moveTo(x, y) {
    this.path.push(['moveTo', x, y]);
  }
  lineTo(x, y) {
    this.path.push(['lineTo', x, y]);
  }
  arc(x, y, r) {
    this.path.push(['arc', x, y, r]);
  }
  rect(x, y, w, h) {
    this.path.push(['rect', x, y, w, h]);
  }
  fill() {
    this.snapshot('fill');
  }
  stroke() {
    this.snapshot('stroke');
  }
}

const CSS = 200; // 9 路：格距 20，第 i 线在 20*(i+1)
const cell = CSS / 10;
const c = (i) => cell * (i + 1);

function draw(opts) {
  const ctx = new FakeCtx();
  D.drawBoard(ctx, Object.assign({ cssSize: CSS, size: 9, cells: new Array(81).fill(0), lastIdx: -1, preview: null, marks: null }, opts));
  return ctx;
}

function arcsIn(op) {
  return op.path.filter((p) => p[0] === 'arc');
}

// 找到画出 (x,y) 处半径 r 圆的 fill 操作
function fillsAt(ctx, idx, r) {
  const x = c(idx % 9);
  const y = c(Math.floor(idx / 9));
  return ctx.ops.filter((o) => o.type === 'fill' && arcsIn(o).some((a) => a[1] === x && a[2] === y && Math.abs(a[3] - r) < 1e-9));
}

const STONE_R = cell * D.STONE_RADIUS;

test('hitTest：最近交叉点，出界与无效参数返回 -1', () => {
  assert.equal(D.hitTest(CSS, 9, 20, 20), 0);
  assert.equal(D.hitTest(CSS, 9, 29, 11), 0);
  assert.equal(D.hitTest(CSS, 9, 31, 20), 1);
  assert.equal(D.hitTest(CSS, 9, 180, 180), 80);
  assert.equal(D.hitTest(CSS, 9, 100, 60), 2 * 9 + 4);
  assert.equal(D.hitTest(CSS, 9, 5, 20), -1);
  assert.equal(D.hitTest(CSS, 9, 195, 20), -1);
  assert.equal(D.hitTest(CSS, 9, 20, 195), -1);
  assert.equal(D.hitTest(0, 9, 20, 20), -1);
  assert.equal(D.hitTest(CSS, 0, 20, 20), -1);
  assert.equal(D.hitTest(CSS, 9, NaN, 20), -1);
  assert.equal(D.hitTest(CSS, 9, undefined, 20), -1);
});

test('空棋盘：底色、网格、星位', () => {
  const ctx = draw({});
  assert.equal(ctx.ops[0].type, 'clearRect');
  assert.deepEqual(ctx.ops[1], { type: 'fillRect', args: [0, 0, CSS, CSS], fillStyle: D.COLORS.wood });
  const grid = ctx.ops.find((o) => o.type === 'stroke');
  assert.equal(grid.path.length, 9 * 4);
  const stars = ctx.ops.find((o) => o.type === 'fill');
  assert.equal(arcsIn(stars).length, 9);
  assert.equal(ctx.ops.filter((o) => o.type === 'fill').length, 1, '没有棋子时只有星位一次填充');
});

test('同色棋子合并为一次填充；非法参数不绘制', () => {
  const cells = new Array(81).fill(0);
  cells[0] = 1;
  cells[40] = 1;
  cells[41] = 2;
  const ctx = draw({ cells });
  const fills = ctx.ops.filter((o) => o.type === 'fill' && arcsIn(o).some((a) => Math.abs(a[3] - STONE_R) < 1e-9));
  assert.equal(fills.length, 2);
  assert.equal(fills[0].fillStyle, D.COLORS.black);
  assert.equal(arcsIn(fills[0]).length, 2);
  assert.equal(fills[1].fillStyle, D.COLORS.white);
  assert.equal(arcsIn(fills[1]).length, 1);
  assert.ok(fills.every((f) => f.alpha === 1));
  // 空上下文 / 无效尺寸：静默返回
  D.drawBoard(null, { cssSize: CSS, size: 9, cells });
  const empty = new FakeCtx();
  D.drawBoard(empty, { cssSize: 0, size: 9, cells });
  assert.equal(empty.ops.length, 0);
});

test('cells 比棋盘长或含非法值时只画有效部分', () => {
  const cells = new Array(100).fill(0);
  cells[90] = 1; // 超出 9 路
  cells[3] = 7; // 非法颜色
  cells[4] = 2;
  const ctx = draw({ cells });
  const stones = ctx.ops.filter((o) => o.type === 'fill' && arcsIn(o).some((a) => Math.abs(a[3] - STONE_R) < 1e-9));
  assert.equal(stones.length, 1);
  assert.equal(stones[0].fillStyle, D.COLORS.white);
});

test('最后一手标记与预览子（v1 行为）', () => {
  const cells = new Array(81).fill(0);
  cells[40] = 1;
  let ctx = draw({ cells, lastIdx: 40, preview: { idx: 41, ok: true, color: 2 } });
  const marker = ctx.ops.find((o) => o.type === 'stroke' && arcsIn(o).some((a) => a[1] === c(4) && Math.abs(a[3] - cell * 0.2) < 1e-9));
  assert.ok(marker);
  assert.equal(marker.strokeStyle, '#fff');
  const pv = fillsAt(ctx, 41, STONE_R);
  assert.equal(pv.length, 1);
  assert.equal(pv[0].alpha, D.PREVIEW_ALPHA);
  assert.equal(pv[0].fillStyle, D.COLORS.white);
  assert.ok(!ctx.ops.some((o) => o.type === 'stroke' && o.strokeStyle === D.COLORS.illegal));
  // 非法预览套红圈
  ctx = draw({ cells, preview: { idx: 40, ok: false, color: 2 } });
  assert.ok(ctx.ops.some((o) => o.type === 'stroke' && o.strokeStyle === D.COLORS.illegal && o.lineWidth === 3));
  // 最后一手位置为空时不画标记；预览越界不画
  ctx = draw({ cells, lastIdx: 10, preview: { idx: 99, ok: true, color: 1 } });
  assert.ok(!ctx.ops.some((o) => o.type === 'stroke' && arcsIn(o).some((a) => Math.abs(a[3] - cell * 0.2) < 1e-9)));
  assert.equal(fillsAt(ctx, 40, STONE_R).length, 1);
});

test('marks：死子半透明并画叉；地盘方块画在空点与死子点上', () => {
  const cells = new Array(81).fill(0);
  cells[40] = 1; // 活黑
  cells[41] = 2; // 死白
  cells[42] = 2; // 活白
  const owner = new Array(81).fill(1);
  owner[42] = 2; // 活白自己的点：不画方块
  owner[43] = 2; // 空点属白
  owner[44] = 0; // 无主
  owner[40] = 1; // 活黑：不画方块
  const ctx = draw({ cells, marks: { dead: [41, 50 /* 空点，忽略 */, 999], owner } });

  const dead = fillsAt(ctx, 41, STONE_R);
  assert.equal(dead.length, 1);
  assert.equal(dead[0].alpha, D.DEAD_ALPHA);
  assert.equal(dead[0].fillStyle, D.COLORS.white);
  assert.equal(fillsAt(ctx, 42, STONE_R)[0].alpha, 1);
  assert.equal(fillsAt(ctx, 50, STONE_R).length, 0, '空点不会被当成死子画出来');

  const cross = ctx.ops.find((o) => o.type === 'stroke' && o.strokeStyle === D.COLORS.deadCross);
  assert.ok(cross);
  assert.equal(cross.path.length, 4, '只有一个死子：两条线 = 4 段路径命令');

  const squares = ctx.ops.filter((o) => o.type === 'fill' && o.path.length && o.path[0][0] === 'rect');
  assert.equal(squares.length, 2);
  const s = cell * D.SQUARE_SIZE;
  const rectAt = (op, idx) => op.path.some((p) => p[1] === c(idx % 9) - s / 2 && p[2] === c(Math.floor(idx / 9)) - s / 2);
  const blackSq = squares.find((o) => o.fillStyle === D.COLORS.black);
  const whiteSq = squares.find((o) => o.fillStyle === D.COLORS.white);
  assert.ok(rectAt(blackSq, 41), '死白子所在点属黑：画黑方块');
  assert.ok(rectAt(blackSq, 0));
  assert.ok(!rectAt(blackSq, 40), '活子不画方块');
  assert.ok(rectAt(whiteSq, 43));
  assert.ok(!rectAt(whiteSq, 42));
  assert.ok(!squares.some((o) => rectAt(o, 44)), '无主点不画');
  // 属黑的点：除 40（活黑）、42/43（属白）、44（无主）以外的 77 个，含死白子 41
  assert.equal(blackSq.path.length, 77);
  // 方块带细的深色描边（白方块在浅色背景上也看得清），每种颜色一次
  const outlines = ctx.ops.filter((o) => o.type === 'stroke' && o.path.length && o.path[0][0] === 'rect');
  assert.equal(outlines.length, 2);
  assert.ok(outlines.every((o) => o.strokeStyle === D.COLORS.edge && o.lineWidth < 1));
});

test('marks：owner 长度不符时不画地盘；marks 为 null 时与 v1 一致', () => {
  const cells = new Array(81).fill(0);
  cells[41] = 2;
  let ctx = draw({ cells, marks: { dead: [41], owner: [1, 2] } });
  assert.ok(!ctx.ops.some((o) => o.path && o.path.length && o.path[0][0] === 'rect'));
  assert.equal(fillsAt(ctx, 41, STONE_R)[0].alpha, D.DEAD_ALPHA);
  ctx = draw({ cells, marks: null });
  assert.equal(fillsAt(ctx, 41, STONE_R)[0].alpha, 1);
  assert.ok(!ctx.ops.some((o) => o.strokeStyle === D.COLORS.deadCross));
  ctx = draw({ cells, marks: { dead: 'x', owner: null } });
  assert.equal(fillsAt(ctx, 41, STONE_R)[0].alpha, 1);
});

test('13/19 路星位数量', () => {
  for (const n of [13, 19]) {
    const ctx = new FakeCtx();
    D.drawBoard(ctx, { cssSize: 400, size: n, cells: [], lastIdx: -1 });
    const stars = ctx.ops.find((o) => o.type === 'fill');
    assert.equal(arcsIn(stars).length, 9);
  }
  const ctx = new FakeCtx();
  D.drawBoard(ctx, { cssSize: 400, size: 5, cells: [], lastIdx: -1 });
  assert.equal(ctx.ops.filter((o) => o.type === 'fill').length, 0, '无星位预设的路数不画星位');
});

test('canvasScale：绘图缓冲区不超过 1365×1365（大屏降低倍数），普通手机保持 pixelRatio', () => {
  assert.equal(D.MAX_CANVAS_PX, 1365);
  assert.equal(D.canvasScale(375, 2), 2);
  assert.equal(D.canvasScale(414, 3), 3); // 1242
  assert.equal(D.canvasScale(430, 3), 3); // 1290
  // 1440 宽的安卓旗舰：411.4 × 3.5 = 1440 → 降到 1365
  const s1 = D.canvasScale(411.4, 3.5);
  assert.ok(s1 < 3.5);
  assert.ok(Math.round(411.4 * s1) <= 1365);
  // iPad：768 × 2 = 1536 → 降到 1365；560（样式里的最大边长）× 3 → 1365
  assert.ok(Math.round(768 * D.canvasScale(768, 2)) <= 1365);
  assert.ok(Math.round(560 * D.canvasScale(560, 3)) <= 1365);
  // 参数异常时退回合理值
  assert.equal(D.canvasScale(0, 2), 2);
  assert.equal(D.canvasScale(300, undefined), 1);
  assert.equal(D.canvasScale(300, NaN), 1);
});
