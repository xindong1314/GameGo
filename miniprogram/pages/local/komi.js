'use strict';
// 本地对弈的贴目校验：输入框（或页面参数）里的文字 → 贴目数值。
// 只收非负的十进制数：整数（"6"）或整数部分、小数部分都写全的小数（"7.5"）；
// 负号、指数写法、".5"、"7." 之类一律不收。首尾空白先去掉。

const KOMI_ERROR = '贴目请输入数字';

// 非空且每个字符都是 0-9
function allDigits(part) {
  if (part.length === 0) return false;
  for (let i = 0; i < part.length; i++) {
    const code = part.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function parseKomi(input) {
  const text = input === undefined || input === null ? '' : String(input).trim();
  const pieces = text.split('.'); // 最多一个小数点，两侧都得是数字
  if (pieces.length > 2 || !pieces.every(allDigits)) return { ok: false, msg: KOMI_ERROR };
  return { ok: true, value: Number(text) };
}

module.exports = { parseKomi };
