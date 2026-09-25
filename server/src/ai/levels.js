'use strict';

// 难度表（设计文档 7.5）。
//   kind 'rank'   —— KaTrain "Calibrated Rank"：每步 1 次神经网络评估，按级位从随机抽取的若干合法点里选 policy 最高者
//   kind 'policy' —— 直接下 policy 最高点（开局 22 手内按 KaTrain 规则加随机性）
//   kind 'search' —— KataGo 真正的搜索
// KaTrain 的级位校准只针对 19 路；同样的参数在小棋盘上明显更强，所以 13 路 kyu +5、9 路 kyu +10（上限 30）。
// kyu 采用 KaTrain 的约定：18 = 18 级 … 1 = 1 级，0 = 1 段，-1 = 2 段，-2 = 3 段。

const LEVELS = Object.freeze(
  [
    {
      id: 'k18',
      name: '入门',
      kind: 'rank',
      kyu: 18,
      desc: '刚学会规则也能赢，常下出随意的棋（19 路约 18 级）',
    },
    {
      id: 'k12',
      name: '初级',
      kind: 'rank',
      kyu: 12,
      desc: '会吃子、会做活，但经常看漏对方的威胁（19 路约 12 级）',
    },
    {
      id: 'k8',
      name: '中级',
      kind: 'rank',
      kyu: 8,
      desc: '棋形像样，中盘战斗时有漏算（19 路约 8 级）',
    },
    {
      id: 'k4',
      name: '中高级',
      kind: 'rank',
      kyu: 4,
      desc: '布局扎实，攻防有章法，偶尔出现失误（19 路约 4 级）',
    },
    {
      id: 'k1',
      name: '高级',
      kind: 'rank',
      kyu: 1,
      desc: '全局判断较好，需要一定实力才能取胜（19 路约 1 级）',
    },
    {
      id: 'd3',
      name: '业余 3 段',
      kind: 'rank',
      kyu: -2,
      desc: '棋感敏锐、少有漏着（19 路约业余 3 段）',
    },
    {
      id: 'd5',
      name: '业余高段',
      kind: 'policy',
      openingMoves: 22,
      desc: '凭神经网络的第一感落子，不做计算（19 路约业余 5 段）',
    },
    {
      id: 'max',
      name: '最强',
      kind: 'search',
      maxVisits: 300,
      maxTimeSec: 8,
      desc: 'KataGo 完整搜索，每步最多思考 8 秒（19 路远超业余顶尖水平）',
    },
  ].map((l) => Object.freeze(l)),
);

const LEVEL_IDS = new Set(LEVELS.map((l) => l.id));

// 小棋盘的级位修正（初始值，未经实测校准；可按实际胜率调整）
const SIZE_KYU_OFFSET = Object.freeze({ 9: 10, 13: 5, 19: 0 });
const MAX_KYU = 30; // KaTrain 公式在 kyu ≥ 36 左右退化，这里留足余量

function getLevel(id) {
  return LEVELS.find((l) => l.id === id) || null;
}

// rank 档在某个路数上实际使用的 kyu
function kyuFor(level, size) {
  if (!level || level.kind !== 'rank') throw new Error(`难度 ${level && level.id} 不是 rank 档`);
  const offset = SIZE_KYU_OFFSET[size] || 0;
  return Math.min(MAX_KYU, level.kyu + offset);
}

// 对外（REST / 客户端）只给 { id, name, desc }
function publicLevels() {
  return LEVELS.map(({ id, name, desc }) => ({ id, name, desc }));
}

module.exports = { LEVELS, LEVEL_IDS, SIZE_KYU_OFFSET, MAX_KYU, getLevel, kyuFor, publicLevels };
