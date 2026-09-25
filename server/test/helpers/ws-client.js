'use strict';
const WebSocket = require('ws');

// 测试用 WebSocket 客户端（真实的 ws 连接）。
//   const c = await TestClient.connect(url, { token });
//   const res = await c.request('hello');           // 完整的 res 消息 { t:'res', rid, ok, data|err }
//   const data = await c.req('match.join', { size: 9 });  // ok 时返回 data，否则抛错（err.code）
//   const msg = await c.waitFor('game.move', { filter: (m) => m.n === 3 });
// 推送（非 res）进入 inbox；waitFor 先在 inbox 里找，找到就取走，否则等到来。

const DEFAULT_TIMEOUT = 3000;

class TestClient {
  constructor(ws) {
    this.ws = ws;
    this.inbox = [];
    this.log = []; // 收到的所有消息（含 res）
    this.waiters = [];
    this.pending = new Map();
    this.nextRid = 1;
    this.closeInfo = null;
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        this.closeInfo = { code, reason: reason.toString() };
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(Object.assign(new Error('连接已关闭'), { code: 'closed' }));
        }
        this.pending.clear();
        for (const w of this.waiters.splice(0)) {
          clearTimeout(w.timer);
          w.reject(Object.assign(new Error(`等待 ${w.t} 时连接已关闭（${code}）`), { code: 'closed' }));
        }
        resolve(this.closeInfo);
      });
    });
    ws.on('message', (data) => this._onMessage(data));
    ws.on('error', () => {});
  }

  // 连接；被拒绝时 reject 的错误带 statusCode
  static connect(url, { token, autoPong = true, timeout = DEFAULT_TIMEOUT, query } = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      if (token !== undefined) u.searchParams.set('token', token);
      if (query) for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
      const ws = new WebSocket(u.toString(), { autoPong, handshakeTimeout: timeout });
      let done = false;
      ws.once('open', () => {
        done = true;
        resolve(new TestClient(ws));
      });
      ws.once('unexpected-response', (req, res) => {
        if (done) return;
        done = true;
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          ws.terminate();
          reject(Object.assign(new Error(`连接被拒绝：HTTP ${res.statusCode}`), { statusCode: res.statusCode, body }));
        });
      });
      ws.once('error', (err) => {
        if (done) return;
        done = true;
        reject(err);
      });
    });
  }

  _onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      msg = { t: '__invalid__', raw: data.toString() };
    }
    this.log.push(msg);
    if (msg.t === 'res' && this.pending.has(msg.rid)) {
      const p = this.pending.get(msg.rid);
      this.pending.delete(msg.rid);
      clearTimeout(p.timer);
      p.resolve(msg);
      return;
    }
    const i = this.waiters.findIndex((w) => w.t === msg.t && (!w.filter || w.filter(msg)));
    if (i >= 0) {
      const w = this.waiters.splice(i, 1)[0];
      clearTimeout(w.timer);
      w.resolve(msg);
      return;
    }
    this.inbox.push(msg);
  }

  get isOpen() {
    return this.ws.readyState === WebSocket.OPEN;
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  sendRaw(data) {
    this.ws.send(data);
  }

  request(t, params = {}, { timeout = DEFAULT_TIMEOUT } = {}) {
    const rid = this.nextRid++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(Object.assign(new Error(`${t} 请求超时`), { code: 'timeout' }));
      }, timeout);
      this.pending.set(rid, { resolve, reject, timer });
      try {
        this.send({ ...params, t, rid });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(rid);
        reject(err);
      }
    });
  }

  async req(t, params = {}, opts) {
    const res = await this.request(t, params, opts);
    if (!res.ok) {
      throw Object.assign(new Error(`${t} 失败：${res.err && res.err.code} ${res.err && res.err.msg}`), {
        code: res.err && res.err.code,
        err: res.err,
      });
    }
    return res.data;
  }

  // 等待一条推送（先查已收到的）
  waitFor(t, { filter, timeout = DEFAULT_TIMEOUT } = {}) {
    const i = this.inbox.findIndex((m) => m.t === t && (!filter || filter(m)));
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]);
    if (this.closeInfo) return Promise.reject(Object.assign(new Error(`连接已关闭，等不到 ${t}`), { code: 'closed' }));
    return new Promise((resolve, reject) => {
      const w = { t, filter, resolve, reject, timer: null };
      w.timer = setTimeout(() => {
        const k = this.waiters.indexOf(w);
        if (k >= 0) this.waiters.splice(k, 1);
        reject(Object.assign(new Error(`等待 ${t} 超时`), { code: 'timeout' }));
      }, timeout);
      this.waiters.push(w);
    });
  }

  // 断言一段时间内没有收到某类推送
  async expectNone(t, ms = 150, filter) {
    await new Promise((r) => setTimeout(r, ms));
    const found = this.inbox.find((m) => m.t === t && (!filter || filter(m)));
    if (found) throw new Error(`不应收到 ${t}：${JSON.stringify(found)}`);
  }

  // 取走 inbox 里的推送（可按类型过滤）
  drain(t) {
    if (!t) return this.inbox.splice(0);
    const out = this.inbox.filter((m) => m.t === t);
    this.inbox = this.inbox.filter((m) => m.t !== t);
    return out;
  }

  close(code = 1000) {
    if (this.ws.readyState === WebSocket.CLOSED) return this.closed;
    this.ws.close(code);
    return this.closed;
  }

  terminate() {
    if (this.ws.readyState !== WebSocket.CLOSED) this.ws.terminate();
    return this.closed;
  }
}

module.exports = { TestClient };
