'use strict';

// 棋盘几何与绘制（纯函数，不依赖 wx，Node 可直接 require）。
// 坐标一律是画布的 CSS 像素：组件已经用 ctx.scale 把绘图缓冲区的倍数处理掉了。
// 几何：四周各留一格边距，格距 cell = cssSize / (n + 1)，第 i 条线在 cell * (i + 1)。

const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

// 小程序 Canvas 2D 的绘图缓冲区边长上限（超过会画不出来或被截断）
const MAX_CANVAS_PX = 1365;

// 以下尺寸都以"格"为单位
const STONE_RADIUS = 0.47; // 棋子半径
const LAST_MARK_RADIUS = 0.2; // 最后一手圆环半径
const STAR_RADIUS = 0.1; // 星位半径
const SQUARE_SIZE = 0.34; // 地盘方块边长
const CROSS_ARM = 0.22; // 死子红叉的半臂长

const PREVIEW_ALPHA = 0.5; // 预览子透明度
const DEAD_ALPHA = 0.45; // 死子透明度
const ILLEGAL_RING_WIDTH = 3; // 非法预览红圈线宽（CSS 像素）
const TERRITORY_EDGE_WIDTH = 0.75; // 地盘方块描边线宽（CSS 像素）

const COLORS = {
  wood: '#e3b96b',
  line: '#5a3d1e',
  star: '#5a3d1e',
  black: '#111',
  white: '#fafafa',
  edge: '#333', // 棋子描边
  markOnBlack: '#fff', // 黑子上的最后一手标记
  markOnWhite: '#111', // 白子上的最后一手标记
  illegal: '#e53935',
  deadCross: '#d32f2f',
};

// 星位所在的线号（横竖取笛卡尔积）；没有预设的路数不画星位
const STAR_LINES = {
  9: [2, 4, 6],
  13: [3, 6, 9],
  19: [3, 9, 15],
};

const FULL_CIRCLE = Math.PI * 2;

