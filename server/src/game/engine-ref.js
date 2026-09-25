'use strict';

// server-game 模块统一从这里取规则引擎。
// 按设计文档第 1 节，服务端经 server/src/engine.js 引用小程序里的引擎（规则只有一份）；
// 这里只取它的命名空间导出，并在加载时校验形状，避免接口变化时在对局中途才报错。
const engine = require('../engine');

const board = engine.board;
const game = engine.game;
const score = engine.score;
const coords = engine.coords;
const record = engine.record;

const REQUIRED = [
  [board, ['Board', 'opponent', 'BLACK', 'WHITE', 'EMPTY']],
  [game, ['createGame', 'play', 'pass', 'undo', 'resign', 'resume', 'finish']],
  [score, ['scoreArea', 'toggleDead']],
  [coords, ['PASS']],
  [record, ['resultText', 'resultLabel']],
];
for (const [ns, names] of REQUIRED) {
  for (const name of names) {
    if (!ns || ns[name] === undefined) {
      throw new Error(`server/src/engine.js 缺少导出 ${name}（server-game 需要 board/game/score/coords/record 命名空间）`);
    }
  }
}

module.exports = { board, game, score, coords, record };
