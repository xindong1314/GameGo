'use strict';

// 业务错误：code 为协议里的错误码（设计文档 5.2），msg 为给用户看的中文说明。
// 路由层把 GameError 转成 { t: 'res', rid, ok: false, err: { code, msg, ...extra } }，
// 其他异常一律视为 internal。

const CODES = Object.freeze([
  'bad_request',
  'not_found',
  'not_player',
  'not_your_turn',
  'illegal',
  'stale',
  'in_game',
  'room_not_found',
  'own_room',
  'ai_unavailable',
  'nothing_to_undo',
  'wrong_phase',
  'rate_limited',
  'internal',
]);

class GameError extends Error {
  constructor(code, msg, extra) {
    super(msg || code);
    this.name = 'GameError';
    this.code = code;
    this.msg = msg || code;
    this.extra = extra && typeof extra === 'object' ? extra : null;
  }

  toJSON() {
    return Object.assign({ code: this.code, msg: this.msg }, this.extra || {});
  }
}

module.exports = { GameError, CODES };
