/*
 * rank.js - JavaScript port of KaTrain's "Calibrated Rank" AI (strategy id "ai:p:rank") and its "Policy" AI
 * (strategy id "ai:policy"), used by the GameGo server for the weaker AI levels.
 *
 * Ported from KaTrain, https://github.com/sanderland/katrain
 *   commit f4981cf905cece90085ce4e3967415d0c16d525f (main, 2026-08-24, v1.20.0)
 *   - katrain/core/ai.py       : AIStrategy.should_play_top_move (L316-354),
 *                                PolicyStrategy (L957-1017), WeightedStrategy (L1020-1096),
 *                                PickBasedStrategy.generate_weighted_coords / select_from_weighted_coords /
 *                                generate_move (L1118-1320), RankStrategy (L1337-1415)
 *   - katrain/core/utils.py    : var_to_grid (L13-20), weighted_selection_without_replacement (L92-95)
 *   - katrain/core/game_node.py: GameNode.policy_ranking (L453-459)
 * The rank calibration formulas are by bale-go (https://github.com/bale-go), see
 *   https://github.com/sanderland/katrain/issues/44 and https://github.com/sanderland/katrain/issues/74
 * The port was checked move-for-move against the original Python code (3000 random cases, 0 mismatches);
 * server/test/ai/rank.test.js repeats that comparison against the recorded Python results.
 * The 'CONTRIBUTIONS.md' file named in the notice below is not part of GameGo; see
 *   https://github.com/sanderland/katrain/blob/f4981cf905cece90085ce4e3967415d0c16d525f/CONTRIBUTIONS.md
 * KaTrain's LICENSE also lists KataGo binaries, flaticon icons and the DIGITAL-7 / Noto Sans fonts under
 * other terms; none of them are used here. All third-party notices: THIRD_PARTY_NOTICES.md.
 *
 * ---------------------------------------------------------------------------------------------------------
 * KaTrain license (MIT), from https://github.com/sanderland/katrain/blob/f4981cf905cece90085ce4e3967415d0c16d525f/LICENSE
 *
 * Copyright 2020 Sander Land and/or other authors of the content in this repository.
 * (See 'CONTRIBUTIONS.md' file for a list of authors as well as other indirect contributors).
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge, publish, distribute,
 * sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
 * NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 * ---------------------------------------------------------------------------------------------------------
 *
 * Index convention (GameGo): the input `policy` is KataGo's analysis-engine "policy" array exactly as returned
 * with "includePolicy": true - length n*n + 1, row-major starting at the TOP-left, last entry = pass, -1 for
 * illegal moves. KataGo's policy index is identical to our board idx (y * n + x, top-left = 0), so the returned
 * move is our idx, or -1 (PASS) for pass. KaTrain's own coordinates have y = 0 at the BOTTOM row; this port keeps
 * KaTrain's iteration order so that tie-breaking is identical to the original.
 */
'use strict';

const PASS = -1;

