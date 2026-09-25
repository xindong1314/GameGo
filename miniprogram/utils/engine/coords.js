'use strict';

// 坐标换算。内部索引 idx = y * n + x，(0,0) 为左上角；-1 表示 pass。
// GTP（KataGo 使用）：列字母跳过 I，行号从下往上数，如 19 路左上角为 "A19"。
// SGF：两个小写字母，列在前行在后，左上角为 "aa"；pass 记为空串。

const PASS = -1;
const GTP_LETTERS = 'ABCDEFGHJKLMNOPQRST';

function assertSize(n) {
  if (!Number.isInteger(n) || n < 2 || n > GTP_LETTERS.length) {
    throw new Error(`不支持的路数 ${n}`);
  }
}

function idxToGtp(idx, n) {
  assertSize(n);
  if (idx === PASS) return 'pass';
  if (!Number.isInteger(idx) || idx < 0 || idx >= n * n) throw new Error(`非法索引 ${idx}`);
  const x = idx % n;
  const y = (idx - x) / n;
  return GTP_LETTERS[x] + String(n - y);
}

function gtpToIdx(str, n) {
  assertSize(n);
  const s = String(str).trim().toUpperCase();
  if (s === 'PASS') return PASS;
  const m = /^([A-HJ-T])(\d{1,2})$/.exec(s);
  if (!m) throw new Error(`非法 GTP 坐标 ${str}`);
  const x = GTP_LETTERS.indexOf(m[1]);
  const row = Number(m[2]);
  if (x >= n || row < 1 || row > n) throw new Error(`GTP 坐标 ${str} 超出 ${n} 路棋盘`);
  return (n - row) * n + x;
}

function idxToSgf(idx, n) {
  assertSize(n);
  if (idx === PASS) return '';
  if (!Number.isInteger(idx) || idx < 0 || idx >= n * n) throw new Error(`非法索引 ${idx}`);
  const x = idx % n;
  const y = (idx - x) / n;
  return String.fromCharCode(97 + x) + String.fromCharCode(97 + y);
}

function sgfToIdx(str, n) {
  assertSize(n);
  if (str === '' || (n <= 19 && str === 'tt')) return PASS;
  if (!/^[a-s]{2}$/.test(str)) throw new Error(`非法 SGF 坐标 ${str}`);
  const x = str.charCodeAt(0) - 97;
  const y = str.charCodeAt(1) - 97;
  if (x >= n || y >= n) throw new Error(`SGF 坐标 ${str} 超出 ${n} 路棋盘`);
  return y * n + x;
}

module.exports = { PASS, GTP_LETTERS, idxToGtp, gtpToIdx, idxToSgf, sgfToIdx };
