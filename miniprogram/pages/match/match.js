'use strict';
const socketModule = require('../../utils/net/socket');
const guard = require('../../utils/guard');
const home = require('../index/home');
const waiting = require('./waiting');

// 契约：socket.js 导出单例；兼容以 { socket } 形式导出
const socket = typeof socketModule.connect === 'function' ? socketModule : socketModule.socket;

function noop() {}

// 等待匹配时保持屏幕常亮：自动锁屏会让小程序进入后台、连接断开，服务端随即把用户移出匹配队列（与好友房等待页相同）
function keepScreenOn(on) {
  try {
    if (typeof wx.setKeepScreenOn === 'function') wx.setKeepScreenOn({ keepScreenOn: !!on, fail: noop });
  } catch (err) {
    // 部分环境不支持，忽略
  }
}

function connectQuietly() {
  try {
    const p = socket.connect();
    if (p && typeof p.catch === 'function') p.catch((err) => console.warn('[match] 连接失败', err));
  } catch (err) {
    console.warn('[match] 连接失败', err);
  }
}

// 快速匹配等待页 ?size=9|13|19
// 状态：joining（正在加入队列）→ waiting（排队中）→ matched（已匹配，跳转对局页）
//       error（加入失败，可重试；断线重连后也会自动重试）/ stopped（已有对局或被顶号）
Page({
  data: {
    size: 19,
    status: 'joining',
    elapsedText: '0:00',
    showAiHint: false,
    errorText: '',
    netStatus: '',
  },

  onLoad(query) {
    this.size = home.normalizeSize(query && query.size, 19);
    this.matched = false; // 已匹配（或正在跳往对局页）
    this.left = false; // 用户已离开 / 已取消
    this.stopped = false; // 不再尝试加入（已有对局、被顶号）
    this.joining = false;
    this.rejoin = false;
    this.gameId = '';
    this.startedAt = Date.now();
    this.lastSec = -1;
    this.setData({ size: this.size });

    this.handlers = {
      'match.found': (d) => this.onFound(d),
      ready: (hello) => this.onSocketReady(hello),
      status: (s) => this.onStatus(s),
      kicked: () => this.onKicked(),
    };
    Object.keys(this.handlers).forEach((t) => socket.on(t, this.handlers[t]));

    this.timer = setInterval(() => this.tick(), 1000);
    this.tick();
    connectQuietly();
    this.join();
  },

  onShow() {
    if (this.active()) keepScreenOn(true);
  },

  onHide() {
    keepScreenOn(false);
  },

  onUnload() {
    keepScreenOn(false);
    this.unbind();
    this.stopTimer();
    if (!this.matched && !this.left && !this.stopped) {
      this.left = true;
      this.cancelQuietly();
    }
  },

  unbind() {
    if (!this.handlers) return;
    Object.keys(this.handlers).forEach((t) => socket.off(t, this.handlers[t]));
    this.handlers = null;
  },

  stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  tick() {
    const sec = waiting.elapsedSeconds(this.startedAt, Date.now());
    if (sec === this.lastSec) return;
    this.lastSec = sec;
    this.setData({
      elapsedText: waiting.formatElapsed(sec),
      showAiHint: sec >= waiting.AI_HINT_SEC,
    });
  },

  active() {
    return !this.matched && !this.left && !this.stopped;
  },

  // 加入匹配队列；请求进行中再次调用时，等它结束后再发一次（断线重连期间可能发生）
  async join() {
    if (!this.active()) return;
    if (this.joining) {
      this.rejoin = true;
      return;
    }
    this.joining = true;
    try {
      await socket.request('match.join', { size: this.size });
      if (this.active()) this.setData({ status: 'waiting', errorText: '', netStatus: 'open' });
    } catch (err) {
      if (this.active()) {
        if (err && err.code === 'in_game') {
          this.handleInGame();
        } else {
          console.warn('[match] 加入匹配失败', err);
          this.setData({ status: 'error', errorText: guard.errorText(err, '加入匹配失败，请重试') });
        }
      }
    } finally {
      this.joining = false;
      if (this.rejoin) {
        this.rejoin = false;
        this.join();
      }
    }
  },

  onRetry() {
    this.setData({ status: 'joining', errorText: '' });
    connectQuietly();
    this.join();
  },

  onFound(d) {
    if (!d || !home.isGameId(d.gameId)) {
      console.warn('[match] match.found 数据异常', d);
      return;
    }
    this.goPlay(d.gameId);
  },

  // 断线重连：可能在断线期间已匹配成功；否则服务端已把我们移出队列，需要重新加入
  onSocketReady(hello) {
    if (!this.active()) return;
    const game = waiting.findActiveGame(hello && hello.activeGames, ['ranked']);
    if (game) {
      this.goPlay(game.id);
      return;
    }
    const m = hello && hello.matching;
    if (m && Number(m.size) === this.size) {
      this.setData({ status: 'waiting', errorText: '', netStatus: 'open' });
      return;
    }
    this.join();
  },

  onStatus(status) {
    if (typeof status !== 'string') return;
    this.setData({ netStatus: status });
  },

  onKicked() {
    if (this.matched) return;
    this.stopped = true;
    this.stopTimer();
    keepScreenOn(false);
    this.setData({ status: 'stopped' });
    wx.showModal({
      title: '连接已断开',
      content: '你的账号已在其他地方登录，匹配已停止。',
      showCancel: false,
      success: () => wx.reLaunch({ url: '/pages/index/index' }),
    });
  },

  goPlay(id) {
    if (this.matched) return;
    this.matched = true;
    this.gameId = id;
    this.stopTimer();
    keepScreenOn(false); // 对局页自己会保持常亮
    this.setData({ status: 'matched' });
    this.openGame();
  },

  // 也用于"进入对局"按钮（跳转失败时重试）
  openGame() {
    if (!this.gameId) return;
    wx.redirectTo({
      url: home.playUrl(this.gameId),
      fail: (e) => {
        console.error('[match] 打开对局页失败', e);
        wx.showToast({ title: '打开对局失败，请重试', icon: 'none' });
      },
    });
  },

  // 已有排位/好友对局在进行：提示并引导回到那一局
  async handleInGame() {
    this.stopped = true;
    this.stopTimer();
    keepScreenOn(false);
    this.setData({ status: 'stopped' });
    let game = null;
    try {
      const hello = await socket.request('hello');
      game = waiting.findActiveGame(hello && hello.activeGames, ['ranked', 'friend']);
    } catch (err) {
      console.warn('[match] 查询进行中的对局失败', err);
    }
    wx.showModal({
      title: '无法开始匹配',
      content: game ? '你有一局对局正在进行，先去完成它吧。' : '你有一局对局正在进行，请稍后再试。',
      confirmText: game ? '返回对局' : '知道了',
      showCancel: !!game,
      cancelText: '稍后',
      success: (res) => {
        if (game && res.confirm) {
          this.matched = true;
          this.gameId = game.id;
          this.openGame();
        } else {
          this.back();
        }
      },
    });
  },

  cancelQuietly() {
    socket.request('match.cancel').catch((err) => console.warn('[match] 取消匹配失败', err));
  },

  onCancel() {
    if (this.matched) return;
    if (!this.stopped) this.cancelQuietly();
    this.left = true;
    this.stopTimer();
    keepScreenOn(false);
    this.back();
  },

  // 等太久：取消匹配，改去人机对弈（同路数）
  onSwitchAi() {
    if (this.matched) return;
    if (!this.stopped) this.cancelQuietly();
    this.left = true;
    this.stopTimer();
    keepScreenOn(false);
    wx.redirectTo({
      url: '/pages/ai/ai?size=' + this.size,
      fail: (e) => {
        console.error('[match] 打开人机设置失败', e);
        this.back();
      },
    });
  },

  back() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/index/index' });
  },
});
