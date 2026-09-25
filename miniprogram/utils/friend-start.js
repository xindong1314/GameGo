'use strict';
// 开局通知（设计文档 8.3）：match.found、game.start 可能在匹配页/好友房页之外到达，应用层收到时提示并进入对局页。
//   - 好友房：房主离开等待页后房间仍保留（见 pages/room/room.js 开头的说明），好友加入时服务端向双方推送
//     game.start { gameId, mode: 'friend' }。好友房页自己会跳转；房主在其他页面时由这里提示。
//   - 排位赛：匹配成功推送 match.found { gameId }。匹配页自己会跳转；但用户可能在服务端配对的同时离开了匹配页
//     （点"取消"或"改为人机对弈"，match.cancel 还没到服务端就已配对），这时匹配页已不再监听，由这里提示。
// 不提示的话，执黑时 60 秒不落第一手对局就作废（对手白等），执白时读秒白白流失。

const ROOM_ROUTE = 'pages/room/room';
const MATCH_ROUTE = 'pages/match/match';
const PLAY_ROUTE = 'pages/play/play';
const GAME_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const KINDS = {
  friend: { ownRoute: ROOM_ROUTE, title: '好友已加入', content: '你的好友房已开局，快去落子吧。' },
  ranked: { ownRoute: MATCH_ROUTE, title: '匹配成功', content: '快速匹配已为你找到对手，快去落子吧。' },
};

function routeOf(page) {
  if (!page || typeof page !== 'object') return '';
  const r = page.route || page.__route__ || '';
  return String(r).replace(/^\//, '');
}

// wxApi：wx；getPages：getCurrentPages。
// 返回 { onGameStart(msg), onMatchFound(msg) }：推送处理函数，返回是否弹出了提示。
function createGameStartNotifier({ wxApi, getPages }) {
  const notified = new Set();

  function open(url) {
    wxApi.navigateTo({
      url,
      // 页面栈满（10 层）等情况：改用 redirectTo，再不行就 reLaunch
      fail: () => wxApi.redirectTo({ url, fail: () => wxApi.reLaunch({ url }) }),
    });
  }

  function notify(id, kind) {
    if (typeof id !== 'string' || !GAME_ID_RE.test(id)) return false;
    const k = KINDS[kind];
    let pages = [];
    try {
      pages = (typeof getPages === 'function' && getPages()) || [];
    } catch (err) {
      pages = [];
    }
    const top = pages[pages.length - 1];
    const route = routeOf(top);
    if (route === k.ownRoute) return false; // 好友房页 / 匹配页自己跳转
    if (route === PLAY_ROUTE && top.options && top.options.id === id) return false;
    if (notified.has(id)) return false;
    notified.add(id);
    const url = '/pages/play/play?id=' + encodeURIComponent(id);
    wxApi.showModal({
      title: k.title,
      content: k.content,
      confirmText: '进入对局',
      showCancel: false,
      success: () => open(url),
      fail: () => open(url),
    });
    return true;
  }

  return {
    onGameStart(msg) {
      if (!msg || (msg.mode !== undefined && msg.mode !== 'friend')) return false;
      return notify(msg.gameId, 'friend');
    },
    onMatchFound(msg) {
      return notify(msg && msg.gameId, 'ranked');
    },
  };
}

// 兼容旧接口：只处理好友房的 game.start
function createFriendStartNotifier(opts) {
  return createGameStartNotifier(opts).onGameStart;
}

module.exports = { createGameStartNotifier, createFriendStartNotifier };
