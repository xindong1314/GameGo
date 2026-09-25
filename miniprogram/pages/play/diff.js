'use strict';

// setData 前做浅层 diff：只提交与上次不同的顶层字段，避免每秒计时刷新时重复传整盘棋子。

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    // NaN 视为相等，避免反复提交
    return typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b);
  }
  const arrA = Array.isArray(a);
  if (arrA !== Array.isArray(b)) return false;
  if (arrA) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k])) return false;
  }
  return true;
}

// 返回 next 中与 prev 不同的顶层字段组成的对象（prev 为空时返回 next 的全部字段）
function diffData(prev, next) {
  const patch = {};
  const old = prev || {};
  for (const k of Object.keys(next)) {
    if (!Object.prototype.hasOwnProperty.call(old, k) || !deepEqual(old[k], next[k])) patch[k] = next[k];
  }
  return patch;
}

module.exports = { deepEqual, diffData };
