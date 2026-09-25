'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTouchTracker } = require('../../miniprogram/components/goboard/touch');

const COMPONENT = path.resolve(__dirname, '../../miniprogram/components/goboard/goboard.js');

test('tracker：按下即 pick；移动到新点再 pick；同一点不重复', () => {
  const t = createTouchTracker();
  assert.equal(t.move(3), -1, '未按下时移动无效');
  assert.equal(t.start(0), 0);
  assert.equal(t.move(0), -1);
  assert.equal(t.move(1), 1);
  assert.equal(t.move(-1), -1, '离开棋盘');
  assert.equal(t.move(1), -1, '离开后回到同一点不重复（v1 行为）');
  assert.equal(t.move(0), 0);
  assert.equal(t.isActive(), true);
});

test('tracker：抬起位置与按下位置相同才 tap', () => {
  const t = createTouchTracker();
  t.start(5);
  assert.equal(t.end(5), 5);
  assert.equal(t.isActive(), false);
  assert.equal(t.end(5), -1, '没有按下时抬起无效');

  t.start(5);
  t.move(6);
  assert.equal(t.end(6), -1, '拖到别的点抬起');

  t.start(5);
  t.move(6);
  t.move(5);
  assert.equal(t.end(5), 5, '拖出去又回到原点抬起仍算 tap');

  t.start(5);
  t.move(6);
  assert.equal(t.end(undefined), -1, '没有抬起坐标时按最后经过的点算');
  t.start(5);
  assert.equal(t.end(undefined), 5);

  t.start(-1);
  assert.equal(t.end(-1), -1, '在棋盘外按下不算');

  t.start(5);
  t.spoil();
  assert.equal(t.move(6), 6, '多指后 pick 继续');
  t.move(5);
  assert.equal(t.end(5), -1, '多指触摸不产生 tap');

  t.start(5);
  t.reset();
  assert.equal(t.end(5), -1, '取消后不产生 tap');
});

// ---- 组件：用最小的 Component 模拟跑真实的 goboard.js ----

function loadComponent({ disabled = false } = {}) {
  let def = null;
  global.Component = (d) => {
    def = d;
  };
  global.wx = { getWindowInfo: () => ({ pixelRatio: 2 }) };
  delete require.cache[COMPONENT];
  require(COMPONENT);
  delete global.Component;

  const inst = {
    data: {},
    events: [],
    triggerEvent(name, detail) {
      this.events.push([name, detail]);
    },
  };
  for (const [k, v] of Object.entries(def.properties)) inst.data[k] = v.value;
  Object.assign(inst, def.methods);
  // 属性变化 → observers（与小程序一样：一次 set 中涉及的字段只触发一次）
  inst.setProps = (props) => {
    Object.assign(inst.data, props);
    for (const [key, fn] of Object.entries(def.observers)) {
      const fields = key.split(',').map((s) => s.trim());
      if (fields.some((f) => f in props)) fn.apply(inst, fields.map((f) => inst.data[f]));
    }
  };
  def.lifetimes.attached.call(inst);
  inst.setProps({ size: 9, disabled });
  return { def, inst };
}

// 9 路、画布 200px：交叉点 i 在 20*(i+1)
const at = (x, y) => ({ x: 20 * (x + 1), y: 20 * (y + 1) });
const ev = (touches, changed) => ({ touches: touches || [], changedTouches: changed || [] });

function ready(inst) {
  inst.cssSize = 200;
}

test('组件：v1 接口不变，新增属性默认值不影响行为', () => {
  const { def } = loadComponent();
  assert.deepEqual(Object.keys(def.properties).sort(), ['cells', 'disabled', 'lastIdx', 'marks', 'preview', 'size']);
  assert.equal(def.properties.disabled.value, false);
  assert.equal(def.properties.marks.value, null);
  assert.equal(def.properties.lastIdx.value, -1);
});

