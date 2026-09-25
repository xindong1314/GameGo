'use strict';

// 页面用的格式化小函数，全部是纯函数（formatDate 的"今年"判断可传入 now）。

const BLACK = 1;
const WHITE = 2;

function isNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

// 0.6234 → '62.3%'；非数字 → '--'
function formatWinrate(rate, digits = 1) {
  if (!isNum(rate)) return '--';
  const d = Number.isInteger(digits) && digits >= 0 && digits <= 4 ? digits : 1;
  return `${(rate * 100).toFixed(d)}%`;
}

// 毫秒 → '05:07'；满一小时 '1:02:03'；向下取整，负数或非数字按 0
function formatDuration(ms) {
  const total = isNum(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

// 秒数 → '35 秒' / '2 分 05 秒'（匹配页"已等待"用）
function formatWaited(ms) {
  const total = isNum(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  if (total < 60) return `${total} 秒`;
  return `${Math.floor(total / 60)} 分 ${pad2(total % 60)} 秒`;
}

// 时间戳 → '09-25 14:03'（今年）或 '2025-09-25 14:03'（往年）；无效返回 ''
function formatDate(ts, now = Date.now()) {
  if (!isNum(ts) || ts <= 0) return '';
  const d = new Date(ts);
  const ref = new Date(isNum(now) ? now : Date.now());
  const md = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return d.getFullYear() === ref.getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

const MY_RESULT_TEXT = { win: '胜', loss: '负', draw: '和', void: '作废' };

// 我方结果：'win' | 'loss' | 'draw' | 'void' | ''。
// result 可以是 Result 对象 { winner, reason }，也可以是 GameSummary.myResult 字符串。
function myResultOf(result, myColor) {
  if (typeof result === 'string') return MY_RESULT_TEXT[result] ? result : '';
  if (!result || typeof result !== 'object') return '';
  if (result.reason === 'abort') return 'void';
  if (result.winner === 0) return 'draw';
  if (result.winner !== BLACK && result.winner !== WHITE) return '';
  if (myColor !== BLACK && myColor !== WHITE) return '';
  return result.winner === myColor ? 'win' : 'loss';
}

// → '胜' / '负' / '和' / '作废'；无法判断时 ''
function resultForMe(result, myColor) {
  return MY_RESULT_TEXT[myResultOf(result, myColor)] || '';
}

// 19 → '19路'
function sizeLabel(n) {
  const v = Number(n);
  return Number.isInteger(v) && v > 0 ? `${v}路` : '';
}

// 1 / 'black' → '黑'；2 / 'white' → '白'；'random' → '随机'
function colorLabel(c) {
  if (c === BLACK || c === 'black') return '黑';
  if (c === WHITE || c === 'white') return '白';
  if (c === 'random') return '随机';
  return '';
}

const MODE_TEXT = { ranked: '排位赛', friend: '好友对局', ai: '人机对局' };

function modeLabel(mode) {
  return MODE_TEXT[mode] || '';
}

// 点数/目数：整数不带小数，其余保留一位（184 → '184'，3.5 → '3.5'）
function formatPoints(x) {
  if (!isNum(x)) return '';
  return Number.isInteger(x) ? String(x) : String(Number(x.toFixed(1)));
}

const LEADERBOARD_TYPES = ['streak', 'maxStreak', 'winrate'];

// 排行榜数值：连胜 '5 连胜'，胜率 '62.3%'
function leaderboardValue(type, value) {
  if (type === 'winrate') return formatWinrate(value);
  if (type === 'streak' || type === 'maxStreak') return isNum(value) ? `${value} 连胜` : '--';
  return isNum(value) ? String(value) : '';
}

// 昵称首字（头像占位用）：支持 emoji 等代理对，英文转大写；空昵称为 '?'
function initialOf(name) {
  const chars = Array.from(String(name == null ? '' : name).trim());
  return chars.length ? chars[0].toUpperCase() : '?';
}

const AVATAR_COLORS = ['#8d6e4c', '#5d7a5a', '#6a6f9a', '#9a5f5f', '#4f7f8c', '#8a7a3c', '#7a5c8a'];

// 按昵称取一个稳定的头像底色
function avatarColor(name) {
  const s = String(name == null ? '' : name);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

// 错误码 → 中文提示（设计文档 5.2 的错误码，以及网络层自己的错误码）
const ERROR_TEXT = {
  network: '网络连接失败，请检查网络',
  timeout: '请求超时，请稍后再试',
  offline: '未连接到服务器，请稍后再试',
  kicked: '账号已在其他设备登录',
  closed: '连接已关闭',
  unauthorized: '登录已失效，请重试',
  wx_login_failed: '微信登录失败，请重试',
  wx_not_configured: '服务器未配置微信登录',
  login_unavailable: '服务器未配置微信登录，也未开启开发登录',
  bad_response: '服务器响应异常',
  bad_request: '请求参数错误',
  too_large: '内容过大',
  not_found: '内容不存在',
  not_player: '你不是这局的对弈者',
  not_your_turn: '还没轮到你',
  illegal: '此处不能落子',
  stale: '局面已更新，请重试',
  in_game: '你有一局对局正在进行',
  room_not_found: '房间不存在或已失效',
  own_room: '不能加入自己创建的房间',
  ai_unavailable: 'AI 暂时不可用',
  nothing_to_undo: '没有可以悔的棋',
  wrong_phase: '当前阶段不能这样操作',
  rate_limited: '操作太频繁，请稍后再试',
  internal: '服务器出错了，请稍后再试',
};

// 不能落子的原因（引擎 canPlay / tryPlay 的 reason）→ 提示文案。
// 本地对局页、联网 / 人机对局页与错误提示共用这一份。
const ILLEGAL_TEXT = Object.freeze({ occupied: '此处已有子', ko: '打劫，暂不能回提', suicide: '禁止自杀' });

function illegalMoveText(reason, fallback = '这里不能落子') {
  return Object.prototype.hasOwnProperty.call(ILLEGAL_TEXT, reason) ? ILLEGAL_TEXT[reason] : fallback;
}

const HAS_CJK = /[一-龥]/;

// 统一错误对象 { code, msg } / Error / 字符串 → 适合 showToast 的中文提示。
// 服务端给了中文 msg 时优先用它（更具体）；否则按错误码翻译；都没有用 fallback。
function errorText(err, fallback = '操作失败，请重试') {
  if (!err) return fallback;
  if (typeof err === 'string') return err || fallback;
  const code = typeof err.code === 'string' ? err.code : '';
  const msg = typeof err.msg === 'string' ? err.msg : typeof err.message === 'string' ? err.message : '';
  if (msg && HAS_CJK.test(msg)) return msg;
  if (code === 'illegal') {
    const reason = Object.keys(ILLEGAL_TEXT).find((k) => msg.includes(k));
    if (reason) return ILLEGAL_TEXT[reason];
  }
  if (ERROR_TEXT[code]) return ERROR_TEXT[code];
  return msg || fallback;
}

module.exports = {
  formatWinrate,
  formatDuration,
  formatWaited,
  formatDate,
  myResultOf,
  resultForMe,
  sizeLabel,
  colorLabel,
  modeLabel,
  formatPoints,
  leaderboardValue,
  LEADERBOARD_TYPES,
  initialOf,
  avatarColor,
  errorText,
  ERROR_TEXT,
  ILLEGAL_TEXT,
  illegalMoveText,
};
