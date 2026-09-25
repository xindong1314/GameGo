'use strict';
const api = require('../../utils/net/api');
const auth = require('../../utils/net/auth');
const guard = require('../../utils/guard');
const rows = require('./rows');

const LIMIT = 50;

// 排行榜 ?type=streak|maxStreak|winrate（可选）
// 三个榜分别缓存；切换标签时先显示缓存，下拉刷新重新请求当前榜
Page({
  data: {
    tabs: rows.TABS,
    type: 'streak',
    state: 'loading', // loading | ok | empty | error
    errorText: '',
    rows: [],
    mine: null,
    hint: '',
  },

  onLoad(query) {
    this.cache = {};
    this.seq = 0;
    const type = rows.isBoardType(query && query.type) ? query.type : 'streak';
    this.setData({ type, hint: rows.boardHint(type) });
    this.load(type);
  },

  onTab(e) {
    const type = e.currentTarget.dataset.type;
    if (!rows.isBoardType(type) || type === this.data.type) return;
    const cached = this.cache[type];
    if (cached) {
      this.setData(Object.assign({ type, errorText: '' }, cached));
      return;
    }
    this.setData({ type, rows: [], mine: null, hint: rows.boardHint(type) });
    this.load(type);
  },

  onPullDownRefresh() {
    this.load(this.data.type, { refresh: true });
  },

  onRetry() {
    this.load(this.data.type);
  },

  async load(type, opts) {
    const refresh = !!(opts && opts.refresh);
    const seq = ++this.seq;
    if (!refresh || !this.cache[type]) this.setData({ state: 'loading', errorText: '' });
    try {
      const me = await auth.ensureLogin();
      const res = await api.request({ method: 'GET', path: `/api/leaderboard?type=${type}&limit=${LIMIT}` });
      const view = rows.buildBoard(type, res, me && me.id);
      this.cache[type] = view;
      if (seq === this.seq && this.data.type === type) this.setData(Object.assign({ errorText: '' }, view));
    } catch (err) {
      console.warn('[leaderboard] 加载失败', type, err);
      if (seq === this.seq && this.data.type === type) {
        if (this.cache[type]) guard.toastError(err, '刷新失败，请稍后重试');
        else this.setData({ state: 'error', errorText: guard.errorText(err, '排行榜加载失败') });
      }
    } finally {
      if (refresh) wx.stopPullDownRefresh();
    }
  },

  // 空榜时"去下一盘"：回到首页（排行榜总是从首页进入）
  onGoHome() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/index/index' });
  },
});
