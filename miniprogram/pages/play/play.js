'use strict';
const M = require('./model');
const { diffData } = require('./diff');
const socketModule = require('../../utils/net/socket');
const auth = require('../../utils/net/auth');
const api = require('../../utils/net/api');
const clockModule = require('../../utils/clock');
const { isTopPage } = require('../../utils/page-stack');

// 联网 / 人机对局页：pages/play/play?id=<gameId>[&color=black|white|random]
// 所有状态转换在 model.js 里，这里只负责：订阅推送、发请求、计时刷新、页面跳转。
// color 为可选参数：人机对局开局时的执子选择，"再来一局"沿用（缺省按本局执子颜色）。

const socket = typeof socketModule.request === 'function' ? socketModule : socketModule.socket;
const displayClock = typeof clockModule.displayClock === 'function' ? clockModule.displayClock : clockModule;

const PUSH_TYPES = ['game.move', 'game.undo', 'game.ai', 'game.scoring', 'game.resumed', 'game.end', 'game.presence'];
const GAME_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const AI_COLORS = ['black', 'white', 'random'];
const TICK_MS = 1000;
// 落子请求已成功但迟迟没收到推送时，多久后主动重新同步
const MOVE_CHECK_MS = 3000;

function decode(value) {
  if (typeof value !== 'string') return '';
  try {
    return decodeURIComponent(value).trim();
  } catch (err) {
    return value.trim();
  }
}

function noop() {}

