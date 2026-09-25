'use strict';

// 极简事件总线：on / off / once / emit。
// on() / once() 返回取消订阅的函数，页面可以在 onUnload 里统一调用。
// 某个监听器抛错不会影响其他监听器（错误会打印到控制台）。

function assertType(type) {
  if (typeof type !== 'string' || !type) throw new TypeError('事件名必须是非空字符串');
}

function assertFn(fn) {
  if (typeof fn !== 'function') throw new TypeError('监听器必须是函数');
}

class Emitter {
  constructor({ logger = console } = {}) {
    this._handlers = new Map();
    this._logger = logger;
  }

  on(type, fn) {
    assertType(type);
    assertFn(fn);
    let list = this._handlers.get(type);
    if (!list) {
      list = [];
      this._handlers.set(type, list);
    }
    list.push(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    assertType(type);
    assertFn(fn);
    const wrapper = (...args) => {
      this.off(type, wrapper);
      fn(...args);
    };
    wrapper.listener = fn;
    return this.on(type, wrapper);
  }

  // 必须同时给出事件名与监听器，避免误删其他页面的订阅；要清空请用 clear()
  off(type, fn) {
    assertType(type);
    assertFn(fn);
    const list = this._handlers.get(type);
    if (!list) return false;
    const i = list.findIndex((h) => h === fn || h.listener === fn);
    if (i < 0) return false;
    list.splice(i, 1);
    if (!list.length) this._handlers.delete(type);
    return true;
  }

  // 清空某个事件（不传则清空全部）的监听器
  clear(type) {
    if (type === undefined) this._handlers.clear();
    else this._handlers.delete(type);
  }

  // 返回是否有监听器收到事件
  emit(type, ...args) {
    const list = this._handlers.get(type);
    if (!list || !list.length) return false;
    // 复制一份：监听器里 off/on 不影响本轮分发
    for (const fn of list.slice()) {
      try {
        fn(...args);
      } catch (err) {
        this._logger.error(`[emitter] "${type}" 的监听器出错`, err);
      }
    }
    return true;
  }

  listenerCount(type) {
    const list = this._handlers.get(type);
    return list ? list.length : 0;
  }
}

function createEmitter(options) {
  return new Emitter(options);
}

module.exports = { Emitter, createEmitter };