// Python 3 round(): round half to even (KaTrain uses `round(n_moves)` in ai.py L1380).
function pyRound(x) {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

// Lexicographic tuple comparison of (p, wt, x, y), as Python does when heapq.nlargest compares tuples.
function cmpTuple(a, b) {
  return a.p - b.p || a.wt - b.wt || a.x - b.x || a.y - b.y;
}

function boardDims({ boardSize, boardXSize, boardYSize }) {
  const sx = boardXSize != null ? boardXSize : boardSize;
  const sy = boardYSize != null ? boardYSize : boardSize;
  if (!Number.isInteger(sx) || !Number.isInteger(sy) || sx < 2 || sy < 2) throw new Error('invalid board size');
  return { sx, sy };
}

// GameNode.policy_ranking (game_node.py L453-459): x outer, y inner, then pass; stable sort by -policy.
// KaTrain y=0 is the bottom row; KataGo index row 0 is the top row => idx = (sy-1-y)*sx + x.
function policyRanking(policy, sx, sy) {
  const ranking = [];
  for (let x = 0; x < sx; x++) {
    for (let y = 0; y < sy; y++) {
      const idx = (sy - 1 - y) * sx + x;
      ranking.push({ p: policy[idx], idx, x, y });
    }
  }
  ranking.push({ p: policy[sx * sy], idx: PASS });
  ranking.sort((a, b) => b.p - a.p); // Array.prototype.sort is stable (ES2019+), like Python's sorted()
  return ranking;
}

/**
 * RankStrategy.get_n_moves (ai.py L1341-1384): how many random legal moves the bot "sees".
 * @param {number} nLegal        number of legal non-pass moves with policy > 0
 * @param {number} boardSquares  boardXSize * boardYSize
 * @param {number} kyuRank       18 = 18k ... 1 = 1k, 0 = 1d, -1 = 2d, -2 = 3d (KaTrain convention: dan = 1 - kyu)
 */
function rankNMoves(nLegal, boardSquares, kyuRank) {
  const normLegMoves = nLegal / boardSquares; // L1347
  // L1355-1357
  const origCalibAvemodrank = 0.063015 + (0.7624 * boardSquares) / Math.pow(10, -0.05737 * kyuRank + 1.9482);
  // L1363-1365
  const exponentTerm = 3.002 * normLegMoves * normLegMoves - normLegMoves - 0.034889 * kyuRank - 0.5097;
  // L1368-1370
  const modifiedCalibAvemodrank =
    (0.3931 + 0.6559 * normLegMoves * Math.exp(-1 * exponentTerm ** 2) - 0.01093 * kyuRank) * origCalibAvemodrank;
  const denominator = 1.31165 * (modifiedCalibAvemodrank + 1) - 0.082653; // L1376
  const nMoves = (boardSquares * normLegMoves) / denominator; // L1379
  return Math.max(1, pyRound(nMoves)); // L1380
}

/**
 * Detailed version: returns { move, reason, nMoves, override, overridetwo, nLegal, picked }.
 * move is our board idx (== KataGo policy index) or -1 for pass.
 */
function pickRankMoveDetailed({ policy, boardSize, boardXSize, boardYSize, kyuRank, rng = Math.random }) {
  const { sx, sy } = boardDims({ boardSize, boardXSize, boardYSize });
  const boardSquares = sx * sy;
  if (!Array.isArray(policy) || policy.length !== boardSquares + 1) {
    // KaTrain falls back to DefaultStrategy (full KataGo top move) when no policy is available (ai.py L1246-1250).
    throw new Error(`policy must be an array of length ${boardSquares + 1}`);
  }
  if (!Number.isFinite(kyuRank)) throw new Error('kyuRank must be a finite number');

  const passPolicy = policy[boardSquares]; // pass_policy = self.cn.policy[-1] (L1253)
  const ranking = policyRanking(policy, sx, sy);

  const top = ranking[0]; // top_policy_move = policy_moves[0][1]
  const topFivePass = ranking.slice(0, 5).some((m) => m.idx === PASS); // L1265
  // legal_policy_moves = [(pol, mv) for pol, mv in policy_moves if not mv.is_pass and pol > 0]  (L1285 / L1392)
  const nLegal = ranking.reduce((n, m) => n + (m.idx !== PASS && m.p > 0 ? 1 : 0), 0);

  // RankStrategy.should_play_top_move (L1386-1412): calibrated override thresholds
  const override = 0.8 * (1 - 0.5 * ((boardSquares - nLegal) / boardSquares)); // L1400-1401
  const overridetwo = 0.85 + Math.max(0, 0.02 * (kyuRank - 8)); // L1406
  const base = { override, overridetwo, nLegal, nMoves: null, picked: null };

  // AIStrategy.should_play_top_move (L316-354)
  if (topFivePass) return { ...base, move: top.idx, reason: 'pass-in-top-5 -> top policy move' }; // L329-331
  if (ranking[0].p > override) return { ...base, move: top.idx, reason: 'top policy > override' }; // L333-338
  if (ranking[0].p + ranking[1].p > overridetwo) {
    return { ...base, move: top.idx, reason: 'top-2 policy sum > overridetwo' }; // L340-349
  }

  // RankStrategy.handle_endgame returns (None, "", None, False) (L1414-1415): no endgame special case.

  // PickBasedStrategy.generate_weighted_coords (L1126-1128):
  // [(policy_grid[y][x], 1, x, y) for x in range(size[0]) for y in range(size[1]) if policy_grid[y][x] > 0]
  const weighted = [];
  for (let x = 0; x < sx; x++) {
    for (let y = 0; y < sy; y++) {
      const idx = (sy - 1 - y) * sx + x;
      const p = policy[idx];
      if (p > 0) weighted.push({ p, wt: 1, x, y, idx });
    }
  }

  const nMoves = rankNMoves(nLegal, boardSquares, kyuRank); // RankStrategy.get_n_moves (L1308 -> L1341)
  base.nMoves = nMoves;

  // utils.weighted_selection_without_replacement (utils.py L92-95):
  //   elt = [(math.log(random.random()) / (item[1] + 1e-18), item) for item in items]
  //   return [e[1] for e in heapq.nlargest(pick_n, elt)]
  // With all weights == 1 this is a uniformly random subset of min(nMoves, len) legal moves.
  const keyed = weighted.map((item) => ({ key: Math.log(rng()) / (item.wt + 1e-18), item }));
  keyed.sort((a, b) => b.key - a.key || cmpTuple(b.item, a.item));
  const picked = keyed.slice(0, nMoves).map((e) => e.item);
  base.picked = picked.length;

  // PickBasedStrategy.select_from_weighted_coords (L1175-1239)
  if (picked.length > 0) {
    // new_top = heapq.nlargest(5, pick_moves) -> best = max by tuple (policy, wt, x, y)   (L1188, L1198)
    let best = picked[0];
    for (const m of picked) if (cmpTuple(m, best) > 0) best = m;
    if (best.p < passPolicy) {
      // L1207-1217: pass rated higher than the chosen move -> play top policy move instead
      return { ...base, move: top.idx, reason: 'picked move policy < pass policy -> top policy move' };
    }
    return { ...base, move: best.idx, reason: `best of ${picked.length} random legal moves` };
  }
  // L1224-1235: no legal moves picked -> top policy move (which is pass if nothing on the board is legal)
  return { ...base, move: top.idx, reason: 'no legal moves -> top policy move' };
}

/** Returns our board idx (== KataGo policy index) or -1 for pass. */
function pickRankMove(opts) {
  return pickRankMoveDetailed(opts).move;
}

/**
 * Port of KaTrain's "Policy" AI (ai:policy, PolicyStrategy ai.py L957-1017) incl. its opening randomisation,
 * which delegates to WeightedStrategy (L1020-1096) with {"pick_override": 0.9, "weaken_fac": 1, "lower_bound": 0.02}.
 * movesPlayed = number of moves already on the game record (KaTrain's cn.depth). Returns our idx or -1 for pass.
 */
function pickPolicyMove({ policy, boardSize, boardXSize, boardYSize, movesPlayed, openingMoves = 22, rng = Math.random }) {
  const { sx, sy } = boardDims({ boardSize, boardXSize, boardYSize });
  const n = sx * sy;
  if (!Array.isArray(policy) || policy.length !== n + 1) throw new Error(`policy must have length ${n + 1}`);
  const ranking = policyRanking(policy, sx, sy);
  const top = ranking[0];
  const topFivePass = ranking.slice(0, 5).some((m) => m.idx === PASS);
  if (movesPlayed <= openingMoves) {
    // WeightedStrategy with pick_override 0.9, weaken_fac 1, lower_bound 0.02 (L993-997 -> L1047-1096)
    // should_play_top_move (L316-354), overridetwo default 1.0
    if (topFivePass || top.p > 0.9 || top.p + ranking[1].p > 1.0) return top.idx;
    const cands = ranking.filter((m) => m.p > 0.02 && m.idx !== PASS); // L1072-1074, weight = pv ** (1/1)
    if (cands.length === 0) return top.idx; // L1088-1093
    let bestKey = -Infinity;
    let best = null;
    for (const m of cands) {
      const key = Math.log(rng()) / (m.p + 1e-18); // utils.weighted_selection_without_replacement(..., 1)
      if (key > bestKey) {
        bestKey = key;
        best = m;
      }
    }
    return best.idx;
  }
  return top.idx; // L1000-1017: top policy move (also when pass is in the top 5)
}

module.exports = { PASS, pickRankMove, pickRankMoveDetailed, pickPolicyMove, rankNMoves, pyRound };
