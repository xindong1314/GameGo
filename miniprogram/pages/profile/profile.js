'use strict';
const auth = require('../../utils/net/auth');
const api = require('../../utils/net/api');
const guard = require('../../utils/guard');
const nick = require('./nickname');
const { isTopPage } = require('../../utils/page-stack');

// 开发者工具的游客模式（appid 为 touristappid）：没有真实 AppID，微信无法对 type="nickname" 的输入做安全检测，
// 失焦时会判为不通过并清空输入框，导致无法设置昵称。游客模式改用普通输入框（服务端仍会校验昵称）。
function isTouristApp() {
  try {
    if (typeof wx.getAccountInfoSync !== 'function') return false;
    const info = wx.getAccountInfoSync();
    const appId = info && info.miniProgram && info.miniProgram.appId;
    return appId === 'touristappid';
  } catch (e) {
    return false;
  }
}

// 头像昵称设置。?redirect=<页面路径>：保存后 redirectTo 该页面（来自联网入口守卫）；否则返回上一页。
Page({
  data: {
    ready: false,
    loadError: '',
    firstTime: false,
    nickname: '',
    count: 0,
    max: nick.NICKNAME_MAX,
    avatarSrc: '',
    avatarChanged: false,
    saving: false,
    needPrivacy: false,
    privacyName: '',
    touristMode: false,
    nicknameType: 'nickname',
  },

  onLoad(query) {
    this.redirect = nick.resolveRedirect(query && query.redirect);
    this.user = null;
    const tourist = isTouristApp();
    this.setData({ firstTime: !!this.redirect, touristMode: tourist, nicknameType: tourist ? 'text' : 'nickname' });
    this.load();
    this.checkPrivacy();
  },

  async load() {
    this.setData({ loadError: '' });
    try {
      const user = await auth.ensureLogin();
      this.user = user || null;
      const nickname = (user && typeof user.nickname === 'string' && user.nickname) || '';
      this.setData({
        ready: true,
        nickname,
        count: nick.nicknameLength(nickname),
        avatarSrc: this.data.avatarChanged ? this.data.avatarSrc : (user && user.avatarUrl) || '',
        firstTime: this.data.firstTime || !nickname,
      });
    } catch (err) {
      console.error('[profile] 登录失败', err);
      this.setData({ ready: false, loadError: guard.errorText(err, '登录失败，请检查网络后重试') });
    }
  },

  onRetry() {
    this.load();
  },

  // 头像昵称属于隐私接口：用户未同意隐私指引时，type="nickname" 的输入框会降级为普通输入框，
  // 所以先查询授权状态，需要时展示同意按钮（open-type="agreePrivacyAuthorization"）。
  checkPrivacy() {
    if (typeof wx.getPrivacySetting !== 'function') return;
    wx.getPrivacySetting({
      success: (res) => {
        if (res && res.needAuthorization) {
          this.setData({ needPrivacy: true, privacyName: res.privacyContractName || '《用户隐私保护指引》' });
        }
      },
      fail: (e) => console.warn('[profile] 查询隐私授权失败', e),
    });
  },

  onOpenPrivacy() {
    if (typeof wx.openPrivacyContract !== 'function') return;
    wx.openPrivacyContract({
      fail: (e) => {
        console.warn('[profile] 打开隐私指引失败', e);
        wx.showToast({ title: '打开隐私指引失败', icon: 'none' });
      },
    });
  },

  onAgreePrivacy() {
    this.setData({ needPrivacy: false });
  },

  onChooseAvatar(e) {
    const url = e && e.detail && e.detail.avatarUrl;
    if (!url) {
      wx.showToast({ title: '未获取到头像，请重试', icon: 'none' });
      return;
    }
    this.setData({ avatarSrc: url, avatarChanged: true });
  },

  // 选用微信昵称时内容是异步填入的：input / blur / confirm 都同步一次，保存时再以表单值为准
  onNicknameInput(e) {
    this.setNickname(e && e.detail ? e.detail.value : '');
  },

  onNicknameBlur(e) {
    this.setNickname(e && e.detail ? e.detail.value : '');
  },

  // 基础库 2.29.1+：微信昵称安全审核结果；未通过时微信会清空输入框
  onNicknameReview(e) {
    const d = (e && e.detail) || {};
    // 游客模式没有真实的安全检测结果，不据此清空
    if (this.data.touristMode) return;
    if (d.pass === false && !d.timeout) {
      this.setNickname('');
      wx.showToast({ title: '昵称未通过微信安全检测，请换一个', icon: 'none' });
    }
  },

  setNickname(value) {
    const text = typeof value === 'string' ? value : '';
    this.setData({ nickname: text, count: nick.nicknameLength(text.trim()) });
  },

  onSubmit(e) {
    const form = e && e.detail && e.detail.value;
    const raw = form && typeof form.nickname === 'string' ? form.nickname : this.data.nickname;
    return this.save(raw);
  },

  async save(raw) {
    if (this.data.saving) return;
    if (!this.data.ready) {
      wx.showToast({ title: this.data.loadError ? '请先重新登录' : '正在登录，请稍候', icon: 'none' });
      return;
    }
    const v = nick.validateNickname(raw);
    if (!v.ok) {
      wx.showToast({ title: v.msg, icon: 'none' });
      return;
    }
    const plan = nick.planSave({
      avatarChanged: this.data.avatarChanged,
      nickname: v.value,
      currentNickname: (this.user && this.user.nickname) || '',
    });
    this.setData({ saving: true, nickname: v.value, count: nick.nicknameLength(v.value) });
    wx.showLoading({ title: '保存中', mask: true });
    try {
      if (plan.upload) {
        const res = await api.uploadAvatar(this.data.avatarSrc);
        if (res && res.user) this.applyUser(res.user);
        // 头像已上传：昵称提交失败后重试时不再重复上传
        this.setData({ avatarChanged: false });
      }
      if (plan.nickname) {
        const res = await api.request({ method: 'PUT', path: '/api/me/profile', data: { nickname: v.value } });
        if (!res || !res.user) throw { code: 'bad_response', msg: '服务器返回数据异常' };
        this.applyUser(res.user);
      }
    } catch (err) {
      console.error('[profile] 保存失败', err);
      wx.hideLoading();
      this.setData({ saving: false });
      guard.toastError(err, '保存失败，请稍后重试');
      return;
    }
    wx.hideLoading();
    wx.showToast({ title: '已保存', icon: 'success' });
    // 保存期间别的页面被打开到上面（如好友房开局通知进入了对局页）：不跳转，否则会把那个页面关掉。
    // 留在本页（已保存），用户回来后可以直接返回。
    if (!isTopPage(this)) {
      this.setData({ saving: false });
      return;
    }
    this.leave();
  },

  // 同步到本地登录信息；失败只记录（服务端已保存成功）
  applyUser(user) {
    this.user = user;
    try {
      auth.setUser(user);
    } catch (err) {
      console.warn('[profile] 更新本地用户信息失败', err);
    }
  },

  leave() {
    if (this.redirect) {
      wx.redirectTo({
        url: this.redirect,
        fail: (e) => {
          console.error('[profile] 跳转失败', this.redirect, e);
          this.back();
        },
      });
      return;
    }
    this.back();
  },

  back() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/index/index' });
  },
});
