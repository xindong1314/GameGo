'use strict';

// 小程序联网配置（设计文档 8.1）。
//
// 本地开发：运行 `npm run config:local` 自动生成不提交 Git 的 config.local.js，
//           手机与电脑需连接同一个 Wi-Fi，并在开发者工具"详情 → 本地设置"里勾选"不校验合法域名"。
// 正式上线：
//   1. API_BASE 改为 'https://你的域名'，WS_URL 改为 'wss://你的域名/ws'（必须是 https / wss）；
//   2. 在小程序后台"开发管理 → 服务器域名"里把该域名加入 request、socket、uploadFile 合法域名；
//   3. DEV_LOGIN 改为 false（服务端 DEV_LOGIN 也必须为 0），只走微信登录。
const defaults = {
  API_BASE: 'http://127.0.0.1:8080',
  WS_URL: 'ws://127.0.0.1:8080/ws',
  DEV_LOGIN: true,
};

let local = {};
try {
  // 此文件由 npm run config:local 生成，并由 .gitignore 排除。
  local = require('./config.local');
} catch (_) {
  // 未生成本地配置时使用默认地址，适合微信开发者工具在本机调试。
}

module.exports = {
  API_BASE: local.API_BASE || defaults.API_BASE,
  WS_URL: local.WS_URL || defaults.WS_URL,
  DEV_LOGIN: typeof local.DEV_LOGIN === 'boolean' ? local.DEV_LOGIN : defaults.DEV_LOGIN,
};
