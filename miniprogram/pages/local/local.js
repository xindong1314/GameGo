'use strict';
// 本地对弈开局设置：选路数、填贴目，然后进入同机双人对局页 pages/game/game。
const { parseKomi } = require('./komi');

const SIZES = [9, 13, 19];

// 常用贴目：点一下填入输入框（也可以自己输入）
const KOMI_PRESETS = [
  { value: '7.5', desc: '中国规则' },
  { value: '6.5', desc: '日韩规则' },
  { value: '0', desc: '不贴目' },
];

Page({
  data: {
    sizes: SIZES,
    size: 19,
    komi: '7.5', // 输入框里的原始文字，开局时再校验
    komiPresets: KOMI_PRESETS,
  },

  onPickSize(e) {
    const size = Number(e.currentTarget.dataset.size);
    if (SIZES.includes(size) && size !== this.data.size) this.setData({ size });
  },

  onPickKomi(e) {
    const value = e.currentTarget.dataset.komi;
    if (typeof value === 'string' && value !== this.data.komi) this.setData({ komi: value });
  },

  onKomiInput(e) {
    const value = e && e.detail ? e.detail.value : '';
    this.setData({ komi: typeof value === 'string' ? value : String(value) });
  },

  onStart() {
    if (this.navigating) return; // 连点只打开一次
    const komi = parseKomi(this.data.komi);
    if (!komi.ok) {
      wx.showToast({ title: komi.msg, icon: 'none' });
      return;
    }
    this.navigating = true;
    wx.navigateTo({
      url: `/pages/game/game?size=${this.data.size}&komi=${komi.value}`,
      fail: (err) => {
        console.error('[local] 打开对局页失败', err);
        wx.showToast({ title: '页面打开失败', icon: 'none' });
      },
      complete: () => {
        this.navigating = false;
      },
    });
  },
});
