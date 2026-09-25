'use strict';
// 本地对弈（同一台手机两人轮流下，不联网）：pages/game/game?size=9|13|19&komi=7.5
// 规则由引擎处理（autoScore: false）：双方连续停一手 → 数子阶段，点选死棋 → 确认结果 / 继续对局。
// 这里只负责：把引擎状态换算成页面数据、响应按钮与棋盘事件。

const { BLACK, WHITE, opponent } = require('../../utils/engine/board');
const { canPlay } = require('../../utils/engine/rules');
const engine = require('../../utils/engine/game');
const { parseKomi } = require('../local/komi');
const LS = require('./local-score');
const { illegalMoveText } = require('../../utils/format');

const SIZES = [9, 13, 19];
const DEFAULT_SIZE = 19;
const DEFAULT_KOMI = 7.5;

const SIDE = { [BLACK]: '黑方', [WHITE]: '白方' };

const SCORING_TIP = '点击棋子把整块标记为死棋（再点取消）';
const EMPTY_TAP_HINT = '点击棋子可标记死活';

function noop() {}

function parseSize(value) {
  const n = Number(value);
  return SIZES.includes(n) ? n : DEFAULT_SIZE;
}

function parseKomiParam(value) {
  const r = parseKomi(value);
  return r.ok ? r.value : DEFAULT_KOMI;
}

// 最近一手落子（跳过停一手）的位置，没有为 -1
function lastPlaced(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].idx !== null) return history[i].idx;
  }
  return -1;
}

// 对局中状态行：轮到谁；对方刚停一手时说明一下
function turnText(game) {
  const side = SIDE[game.toPlay];
  const last = game.history[game.history.length - 1];
  if (last && last.idx === null) {
    return `${SIDE[last.color]}停了一手，轮到${side}${game.consecutivePasses ? '（再停一手进入数子）' : ''}`;
  }
  return `轮到${side}落子`;
}