Page({
  data: {
    loading: true,
    loaded: false,
    loadError: '',
    banner: '',
  },

  onLoad(query) {
    const q = query || {};
    this.gameId = decode(q.id);
    const color = decode(q.color);
    this.aiColor = AI_COLORS.includes(color) ? color : '';
    this.model = null;
    this.view = null;
    this.visible = true;
    this.unloaded = false;
    this.syncing = null;
    this.syncAgain = false;
    this.ticker = null;
    this.moveCheckTimer = null;
    this.resyncTimer = null;
    // 断线后为真：重新连上后要等 game.sync 拿到最新快照才算"已连接"
    this.stale = false;
    this.statsRequested = false;
    this.handlers = [];
    if (!GAME_ID_RE.test(this.gameId)) {
      this.setData({ loading: false, loadError: '对局编号无效' });
      return;
    }
    this.subscribe();
    this.start();
  },

  onShow() {
    this.visible = true;
    wx.setKeepScreenOn({ keepScreenOn: true, fail: noop });
    this.render();
    this.updateTicker();
  },

  onHide() {
    this.visible = false;
    wx.setKeepScreenOn({ keepScreenOn: false, fail: noop });
    this.updateTicker();
  },

  onUnload() {
    this.unloaded = true;
    this.visible = false;
    for (const [t, fn] of this.handlers || []) socket.off(t, fn);
    this.handlers = [];
    this.stopTicker();
    if (this.moveCheckTimer) {
      clearTimeout(this.moveCheckTimer);
      this.moveCheckTimer = null;
    }
    if (this.resyncTimer) {
      clearTimeout(this.resyncTimer);
      this.resyncTimer = null;
    }
    wx.setKeepScreenOn({ keepScreenOn: false, fail: noop });
  },

  // ---------- 连接与同步 ----------

  subscribe() {
    const add = (t, fn) => {
      socket.on(t, fn);
      this.handlers.push([t, fn]);
    };
    for (const t of PUSH_TYPES) add(t, (msg) => this.onPush(t, msg));
    add('status', (status) => this.onStatus(status));
    add('ready', () => this.onSocketReady());
    add('kicked', () => this.onKicked());
  },

  start() {
    this.setData({ loading: !this.model, loadError: '' });
    Promise.resolve()
      .then(() => auth.ensureLogin())
      .then(() => {
        this.connect();
        return this.sync();
      })
      .catch((err) => this.showLoadError(err));
  },

  connect() {
    try {
      const p = socket.connect();
      if (p && typeof p.then === 'function') p.then(noop, (err) => this.showLoadError(err));
    } catch (err) {
      this.showLoadError(err);
    }
  },

  showLoadError(err) {
    if (this.unloaded || this.model) return;
    this.setData({ loading: false, loadError: M.errorText(err) });
  },

  // 获取快照；进行中时合并为一次额外的同步
  sync() {
    if (this.unloaded) return Promise.resolve();
    if (this.syncing) {
      this.syncAgain = true;
      return this.syncing;
    }
    const finish = () => {
      this.syncing = null;
      if (this.syncAgain && !this.unloaded) {
        this.syncAgain = false;
        this.sync();
      }
    };
    this.syncing = Promise.resolve()
      .then(() => socket.request('game.sync', { gameId: this.gameId }))
      .then((data) => {
        if (this.unloaded) return;
        if (!data || !data.game) throw { code: 'bad_response', msg: '服务器返回的对局数据为空' };
        const first = !this.model;
        let next = M.fromSnapshot(data.game, Date.now(), this.model);
        // 拿到了最新快照：连接状态以 socket 的实际状态为准（重连后在这里才切为已连接）
        next = M.setConnection(next, this.socketStatus());
        this.stale = false;
        this.setModel(next);
        if (first) this.onFirstLoad();
        this.loadStatsIfMissing();
      })
      .catch((err) => {
        if (this.unloaded) return;
        if (!this.model) this.showLoadError(err);
        else {
          this.setModel(M.syncFailed(this.model, err));
          // 重连后的同步失败：界面仍停在"正在重连"，稍后再试，免得一直卡住
          if (this.stale) this.scheduleResync();
        }
      })
      .then(finish, finish);
    return this.syncing;
  },

  // 刚通过连接收到快照，一般就是 open；socket 提供 getStatus 时以它为准
  socketStatus() {
    const s = typeof socket.getStatus === 'function' ? socket.getStatus() : 'open';
    return s === 'connecting' || s === 'closed' ? s : 'open';
  },

  // 排位赛在断线/后台期间结束：结果来自快照，没有 game.end 推送里的统计。用 GET /api/me 补上连胜与胜率
  loadStatsIfMissing() {
    if (this.statsRequested || !M.needsStats(this.model)) return;
    this.statsRequested = true;
    Promise.resolve()
      .then(() => api.request({ method: 'GET', path: '/api/me' }))
      .then((me) => {
        if (this.unloaded || !this.model || !me) return;
        const next = M.withMyStats(this.model, me.stats);
        if (next !== this.model) this.setModel(next);
      })
      .catch((err) => {
        console.warn('[play] 获取排位统计失败', err);
      });
  },

  onFirstLoad() {
    const title = M.MODE_LABEL[this.model.mode] || '对局';
    wx.setNavigationBarTitle({ title, fail: noop });
  },

  onStatus(status) {
    const s = typeof status === 'string' ? status : status && status.status;
    if (!this.model || this.unloaded) return;
    // 断线期间可能错过推送（服务端重启时数子确认还会被清零）。重新连上后先保持"正在重连"，
    // 等 onSocketReady 触发的 game.sync 拿到最新快照再切为已连接，避免界面短暂显示旧状态、按钮可点
    if (s !== 'open') this.stale = true;
    if (s === 'open' && this.stale) return;
    this.setModel(M.setConnection(this.model, s));
  },

  // 连接（重新）建立并完成 hello：重新同步本局，同步成功后才显示为已连接
  onSocketReady() {
    if (this.unloaded || !GAME_ID_RE.test(this.gameId)) return;
    this.sync();
  },

  scheduleResync() {
    if (this.resyncTimer || this.unloaded) return;
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null;
      if (!this.unloaded && this.stale && this.socketStatus() === 'open') this.sync();
    }, 2000);
  },

  onKicked() {
    if (!this.model || this.unloaded) return;
    this.setModel(M.setConnection(this.model, 'kicked'));
  },

  onBannerTap() {
    if (!this.model || this.model.connection !== 'kicked') return;
    this.setModel(M.setConnection(this.model, 'connecting'));
    this.connect();
  },

  onPush(t, msg) {
    if (!this.model || this.unloaded || !msg || msg.gameId !== this.gameId) return;
    const prev = this.model;
    const next = M.applyEvent(prev, Object.assign({}, msg, { t }), Date.now());
    if (next && next.resync) {
      this.sync();
      return;
    }
    if (next === prev) return;
    this.setModel(next);
    if (t === 'game.move' && next.moves.length > prev.moves.length && M.colorOfMove(next.moves.length) !== prev.myColor) this.vibrate();
    if (t === 'game.end' && prev.status !== 'ended') {
      this.scrollToEnd();
      this.loadStatsIfMissing(); // 推送没带统计（服务端读取失败）时同样补上
    }
  },

  // ---------- 渲染 ----------

  setModel(next) {
    this.model = next;
    this.render();
    this.updateTicker();
  },

  render() {
    if (!this.model || this.unloaded) return;
    const view = M.viewData(this.model, Date.now(), { displayClock });
    const patch = diffData(this.view, view);
    if (!this.view) {
      patch.loading = false;
      patch.loadError = '';
    }
    this.view = view;
    if (Object.keys(patch).length) this.setData(patch);
  },

  // 本地每秒刷新读秒与数子倒计时（只在页面可见且未终局时运行）
  updateTicker() {
    const need = this.visible && !this.unloaded && !!this.model && this.model.status !== 'ended';
    if (need && !this.ticker) this.ticker = setInterval(() => this.render(), TICK_MS);
    else if (!need) this.stopTicker();
  },

  stopTicker() {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  },

  vibrate() {
    if (!this.visible) return;
    try {
      wx.vibrateShort({ type: 'light', fail: noop });
    } catch (err) {
      // 部分机型不支持震动，忽略
    }
  },

  scrollToEnd() {
    setTimeout(() => {
      if (this.unloaded) return;
      wx.pageScrollTo({ scrollTop: 100000, duration: 300, fail: noop });
    }, 100);
  },

  // ---------- 请求 ----------

  send(kind, start) {
    if (!this.model || this.unloaded) return;
    const r = start(this.model);
    if (r.model !== this.model) this.setModel(r.model);
    if (!r.req) return;
    Promise.resolve()
      .then(() => socket.request(r.req.t, r.req.params))
      .then(
        () => {
          if (this.unloaded || !this.model) return;
          this.setModel(M.requestDone(this.model, kind));
          if (M.awaitingMove(this.model)) this.scheduleMoveCheck();
        },
        (err) => {
          if (this.unloaded || !this.model) return;
          const f = M.requestFailed(this.model, kind, err);
          this.setModel(f.model);
          if (f.resync) this.sync();
        }
      );
  },

  scheduleMoveCheck() {
    if (this.moveCheckTimer) clearTimeout(this.moveCheckTimer);
    this.moveCheckTimer = setTimeout(() => {
      this.moveCheckTimer = null;
      if (!this.unloaded && this.model && M.awaitingMove(this.model)) this.sync();
    }, MOVE_CHECK_MS);
  },

  // ---------- 用户操作 ----------

  onPick(e) {
    const idx = e && e.detail ? e.detail.idx : undefined;
    if (!this.model || !Number.isInteger(idx)) return;
    const next = M.pick(this.model, idx);
    if (next !== this.model) this.setModel(next);
  },

  // 棋盘自定义 tap 事件（数子阶段点选死子）；忽略没有 idx 的原生 tap
  onBoardTap(e) {
    const idx = e && e.detail ? e.detail.idx : undefined;
    if (!Number.isInteger(idx)) return;
    this.send('toggle', (m) => M.tapPoint(m, idx));
  },

  onConfirm() {
    this.send('move', M.startMove);
  },

  // 停一手不能撤回（真人对局没有悔棋），而且紧挨着"确定"：真人对局先确认
  onPass() {
    if (!this.model) return;
    if (this.model.mode === 'ai') {
      this.send('pass', M.startPass);
      return;
    }
    const check = M.startPass(this.model);
    if (!check.req) {
      if (check.model !== this.model) this.setModel(check.model);
      return;
    }
    const n = this.model.moves.length;
    const oppPassed = n > 0 && this.model.moves[n - 1] === -1;
    wx.showModal({
      title: '停一手',
      content: oppPassed ? '对手已停一手，你也停一手将进入数子阶段。' : '停一手后轮到对手落子，确定吗？',
      confirmText: '停一手',
      success: (res) => {
        // 确认前局面可能已变（如对手超时）：startPass 会重新检查
        if (res && res.confirm && !this.unloaded) this.send('pass', M.startPass);
      },
    });
  },

  onUndo() {
    this.send('undo', M.startUndo);
  },

  onResign() {
    if (!this.model) return;
    wx.showModal({
      title: '认输',
      content: '确定认输吗？',
      confirmText: '认输',
      confirmColor: '#b3261e',
      success: (res) => {
        if (res && res.confirm) this.send('resign', M.startResign);
      },
    });
  },

  onAccept() {
    this.send('accept', M.startAccept);
  },

  onResume() {
    this.send('resume', M.startResume);
  },

  onReplay() {
    wx.navigateTo({ url: `/pages/replay/replay?id=${encodeURIComponent(this.gameId)}` });
  },

  onAgain() {
    if (!this.model) return;
    const r = M.startAgain(this.model, { aiColor: this.aiColor });
    if (r.model !== this.model) this.setModel(r.model);
    const action = r.action;
    if (!action) return;
    if (action.type === 'navigate') {
      wx[action.method]({ url: action.url });
      return;
    }
    wx.showLoading({ title: '正在开局…', mask: true });
    Promise.resolve()
      .then(() => socket.request(action.t, action.params, { timeout: 15000 }))
      .then((data) => {
        if (!data || typeof data.gameId !== 'string' || !data.gameId) {
          throw { code: 'bad_response', msg: '开局失败：服务器没有返回对局编号' };
        }
        wx.hideLoading();
        if (this.unloaded) return;
        this.setModel(M.requestDone(this.model, 'again'));
        // 开局期间别的页面被打开到上面（如开局通知）：不 redirectTo（会关掉那个页面），新局可从首页进入
        if (!isTopPage(this)) return;
        const colorParam = this.aiColor ? `&color=${this.aiColor}` : '';
        wx.redirectTo({ url: `/pages/play/play?id=${encodeURIComponent(data.gameId)}${colorParam}` });
      })
      .catch((err) => {
        wx.hideLoading();
        if (this.unloaded || !this.model) return;
        const f = M.requestFailed(this.model, 'again', err);
        this.setModel(f.model);
        wx.showToast({ title: f.model.hint, icon: 'none' });
      });
  },

  onHome() {
    wx.reLaunch({ url: '/pages/index/index' });
  },

  onRetry() {
    if (!GAME_ID_RE.test(this.gameId)) return;
    this.start();
  },
});
