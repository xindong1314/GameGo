'use strict';
const auth = require('../../utils/net/auth');
const api = require('../../utils/net/api');
const socketModule = require('../../utils/net/socket');
const guard = require('../../utils/guard');
const home = require('../index/home');
const rs = require('./room-state');
const { findActiveGame } = require('../match/waiting');

// 契约：socket.js 导出单例；兼容以 { socket } 形式导出
const socket = typeof socketModule.connect === 'function' ? socketModule : socketModule.socket;

function noop() {}

// 等待好友时保持屏幕常亮：锁屏会让小程序进入后台、连接断开，好友加入后房主就收不到开局通知
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
    if (p && typeof p.catch === 'function') p.catch((err) => console.warn('[room] 连接失败', err));
  } catch (err) {
    console.warn('[room] 连接失败', err);
  }
}

// 好友房。三种进入方式：
//   ?create=1&size=&color=  创建房间并等待（房主）
//   ?code=<6 位房号>        受邀进入（如果是自己的房间则回到等待界面）
//   无参数                   手动输入房号
// view：loading | waiting（房主等待）| invite（受邀）| entry（输入房号）| closed | started | error
//
// 房主离开等待页不关闭房间（只有"取消房间"才关）：房间在服务端保留到过期，首页显示"你的好友房正在等待对手"，
// 好友加入时 app.js 会提示进入对局。热启动点分享卡片（包括房主点自己发的卡片）会 reLaunch 到本页，
// 旧页面被卸载、新页面用同一个房号打开，房间必须还在。
Page({
  data: {
    view: 'loading',
    loadingText: '',
    room: null,
    expireText: '',
    codeInput: '',
    entryError: '',
    joining: false,
    closedText: '',
    canRecreate: false,
    fromEntry: false,
    errorText: '',
    canRetry: false,
    netStatus: '',
  },

  onLoad(query) {
    const q = rs.parseRoomQuery(query);
    this.size = q.size || 19;
    this.color = q.color || 'random';
    this.code = q.code || '';
    this.room = null;
    this.isOwner = false;
    this.started = false; // 已开局（正在跳往对局页）
    this.left = false; // 房主已主动关闭房间
    this.unloaded = false;
    this.hidden = false;
    this.joinSent = false; // 已发出过 room.join（回应可能因断线丢失，对局其实已经开始）
    this.roomShownAt = 0; // 开始显示自己房间的时刻（解释房间为何消失时用）
    this.pendingJoin = false; // 去设置资料后回来自动加入
    this.gameId = '';
    this.expiresAt = 0;
    this.countdown = null;
    this.retryAction = null;

    this.handlers = {
      'game.start': (d) => this.onGameStart(d),
      'room.update': (d) => this.onRoomUpdate(d),
      ready: (hello) => this.onSocketReady(hello),
      status: (s) => this.onStatus(s),
      kicked: () => this.onKicked(),
    };
    Object.keys(this.handlers).forEach((t) => socket.on(t, this.handlers[t]));
    connectQuietly();

    if (q.mode === 'create') {
      this.createRoom();
    } else if (q.mode === 'invite') {
      this.loadRoom(q.code);
    } else {
      this.setData({ view: 'entry', fromEntry: true, entryError: q.invalidCode ? '链接中的房号无效，请手动输入' : '' });
    }
  },

  onShow() {
    this.hidden = false;
    if (this.data.view === 'waiting') keepScreenOn(true);
    if (!this.pendingJoin) return;
    this.pendingJoin = false;
    let ready = false;
    try {
      ready = !auth.needProfile();
    } catch (err) {
      console.warn('[room] 读取资料状态失败', err);
    }
    if (ready && this.data.view === 'invite') this.doJoin();
  },

  onHide() {
    this.hidden = true;
    keepScreenOn(false);
  },

  onUnload() {
    this.unloaded = true;
    this.unbind();
    this.stopCountdown();
    keepScreenOn(false);
    // 不在这里关闭房间，见文件开头的说明
  },

  unbind() {
    if (!this.handlers) return;
    Object.keys(this.handlers).forEach((t) => socket.off(t, this.handlers[t]));
    this.handlers = null;
  },

  // ---------- 房主 ----------

  async createRoom() {
    this.retryAction = () => this.createRoom();
    this.setData({ view: 'loading', loadingText: '正在创建房间…', errorText: '' });
    try {
      const data = await socket.request('room.create', { size: this.size, color: this.color });
      const room = data && data.room;
      if (!rs.isRoom(room)) throw { code: 'bad_response', msg: '服务器返回的房间数据异常' };
      if (this.unloaded) {
        // 创建过程中用户已离开：把刚建好的房间关掉
        this.leaveQuietly();
        return;
      }
      this.showOwnRoom(room);
    } catch (err) {
      if (this.unloaded || this.started) return;
      if (err && err.code === 'in_game') {
        this.handleInGame();
        return;
      }
      console.warn('[room] 创建房间失败', err);
      this.showError(err, '创建房间失败');
    }
  },

  showOwnRoom(room) {
    this.room = room;
    this.code = String(room.code);
    this.isOwner = true;
    this.size = Number(room.size);
    if (['black', 'white', 'random'].includes(room.color)) this.color = room.color;
    if (!this.roomShownAt) this.roomShownAt = Date.now();
    this.setExpire(room.expiresIn);
    this.setData({ view: 'waiting', room: rs.roomView(room, true), joining: false });
    this.startCountdown();
    if (!this.hidden) keepScreenOn(true);
  },

  setExpire(expiresIn) {
    const ms = Number(expiresIn);
    this.expiresAt = Number.isFinite(ms) && ms > 0 ? Date.now() + ms : 0;
    this.updateCountdown();
  },

  startCountdown() {
    this.stopCountdown();
    this.countdown = setInterval(() => this.updateCountdown(), 1000);
    this.updateCountdown();
  },

  stopCountdown() {
    if (this.countdown) {
      clearInterval(this.countdown);
      this.countdown = null;
    }
  },

  updateCountdown() {
    if (!this.expiresAt) {
      if (this.data.expireText) this.setData({ expireText: '' });
      return;
    }
    const remain = this.expiresAt - Date.now();
    // 正常情况下服务端会推送 room.update closed；推送丢失时本地兜底
    if (remain <= -5000 && this.data.view === 'waiting') {
      this.showClosed('房间已过期，可以重新创建', true);
      return;
    }
    const text = rs.formatRemain(remain);
    if (text !== this.data.expireText) this.setData({ expireText: text });
  },

  onCopy() {
    if (!this.code) return;
    wx.setClipboardData({
      data: this.code,
      fail: (e) => {
        console.warn('[room] 复制失败', e);
        wx.showToast({ title: '复制失败，请手动记下房号', icon: 'none' });
      },
    });
  },

  onCancel() {
    if (this.started) return;
    this.left = true;
    this.stopCountdown();
    this.leaveQuietly();
    this.back();
  },

  onRecreate() {
    this.left = false;
    this.roomShownAt = 0;
    this.createRoom();
  },

  leaveQuietly() {
    socket.request('room.leave').catch((err) => console.warn('[room] 关闭房间失败', err));
  },

  // ---------- 受邀者 ----------

  async loadRoom(code, opts) {
    const quiet = !!(opts && opts.quiet);
    this.code = code;
    this.retryAction = () => this.loadRoom(code);
    if (!quiet) this.setData({ view: 'loading', loadingText: '正在查找房间…', errorText: '' });
    try {
      const user = await auth.ensureLogin();
      const data = await socket.request('room.get', { code });
      if (this.unloaded || this.started) return;
      const room = data && data.room;
      if (!rs.isRoom(room)) throw { code: 'bad_response', msg: '服务器返回的房间数据异常' };
      if (room.status === 'closed') {
        this.showClosed('房间已关闭', false);
        return;
      }
      if (user && room.owner.userId === user.id) {
        this.showOwnRoom(room);
        return;
      }
      this.room = room;
      this.isOwner = false;
      this.setData({ view: 'invite', room: rs.roomView(room, false) });
    } catch (err) {
      if (this.unloaded || this.started) return;
      if (err && err.code === 'room_not_found') {
        // 房间开局后就被移除：若我正在这个房间开的对局里（例如点卡片回来、加入的回应丢失），直接进入对局
        this.resolveMissingRoom('房间不存在或已失效', false);
        return;
      }
      if (quiet) {
        console.warn('[room] 刷新房间失败', err);
        return;
      }
      console.warn('[room] 获取房间失败', err);
      this.showError(err, '获取房间信息失败');
    }
  },

  async onJoin() {
    if (this.data.joining || this.started) return;
    const ok = await guard.requireProfile();
    if (!ok) {
      // 未设置资料时守卫会打开资料页，保存返回后在 onShow 里继续加入
      this.pendingJoin = true;
      return;
    }
    this.doJoin();
  },

  async doJoin() {
    if (this.data.joining || this.started) return;
    this.setData({ joining: true });
    this.joinSent = true;
    try {
      const data = await socket.request('room.join', { code: this.code });
      if (!data || !home.isGameId(data.gameId)) throw { code: 'bad_response', msg: '服务器返回数据异常' };
      this.goPlay(data.gameId);
    } catch (err) {
      if (this.unloaded || this.started) return;
      this.setData({ joining: false });
      const code = err && err.code;
      if (code === 'own_room') {
        this.loadRoom(this.code);
      } else if (code === 'room_not_found') {
        // 可能是上一次加入其实已成功（回应丢失后重试）
        this.resolveMissingRoom('房间已开局或已失效', false);
      } else if (code === 'in_game') {
        this.handleInGame();
      } else {
        console.warn('[room] 加入失败', err);
        guard.toastError(err, '加入失败，请重试');
        // 请求已发出但没等到回应：服务端可能已经开局。现在查一下（断线时等连接恢复后由 onSocketReady 处理）
        if (code === 'offline' || code === 'timeout') this.checkJoinedGame();
      }
    }
  },

  // ---------- 输入房号 ----------

  onCodeInput(e) {
    const value = rs.sanitizeCodeInput(e && e.detail ? e.detail.value : '');
    this.setData({ codeInput: value, entryError: '' });
    return value;
  },

  onSubmitCode() {
    const code = rs.normalizeCode(this.data.codeInput);
    if (!code) {
      this.setData({ entryError: '请输入 6 位数字房号' });
      return;
    }
    this.loadRoom(code);
  },

  onReenter() {
    this.room = null;
    this.isOwner = false;
    this.setData({ view: 'entry', codeInput: '', entryError: '' });
  },

  // ---------- 推送与重连 ----------

  onGameStart(d) {
    if (!d || !home.isGameId(d.gameId)) {
      console.warn('[room] game.start 数据异常', d);
      return;
    }
    this.goPlay(d.gameId);
  },

  onRoomUpdate(d) {
    const room = d && d.room;
    if (!room || String(room.code) !== this.code || this.started) return;
    if (room.status === 'closed') {
      this.showClosed(this.isOwner ? '房间已超时关闭，可以重新创建' : '房间已关闭', this.isOwner);
    } else if (this.isOwner && this.data.view === 'waiting') {
      this.setExpire(room.expiresIn);
    }
  },

  // 断线重连：断线期间可能已开局；房主确认房间还在，受邀者刷新房间信息
  onSocketReady(hello) {
    if (this.started || this.unloaded) return;
    const view = this.data.view;
    const game = findActiveGame(hello && hello.activeGames, ['friend']);
    if (game && (view === 'waiting' || this.data.joining || this.joinSent)) {
      this.goPlay(game.id);
      return;
    }
    if (view === 'waiting') {
      const r = hello && hello.room;
      if (r && String(r.code) === this.code && r.status !== 'closed') {
        this.setExpire(r.expiresIn);
        return;
      }
      this.verifyOwnRoom();
    } else if (view === 'invite') {
      this.loadRoom(this.code, { quiet: true });
    } else if (view === 'error' && this.retryAction) {
      this.retryAction();
    }
  },

  // hello 里没有这个房间：再用 room.get 确认一次（避免 hello 与 room.create 先后顺序造成误判）
  async verifyOwnRoom() {
    const code = this.code;
    try {
      const data = await socket.request('room.get', { code });
      const room = data && data.room;
      if (this.started || this.unloaded || this.data.view !== 'waiting' || code !== this.code) return;
      if (rs.isRoom(room) && room.status !== 'closed') {
        this.setExpire(room.expiresIn);
        return;
      }
      this.explainClosedRoom();
    } catch (err) {
      if (this.started || this.unloaded || this.data.view !== 'waiting' || code !== this.code) return;
      if (err && err.code === 'room_not_found') {
        this.explainClosedRoom();
      } else {
        console.warn('[room] 确认房间状态失败', err);
      }
    }
  },

  // 房主的房间不见了：可能是过期，也可能是房主离线时好友加入、对局已作废。查最近一局给出原因
  async explainClosedRoom() {
    const room = this.room;
    const since = this.roomShownAt;
    let text = '';
    try {
      const res = await api.request({ method: 'GET', path: '/api/games?limit=1' });
      const first = res && Array.isArray(res.items) ? res.items[0] : null;
      text = rs.missedGameText(first, since, room);
    } catch (err) {
      console.warn('[room] 查询最近对局失败', err);
    }
    if (this.started || this.unloaded || this.data.view !== 'waiting') return;
    this.showClosed(text || '房间已关闭，可以重新创建', true);
  },

  // room_not_found：若我有一局进行中的好友对局（就是这个房间开的局），直接进入；否则显示房间已失效
  async resolveMissingRoom(text, canRecreate) {
    const game = await this.findFriendGame();
    if (this.unloaded || this.started) return;
    if (game) {
      this.goPlay(game.id);
      return;
    }
    this.showClosed(text, canRecreate);
  },

  // 加入请求没等到回应：查一下是否已经开局
  async checkJoinedGame() {
    const game = await this.findFriendGame();
    if (game && !this.unloaded && !this.started) this.goPlay(game.id);
  },

  async findFriendGame() {
    try {
      const hello = await socket.request('hello');
      return findActiveGame(hello && hello.activeGames, ['friend']);
    } catch (err) {
      console.warn('[room] 查询进行中的对局失败', err);
      return null;
    }
  },

  onStatus(status) {
    if (typeof status !== 'string') return;
    this.setData({ netStatus: status });
  },

  onKicked() {
    if (this.started) return;
    this.stopCountdown();
    keepScreenOn(false);
    this.left = true;
    wx.showModal({
      title: '连接已断开',
      content: '你的账号已在其他地方登录。',
      showCancel: false,
      success: () => wx.reLaunch({ url: '/pages/index/index' }),
    });
  },

  // ---------- 通用 ----------

  goPlay(id) {
    if (this.started) return;
    this.started = true;
    this.gameId = id;
    this.stopCountdown();
    keepScreenOn(false);
    this.openGame();
  },

  openGame() {
    if (!this.gameId) return;
    wx.redirectTo({
      url: home.playUrl(this.gameId),
      fail: (e) => {
        console.error('[room] 打开对局页失败', e);
        this.setData({ view: 'started', joining: false });
        wx.showToast({ title: '打开对局失败，请重试', icon: 'none' });
      },
    });
  },

  async handleInGame() {
    let game = null;
    try {
      const hello = await socket.request('hello');
      game = findActiveGame(hello && hello.activeGames, ['ranked', 'friend']);
    } catch (err) {
      console.warn('[room] 查询进行中的对局失败', err);
    }
    if (this.unloaded) return;
    this.retryAction = null;
    this.showError({ code: 'in_game' }, '你有一局对局正在进行');
    wx.showModal({
      title: '无法进入房间',
      content: game ? '你有一局对局正在进行，先去完成它吧。' : '你有一局对局正在进行，请稍后再试。',
      confirmText: game ? '返回对局' : '知道了',
      showCancel: !!game,
      cancelText: '稍后',
      success: (res) => {
        if (game && res.confirm) {
          this.started = true;
          this.gameId = game.id;
          this.openGame();
        }
      },
    });
  },

  showClosed(text, canRecreate) {
    this.stopCountdown();
    keepScreenOn(false);
    this.room = null;
    this.setData({ view: 'closed', closedText: text, canRecreate: !!canRecreate, joining: false });
  },

  // 有 retryAction 时显示"重试"按钮
  showError(err, fallback) {
    this.setData({
      view: 'error',
      errorText: guard.errorText(err, fallback),
      canRetry: !!this.retryAction,
      joining: false,
    });
  },

  onRetry() {
    if (this.retryAction) this.retryAction();
    else this.onHome();
  },

  onHome() {
    wx.reLaunch({ url: '/pages/index/index' });
  },

  back() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/index/index' });
  },

  onShareAppMessage() {
    const view = this.data.view;
    if (this.room && (view === 'waiting' || view === 'invite')) return rs.shareMessage(this.room);
    return { title: '来下一盘围棋吧', path: '/pages/index/index' };
  },
});
