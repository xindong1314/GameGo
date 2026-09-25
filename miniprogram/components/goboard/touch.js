'use strict';

// 单次触摸的状态跟踪（纯逻辑，不依赖 wx）。
// 组件先把触点换算成交叉点索引（棋盘外为 -1），再交给这里决定要不要发事件：
// - start / move 返回应当发出 pick 的索引，不发时返回 -1。
//   同一次触摸中不重复发最近一次已发过的点；离开棋盘不发，也不清掉"最近发过的点"。
// - end 返回应当发出 tap 的索引，不发时返回 -1。
//   条件：这次触摸没有被多指干扰、没有被取消，且抬起点与按下点是同一个交叉点。
//   抬起时拿不到坐标（传 undefined / null）就按最后经过的位置算。

function toPoint(idx) {
  return Number.isInteger(idx) && idx >= 0 ? idx : -1;
}

function createTouchTracker() {
  let active = false; // 手指是否按在棋盘上（一次触摸进行中）
  let spoiled = false; // 这次触摸出现过多指，不再产生 tap
  let downIdx = -1; // 按下时的交叉点
  let hereIdx = -1; // 最后经过的位置（棋盘外为 -1）
  let pickedIdx = -1; // 最近一次发出 pick 的交叉点

  function reset() {
    active = false;
    spoiled = false;
    downIdx = -1;
    hereIdx = -1;
    pickedIdx = -1;
  }

  function start(idx) {
    const p = toPoint(idx);
    active = true;
    spoiled = false;
    downIdx = p;
    hereIdx = p;
    pickedIdx = p;
    return p;
  }

  function move(idx) {
    if (!active) return -1;
    const p = toPoint(idx);
    hereIdx = p;
    if (p < 0 || p === pickedIdx) return -1;
    pickedIdx = p;
    return p;
  }

  function end(idx) {
    if (!active) return -1;
    const p = idx === undefined || idx === null ? hereIdx : toPoint(idx);
    const tap = !spoiled && downIdx >= 0 && p === downIdx ? p : -1;
    reset();
    return tap;
  }

  // 出现第二根手指：pick 照常，但这次触摸不再产生 tap
  function spoil() {
    if (active) spoiled = true;
  }

  function isActive() {
    return active;
  }

  return { start, move, end, spoil, reset, isActive };
}

module.exports = { createTouchTracker };
