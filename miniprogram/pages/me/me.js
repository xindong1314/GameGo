'use strict';
const api = require('../../utils/net/api');
const auth = require('../../utils/net/auth');
const socketModule = require('../../utils/net/socket');
const guard = require('../../utils/guard');
const home = require('../index/home');
const history = require('./history');

// 契约：socket.js 导出单例；兼容以 { socket } 形式导出
const socket = typeof socketModule.close === 'function' ? socketModule : socketModule.socket;

// 我的：头像昵称、排位战绩、人机战绩、对局列表（上拉加载更多，点击进入复盘）
Page({
  data: {
    state: 'loading', // 个人信息：loading | ok | error
    errorText: '',
    user: null,
    needProfile: false,
    statCards: [],
    statsDetail: '',
    aiText: '',
    activeIds: [],
    games: [],
    listState: 'loading', // 对局列表：loading | ok | empty | error
    listError: '',
    loadingMore: false,
    loadMoreFailed: false,
    noMore: false,
  },

  onLoad() {
    this.next = null;
    this.gamesSeq = 0;
    this.loadingGames = false;
    this.shown = false;
    this.loadMe();
    this.loadGames(true);
  },

  // 从资料页、复盘页、对局页返回时刷新头像昵称、战绩，并把新结束的对局补到列表顶部
  onShow() {
    if (!this.shown) {
      this.shown = true;
      return;
    }
    this.loadMe({ quiet: true });
    this.refreshNewGames();
  },

  // 只取第一页，把列表里还没有的对局插到最前面，已加载的更早的分页与滚动位置保持不变。
  // 列表为空/出错，或新对局多到第一页里一个旧的都没有时，整体重新加载。
  async refreshNewGames() {
    if (this.loadingGames || this.data.listState !== 'ok' || !this.data.games.length) {
      if (!this.loadingGames) this.loadGames(true);
      return;
    }
    const seq = this.gamesSeq;
    try {
      const res = await api.request({ method: 'GET', path: history.gamesPath(null, history.PAGE_SIZE) });
      if (seq !== this.gamesSeq || this.loadingGames) return;
      const items = res && Array.isArray(res.items) ? res.items : [];
      const now = Date.now();
      const page = items.map((g) => history.formatGameRow(g, now)).filter(Boolean);
      const merged = history.prependGames(this.data.games, page);
      if (merged === null) {
        this.loadGames(true);
        return;
      }
      if (merged.length !== this.data.games.length) this.setData({ games: merged });
    } catch (err) {
      console.warn('[me] 刷新对局列表失败', err);
    }
  },

  async loadMe(opts) {
    const quiet = !!(opts && opts.quiet);
    if (!quiet) this.setData({ state: 'loading', errorText: '' });
    try {
      const res = await api.request({ method: 'GET', path: '/api/me' });
      if (res && res.user) {
        try {
          auth.setUser(res.user);
        } catch (err) {
          console.warn('[me] 更新本地用户信息失败', err);
        }
      }
      this.setData(Object.assign({ state: 'ok', errorText: '' }, history.formatMe(res)));
    } catch (err) {
      console.warn('[me] 加载个人信息失败', err);
      if (quiet && this.data.state === 'ok') guard.toastError(err, '刷新失败，请稍后重试');
      else this.setData({ state: 'error', errorText: guard.errorText(err, '加载失败，请稍后重试') });
    }
  },

  // reset：重新加载第一页；否则按 next 游标加载下一页
  async loadGames(reset) {
    if (!reset && (this.loadingGames || this.data.noMore || this.next === null)) return;
    const seq = reset ? ++this.gamesSeq : this.gamesSeq;
    const before = reset ? null : this.next;
    this.loadingGames = true;
    if (reset) {
      if (!this.data.games.length) this.setData({ listState: 'loading', listError: '' });
    } else {
      this.setData({ loadingMore: true, loadMoreFailed: false });
    }
    try {
      const res = await api.request({ method: 'GET', path: history.gamesPath(before, history.PAGE_SIZE) });
      if (seq !== this.gamesSeq) return;
      const items = res && Array.isArray(res.items) ? res.items : [];
      const now = Date.now();
      const page = items.map((g) => history.formatGameRow(g, now)).filter(Boolean);
      const games = reset ? history.mergeGames([], page) : history.mergeGames(this.data.games, page);
      this.next = history.nextCursor(res && res.next);
      this.setData({
        games,
        listState: games.length ? 'ok' : 'empty',
        listError: '',
        loadingMore: false,
        loadMoreFailed: false,
        noMore: this.next === null,
      });
    } catch (err) {
      if (seq !== this.gamesSeq) return;
      console.warn('[me] 加载对局列表失败', err);
      if (this.data.games.length) {
        this.setData({ loadingMore: false, loadMoreFailed: !reset });
        guard.toastError(err, '加载失败，请稍后重试');
      } else {
        this.setData({ listState: 'error', listError: guard.errorText(err, '对局列表加载失败'), loadingMore: false });
      }
    } finally {
      if (seq === this.gamesSeq) this.loadingGames = false;
    }
  },

  onReachBottom() {
    this.loadGames(false);
  },

  onLoadMore() {
    this.loadGames(false);
  },

  onPullDownRefresh() {
    Promise.all([this.loadMe({ quiet: true }), this.loadGames(true)])
      .catch((err) => console.warn('[me] 刷新失败', err))
      .then(() => wx.stopPullDownRefresh());
  },

  onRetryMe() {
    this.loadMe();
  },

  onRetryGames() {
    this.loadGames(true);
  },

  onEditProfile() {
    wx.navigateTo({ url: '/pages/profile/profile' });
  },

  onGameTap(e) {
    const id = e.currentTarget.dataset.id;
    if (!home.isGameId(id)) return;
    wx.navigateTo({
      url: '/pages/replay/replay?id=' + encodeURIComponent(id),
      fail: (err) => {
        console.error('[me] 打开复盘失败', err);
        wx.showToast({ title: '打开复盘失败', icon: 'none' });
      },
    });
  },

  // 重新登录：注销本机当前的登录凭证（POST /api/auth/logout，服务端立即作废这个令牌），再重新登录换一个新的。
  // 账号不变（同一个微信用户）。令牌如果泄露过（例如旧版客户端把它放在 WebSocket 地址里、被写进了服务器日志），
  // 这样可以让它失效。其他设备的登录不受影响。
  onRelogin() {
    if (this.relogging) return;
    wx.showModal({
      title: '重新登录',
      content: '将注销本机当前的登录凭证并重新登录，账号和战绩不变。正在进行的对局会短暂断线后自动重连。',
      confirmText: '重新登录',
      success: (res) => {
        if (res && res.confirm) this.relogin();
      },
    });
  },

  async relogin() {
    if (this.relogging) return;
    this.relogging = true;
    wx.showLoading({ title: '正在重新登录', mask: true });
    try {
      await api.request({ method: 'POST', path: '/api/auth/logout' });
    } catch (err) {
      // 注销失败时保留本地令牌：清掉它并不能让服务端的旧令牌失效
      console.warn('[me] 注销失败', err);
      wx.hideLoading();
      this.relogging = false;
      guard.toastError(err, '重新登录失败，请稍后重试');
      return;
    }
    auth.clear();
    try {
      socket.close(); // 当前连接是用旧令牌建立的；首页会用新令牌重新连接
    } catch (err) {
      console.warn('[me] 关闭连接失败', err);
    }
    try {
      await auth.ensureLogin();
    } catch (err) {
      // 登录失败不要紧：首页会再次登录并显示原因
      console.warn('[me] 重新登录失败', err);
    }
    wx.hideLoading();
    this.relogging = false;
    wx.reLaunch({ url: '/pages/index/index' });
  },

  onActiveTap(e) {
    const id = e.currentTarget.dataset.id;
    if (!home.isGameId(id)) return;
    wx.navigateTo({
      url: home.playUrl(id),
      fail: (err) => {
        console.error('[me] 打开对局失败', err);
        wx.showToast({ title: '打开对局失败', icon: 'none' });
      },
    });
  },
});
