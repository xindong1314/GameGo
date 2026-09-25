'use strict';

// 服务端使用的规则引擎就是小程序里的那一份（规则只有一份）。
// 用法两种都可以：
//   const engine = require('../engine');  engine.game.createGame(...)、engine.record.replay(...)
//   const { createGame, replay, scoreArea, BLACK } = require('../engine');   // 扁平导出
// 注意：engine.score 既是 score.js 模块（engine.score.scoreArea）也可以直接调用
// engine.score(board, komi)（即 Tromp-Taylor 计分函数），两种写法都成立。

const board = require('../../miniprogram/utils/engine/board');
const rules = require('../../miniprogram/utils/engine/rules');
const game = require('../../miniprogram/utils/engine/game');
const scoreModule = require('../../miniprogram/utils/engine/score');
const coords = require('../../miniprogram/utils/engine/coords');
const record = require('../../miniprogram/utils/engine/record');

// 可调用的命名空间：score(board, komi) 与 score.scoreArea / score.toggleDead / score.score
const score = Object.assign(function score(b, komi) {
  return scoreModule.score(b, komi);
}, scoreModule);

module.exports = {
  ...board,
  ...rules,
  ...game,
  ...scoreModule,
  ...coords,
  ...record,
  board,
  rules,
  game,
  score,
  coords,
  record,
};
