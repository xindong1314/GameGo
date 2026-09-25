'use strict';
// 静态检查（没有开发者工具时的兜底）：app.json 注册、页面文件齐全、JSON 合法、
// WXML 标签配对且事件处理函数都在页面里定义、WXSS 花括号配对。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./pages-harness');

const ROOT = h.MINI_ROOT;
const OWNED = ['index', 'local', 'profile', 'match', 'room', 'ai', 'leaderboard', 'me', 'game', 'play', 'replay'];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// 极简 WXML 解析：返回 { tags: [{ name, attrs: {k: v} }], errors: [] }，检查开闭标签配对与 {{ }} 配对
function parseWxml(src) {
  const errors = [];
  const tags = [];
  const stack = [];
  let i = 0;
  const text = (s) => {
    if ((s.match(/\{\{/g) || []).length !== (s.match(/\}\}/g) || []).length) errors.push('文本里的 {{ }} 不配对：' + s.trim().slice(0, 40));
  };
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      text(src.slice(i));
      break;
    }
    text(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt);
      if (end < 0) {
        errors.push('注释未闭合');
        break;
      }
      i = end + 3;
      continue;
    }
    // 读到标签结束的 '>'（跳过引号里的内容）
    let j = lt + 1;
    let quote = '';
    while (j < src.length) {
      const c = src[j];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        break;
      }
      j++;
    }
    if (j >= src.length) {
      errors.push('标签未闭合：' + src.slice(lt, lt + 40));
      break;
    }
    const raw = src.slice(lt + 1, j);
    i = j + 1;
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim();
      const top = stack.pop();
      if (top !== name) errors.push(`闭合标签 </${name}> 与 <${top}> 不匹配`);
      continue;
    }
    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const m = /^([A-Za-z][\w-]*)/.exec(body);
    if (!m) {
      errors.push('无法解析标签：' + raw.slice(0, 40));
      continue;
    }
    const attrs = {};
    const re = /([A-Za-z_:][\w:.-]*)(?:\s*=\s*("([^"]*)"|'([^']*)'))?/g;
    re.lastIndex = m[1].length;
    let a;
    while ((a = re.exec(body))) {
      const value = a[3] !== undefined ? a[3] : a[4] !== undefined ? a[4] : true;
      if (typeof value === 'string' && (value.match(/\{\{/g) || []).length !== (value.match(/\}\}/g) || []).length) {
        errors.push(`属性 ${a[1]} 的 {{ }} 不配对`);
      }
      attrs[a[1]] = value;
    }
    tags.push({ name: m[1], attrs });
    if (!selfClosing) stack.push(m[1]);
  }
  if (stack.length) errors.push('未闭合的标签：' + stack.join(', '));
  return { tags, errors };
}

function handlersOf(tags) {
  const out = [];
  tags.forEach((t) => {
    Object.keys(t.attrs).forEach((k) => {
      if (/^(capture-)?(bind|catch|mut-bind)(:)?[a-z]+$/.test(k)) out.push({ attr: k, handler: t.attrs[k], tag: t.name });
    });
  });
  return out;
}

test('app.json：注册全部页面（首页在最前）与全局头像组件，保留窗口样式', () => {
  const app = JSON.parse(read('app.json'));
  assert.deepEqual(app.pages, [
    'pages/index/index',
    'pages/local/local',
    'pages/game/game',
    'pages/profile/profile',
    'pages/match/match',
    'pages/room/room',
    'pages/ai/ai',
    'pages/play/play',
    'pages/replay/replay',
    'pages/leaderboard/leaderboard',
    'pages/me/me',
  ]);
  assert.equal(app.usingComponents.avatar, '/components/avatar/avatar');
  assert.equal(app.window.navigationBarBackgroundColor, '#3b2a1a');
  assert.equal(app.window.backgroundColor, '#f5efe6');
  assert.equal(app.sitemapLocation, 'sitemap.json');
});

test('app.wxss：保留原有 .btn 类，新增共用类花括号配对', () => {
  const css = read('app.wxss');
  for (const sel of ['.btn {', '.btn.primary {', '.btn.danger {', '.btn[disabled] {', '.ui-card {', '.ui-seg-item.active {', '.ui-netbar {', '.ui-empty {']) {
    assert.ok(css.includes(sel), sel);
  }
  assert.equal((css.match(/\{/g) || []).length, (css.match(/\}/g) || []).length);
});

