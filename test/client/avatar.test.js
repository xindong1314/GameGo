'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '../../miniprogram/components/avatar');

// 用假的 Component() 取到组件定义
function loadDefinition() {
  let def = null;
  global.Component = (d) => { def = d; };
  const file = path.join(DIR, 'avatar.js');
  delete require.cache[require.resolve(file)];
  try {
    require(file);
  } finally {
    delete global.Component;
  }
  return def;
}

// 极简组件实例：properties 默认值 + data，setProp 模拟父组件改属性（触发 observer）
function mount(def, props = {}) {
  const data = {};
  for (const [k, p] of Object.entries(def.properties)) data[k] = p.value;
  Object.assign(data, JSON.parse(JSON.stringify(def.data)), props);
  const inst = {
    data,
    setData(patch) {
      Object.assign(this.data, patch);
    },
  };
  for (const [k, fn] of Object.entries(def.methods)) inst[k] = fn.bind(inst);
  inst.setProp = (key, value) => {
    inst.data[key] = value;
    if (def.observers[key]) def.observers[key].call(inst, value);
  };
  def.lifetimes.attached.call(inst);
  return inst;
}

test('属性定义：src / name / size(rpx)', () => {
  const def = loadDefinition();
  assert.deepEqual(Object.keys(def.properties).sort(), ['name', 'size', 'src']);
  assert.equal(def.properties.size.type, Number);
  assert.equal(def.properties.size.value, 80);
  assert.deepEqual(def.externalClasses, ['custom-class']);
});

test('没有头像：显示昵称首字与稳定底色；尺寸换算', () => {
  const def = loadDefinition();
  const inst = mount(def, { name: '棋圣', size: 120 });
  assert.equal(inst.data.initial, '棋');
  assert.match(inst.data.bg, /^#[0-9a-f]{6}$/);
  assert.equal(inst.data.box, 120);
  assert.equal(inst.data.font, 54);
  inst.setProp('name', 'bob');
  assert.equal(inst.data.initial, 'B');
  inst.setProp('name', '');
  assert.equal(inst.data.initial, '?');
  inst.setProp('size', 0);
  assert.equal(inst.data.box, 80);
  inst.setProp('size', NaN);
  assert.equal(inst.data.box, 80);
});

test('图片加载失败回退到首字；换新地址重新尝试，同一个失败地址不再反复加载', () => {
  const def = loadDefinition();
  const inst = mount(def, { src: 'http://a/1.png', name: 'A' });
  assert.equal(inst.data.failed, false);
  const warn = console.warn;
  console.warn = () => {};
  try {
    inst.onImageError({ detail: { errMsg: '404' } });
  } finally {
    console.warn = warn;
  }
  assert.equal(inst.data.failed, true);
  inst.setProp('src', 'http://a/1.png');
  assert.equal(inst.data.failed, true);
  inst.setProp('src', 'http://a/2.png');
  assert.equal(inst.data.failed, false);
  inst.setProp('src', '');
  assert.equal(inst.data.failed, false);
});

test('WXML 引用的数据与事件处理函数都存在', () => {
  const def = loadDefinition();
  const wxml = fs.readFileSync(path.join(DIR, 'avatar.wxml'), 'utf8');
  const known = new Set([...Object.keys(def.properties), ...Object.keys(def.data)]);
  const names = new Set();
  for (const m of wxml.matchAll(/\{\{([^}]+)\}\}/g)) {
    for (const id of m[1].match(/[A-Za-z_$][\w$]*/g) || []) names.add(id);
  }
  for (const id of names) assert.ok(known.has(id), `WXML 用到未定义的 ${id}`);
  for (const m of wxml.matchAll(/bind\w+="(\w+)"/g)) {
    assert.equal(typeof def.methods[m[1]], 'function', `缺少事件处理函数 ${m[1]}`);
  }
  const json = JSON.parse(fs.readFileSync(path.join(DIR, 'avatar.json'), 'utf8'));
  assert.equal(json.component, true);
  assert.ok(fs.existsSync(path.join(DIR, 'avatar.wxss')));
});
