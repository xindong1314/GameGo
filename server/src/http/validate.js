'use strict';
const { badRequest } = require('./errors');

// 请求参数校验

const NICKNAME_MAX = 16;
// 禁止的字符：控制字符（C0/C1/DEL）、零宽空格、行/段分隔符、双向文本控制符与 BOM（可用来伪造显示效果）。
// 不拦截零宽连接符 U+200D：组合 emoji 需要它。
function isForbiddenCodePoint(cp) {
  if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return true;
  if (cp === 0x200b || cp === 0x2028 || cp === 0x2029 || cp === 0xfeff) return true;
  return (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
}

function hasForbiddenChar(s) {
  for (const ch of s) if (isForbiddenCodePoint(ch.codePointAt(0))) return true;
  return false;
}

// 昵称：去首尾空白后 1~16 个字符（按 Unicode 码点计），不含控制字符。返回规范化后的昵称。
function validateNickname(raw) {
  if (typeof raw !== 'string') throw badRequest('请填写昵称');
  if (!raw.isWellFormed()) throw badRequest('昵称包含无效字符');
  const s = raw.trim();
  const len = [...s].length;
  if (len === 0) throw badRequest('昵称不能为空');
  if (len > NICKNAME_MAX) throw badRequest(`昵称最多 ${NICKNAME_MAX} 个字`);
  if (hasForbiddenChar(s)) throw badRequest('昵称不能包含控制字符');
  return s;
}

// 查询参数中的正整数（如 limit），缺省返回 def，超出范围时截断到 [1, max]
function parseLimit(raw, def, max) {
  if (raw === null || raw === undefined || raw === '') return def;
  if (!/^\d{1,6}$/.test(raw)) throw badRequest('limit 必须是正整数');
  return Math.min(Math.max(Number(raw), 1), max);
}

// 查询参数中的毫秒时间戳（游标），缺省返回 undefined
function parseTimestamp(raw, name) {
  if (raw === null || raw === undefined || raw === '') return undefined;
  if (!/^\d{1,16}$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw badRequest(`${name} 必须是毫秒时间戳`);
  return Number(raw);
}

// 按魔数识别图片类型（不相信客户端给的 MIME）：返回 'png' | 'jpg' | null
function detectImageType(buf) {
  if (!buf || buf.length < 8) return null;
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'png';
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  return null;
}

const PNG_IEND = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]); // 'IEND' + CRC
const TAIL_SLACK = 1024; // 结束标记之后允许的少量尾随字节

// PNG：第一个块必须是 IHDR（宽、高在第 16~23 字节），结尾要有 IEND
function inspectPng(buf) {
  if (buf.length < 33 || buf.readUInt32BE(8) !== 13 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const end = buf.lastIndexOf(PNG_IEND);
  if (end < 0 || end + PNG_IEND.length < buf.length - TAIL_SLACK) return null;
  return { width, height };
}

// JPEG 的帧头标记（SOF0~SOF15，除去 DHT C4、JPG C8、DAC CC）
function isSof(marker) {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

// JPEG：按段遍历找到 SOF 帧头取宽高（在 SOS 之前），结尾要有 EOI（FF D9）
function inspectJpeg(buf) {
  let i = 2;
  let size = null;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    let marker = buf[i + 1];
    while (marker === 0xff && i + 2 < buf.length) {
      i += 1; // 填充字节
      marker = buf[i + 1];
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // 没有长度的独立标记
      continue;
    }
    if (marker === 0xd9) break; // 在帧头之前就结束了
    if (i + 4 > buf.length) return null; // 段长度不完整（如结尾是一串 FF 填充字节，LS-7）
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return null;
    if (isSof(marker)) {
      if (len < 7) return null;
      size = { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      break;
    }
    if (marker === 0xda) break; // 扫描数据开始了还没有帧头
    i += 2 + len;
  }
  if (!size) return null;
  const eoi = buf.lastIndexOf(Buffer.from([0xff, 0xd9]));
  if (eoi < 0 || eoi + 2 < buf.length - TAIL_SLACK) return null;
  return size;
}

// 识别并检查图片结构：返回 { type: 'png'|'jpg', width, height }；不是 PNG/JPEG 或结构不完整返回 null。
// 不解码像素，只读文件头里的宽高（防"解压炸弹"：文件很小但宽高极大的图片）。
function inspectImage(buf) {
  const type = detectImageType(buf);
  if (!type) return null;
  const size = type === 'png' ? inspectPng(buf) : inspectJpeg(buf);
  if (!size || !(size.width > 0) || !(size.height > 0)) return null;
  return { type, width: size.width, height: size.height };
}

module.exports = { validateNickname, parseLimit, parseTimestamp, detectImageType, inspectImage, NICKNAME_MAX };
