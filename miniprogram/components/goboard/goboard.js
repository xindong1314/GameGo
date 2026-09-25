'use strict';

// 棋盘组件：用 Canvas 2D 画棋盘，把触摸换算成交叉点后发出事件。
// 用法：<goboard size="{{19}}" cells="{{cells}}" lastIdx="{{lastIdx}}" preview="{{preview}}"
//              marks="{{marks}}" disabled="{{false}}" bind:pick="onPick" bind:tap="onBoardTap" />
// 属性：size 路数；cells 棋子（0 空 / 1 黑 / 2 白，下标 y * size + x）；lastIdx 最后一手（-1 为无）；
//       preview 预览子 { idx, ok, color }；disabled 为真时不响应触摸；marks 数子标记 { dead, owner }。
// 事件：pick { idx }——手指按下或移到一个新的交叉点；
//       tap { idx }——单指抬起，且抬起点与按下点是同一交叉点。

const { drawBoard, hitTest, canvasScale } = require('./draw');
const { createTouchTracker } = require('./touch');

const CANVAS_SELECTOR = '#goboard-canvas';
const INIT_RETRIES = 5; // 画布节点还没就绪时最多重试几次
const INIT_RETRY_MS = 60;

// 屏幕像素比：优先用新接口，旧基础库退回 getSystemInfoSync，都拿不到按 1 处理
function devicePixelRatio() {
  try {
    if (typeof wx !== 'undefined' && wx) {
      if (typeof wx.getWindowInfo === 'function') return wx.getWindowInfo().pixelRatio;
      if (typeof wx.getSystemInfoSync === 'function') return wx.getSystemInfoSync().pixelRatio;
    }
  } catch (e) {
    // 取不到就用默认值
  }
  return 1;
}

Component({
  properties: {
    size: { type: Number, value: 19 },
    cells: { type: Array, value: [] },
    lastIdx: { type: Number, value: -1 },
    preview: { type: Object, value: null },
    disabled: { type: Boolean, value: false },
    marks: { type: Object, value: null },
  },

  observers: {
    // 绘图相关的属性变了就重绘（同一次 setData 涉及多个字段也只画一次）
    'size, cells, lastIdx, preview, marks'() {
      this.draw();
    },
    // 被禁用时丢弃进行中的触摸：之后的抬起不会再产生 tap
    disabled(disabled) {
      if (disabled) this.tracker().reset();
    },
  },

  lifetimes: {
    attached() {
      this.cssSize = 0; // 画布边长（CSS 像素），画布就绪后才大于 0
      this.canvas = null;
      this.ctx = null;
      this.gone = false;
      this.tracker();
    },
    ready() {
      this.initCanvas();
    },
    detached() {
      this.gone = true;
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.canvas = null;
      this.ctx = null;
      this.cssSize = 0;
    },
  },

  pageLifetimes: {
    // 屏幕旋转、分屏等导致尺寸变化：重新量画布
    resize() {
      if (this.ctx) this.initCanvas();
    },
  },

  methods: {
    tracker() {
      if (!this.touchTracker) this.touchTracker = createTouchTracker();
      return this.touchTracker;
    },

    // 取画布节点并设置绘图缓冲区；节点没就绪时稍后重试几次
    initCanvas(attempt) {
      const tries = attempt || 0;
      this.createSelectorQuery()
        .select(CANVAS_SELECTOR)
        .fields({ node: true, size: true })
        .exec((res) => this.setupCanvas(res && res[0], tries));
    },

    setupCanvas(info, tries) {
      if (this.gone) return;
      const ctx = info && info.node && typeof info.node.getContext === 'function' ? info.node.getContext('2d') : null;
      if (!ctx || !(info.width > 0)) {
        if (tries < INIT_RETRIES) {
          if (this.retryTimer) clearTimeout(this.retryTimer);
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (!this.gone) this.initCanvas(tries + 1);
          }, INIT_RETRY_MS);
        }
        return;
      }
      const canvas = info.node;
      const cssSize = info.width;
      // 缓冲区 = CSS 边长 × 倍数（倍数封顶，保证缓冲区不超过 Canvas 2D 上限）
      const px = Math.round(cssSize * canvasScale(cssSize, devicePixelRatio()));
      canvas.width = px; // 重设宽高会清空画布并重置变换
      canvas.height = px;
      const k = px / cssSize;
      ctx.scale(k, k); // 之后一律用 CSS 像素绘图
      this.canvas = canvas;
      this.ctx = ctx;
      this.cssSize = cssSize;
      this.draw();
    },

    draw() {
      if (!this.ctx) return;
      const d = this.data;
      drawBoard(this.ctx, {
        cssSize: this.cssSize,
        size: d.size,
        cells: d.cells,
        lastIdx: d.lastIdx,
        preview: d.preview,
        marks: d.marks,
      });
    },

    // 触点（相对画布的 CSS 像素）→ 交叉点索引，棋盘外为 -1
    pointOf(touch) {
      if (!touch) return -1;
      return hitTest(this.cssSize, this.data.size, touch.x, touch.y);
    },

    touchable() {
      return !this.data.disabled && this.cssSize > 0;
    },

    emitPick(idx) {
      if (idx >= 0) this.triggerEvent('pick', { idx });
    },

    onTouchStart(e) {
      if (!this.touchable()) return;
      const touches = (e && e.touches) || [];
      if (!touches.length) return;
      const tracker = this.tracker();
      if (touches.length > 1) {
        // 又落下一根手指：这次触摸不再算 tap；几根手指同时按下则整个忽略
        tracker.spoil();
        return;
      }
      this.emitPick(tracker.start(this.pointOf(touches[0])));
    },

    // 由 catchtouchmove 绑定：拖动不会冒泡到页面，因此棋盘上拖动时页面不滚动
    onTouchMove(e) {
      if (!this.touchable()) return;
      const touches = (e && e.touches) || [];
      if (!touches.length) return;
      const tracker = this.tracker();
      if (touches.length > 1) tracker.spoil();
      this.emitPick(tracker.move(this.pointOf(touches[0])));
    },

    onTouchEnd(e) {
      const tracker = this.tracker();
      if (!tracker.isActive()) return;
      if (!this.touchable()) {
        tracker.reset();
        return;
      }
      if (e && e.touches && e.touches.length) {
        // 还有手指留在屏幕上：多指触摸，等最后一根手指抬起时收尾
        tracker.spoil();
        return;
      }
      const changed = (e && e.changedTouches) || [];
      const idx = tracker.end(changed.length ? this.pointOf(changed[0]) : undefined);
      if (idx >= 0) this.triggerEvent('tap', { idx });
    },

    onTouchCancel() {
      this.tracker().reset();
    },

    // 拦截画布的原生 tap：不让它冒泡出去，和组件自己的 tap 事件混在一起
    onNativeTap() {},
  },
});
