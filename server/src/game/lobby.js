'use strict';
const crypto = require('node:crypto');
const { GameError } = require('./errors');
const { playerInfo } = require('./players');
const { RateLimiter } = require('../util/rate-limit');

// 大厅：把匹配队列、好友房与对局管理器串起来（设计文档 5.2 的 hello / match.* / room.* / ai.start）。
// 所有推送经 hub.send 发出；在请求处理中产生的推送会排在 res 之后（见 ws/hub.js 的 batch）。

const COLORS = ['black', 'white', 'random'];

class Lobby {
  constructor({ manager, matchmaker, rooms, repos, hub, settings, logger, now = Date.now, randomInt = crypto.randomInt }) {
    this.manager = manager;
    this.matchmaker = matchmaker;
    this.rooms = rooms;
    this.repos = repos;
    this.hub = hub;
    this.settings = settings;
    this.logger = logger;
    this.randomInt = randomInt;
    // 按用户限流（不随连接重置）：开人机对局的频率；找不到房间的次数（防止枚举 6 位房号）
    this.aiStartLimit = new RateLimiter({
      capacity: settings.aiStartBurst,
      refillPerSec: 1000 / settings.aiStartRefillMs,
      now,
    });
    this.roomMissLimit = new RateLimiter({
      capacity: settings.roomMissBurst,
      refillPerSec: 1000 / settings.roomMissRefillMs,
      now,
    });
  }

  // 清掉已经补满的限流桶（由 realtime 定时调用；否则每个开过人机、输错过房号的用户都会一直占一条记录）
  prune() {
    this.aiStartLimit.prune();
    this.roomMissLimit.prune();
  }

  _requireSize(size) {
    if (!this.settings.sizes.includes(size)) throw new GameError('bad_request', '路数只能是 9、13 或 19');
  }

  _requireColor(color) {
    if (!COLORS.includes(color)) throw new GameError('bad_request', '执子只能是 black、white 或 random');
  }

  _requireNotInGame(userId) {
    if (this.manager.humanGameOf(userId)) throw new GameError('in_game', '你还有一局棋没下完');
  }

  _userInfo(userId) {
    let user = null;
    try {
      user = this.repos.users.findById(userId);
    } catch (err) {
      this.logger.error(`读取用户 ${userId} 失败`, err);
    }
    return playerInfo(user, this.settings.publicBaseUrl, userId);
  }

  _roomView(room) {
    return this.rooms.view(room, this._userInfo(room.ownerId));
  }

  // ---------- hello ----------

  hello(userId) {
    const room = this.rooms.ofOwner(userId);
    return {
      activeGames: this.manager.activeGamesOf(userId),
      room: room ? this._roomView(room) : null,
      matching: this.matchmaker.statusOf(userId),
    };
  }

  // ---------- 快速匹配 ----------

  matchJoin(userId, size) {
    this._requireSize(size);
    this._requireNotInGame(userId);
    this._closeRoomOf(userId);
    const { pair } = this.matchmaker.join(userId, size);
    if (pair) this._startRanked(size, pair);
    return { size };
  }

  _startRanked(size, pair) {
    const [first, second] = pair;
    const [blackId, whiteId] = this.randomInt(2) === 0 ? [first, second] : [second, first];
    let session;
    try {
      session = this.manager.createHumanGame({ mode: 'ranked', size, blackId, whiteId });
    } catch (err) {
      // 建局失败：先排队的人放回队首，后来的（当前请求者）收到 internal 错误
      this.matchmaker.requeueFront(first, size);
      throw err;
    }
    for (const uid of pair) this.hub.send(uid, { t: 'match.found', gameId: session.id });
  }

  matchCancel(userId) {
    this.matchmaker.cancel(userId);
  }

  // ---------- 好友房 ----------

  roomCreate(userId, size, color) {
    this._requireSize(size);
    this._requireColor(color);
    this._requireNotInGame(userId);
    this.matchmaker.cancel(userId);
    const { room, replaced } = this.rooms.create(userId, size, color);
    if (replaced) this._notifyClosed(replaced, [userId]);
    return { room: this._roomView(room) };
  }

