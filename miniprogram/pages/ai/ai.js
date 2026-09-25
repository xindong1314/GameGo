'use strict';
const api = require('../../utils/net/api');
const socketModule = require('../../utils/net/socket');
const guard = require('../../utils/guard');
const home = require('../index/home');
const { findActiveGame } = require('../match/waiting');
const lv = require('./levels');
const { isTopPage } = require('../../utils/page-stack');

// 契约：socket.js 导出单例；兼容以 { socket } 形式导出
const socket = typeof socketModule.connect === 'function' ? socketModule : socketModule.socket;

const STORE_KEY = 'ai.settings';

function readSettings() {
  try {
    return lv.normalizeSettings(wx.getStorageSync(STORE_KEY));
  } catch (e) {
    return lv.normalizeSettings(null);
  }
}

function writeSettings(settings) {
  try {
    wx.setStorageSync(STORE_KEY, settings);
  } catch (e) {
    console.warn('[ai] 保存设置失败', e);
  }
}

// 人机对弈设置 ?size=（可选，来自匹配页"改为人机对弈"）
// state：loading | ok | unavailable（服务器未启用 AI）| error（难度列表加载失败）
Page({
  data: {
    sizes: home.SIZES,
    size: 19,
    state: 'loading',
    errorText: '',
    levels: [],
    levelId: '',
    colors: lv.AI_COLORS,
    color: 'random',
    starting: false,
  },

  onLoad(query) {
    const saved = readSettings();
    this.preferredLevel = saved.level;
    this.started = false;
    this.setData({
      size: home.normalizeSize(query && query.size, saved.size),
      color: saved.color,
    });
    this.loadLevels();
  },

  async loadLevels() {
    this.setData({ state: 'loading', errorText: '' });
    try {
      const res = await api.request({ method: 'GET', path: '/api/ai/levels' });
      const { available, levels } = lv.normalizeLevels(res);
      this.setData({
        levels,
        levelId: lv.pickLevel(levels, this.data.levelId || this.preferredLevel),
        state: available ? 'ok' : 'unavailable',
      });
    } catch (err) {
      console.warn('[ai] 加载难度失败', err);
      this.setData({ state: 'error', errorText: guard.errorText(err, '加载难度列表失败') });
    }
  },

  onRetry() {
    this.loadLevels();
  },

  onPickSize(e) {
    this.setData({ size: home.normalizeSize(e.currentTarget.dataset.size, this.data.size) });
  },

  onPickLevel(e) {
    if (this.data.state !== 'ok') return;
    const id = String(e.currentTarget.dataset.id);
    if (this.data.levels.some((x) => x.id === id)) this.setData({ levelId: id });
  },

  onPickColor(e) {
    const color = e.currentTarget.dataset.color;
    if (lv.isColor(color)) this.setData({ color });
  },

  async onStart() {
    if (this.data.starting || this.started) return;
    if (this.data.state !== 'ok' || !this.data.levelId) {
      wx.showToast({ title: this.data.state === 'unavailable' ? 'AI 暂不可用' : '请先选择难度', icon: 'none' });
      return;
    }
    this.setData({ starting: true });
    try {
      const ok = await guard.requireProfile();
      if (!ok) return;
      const p = socket.connect();
      if (p && typeof p.catch === 'function') p.catch((err) => console.warn('[ai] 连接失败', err));
      // 开新局会让服务端作废进行中的人机对局：先问一下
      const choice = await this.confirmReplace();
      if (choice === 'cancel') return;
      if (choice && choice.resume) {
        this.openGame(choice.resume, '');
        return;
      }
      const { size, levelId, color } = this.data;
      const data = await socket.request('ai.start', { size, level: levelId, color }, { timeout: 15000 });
      if (!data || !home.isGameId(data.gameId)) throw { code: 'bad_response', msg: '服务器返回数据异常' };
      writeSettings({ size, level: levelId, color });
      // color：对局页"再来一局"时沿用原来的执子设置（如"随机"）
      this.openGame(data.gameId, color);
    } catch (err) {
      console.warn('[ai] 开始人机对局失败', err);
      if (err && err.code === 'in_game') {
        // 排位/好友对局进行中不能开人机（例如刚从匹配页改为人机时正好匹配成功）：引导回到那一局
        await this.handleInGame();
        return;
      }
      if (err && err.code === 'ai_unavailable') this.setData({ state: 'unavailable' });
      guard.toastError(err, '开局失败，请稍后再试');
    } finally {
      if (!this.started) this.setData({ starting: false });
    }
  },

  // 开局前查一下进行中的对局：返回 null（没有，直接开）| 'replace'（作废旧局开新局）
  // | { resume: gameId }（回到那一局）| 'cancel'（什么都不做）
  // 排位/好友对局进行中时服务端不允许开人机（in_game），直接引导回到那一局；
  // 有进行中的人机对局时让用户选择作废它还是回去。
  async confirmReplace() {
    let hello = null;
    try {
      hello = await socket.request('hello');
    } catch (err) {
      // 查询失败时不拦着：ai.start 本身也会因为同样的网络问题失败并提示
      console.warn('[ai] 查询进行中的对局失败', err);
    }
    const games = hello && hello.activeGames;
    const human = findActiveGame(games, ['ranked', 'friend']);
    if (human) return this.askReturn(human);
    const game = findActiveGame(games, ['ai']);
    if (!game) return null;
    // 作废旧局要明确点"开新局"；取消（包括安卓返回键关掉弹窗）回到那一盘
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: '有一盘人机对局没下完',
        content: '开新局会作废那一盘，确定开新局吗？',
        confirmText: '开新局',
        confirmColor: '#b3261e',
        cancelText: '回到那盘',
        success: (r) => resolve(r || {}),
        fail: () => resolve({}),
      });
    });
    if (res.confirm) return 'replace';
    if (res.cancel) return { resume: game.id };
    return 'cancel';
  },

  // 排位/好友对局进行中：提示并可回到那一局。返回 { resume: gameId } | 'cancel'
  askReturn(game) {
    const what = game.mode === 'ranked' ? '一局排位赛' : '一局好友对局';
    return new Promise((resolve) => {
      wx.showModal({
        title: '无法开始人机对局',
        content: `你有${what}正在进行，先去完成它吧。`,
        confirmText: '返回对局',
        cancelText: '稍后',
        success: (r) => resolve(r && r.confirm ? { resume: game.id } : 'cancel'),
        fail: () => resolve('cancel'),
      });
    });
  },

  // ai.start 报 in_game：查出是哪一局，引导回去；查不到时只提示
  async handleInGame() {
    let game = null;
    try {
      const hello = await socket.request('hello');
      game = findActiveGame(hello && hello.activeGames, ['ranked', 'friend']);
    } catch (err) {
      console.warn('[ai] 查询进行中的对局失败', err);
    }
    if (!game) {
      guard.toastError({ code: 'in_game' });
      return;
    }
    const choice = await this.askReturn(game);
    if (choice && choice.resume) this.openGame(choice.resume, '');
  },

  // 在开局请求、弹窗之后调用：期间若有别的页面被打开到上面（如开局通知进入了另一局），
  // 不能 redirectTo（会把那个页面关掉），只恢复按钮；新开的人机对局在首页"进行中"里可以找到。
  openGame(gameId, color) {
    if (!isTopPage(this)) {
      this.setData({ starting: false });
      return;
    }
    this.started = true;
    wx.redirectTo({
      url: home.playUrl(gameId) + (color ? '&color=' + color : ''),
      fail: (e) => {
        console.error('[ai] 打开对局页失败', e);
        this.started = false;
        this.setData({ starting: false });
        wx.showToast({ title: '打开对局失败，请重试', icon: 'none' });
      },
    });
  },
});
