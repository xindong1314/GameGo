'use strict';

// 头像：有 src 显示图片；没有头像或图片加载失败时显示昵称首字的圆形色块。
// 用法：<avatar src="{{user.avatarUrl}}" name="{{user.nickname}}" size="{{96}}" custom-class="xx" />
// size 单位为 rpx（默认 80）。

const { initialOf, avatarColor } = require('../../utils/format');

const DEFAULT_SIZE = 80;

function sizeView(size) {
  const box = typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : DEFAULT_SIZE;
  return { box, font: Math.round(box * 0.45) };
}

function nameView(name) {
  return { initial: initialOf(name), bg: avatarColor(name) };
}

Component({
  externalClasses: ['custom-class'],

  properties: {
    src: { type: String, value: '' },
    name: { type: String, value: '' },
    size: { type: Number, value: DEFAULT_SIZE },
  },

  data: Object.assign({ failed: false }, nameView(''), sizeView(DEFAULT_SIZE)),

  observers: {
    // 换了新地址就重新尝试加载；同一个失败过的地址不再反复加载
    src(src) {
      const failed = !!src && src === this.failedSrc;
      if (failed !== this.data.failed) this.setData({ failed });
    },
    name(name) {
      this.setData(nameView(name));
    },
    size(size) {
      this.setData(sizeView(size));
    },
  },

  lifetimes: {
    attached() {
      this.failedSrc = '';
      this.setData(Object.assign(nameView(this.data.name), sizeView(this.data.size)));
    },
  },

  methods: {
    onImageError(e) {
      console.warn('[avatar] 头像加载失败，改为显示昵称首字', this.data.src, e && e.detail);
      this.failedSrc = this.data.src;
      this.setData({ failed: true });
    },
  },
});
