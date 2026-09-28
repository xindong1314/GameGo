'use strict';

// 复制为 config.local.js 后填写运行服务端的电脑局域网地址。
// 推荐直接运行：npm run config:local
module.exports = {
  API_BASE: 'http://192.168.1.100:8080',
  WS_URL: 'ws://192.168.1.100:8080/ws',
  DEV_LOGIN: true,
};
