'use strict';
// 联网入口守卫：进入匹配 / 好友房 / 人机 / 排行榜之前，确保已登录并设置了头像昵称。
// 另提供把网络错误转成中文提示的 errorText / toastError，供各联网页面共用。

const PROFILE_PAGE = '/pages/profile/profile';

// 服务端错误码（见设计文档 4、5.2 节）与网络层错误码 → 用户可读的提示
const ERROR_TEXT = {
  offline: '网络未连接，请检查网络后重试',
  timeout: '请求超时，请稍后重试',
  network: '网络异常，请检查网络后重试',
  unauthorized: '登录已失效，请重试',
  wx_login_failed: '微信登录失败，请稍后重试',
  wx_not_configured: '服务器暂未开放微信登录',
  bad_request: '请求参数有误',
  not_found: '内容不存在或已删除',
  not_player: '你不是这局棋的对局者',
  in_game: '你有一局对局正在进行',
  room_not_found: '房间不存在或已失效',
  own_room: '这是你自己创建的房间',
  ai_unavailable: 'AI 暂不可用，请稍后再试',
  rate_limited: '操作太频繁，请稍后再试',
  internal: '服务器开小差了，请稍后再试',
  kicked: '账号已在其他设备登录',
  closed: '连接已关闭，请重新进入',
};

const HAS_CHINESE = /[\u4e00-\u9fa5]/;

// 这些错误码用本地的统一提示：网络层自己产生的错误，以及服务端信息比较笼统的错误。
// 其余错误码（如 bad_request 的"昵称不能包含控制字符""头像只支持 PNG 或 JPEG 图片"）优先展示服务端给出的中文说明，
// 它比按错误码的通用提示更具体。
const PREFER_LOCAL = ['offline', 'timeout', 'network', 'kicked', 'closed', 'internal', 'unauthorized', 'rate_limited', 'wx_login_failed', 'wx_not_configured'];

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// err 可能是 { code, msg }（api/socket 约定）、wx 接口的 { errMsg }、Error 或字符串
function errorText(err, fallback) {
  const fb = fallback || '操作失败，请稍后重试';
  if (!err) return fb;
  if (typeof err === 'string') return HAS_CHINESE.test(err) ? err : fb;
  const code = typeof err.code === 'string' ? err.code : '';
  const known = !!code && has(ERROR_TEXT, code);
  if (known && PREFER_LOCAL.includes(code)) return ERROR_TEXT[code];
  const msg = err.msg || err.errMsg || err.message || '';
  if (typeof msg === 'string' && msg) {
    // wx.request / wx.uploadFile 的失败形如 'request:fail timeout'
    if (/:fail/.test(msg)) return /timeout/i.test(msg) ? ERROR_TEXT.timeout : ERROR_TEXT.network;
    // 服务端给出的中文说明直接展示
    if (HAS_CHINESE.test(msg) && msg.length <= 40) return msg;
  }
  if (known) return ERROR_TEXT[code];
  return fb;
}

function toastError(err, fallback) {
  wx.showToast({ title: errorText(err, fallback), icon: 'none', duration: 2500 });
}

function profileUrl(redirect) {
  return PROFILE_PAGE + (redirect ? '?redirect=' + encodeURIComponent(redirect) : '');
}

// 依赖注入便于单测；页面使用下面导出的 requireProfile
function createGuard({ auth, wxApi }) {
  // 已登录且已有昵称 → true；需要设置资料 → 打开资料页并返回 false；登录失败 → 提示并返回 false。
  // redirect：资料保存后要进入的页面（完整路径，如 '/pages/match/match?size=19'）；
  // 不传则资料页保存后返回上一页。
  async function requireProfile(options) {
    const redirect = options && typeof options.redirect === 'string' ? options.redirect : '';
    let user;
    try {
      user = await auth.ensureLogin();
    } catch (err) {
      console.error('[guard] 登录失败', err);
      wxApi.showToast({ title: errorText(err, '登录失败，请检查网络后重试'), icon: 'none', duration: 2500 });
      return false;
    }
    const need = typeof auth.needProfile === 'function' ? auth.needProfile() : !(user && user.nickname);
    if (!need) return true;
    wxApi.navigateTo({
      url: profileUrl(redirect),
      fail: (e) => {
        console.error('[guard] 打开资料页失败', e);
        wxApi.showToast({ title: '请先设置头像和昵称', icon: 'none' });
      },
    });
    return false;
  }
  return { requireProfile };
}

async function requireProfile(options) {
  return createGuard({ auth: require('./net/auth'), wxApi: wx }).requireProfile(options);
}

module.exports = {
  requireProfile,
  errorText,
  toastError,
  profileUrl,
  createGuard,
  ERROR_TEXT,
};