function isPositive(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function isBoardSize(n) {
  return Number.isInteger(n) && n > 0;
}

function isCoord(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isStone(c) {
  return c === BLACK || c === WHITE;
}

function stoneColor(c) {
  return c === BLACK ? COLORS.black : COLORS.white;
}

// 触点 (x, y)（CSS 像素）→ 最近的交叉点索引；落在棋盘外（离边线超过半格）或参数无效时返回 -1
function hitTest(cssSize, n, x, y) {
  if (!isPositive(cssSize) || !isBoardSize(n) || !isCoord(x) || !isCoord(y)) return -1;
  const cell = cssSize / (n + 1);
  // 第 i 条线在 cell * (i + 1)，最近的线号 = round(v / cell - 1) = floor(v / cell - 0.5)
  const col = Math.floor(x / cell - 0.5);
  const row = Math.floor(y / cell - 0.5);
  if (col < 0 || col >= n || row < 0 || row >= n) return -1;
  return row * n + col;
}

// 绘图缓冲区相对 CSS 像素的倍数：通常就是屏幕像素比，但缓冲区边长不能超过 MAX_CANVAS_PX
function canvasScale(cssSize, pixelRatio) {
  const ratio = isPositive(pixelRatio) ? pixelRatio : 1;
  if (!isPositive(cssSize)) return ratio;
  return Math.min(ratio, MAX_CANVAS_PX / cssSize);
}

// ---------- 数据整理：把外部传入的数据规整成绘制用的形式，非法值一律忽略 ----------

// 棋子：长度 n*n，每项 0/1/2；超出棋盘的部分与非法颜色当作空点
function readStones(cells, total) {
  const out = new Array(total).fill(EMPTY);
  if (!cells || typeof cells.length !== 'number') return out;
  const len = Math.min(total, cells.length);
  for (let i = 0; i < len; i++) {
    if (isStone(cells[i])) out[i] = cells[i];
  }
  return out;
}

// 数子标记：dead 只认棋盘内、确实有子的点；owner 长度必须恰好是 n*n，否则不画地盘
function readMarks(marks, stones, total) {
  const dead = new Array(total).fill(false);
  let owner = null;
  if (!marks || typeof marks !== 'object') return { dead, owner };
  if (Array.isArray(marks.dead)) {
    marks.dead.forEach((idx) => {
      if (Number.isInteger(idx) && idx >= 0 && idx < total && stones[idx] !== EMPTY) dead[idx] = true;
    });
  }
  if (Array.isArray(marks.owner) && marks.owner.length === total) owner = marks.owner;
  return { dead, owner };
}

function validIndex(idx, total) {
  return Number.isInteger(idx) && idx >= 0 && idx < total;
}

// ---------- 绘制各层 ----------

function makeGeometry(cssSize, n) {
  const cell = cssSize / (n + 1);
  return {
    n,
    cell,
    // 交叉点 idx 的圆心（CSS 像素）
    x: (idx) => cell * ((idx % n) + 1),
    y: (idx) => cell * (Math.floor(idx / n) + 1),
  };
}

// 在当前路径里追加一个整圆（先 moveTo 到圆周上，避免和上一个圆连成线）
function addCircle(ctx, cx, cy, r) {
  ctx.moveTo(cx + r, cy);
  ctx.arc(cx, cy, r, 0, FULL_CIRCLE);
}

function drawGrid(ctx, g) {
  const first = g.cell;
  const last = g.cell * g.n;
  ctx.beginPath();
  for (let i = 0; i < g.n; i++) {
    const p = g.cell * (i + 1);
    ctx.moveTo(first, p);
    ctx.lineTo(last, p);
  }
  for (let i = 0; i < g.n; i++) {
    const p = g.cell * (i + 1);
    ctx.moveTo(p, first);
    ctx.lineTo(p, last);
  }
  ctx.strokeStyle = COLORS.line;
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawStars(ctx, g) {
  const lines = STAR_LINES[g.n];
  if (!lines) return;
  const r = Math.max(1.5, g.cell * STAR_RADIUS);
  ctx.beginPath();
  lines.forEach((row) => {
    lines.forEach((col) => {
      addCircle(ctx, g.cell * (col + 1), g.cell * (row + 1), r);
    });
  });
  ctx.fillStyle = COLORS.star;
  ctx.fill();
}

// 一批同色棋子合并成一条路径：一次填充、一次描边
function drawStoneBatch(ctx, g, list, color, alpha) {
  if (!list.length) return;
  const r = g.cell * STONE_RADIUS;
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  list.forEach((idx) => addCircle(ctx, g.x(idx), g.y(idx), r));
  ctx.fillStyle = stoneColor(color);
  ctx.fill();
  ctx.strokeStyle = COLORS.edge;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawStones(ctx, g, stones, dead) {
  const live = { [BLACK]: [], [WHITE]: [] };
  const gone = { [BLACK]: [], [WHITE]: [] };
  stones.forEach((c, idx) => {
    if (c === EMPTY) return;
    (dead[idx] ? gone : live)[c].push(idx);
  });
  drawStoneBatch(ctx, g, live[BLACK], BLACK, 1);
  drawStoneBatch(ctx, g, live[WHITE], WHITE, 1);
  drawStoneBatch(ctx, g, gone[BLACK], BLACK, DEAD_ALPHA);
  drawStoneBatch(ctx, g, gone[WHITE], WHITE, DEAD_ALPHA);
}

// 最后一手：棋子中心的小圆环，颜色与棋子相反；该点没有棋子（例如已被提走）就不画
function drawLastMove(ctx, g, stones, lastIdx) {
  if (!validIndex(lastIdx, stones.length)) return;
  const c = stones[lastIdx];
  if (c === EMPTY) return;
  ctx.beginPath();
  addCircle(ctx, g.x(lastIdx), g.y(lastIdx), g.cell * LAST_MARK_RADIUS);
  ctx.strokeStyle = c === BLACK ? COLORS.markOnBlack : COLORS.markOnWhite;
  ctx.lineWidth = Math.max(1, g.cell * 0.08);
  ctx.stroke();
}

// 预览子：空点上画半透明的子；非法（ok 为假）时再套一个红圈。已有子的点只套红圈，不叠画
function drawPreview(ctx, g, stones, preview) {
  if (!preview || typeof preview !== 'object') return;
  const idx = preview.idx;
  if (!validIndex(idx, stones.length)) return;
  const cx = g.x(idx);
  const cy = g.y(idx);
  const r = g.cell * STONE_RADIUS;
  if (stones[idx] === EMPTY && isStone(preview.color)) {
    ctx.globalAlpha = PREVIEW_ALPHA;
    ctx.beginPath();
    addCircle(ctx, cx, cy, r);
    ctx.fillStyle = stoneColor(preview.color);
    ctx.fill();
    ctx.strokeStyle = COLORS.edge;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  if (!preview.ok) {
    ctx.beginPath();
    addCircle(ctx, cx, cy, r);
    ctx.strokeStyle = COLORS.illegal;
    ctx.lineWidth = ILLEGAL_RING_WIDTH;
    ctx.stroke();
  }
}

// 地盘：owner 为 1/2 的空点与死子点画所属方颜色的小方块（活子处不画），方块带细描边
function drawTerritory(ctx, g, stones, dead, owner) {
  if (!owner) return;
  const s = g.cell * SQUARE_SIZE;
  [BLACK, WHITE].forEach((color) => {
    const list = [];
    for (let idx = 0; idx < stones.length; idx++) {
      if (owner[idx] !== color) continue;
      if (stones[idx] !== EMPTY && !dead[idx]) continue;
      list.push(idx);
    }
    if (!list.length) return;
    ctx.beginPath();
    list.forEach((idx) => ctx.rect(g.x(idx) - s / 2, g.y(idx) - s / 2, s, s));
    ctx.fillStyle = stoneColor(color);
    ctx.fill();
    // 细的深色描边：白方块落在木色底或半透明的白色死子上时也能看清
    ctx.strokeStyle = COLORS.edge;
    ctx.lineWidth = TERRITORY_EDGE_WIDTH;
    ctx.stroke();
  });
}

// 死子：棋子上画红叉（每个死子两笔）
function drawDeadCrosses(ctx, g, dead) {
  const a = g.cell * CROSS_ARM;
  let any = false;
  ctx.beginPath();
  dead.forEach((isDead, idx) => {
    if (!isDead) return;
    any = true;
    const cx = g.x(idx);
    const cy = g.y(idx);
    ctx.moveTo(cx - a, cy - a);
    ctx.lineTo(cx + a, cy + a);
    ctx.moveTo(cx + a, cy - a);
    ctx.lineTo(cx - a, cy + a);
  });
  if (!any) return;
  ctx.strokeStyle = COLORS.deadCross;
  ctx.lineWidth = Math.max(1.5, g.cell * 0.08);
  ctx.stroke();
}

// 画整个棋盘。opts：{ cssSize, size, cells, lastIdx, preview, marks }
// 顺序：清屏 → 木色底 → 网格 → 星位 → 棋子（死子半透明）→ 最后一手 → 预览子 → 地盘方块 → 死子红叉
function drawBoard(ctx, opts) {
  if (!ctx || !opts) return;
  const cssSize = opts.cssSize;
  const n = opts.size;
  if (!isPositive(cssSize) || !isBoardSize(n)) return;

  const total = n * n;
  const g = makeGeometry(cssSize, n);
  const stones = readStones(opts.cells, total);
  const { dead, owner } = readMarks(opts.marks, stones, total);

  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, cssSize, cssSize);
  ctx.fillStyle = COLORS.wood;
  ctx.fillRect(0, 0, cssSize, cssSize);

  drawGrid(ctx, g);
  drawStars(ctx, g);
  drawStones(ctx, g, stones, dead);
  drawLastMove(ctx, g, stones, opts.lastIdx);
  drawPreview(ctx, g, stones, opts.preview);
  drawTerritory(ctx, g, stones, dead, owner);
  drawDeadCrosses(ctx, g, dead);
}

module.exports = {
  drawBoard,
  hitTest,
  canvasScale,
  MAX_CANVAS_PX,
  STONE_RADIUS,
  LAST_MARK_RADIUS,
  SQUARE_SIZE,
  PREVIEW_ALPHA,
  DEAD_ALPHA,
  COLORS,
  STAR_LINES,
};
