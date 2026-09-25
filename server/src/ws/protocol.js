'use strict';
const { GameError } = require('../game/errors');

// 客户端消息的严格校验（设计文档 5.1 / 5.2）。
// 只接受已知的消息类型；参数类型必须精确（数字不能是字符串），多余字段忽略。
// 字段名以 ? 结尾表示可选：没有（undefined）时不校验、不放进 params，给了就必须合法。

const SIZES = [9, 13, 19];
const COLORS = ['black', 'white', 'random'];
const GAME_ID_RE = /^[0-9a-z]{12}$/;
const ROOM_CODE_RE = /^\d{6}$/;
const LEVEL_RE = /^[A-Za-z0-9_.-]{1,32}$/;
const MAX_IDX = 19 * 19 - 1;
const MAX_N = 100000;
const MAX_VERSION = 1000000000;
const MAX_TYPE_LEN = 32;

function intIn(min, max, name) {
  return (v) => (Number.isSafeInteger(v) && v >= min && v <= max ? null : `${name} 必须是 ${min}~${max} 之间的整数`);
}

const FIELDS = {
  size: (v) => (SIZES.includes(v) ? null : 'size 必须是 9、13 或 19'),
  color: (v) => (COLORS.includes(v) ? null : 'color 必须是 black、white 或 random'),
  code: (v) => (typeof v === 'string' && ROOM_CODE_RE.test(v) ? null : 'code 必须是 6 位数字'),
  gameId: (v) => (typeof v === 'string' && GAME_ID_RE.test(v) ? null : 'gameId 格式不对'),
  level: (v) => (typeof v === 'string' && LEVEL_RE.test(v) ? null : 'level 格式不对'),
  n: intIn(1, MAX_N, 'n'),
  idx: intIn(0, MAX_IDX, 'idx'),
  version: intIn(0, MAX_VERSION, 'version'),
};

const SCHEMAS = {
  ping: [],
  hello: [],
  'match.join': ['size'],
  'match.cancel': [],
  'room.create': ['size', 'color'],
  'room.get': ['code'],
  'room.join': ['code'],
  'room.leave': [],
  'ai.start': ['size', 'level', 'color'],
  'game.sync': ['gameId'],
  'game.move': ['gameId', 'n', 'idx'],
  'game.pass': ['gameId', 'n'],
  'game.resign': ['gameId'],
  'game.undo': ['gameId'],
  'game.score.toggle': ['gameId', 'idx', 'version?'],
  'game.score.accept': ['gameId', 'version'],
  'game.score.resume': ['gameId'],
};

const TYPES = Object.freeze(Object.keys(SCHEMAS));

// rid 不合法时，能原样带回的（有限数字或短字符串）就带回，方便客户端对上号
function echoableRid(rid) {
  if (typeof rid === 'number' && Number.isFinite(rid)) return rid;
  if (typeof rid === 'string' && rid.length <= 64) return rid;
  return undefined;
}

// msg 为 JSON.parse 后的值。
// 成功：{ ok: true, t, rid, params }；失败：{ ok: false, rid, err: GameError }（rid 为 undefined 时不应回复）
function parseMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return { ok: false, rid: undefined, err: new GameError('bad_request', '消息必须是 JSON 对象') };
  }
  let rid;
  if (msg.rid !== undefined) {
    if (!Number.isSafeInteger(msg.rid) || msg.rid < 0) {
      return { ok: false, rid: echoableRid(msg.rid), err: new GameError('bad_request', 'rid 必须是非负整数') };
    }
    rid = msg.rid;
  }
  const t = msg.t;
  if (typeof t !== 'string' || !t || t.length > MAX_TYPE_LEN) {
    return { ok: false, rid, err: new GameError('bad_request', '缺少消息类型 t') };
  }
  if (!Object.prototype.hasOwnProperty.call(SCHEMAS, t)) {
    return { ok: false, rid, err: new GameError('bad_request', `未知的消息类型 ${t}`) };
  }
  const params = {};
  for (const spec of SCHEMAS[t]) {
    const optional = spec.endsWith('?');
    const name = optional ? spec.slice(0, -1) : spec;
    if (optional && msg[name] === undefined) continue;
    const problem = FIELDS[name](msg[name]);
    if (problem) return { ok: false, rid, err: new GameError('bad_request', problem, { field: name }) };
    params[name] = msg[name];
  }
  return { ok: true, t, rid, params };
}

module.exports = { parseMessage, TYPES, SCHEMAS, GAME_ID_RE, ROOM_CODE_RE, SIZES, COLORS };
