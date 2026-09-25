'use strict';

// 小程序联网配置（设计文档 8.1）。
//
// 本地开发：把 192.168.1.100 换成运行服务端的电脑的局域网 IP（手机与电脑连同一个 Wi-Fi），
//           并在开发者工具"详情 → 本地设置"里勾选"不校验合法域名"。
// 正式上线：
//   1. API_BASE 改为 'https://你的域名'，WS_URL 改为 'wss://你的域名/ws'（必须是 https / wss）；
//   2. 在小程序后台"开发管理 → 服务器域名"里把该域名加入 request、socket、uploadFile 合法域名；
//   3. DEV_LOGIN 改为 false（服务端 DEV_LOGIN 也必须为 0），只走微信登录。
module.exports = {
  API_BASE: 'http://192.168.1.100:8080', // 本地开发：电脑的局域网 IP；上线改为 https://你的域名
  WS_URL: 'ws://192.168.1.100:8080/ws', // 上线改为 wss://你的域名/ws
  DEV_LOGIN: true, // 服务端未配置微信 AppSecret 时使用开发登录
};