  // 查房间：连续找不到房间太多次（猜房号）→ rate_limited，一段时间内所有房号都查不了
  _findRoom(userId, code) {
    if (!this.roomMissLimit.allows(userId)) throw new GameError('rate_limited', '房号输错太多次，请稍后再试');
    const room = this.rooms.get(code);
    if (!room) {
      this.roomMissLimit.take(userId);
      throw new GameError('room_not_found', '房间不存在或已过期');
    }
    return room;
  }

  roomGet(userId, code) {
    const room = this._findRoom(userId, code);
    if (room.ownerId !== userId) room.watchers.add(userId);
    return { room: this._roomView(room) };
  }

  // 房主不在线（切到后台等人）也可以加入：对局照常创建，房主到场前不走他的钟、不判弃局（见 GameSession.expectArrival），
  // 房主回来后 hello.activeGames 里就有这局。
  roomJoin(userId, code) {
    const room = this._findRoom(userId, code);
    if (room.ownerId === userId) throw new GameError('own_room', '不能加入自己创建的房间');
    this._requireNotInGame(userId);
    if (this.manager.humanGameOf(room.ownerId)) {
      // 房主已在别的对局中（正常流程下不会发生）：房间作废
      this.rooms.remove(room.code);
      this._notifyClosed(room, [room.ownerId]);
      throw new GameError('room_not_found', '房间已关闭');
    }
    const ownerColor = room.color === 'black' ? 1 : room.color === 'white' ? 2 : this.randomInt(2) + 1;
    const blackId = ownerColor === 1 ? room.ownerId : userId;
    const whiteId = ownerColor === 1 ? userId : room.ownerId;
    const session = this.manager.createHumanGame({ mode: 'friend', size: room.size, blackId, whiteId });
    this.rooms.remove(room.code);
    this._notifyClosed(room, [room.ownerId, userId]);
    this._closeRoomOf(userId);
    this.matchmaker.cancel(room.ownerId);
    this.matchmaker.cancel(userId);
    for (const uid of [room.ownerId, userId]) this.hub.send(uid, { t: 'game.start', gameId: session.id, mode: 'friend' });
    return { gameId: session.id };
  }

  roomLeave(userId) {
    this._closeRoomOf(userId);
  }

  // 关闭该用户创建的房间（房主自己发起，不通知房主）
  _closeRoomOf(userId) {
    const room = this.rooms.ofOwner(userId);
    if (!room) return;
    this.rooms.remove(room.code);
    this._notifyClosed(room, [userId]);
  }

  // 通知查看过房间的人：房间已关闭
  _notifyClosed(room, exclude) {
    const view = this._roomView(room);
    for (const uid of room.watchers) {
      if (!exclude.includes(uid)) this.hub.send(uid, { t: 'room.update', room: view });
    }
  }

  // 房间到期：通知房主与查看过的人
  onRoomExpired(room) {
    const view = this._roomView(room);
    const targets = new Set([room.ownerId, ...room.watchers]);
    for (const uid of targets) this.hub.send(uid, { t: 'room.update', room: view });
  }

  // ---------- 人机 ----------

  // 排位/好友对局进行中不能开人机（离开会按掉线判负）；开局有频率限制（每局都要写库、请求 AI）
  aiStart(userId, { size, level, color }) {
    this._requireSize(size);
    this._requireColor(color);
    if (typeof level !== 'string' || !level) throw new GameError('bad_request', '缺少难度');
    this._requireNotInGame(userId);
    if (!this.aiStartLimit.take(userId)) throw new GameError('rate_limited', '开局太频繁，请稍后再试');
    const session = this.manager.startAiGame(userId, { size, level, color });
    return { gameId: session.id };
  }

  // ---------- 连接 ----------

  userOffline(userId) {
    this.matchmaker.cancel(userId);
  }

  // 同一用户的新连接顶替了旧连接（换了设备，或同一设备的旧连接还没断）：退出匹配队列。
  // 在匹配页上重连的会在 ready 后重新 match.join；换到别的设备则不会在不知情的情况下被配对。
  // 好友房保留（新连接的 hello.room 里能看到）。
  userReplaced(userId) {
    this.matchmaker.cancel(userId);
  }
}

module.exports = { Lobby };
