'use strict';
const auth = require('../../utils/net/auth');
const socketModule = require('../../utils/net/socket');
const guard = require('../../utils/guard');
const home = require('./home');
const { isTopPage } = require('../../utils/page-stack');

// 契约：socket.js 导出单例；兼容以 { socket } 形式导出
const socket = typeof socketModule.connect === 'function' ? socketModule : socketModule.socket;

const STORE_MATCH_SIZE = 'home.matchSize';
const STORE_ROOM = 'home.room';

function readStorage(key) {
  try {
    return wx.getStorageSync(key);
  } catch (e) {
    return '';
  }
}

function writeStorage(key, value) {
  try {
    wx.setStorageSync(key, value);
  } catch (e) {
    console.warn('[index] 本地存储写入失败', key, e);
  }
}

Page({
  data: {
    loginState: 'loading', // loading | ok | error
    loginError: '', // 登录失败的原因（如服务器未开启开发登录、网络不通）
    user: null,
    sizes: home.SIZES,
    matchSize: 19,
    banners: [],
    offline: false,
    kicked: false, // 账号在其他设备登录：不自动重连，等用户点"在本机重新连接"
    panel: false,
    roomSize: 19,
    roomColor: 'random',
    roomColors: home.ROOM_COLORS,
  },

  onLoad() {
    const room = readStorage(STORE_ROOM) || {};
    this.setData({
      matchSize: home.normalizeSize(readStorage(STORE_MATCH_SIZE), 19),
      roomSize: home.normalizeSize(room.size, 19),
      roomColor: home.normalizeRoomColor(room.color),
    });
    this.navigating = false;
    this.onSocketReady = (hello) => this.applyHello(hello);
    this.onSocketKicked = () => this.showKicked();
    // 开局推送（排位 match.found、好友房 game.start）：app.js 会提示进入对局，首页同时刷新"进行中"横幅（8.3）
    this.onGameStarted = () => {
      if (this.visible) this.refreshActive();
    };
  },

  onShow() {
    this.visible = true;
    this.subscribe(true);
    this.refreshUser();
    this.refreshActive();
  },

  onHide() {
    this.visible = false;
    this.subscribe(false);
  },

  onUnload() {
    this.visible = false;
    this.subscribe(false);
  },

  subscribe(on) {
    const pairs = [
      ['ready', this.onSocketReady],
      ['kicked', this.onSocketKicked],
      ['match.found', this.onGameStarted],
      ['game.start', this.onGameStarted],
    ];
    for (const [t, fn] of pairs) {
      socket.off(t, fn); // 先取消，避免重复订阅
      if (on) socket.on(t, fn);
    }
  },

  async refreshUser() {
    if (!this.data.user) this.setData({ loginState: 'loading' });
    try {
      const user = await auth.ensureLogin();
      this.setData({ user: home.userView(user), loginState: 'ok', loginError: '' });
    } catch (err) {
      console.error('[index] 登录失败', err);
      this.setData({
        loginState: this.data.user ? 'ok' : 'error',
        // 显示具体原因：开发时最常见的是服务器地址不对或服务端没开 DEV_LOGIN
        loginError: guard.errorText(err, '登录失败，请检查网络与服务器地址'),
      });
    }
  },

  isKicked() {
    return typeof socket.isKicked === 'function' && socket.isKicked();
  },

  // 连接 WebSocket 并用 hello 恢复"进行中的对局 / 等待中的房间 / 匹配"提示。
  // 被顶号后不自动重连（否则会立刻把另一台设备顶掉），显示提示条，由用户点击后再连。
  async refreshActive() {
    if (this.isKicked()) {
      this.showKicked();
      return;
    }
    if (this.data.kicked) this.setData({ kicked: false });
    try {
      const p = socket.connect();
      if (p && typeof p.catch === 'function') p.catch((err) => console.warn('[index] 连接失败', err));
      const hello = await socket.request('hello');
      this.applyHello(hello);
    } catch (err) {
      console.warn('[index] 获取进行中的对局失败', err);
      if (this.isKicked() || (err && err.code === 'kicked')) this.showKicked();
      else if (this.visible) this.setData({ offline: true });
    }
  },

  showKicked() {
    if (!this.visible) return;
    this.setData({ kicked: true, banners: [], offline: false });
  },

  // 用户主动选择在本机继续：重新连接（会把另一台设备顶下线）
  onReconnect() {
    this.setData({ kicked: false });
    try {
      const p = socket.connect();
      if (p && typeof p.catch === 'function') p.catch((err) => console.warn('[index] 连接失败', err));
    } catch (err) {
      console.warn('[index] 连接失败', err);
    }
    this.refreshActive();
  },

  applyHello(hello) {
    if (!this.visible) return;
    this.setData({ banners: home.bannersFromHello(hello), offline: false });
  },

  onBannerTap(e) {
    const url = e.currentTarget.dataset.url;
    if (url) this.go(url, false);
  },

  onUserTap() {
    if (this.data.loginState === 'error') {
      this.refreshUser();
      this.refreshActive();
      return;
    }
    if (this.data.loginState !== 'ok') return;
    const user = this.data.user;
    this.go(user && user.nickname ? '/pages/me/me' : '/pages/profile/profile', false);
  },

  // 打开页面；needProfile 为真时先经过资料守卫（未设置昵称会先去资料页，保存后再进入 url）
  async go(url, needProfile) {
    if (this.navigating) return;
    this.navigating = true;
    try {
      if (needProfile) {
        const ok = await guard.requireProfile({ redirect: url });
        if (!ok) {
          this.navigating = false;
          return;
        }
      }
    } catch (err) {
      this.navigating = false;
      guard.toastError(err);
      return;
    }
    // 登录期间别的页面被打开到上面（如开局通知进入了对局页）：不再叠加打开
    if (needProfile && !isTopPage(this)) {
      this.navigating = false;
      return;
    }
    wx.navigateTo({
      url,
      fail: (e) => {
        console.error('[index] 打开页面失败', url, e);
        wx.showToast({ title: '页面打开失败', icon: 'none' });
      },
      complete: () => {
        this.navigating = false;
      },
    });
  },

  onPickMatchSize(e) {
    const size = home.normalizeSize(e.currentTarget.dataset.size, this.data.matchSize);
    this.setData({ matchSize: size });
    writeStorage(STORE_MATCH_SIZE, size);
  },

  onQuickMatch() {
    this.go(home.matchUrl(this.data.matchSize), true);
  },

  onOpenFriend() {
    this.setData({ panel: true });
  },

  onClosePanel() {
    this.setData({ panel: false });
  },

  // 面板内部点击不关闭面板
  noop() {},

  onPickRoomSize(e) {
    this.setData({ roomSize: home.normalizeSize(e.currentTarget.dataset.size, this.data.roomSize) });
  },

  onPickRoomColor(e) {
    this.setData({ roomColor: home.normalizeRoomColor(e.currentTarget.dataset.color) });
  },

  onCreateRoom() {
    const { roomSize, roomColor } = this.data;
    writeStorage(STORE_ROOM, { size: roomSize, color: roomColor });
    this.setData({ panel: false });
    this.go(home.roomCreateUrl(roomSize, roomColor), true);
  },

  onEnterCode() {
    this.setData({ panel: false });
    this.go('/pages/room/room', true);
  },

  onAi() {
    this.go('/pages/ai/ai', true);
  },

  onLocal() {
    this.go('/pages/local/local', false);
  },

  onLeaderboard() {
    this.go('/pages/leaderboard/leaderboard', true);
  },

  onMe() {
    this.go('/pages/me/me', false);
  },

  onShareAppMessage() {
    return { title: '来下一盘围棋吧', path: '/pages/index/index' };
  },
});
