'use strict';

const auth = require('./utils/net/auth');
const socketModule = require('./utils/net/socket');
const { createGameStartNotifier } = require('./utils/friend-start');

const socket = typeof socketModule.on === 'function' ? socketModule : socketModule.socket;

App({
  globalData: {},

  // 启动时静默登录，失败不打扰用户：页面联网前会再次 ensureLogin 并提示错误。
  // WebSocket 不在这里连，由需要联网的页面调用 socket.connect()。
  onLaunch() {
    auth.ensureLogin().catch((err) => {
      console.warn('[app] 自动登录失败，稍后联网时重试', err);
    });
    // 开局通知在匹配页/好友房页之外到达（房主离开了等待页；离开匹配页的同时正好配对成功）：
    // 在任意页面提示并进入对局（设计文档 8.3，只注册一次）
    if (!this.gameStartNotifier) {
      const notifier = createGameStartNotifier({
        wxApi: wx,
        getPages: () => (typeof getCurrentPages === 'function' ? getCurrentPages() : []),
      });
      this.gameStartNotifier = notifier;
      socket.on('game.start', (msg) => notifier.onGameStart(msg));
      socket.on('match.found', (msg) => notifier.onMatchFound(msg));
    }
  },
});