for (const name of OWNED) {
  test(`页面 ${name}：文件齐全、JSON 合法、WXML 结构正确、事件处理函数存在`, () => {
    const base = `pages/${name}/${name}`;
    for (const ext of ['js', 'json', 'wxml', 'wxss']) {
      assert.ok(fs.existsSync(path.join(ROOT, `${base}.${ext}`)), `${base}.${ext} 缺失`);
    }
    const json = JSON.parse(read(`${base}.json`));
    assert.equal(typeof json.navigationBarTitleText, 'string');

    const css = read(`${base}.wxss`);
    assert.equal((css.match(/\{/g) || []).length, (css.match(/\}/g) || []).length, 'WXSS 花括号不配对');
    assert.ok(!/:(nth-child|first-of-type|last-of-type|not)\(/.test(css), '避免使用 WXSS 不保证支持的伪类');

    const { tags, errors } = parseWxml(read(`${base}.wxml`));
    assert.deepEqual(errors, []);
    assert.ok(tags.length > 0);

    const def = h.loadPageDef(`${name}/${name}`, h.createEnv());
    const handlers = handlersOf(tags);
    for (const { attr, handler, tag } of handlers) {
      assert.match(handler, /^[A-Za-z_]\w*$/, `<${tag} ${attr}> 的处理函数名`);
      assert.equal(typeof def[handler], 'function', `<${tag} ${attr}="${handler}"> 在页面里没有定义`);
    }
    // wx:key 只能是 *this 或列表项的属性名（'index' 不是属性）
    tags.filter((tg) => tg.attrs['wx:key'] !== undefined).forEach((tg) => {
      const key = tg.attrs['wx:key'];
      assert.ok(key === '*this' || (/^[A-Za-z_]\w*$/.test(key) && key !== 'index'), `<${tg.name} wx:key="${key}">`);
      assert.ok(tg.attrs['wx:for'] !== undefined, `<${tg.name}> 有 wx:key 却没有 wx:for`);
    });
    const src = read(`${base}.wxml`);
    assert.ok(!/wx:else\s*=/.test(src), 'wx:else 不带值');
  });
}

test('parseWxml 自检：能发现不配对的标签与花括号', () => {
  assert.deepEqual(parseWxml('<view a="{{x > 1}}"><text>{{a}}</text></view>').errors, []);
  assert.ok(parseWxml('<view><text></view>').errors.length > 0);
  assert.ok(parseWxml('<view>{{a</view>').errors.length > 0);
  assert.ok(parseWxml('<view a="{{b"></view>').errors.length > 0);
  assert.ok(parseWxml('<view>').errors.length > 0);
  assert.deepEqual(handlersOf(parseWxml('<button bindtap="a" catch:tap="b" bindchooseavatar="c" class="d" />').tags).map((x) => x.handler), ['a', 'b', 'c']);
});

test('分享：好友房页面与首页定义了 onShareAppMessage', () => {
  for (const name of ['room', 'index']) {
    const def = h.loadPageDef(`${name}/${name}`, h.createEnv());
    assert.equal(typeof def.onShareAppMessage, 'function', name);
  }
  const room = read('pages/room/room.wxml');
  assert.ok(/open-type="share"/.test(room), '等待界面有邀请好友的分享按钮');
  const profile = read('pages/profile/profile.wxml');
  assert.ok(/open-type="chooseAvatar"/.test(profile));
  assert.ok(/type="nickname"/.test(profile));
  assert.ok(/open-type="agreePrivacyAuthorization"/.test(profile));
  assert.ok(/form-type="submit"/.test(profile));
});

test('需要下拉刷新的页面在 json 里开启', () => {
  for (const name of ['leaderboard', 'me']) {
    assert.equal(JSON.parse(read(`pages/${name}/${name}.json`)).enablePullDownRefresh, true, name);
  }
});

test('WXSS 不用 flex 的 gap（iOS 14.5 以下的 WebView 不支持，按钮会挤在一起），间距用 margin', () => {
  const files = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.wxss')) files.push(p);
    }
  };
  walk(ROOT);
  assert.ok(files.length >= 12);
  for (const f of files) {
    const css = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/(^|[\s;{])(row-|column-)?gap\s*:/.test(css), path.relative(ROOT, f));
  }
});
