'use strict';
// 资料页纯逻辑：昵称校验、redirect 参数解析、保存步骤规划。

const NICKNAME_MAX = 16;

// 与服务端 validateNickname 一致的禁用字符：C0/C1 控制字符、零宽空格 U+200B、行/段分隔符 U+2028/2029、
// 双向文本控制符 U+202A–202E / U+2066–2069、BOM U+FEFF（不拦截零宽连接符 U+200D：组合 emoji 需要它）
function isForbiddenCodePoint(cp) {
  if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return true;
  if (cp === 0x200b || cp === 0x2028 || cp === 0x2029 || cp === 0xfeff) return true;
  return (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
}

// 有落单的代理项（不成对的 UTF-16 半个字符）时为 false；小程序的 JS 引擎不一定有 String.prototype.isWellFormed
function isWellFormed(text) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = text.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function hasForbiddenChar(text) {
  for (const ch of text) if (isForbiddenCodePoint(ch.codePointAt(0))) return true;
  return false;
}

// 按码点计数，emoji 等代理对算一个字
function nicknameLength(text) {
  return Array.from(String(text || '')).length;
}

// → { ok: true, value } | { ok: false, value, msg }（规则与服务端 PUT /api/me/profile 一致）
function validateNickname(raw) {
  const text = typeof raw === 'string' ? raw : raw === undefined || raw === null ? '' : String(raw);
  const value = text.trim();
  if (!value) return { ok: false, value, msg: '请输入昵称' };
  if (!isWellFormed(value)) return { ok: false, value, msg: '昵称包含无效字符' };
  if (nicknameLength(value) > NICKNAME_MAX) return { ok: false, value, msg: `昵称最多 ${NICKNAME_MAX} 个字` };
  if (hasForbiddenChar(value)) return { ok: false, value, msg: '昵称含有不可见的特殊字符' };
  return { ok: true, value };
}

// 页面参数可能已被解码，也可能仍是 encodeURIComponent 的结果；最多解码两次
function safeDecode(text) {
  let value = String(text);
  for (let i = 0; i < 2 && /%[0-9a-fA-F]{2}/.test(value); i++) {
    try {
      value = decodeURIComponent(value);
    } catch (e) {
      break;
    }
  }
  return value;
}

// 只接受本小程序内的页面路径，且不能指回资料页自身
function resolveRedirect(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  const url = safeDecode(raw).trim();
  if (!/^\/pages\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+(\?[^\s#]*)?$/.test(url)) return '';
  if (/^\/pages\/profile\/profile(\?|$)/.test(url)) return '';
  return url;
}

// 决定保存时要做的请求：{ upload: bool, nickname: bool }
// 首次设置（服务端尚无昵称）时总要提交昵称
function planSave({ avatarChanged, nickname, currentNickname }) {
  return {
    upload: !!avatarChanged,
    nickname: !currentNickname || nickname !== currentNickname,
  };
}

module.exports = {
  NICKNAME_MAX,
  isForbiddenCodePoint,
  nicknameLength,
  validateNickname,
  safeDecode,
  resolveRedirect,
  planSave,
};