Page({
  data: {
    size: DEFAULT_SIZE,
    komiLabel: '7.5',
    cells: [],
    lastIdx: -1,
    preview: null, // { idx, ok, color }
    marks: null, // 数子阶段与数子终局：{ dead, owner }
    status: 'playing', // playing | scoring | ended
    toPlay: BLACK,
    players: [],
    moveText: '',
    statusText: '',
    hint: '', // 操作提示（非法落子原因等），优先于 statusText 显示
    canConfirm: false,
    canUndo: false,
    boardDisabled: false,
    score: null, // 数子阶段的点数文字
    result: null,
    end: null, // 终局面板
  },

  onLoad(query) {
    const q = query || {};
    this.settings = { size: parseSize(q.size), komi: parseKomiParam(q.komi) };
    this.newGame();
  },

  // 对局时保持屏幕常亮，离开页面恢复
  onShow() {
    wx.setKeepScreenOn({ keepScreenOn: true, fail: noop });
  },

  onHide() {
    wx.setKeepScreenOn({ keepScreenOn: false, fail: noop });
  },

  onUnload() {
    wx.setKeepScreenOn({ keepScreenOn: false, fail: noop });
  },

  newGame() {
    const { size, komi } = this.settings;
    this.game = engine.createGame({ size, komi, autoScore: false });
    this.dead = [];
    this.render();
  },

  // 引擎状态 → 页面数据（整盘刷新；选点预览只改 preview / hint，见 onPick）
  render() {
    const game = this.game;
    const { status, history, result } = game;
    const playing = status === 'playing';
    const komiLabel = LS.formatNumber(game.komi);

    // 数子阶段，以及按数子结束的终局，都在棋盘上显示死子与地盘
    let view = null;
    if (status === 'scoring' || (status === 'ended' && result && result.reason === 'score')) {
      view = LS.scoreView(game.board, game.komi, this.dead);
    }

    let end = null;
    if (status === 'ended') {
      end = LS.endView(result);
      if (end) {
        const byScore = result.reason === 'score';
        const margin = byScore && result.winner && typeof result.black === 'number' && typeof result.white === 'number'
          ? `${LS.formatNumber(Math.abs(result.black - result.white))} 目`
          : '';
        end = Object.assign({}, end, {
          winner: result.winner,
          marginText: margin,
          komiText: byScore && game.komi ? `白方点数含贴目 ${komiLabel}` : '',
        });
      }
    }

    let statusText = '';
    if (playing) statusText = turnText(game);
    else if (status === 'scoring') statusText = SCORING_TIP;

    const players = [BLACK, WHITE].map((color) => ({
      color,
      name: SIDE[color],
      captures: game.captures[color],
      active: playing && game.toPlay === color,
    }));

    this.setData({
      size: game.size,
      komiLabel,
      cells: Array.from(game.board.cells),
      lastIdx: lastPlaced(history),
      preview: null,
      marks: view ? view.marks : null,
      status,
      toPlay: game.toPlay,
      players,
      moveText: history.length ? `第 ${history.length} 手` : '黑先',
      statusText,
      hint: '',
      canConfirm: false,
      canUndo: history.length > 0 || !!(result && result.reason === 'resign'),
      boardDisabled: status === 'ended',
      score: status === 'scoring' ? {
        blackText: view.blackText,
        whiteText: view.whiteText,
        leadText: view.leadText,
        komiText: view.komiText,
      } : null,
      result: result ? Object.assign({}, result) : null,
      end,
    });
    this.updateLeaveAlert(history.length > 0 && status !== 'ended');
  },

  // 下过棋且没下完时，用户按返回键 / 侧滑先确认（本地对局不保存）。基础库 2.12 起才有这组接口
  updateLeaveAlert(on) {
    if (this.leaveAlert === on) return;
    this.leaveAlert = on;
    try {
      if (on && typeof wx.enableAlertBeforeUnload === 'function') {
        wx.enableAlertBeforeUnload({ message: '本局还没下完，离开后不会保存，确定离开吗？', fail: noop });
      } else if (!on && typeof wx.disableAlertBeforeUnload === 'function') {
        wx.disableAlertBeforeUnload({ fail: noop });
      }
    } catch (err) {
      console.warn('[game] 设置离开提示失败', err);
    }
  },

  // ---------- 棋盘 ----------

  // 手指按下 / 移到新的交叉点：显示预览子，非法时说明原因；"确定"才真正落子
  onPick(e) {
    const idx = e && e.detail ? e.detail.idx : undefined;
    const game = this.game;
    if (!game || game.status !== 'playing' || !Number.isInteger(idx)) return;
    const r = canPlay(game.board, game.toPlay, game.ko, idx);
    const hint = r.ok ? '' : illegalMoveText(r.reason);
    const pv = this.data.preview;
    if (pv && pv.idx === idx && pv.ok === r.ok && this.data.hint === hint) return;
    this.setData({
      preview: { idx, ok: r.ok, color: game.toPlay },
      hint,
      canConfirm: r.ok,
    });
  },

  // 棋盘单击：只在数子阶段有用，切换所点棋子整块的死活
  onBoardTap(e) {
    const idx = e && e.detail ? e.detail.idx : undefined;
    const game = this.game;
    if (!game || game.status !== 'scoring' || !Number.isInteger(idx)) return;
    const next = LS.toggle(game.board, this.dead, idx);
    if (!next) {
      this.setData({ hint: EMPTY_TAP_HINT });
      return;
    }
    this.dead = next;
    this.render();
  },

  // ---------- 对局中 ----------

  onConfirm() {
    const game = this.game;
    const pv = this.data.preview;
    if (!game || game.status !== 'playing') return;
    if (!pv) {
      this.setData({ hint: '请先在棋盘上选点' });
      return;
    }
    const r = engine.play(game, pv.idx);
    if (!r.ok) {
      // 按理不会发生（选点时已判断过）；以防万一，标红并说明
      this.setData({
        preview: Object.assign({}, pv, { ok: false }),
        hint: illegalMoveText(r.reason),
        canConfirm: false,
      });
      return;
    }
    this.render();
  },

  onPass() {
    const game = this.game;
    if (!game || game.status !== 'playing') return;
    if (!engine.pass(game).ok) return;
    if (game.status === 'scoring') this.dead = []; // 每次进入数子都从"没有死子"开始
    this.render();
  },

  onUndo() {
    const game = this.game;
    if (!game || !engine.undo(game)) return;
    this.dead = [];
    this.render();
  },

  // 认输：先确认，说明是哪一方认输（本地对局认输的是当前轮到的一方）
  onResign() {
    const game = this.game;
    if (!game || game.status !== 'playing') return;
    const loser = game.toPlay;
    wx.showModal({
      title: '认输',
      content: `确定${SIDE[loser]}认输吗？本局将判${SIDE[opponent(loser)]}获胜。`,
      confirmText: '认输',
      confirmColor: '#b3261e',
      success: (res) => {
        if (!res || !res.confirm) return;
        // 确认框弹出期间局面没变才执行
        if (this.game !== game || game.status !== 'playing' || game.toPlay !== loser) return;
        if (engine.resign(game, loser).ok) this.render();
      },
    });
  },

  // ---------- 数子阶段 ----------

  // 用当前死子标记计分并结束对局
  onAcceptScore() {
    const game = this.game;
    if (!game || game.status !== 'scoring') return;
    const view = LS.scoreView(game.board, game.komi, this.dead);
    this.dead = view.dead;
    if (engine.finish(game, view.result).ok) this.render();
  },

  // 对死活有异议：回到对局，由最先停一手的一方接着下
  onResumeScore() {
    const game = this.game;
    if (!game || !engine.resume(game).ok) return;
    this.dead = [];
    this.render();
  },

  // ---------- 终局 ----------

  onRestart() {
    if (!this.settings) return;
    this.newGame();
  },

  onBack() {
    wx.navigateBack({
      // 从分享等入口直接打开时没有上一页：回首页
      fail: () => wx.reLaunch({ url: '/pages/index/index' }),
    });
  },
});
