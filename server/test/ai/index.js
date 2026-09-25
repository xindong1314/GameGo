'use strict';
// `node --test test/ai/` 在 Node 22 上会把目录当作模块执行（即这个 index.js），
// 这里把本目录下的 *.test.js 全部加载进来。`npm test` 用 "test/**/*.test.js" 通配，不会加载本文件，不会重复运行。
const fs = require('node:fs');
const path = require('node:path');

for (const f of fs.readdirSync(__dirname).filter((name) => name.endsWith('.test.js')).sort()) {
  require(path.join(__dirname, f));
}
