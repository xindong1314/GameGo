'use strict';
const crypto = require('node:crypto');

// 好友房登记表：6 位数字房号（在等待中的房间里唯一）、有效期、每人最多一个房间。
// 房主可以离线等待。房间只存在内存里，重启后失效。

const MAX_TIMER_MS = 2 ** 31 - 1;
const ROOM_CODE_RE = /^\d{6}$/;

class RoomRegistry {
  // onExpire(room)：房间过期时回调（此时已从登记表移除，status 为 'closed'）
  constructor({ ttlMs, now = Date.now, timers, randomInt = crypto.randomInt, onExpire, logger } = {}) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new TypeError('RoomRegistry: ttlMs 必须是正整数');
    if (!timers || typeof timers.setTimeout !== 'function') throw new TypeError('RoomRegistry: 需要 timers');
    this.ttlMs = ttlMs;
    this.now = now;
    this.timers = timers;
    this.randomInt = randomInt;
    this.onExpire = typeof onExpire === 'function' ? onExpire : () => {};
    this.logger = logger;
    this.rooms = new Map(); // code → room
    this.byOwner = new Map(); // ownerId → code
  }

  _newCode() {
    for (let i = 0; i < 100; i++) {
      const code = String(this.randomInt(1000000)).padStart(6, '0');
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('无法生成空闲的房号');
  }

  // 创建房间；该用户已有房间时先关闭旧的（旧房间通过返回值 replaced 交给调用方通知）
  create(ownerId, size, color) {
    const replaced = this.ofOwner(ownerId);
    if (replaced) this.remove(replaced.code);
    const code = this._newCode();
    const createdAt = this.now();
    const room = {
      code,
      ownerId,
      size,
      color,
      status: 'waiting',
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      watchers: new Set(), // 查看过房间的受邀者，房间关闭时通知他们
      timer: null,
    };
    this.rooms.set(code, room);
    this.byOwner.set(ownerId, code);
    this._arm(room);
    return { room, replaced };
  }

  _arm(room) {
    const delay = Math.min(Math.max(0, room.expiresAt - this.now()), MAX_TIMER_MS);
    room.timer = this.timers.setTimeout(() => {
      room.timer = null;
      this._expire(room.code);
    }, delay);
  }

  _expire(code) {
    const room = this.rooms.get(code);
    if (!room) return;
    if (this.now() < room.expiresAt) {
      this._arm(room); // 定时器提前触发（或超过最大延时被截断）
      return;
    }
    this.remove(code);
    try {
      this.onExpire(room);
    } catch (err) {
      if (this.logger) this.logger.error('房间过期通知失败', err);
    }
  }

  // 等待中的房间；过期的顺便清掉
  get(code) {
    if (typeof code !== 'string' || !ROOM_CODE_RE.test(code)) return null;
    const room = this.rooms.get(code);
    if (!room) return null;
    if (this.now() >= room.expiresAt) {
      this._expire(code);
      return null;
    }
    return room;
  }

  ofOwner(ownerId) {
    const code = this.byOwner.get(ownerId);
    return code === undefined ? null : this.get(code);
  }

  // 移出登记表并标记 closed；返回该房间（不存在返回 null）
  remove(code) {
    const room = this.rooms.get(code);
    if (!room) return null;
    if (room.timer) this.timers.clearTimeout(room.timer);
    room.timer = null;
    room.status = 'closed';
    this.rooms.delete(code);
    if (this.byOwner.get(room.ownerId) === code) this.byOwner.delete(room.ownerId);
    return room;
  }

  // 对外的 Room 视图（设计文档 5.4）；owner 由调用方查用户表给出
  view(room, owner) {
    const closed = room.status !== 'waiting';
    return {
      code: room.code,
      owner,
      size: room.size,
      color: room.color,
      status: closed ? 'closed' : 'waiting',
      expiresIn: closed ? 0 : Math.max(0, room.expiresAt - this.now()),
    };
  }

  get count() {
    return this.rooms.size;
  }

  clear() {
    for (const code of [...this.rooms.keys()]) this.remove(code);
  }
}

module.exports = { RoomRegistry, ROOM_CODE_RE };
