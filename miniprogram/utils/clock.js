'use strict';

/**
 * 读秒显示（设计文档 6.1、8.2），规则与服务端 game/clock.js 一致：
 * 先扣基本时间；基本时间用完进入读秒，每用满一个完整周期消耗一次，本手在周期内完成则周期重置；
 * 剩余次数用尽即超时。
 *
 *   displayClock(clock, runningElapsedMs, timeControl?) → { text, sub, urgent, timeout, phase, remainingMs }
 *     clock            快照里某一方的 { mainMs, periodsLeft, periodMs }（服务端在发送时刻算好的剩余量）；
 *                      null（人机对局不计时）时返回空显示。
 *     runningElapsedMs 这一方正在走时：从收到快照到现在的本地毫秒数；没在走时传 0。
 *     timeControl      可选，{ periodMs } 或数字：完整读秒周期长度。快照里正在走的一方的 periodMs
 *                      可能是"当前周期剩余"，用满后下一个周期要按完整长度算；不传则按 clock.periodMs 算。
 *     text   基本时间 'mm:ss'（如 '09:58'）；读秒阶段为当前周期剩余秒数（如 '28'）；向上取整。
 *     sub    '读秒 N 次'（N 为剩余次数，基本时间阶段也显示，没有读秒时为 ''）；超时为 '超时'。
 *     urgent 读秒阶段剩余 ≤ 10 秒；或没有读秒时基本时间剩余 ≤ 30 秒；超时也为 true。
 *     phase  'main' | 'byoyomi' | 'timeout' | 'none'；remainingMs 为当前阶段（当前周期）剩余毫秒。
 *
 *   displayClocks(clocks, sinceSnapshotMs, timeControl?) → { 1: 显示, 2: 显示 }
 *     clocks 为快照里的 Clocks（含 running）；只有 running 一方计入 sinceSnapshotMs。
 */

const URGENT_BYO_MS = 10000;
const URGENT_MAIN_MS = 30000;

const EMPTY = Object.freeze({ text: '', sub: '', urgent: false, timeout: false, phase: 'none', remainingMs: 0 });

function nonNeg(x) {
  return typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0;
}

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

function mmss(ms) {
  const total = Math.ceil(ms / 1000);
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

function periodLengthOf(timeControl, fallback) {
  if (typeof timeControl === 'number') return nonNeg(timeControl) || fallback;
  if (timeControl && typeof timeControl === 'object') return nonNeg(timeControl.periodMs) || fallback;
  return fallback;
}

function periodsText(n) {
  return n > 0 ? `读秒 ${n} 次` : '';
}

function displayClock(clock, runningElapsedMs, timeControl) {
  if (!clock || typeof clock !== 'object') return Object.assign({}, EMPTY);
  const main = nonNeg(clock.mainMs);
  const periods0 = Math.floor(nonNeg(clock.periodsLeft));
  const current = nonNeg(clock.periodMs); // 当前周期剩余（不在走的一方即完整周期）
  const full = periodLengthOf(timeControl, current);
  const hasByo = periods0 > 0 && current > 0;
  let elapsed = nonNeg(runningElapsedMs);

  // 基本时间
  if (elapsed < main) {
    const left = main - elapsed;
    return {
      text: mmss(left),
      sub: hasByo ? periodsText(periods0) : '',
      urgent: !hasByo && left <= URGENT_MAIN_MS,
      timeout: false,
      phase: 'main',
      remainingMs: left,
    };
  }

  // 读秒：先用完当前周期，之后每个周期为完整长度
  elapsed -= main;
  if (hasByo) {
    let periods = periods0;
    let left;
    if (elapsed < current) {
      left = current - elapsed;
    } else {
      elapsed -= current;
      periods -= 1;
      const used = full > 0 ? Math.floor(elapsed / full) : periods;
      periods -= used;
      left = full - (elapsed - used * full);
    }
    if (periods > 0) {
      return {
        text: String(Math.ceil(left / 1000)),
        sub: periodsText(periods),
        urgent: left <= URGENT_BYO_MS,
        timeout: false,
        phase: 'byoyomi',
        remainingMs: left,
      };
    }
  }

  return {
    text: hasByo ? '0' : '00:00',
    sub: '超时',
    urgent: true,
    timeout: true,
    phase: 'timeout',
    remainingMs: 0,
  };
}

function displayClocks(clocks, sinceSnapshotMs, timeControl) {
  const c = clocks && typeof clocks === 'object' ? clocks : null;
  const running = c ? c.running : null;
  return {
    1: displayClock(c && c[1], running === 1 ? sinceSnapshotMs : 0, timeControl),
    2: displayClock(c && c[2], running === 2 ? sinceSnapshotMs : 0, timeControl),
  };
}

module.exports = { displayClock, displayClocks, URGENT_BYO_MS, URGENT_MAIN_MS };
