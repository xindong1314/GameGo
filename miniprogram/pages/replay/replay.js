'use strict';
const R = require('./model');
const { diffData } = require('../play/diff');
const api = require('../../utils/net/api');
const auth = require('../../utils/net/auth');

// 棋谱复盘：pages/replay/replay?id=<gameId>
// 打开时停在最后一手（数子终局时显示死子与地盘），可逐手前后翻、拖动进度条。

const GAME_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// 拖动进度条（changing 事件大约每帧一次）时棋盘最多每 100ms 刷新一次，避免每秒几十次整盘 setData 与重绘
const SLIDE_INTERVAL_MS = 100;

function decode(value) {
  if (typeof value !== 'string') return '';
  try {
    return decodeURIComponent(value).trim();
  } catch (err) {
    return value.trim();
  }
}

Page({
  data: {
    loading: true,
    loaded: false,
    loadError: '',
  },

  onLoad(query) {
    this.gameId = decode((query || {}).id);
    this.model = null;
    this.view = null;
    this.k = -1;
    this.unloaded = false;
    this.slideTimer = null;
    this.slideTarget = 0;
    this.lastSlideAt = 0;
    if (!GAME_ID_RE.test(this.gameId)) {
      this.setData({ loading: false, loadError: '对局编号无效' });
      return;
    }
    this.load();
  },

  onUnload() {
    this.unloaded = true;
    this.cancelSlide();
  },

  load() {
    this.setData({ loading: true, loadError: '' });
    Promise.resolve()
      .then(() => auth.ensureLogin())
      .then(() => api.request({ method: 'GET', path: `/api/games/${encodeURIComponent(this.gameId)}` }))
      .then((record) => {
        if (this.unloaded) return;
        this.model = R.fromRecord(record);
        this.view = null;
        this.k = -1;
        this.setData(Object.assign({ loading: false, loaded: true, loadError: '' }, R.headerView(this.model)));
        this.go(this.model.total);
      })
      .catch((err) => {
        if (this.unloaded) return;
        this.setData({ loading: false, loadError: R.loadErrorText(err) });
      });
  },

  go(k) {
    if (!this.model) return;
    const kk = R.clampMove(this.model, k);
    if (kk === this.k) return;
    this.k = kk;
    const view = R.viewAt(this.model, kk);
    const patch = diffData(this.view, view);
    this.view = view;
    if (Object.keys(patch).length) this.setData(patch);
  },

  onFirst() {
    this.go(0);
  },

  onPrev() {
    this.go(this.k - 1);
  },

  onNext() {
    this.go(this.k + 1);
  },

  onLast() {
    if (this.model) this.go(this.model.total);
  },

  // 进度条拖动中（changing）：节流，最多每 SLIDE_INTERVAL_MS 刷新一次，刷新时用最新位置
  onSliding(e) {
    const value = e && e.detail ? Number(e.detail.value) : NaN;
    if (!Number.isFinite(value)) return;
    this.slideTarget = value;
    if (this.slideTimer) return;
    const wait = SLIDE_INTERVAL_MS - (Date.now() - this.lastSlideAt);
    if (wait <= 0) {
      this.lastSlideAt = Date.now();
      this.go(value);
      return;
    }
    this.slideTimer = setTimeout(() => {
      this.slideTimer = null;
      if (this.unloaded) return;
      this.lastSlideAt = Date.now();
      this.go(this.slideTarget);
    }, wait);
  },

  // 松手（change）：立即跳到最终位置
  onSlide(e) {
    const value = e && e.detail ? Number(e.detail.value) : NaN;
    if (!Number.isFinite(value)) return;
    this.cancelSlide();
    this.go(value);
  },

  cancelSlide() {
    if (this.slideTimer) {
      clearTimeout(this.slideTimer);
      this.slideTimer = null;
    }
  },

  onCopySgf() {
    if (!this.model) return;
    wx.setClipboardData({
      data: R.sgfOf(this.model),
      success: () => wx.showToast({ title: 'SGF 棋谱已复制', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败', icon: 'none' }),
    });
  },

  onRetry() {
    if (GAME_ID_RE.test(this.gameId)) this.load();
  },

  onHome() {
    wx.reLaunch({ url: '/pages/index/index' });
  },
});