test('组件：触摸产生 pick 与 tap', () => {
  const { inst } = loadComponent();
  ready(inst);
  inst.onTouchStart(ev([at(4, 4)]));
  inst.onTouchMove(ev([at(4, 4)]));
  inst.onTouchEnd(ev([], [at(4, 4)]));
  assert.deepEqual(inst.events, [
    ['pick', { idx: 40 }],
    ['tap', { idx: 40 }],
  ]);
  inst.events = [];
  inst.onTouchStart(ev([at(0, 0)]));
  inst.onTouchMove(ev([at(1, 0)]));
  inst.onTouchEnd(ev([], [at(1, 0)]));
  assert.deepEqual(inst.events, [
    ['pick', { idx: 0 }],
    ['pick', { idx: 1 }],
  ]);
  // 抬起时没有坐标：按最后经过的点
  inst.events = [];
  inst.onTouchStart(ev([at(2, 2)]));
  inst.onTouchEnd({});
  assert.deepEqual(inst.events, [
    ['pick', { idx: 20 }],
    ['tap', { idx: 20 }],
  ]);
  // 取消
  inst.events = [];
  inst.onTouchStart(ev([at(2, 2)]));
  inst.onTouchCancel();
  inst.onTouchEnd(ev([], [at(2, 2)]));
  assert.deepEqual(inst.events, [['pick', { idx: 20 }]]);
  // 原生 tap 被拦截（空函数，不抛错）
  assert.equal(inst.onNativeTap({ detail: { x: 1, y: 1 } }), undefined);
});

test('组件：disabled 时不响应触摸；按下后被禁用则丢弃该次触摸', () => {
  const { inst } = loadComponent({ disabled: true });
  ready(inst);
  inst.onTouchStart(ev([at(4, 4)]));
  inst.onTouchMove(ev([at(5, 4)]));
  inst.onTouchEnd(ev([], [at(5, 4)]));
  assert.deepEqual(inst.events, []);

  inst.setProps({ disabled: false });
  inst.onTouchStart(ev([at(4, 4)]));
  inst.setProps({ disabled: true });
  inst.setProps({ disabled: false });
  inst.onTouchEnd(ev([], [at(4, 4)]));
  assert.deepEqual(inst.events, [['pick', { idx: 40 }]], '中途被禁用过：不发 tap');
});

test('组件：多指触摸不产生 tap；棋盘外按下不发事件；画布未就绪不发事件', () => {
  const { inst } = loadComponent();
  ready(inst);
  inst.onTouchStart(ev([at(4, 4)]));
  inst.onTouchStart(ev([at(4, 4), at(6, 6)]));
  inst.onTouchEnd(ev([at(6, 6)], [at(4, 4)]));
  assert.deepEqual(inst.events, [['pick', { idx: 40 }]]);

  inst.events = [];
  inst.onTouchStart(ev([{ x: 3, y: 3 }]));
  inst.onTouchEnd(ev([], [{ x: 3, y: 3 }]));
  assert.deepEqual(inst.events, []);

  const other = loadComponent().inst; // cssSize 未设置
  other.onTouchStart(ev([at(4, 4)]));
  other.onTouchEnd(ev([], [at(4, 4)]));
  assert.deepEqual(other.events, []);
  other.onTouchStart(ev([]));
  other.onTouchMove(ev([]));
  assert.deepEqual(other.events, []);
});

test('组件：画布初始化后按 dpr 缩放并绘制；属性变化触发重绘', () => {
  const { inst } = loadComponent();
  const calls = [];
  const ctx = {
    scale: (a, b) => calls.push(['scale', a, b]),
    clearRect: () => calls.push(['clearRect']),
    fillRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    rect() {},
    fill() {},
    stroke() {},
  };
  const canvas = { getContext: (type) => (type === '2d' ? ctx : null) };
  inst.createSelectorQuery = () => ({
    select: () => ({
      fields: () => ({ exec: (cb) => cb([{ node: canvas, width: 300, height: 300 }]) }),
    }),
  });
  inst.draw();
  assert.equal(calls.length, 0, '画布就绪前不绘制');
  inst.initCanvas();
  assert.equal(canvas.width, 600);
  assert.equal(canvas.height, 600);
  assert.deepEqual(calls[0], ['scale', 2, 2]);
  assert.equal(calls.filter((c) => c[0] === 'clearRect').length, 1);
  inst.setProps({ marks: { dead: [], owner: [] } });
  inst.setProps({ cells: new Array(81).fill(0), lastIdx: 3 });
  assert.equal(calls.filter((c) => c[0] === 'clearRect').length, 3, '同一次 set 多个字段只重绘一次');
  inst.setProps({ disabled: true });
  assert.equal(calls.filter((c) => c[0] === 'clearRect').length, 3, 'disabled 变化不重绘');
});
