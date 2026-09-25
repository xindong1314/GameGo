'use strict';

// 快速匹配队列：每个路数一个先进先出队列，一个用户同时最多在一个队列里。
// 只负责排队与配对；配对成功后由调用方（Lobby）创建排位对局。

class Matchmaker {
  constructor({ sizes = [9, 13, 19], now = Date.now } = {}) {
    this.now = now;
    this.queues = new Map(sizes.map((s) => [s, []]));
    this.entries = new Map(); // userId → { size, joinedAt }
  }

  // 加入 size 路的队列（已在别的队列里则先移出）。
  // 返回 { size, pair }：pair 为配对成功的 [先排队者, 后排队者]，否则为 null
  join(userId, size) {
    const queue = this.queues.get(size);
    if (!queue) throw new TypeError(`不支持的路数 ${size}`);
    const cur = this.entries.get(userId);
    if (cur && cur.size === size) return { size, pair: null };
    if (cur) this.cancel(userId);
    queue.push(userId);
    this.entries.set(userId, { size, joinedAt: this.now() });
    return { size, pair: this._tryPair(size) };
  }

  _tryPair(size) {
    const queue = this.queues.get(size);
    if (queue.length < 2) return null;
    const a = queue.shift();
    const b = queue.shift();
    this.entries.delete(a);
    this.entries.delete(b);
    return [a, b];
  }

  // 退出队列；返回是否确实在队列中
  cancel(userId) {
    const cur = this.entries.get(userId);
    if (!cur) return false;
    const queue = this.queues.get(cur.size);
    const i = queue.indexOf(userId);
    if (i >= 0) queue.splice(i, 1);
    this.entries.delete(userId);
    return true;
  }

  // 配对后建局失败时，把先排队的人放回队首
  requeueFront(userId, size) {
    const queue = this.queues.get(size);
    if (!queue || this.entries.has(userId)) return;
    queue.unshift(userId);
    this.entries.set(userId, { size, joinedAt: this.now() });
  }

  statusOf(userId) {
    const cur = this.entries.get(userId);
    return cur ? { size: cur.size } : null;
  }

  queueLength(size) {
    const queue = this.queues.get(size);
    return queue ? queue.length : 0;
  }

  clear() {
    for (const q of this.queues.values()) q.length = 0;
    this.entries.clear();
  }
}

module.exports = { Matchmaker };
