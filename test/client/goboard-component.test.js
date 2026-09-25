'use strict';
// 棋盘组件胶水：用假的 Component / wx / canvas 节点加载 goboard.js，检查画布缓冲区尺寸。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const FILE = path.join(__dirname, '..', '..', 'miniprogram', 'components', 'goboard', 'goboard.js');

function loadComponent() {
  let def = null;
  global.Component = (d) => {
    def = d;
  };
  try {
    delete require.cache[require.resolve(FILE)];
    require(FILE);
  } finally {
    delete global.Component;
  }
  return def;
}

// 创建组件实例并跑到 ready：canvas 节点的 css 宽度为 width，屏幕像素比为 pixelRatio
function mount(width, pixelRatio) {
  const def = loadComponent();
  const scaled = [];
  const canvas = {
    width: 300,
    height: 150,
    getContext: () => ({ scale: (x, y) => scaled.push([x, y]), clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, fill() {}, stroke() {}, closePath() {}, rect() {} }),
  };
  global.wx = { getWindowInfo: () => ({ pixelRatio }) };
  const inst = Object.assign({ data: { size: 19, cells: [], lastIdx: -1, preview: null, disabled: false, marks: null } }, def.methods);
  inst.createSelectorQuery = () => ({
    select: () => ({
      fields: () => ({
        exec: (cb) => cb([{ node: canvas, width, height: width }]),
      }),
    }),
  });
  def.lifetimes.attached.call(inst);
  def.lifetimes.ready.call(inst);
  delete global.wx;
  return { inst, canvas, scaled };
}

test('goboard：手机上缓冲区 = css 宽 × pixelRatio', () => {
  const { canvas, scaled, inst } = mount(375, 2);
  assert.equal(canvas.width, 750);
  assert.equal(canvas.height, 750);
  assert.deepEqual(scaled, [[2, 2]]);
  assert.equal(inst.cssSize, 375);
});

test('goboard：大屏（1440 宽安卓、iPad）缓冲区封顶 1365，触点换算仍用 css 像素', () => {
  for (const [w, r] of [[411.4, 3.5], [768, 2], [560, 3]]) {
    const { canvas, scaled, inst } = mount(w, r);
    assert.ok(canvas.width <= 1365, `${w}×${r} → ${canvas.width}`);
    assert.equal(canvas.height, canvas.width);
    assert.ok(scaled[0][0] < r);
    assert.equal(inst.cssSize, w);
    // 右下角交叉点（css 像素）仍然命中
    const cell = w / 20;
    assert.equal(inst.pointOf({ x: cell * 19, y: cell * 19 }), 360);
  }
});
