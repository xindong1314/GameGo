/*
 * RankStrategy.java - Java port of KaTrain's "Calibrated Rank" AI (strategy id "ai:p:rank") and its "Policy" AI
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
 * via GameGo's JavaScript port server/src/ai/rank.js (same logic, same tie-breaking).
 * The rank calibration formulas are by bale-go (https://github.com/bale-go), see
 *   https://github.com/sanderland/katrain/issues/44 and https://github.com/sanderland/katrain/issues/74
 * The port was checked move-for-move against the original Python code (3000 random cases, 0 mismatches);
 * src/test/java/com/gamego/ai/RankStrategyTest.java repeats that comparison against the recorded Python results
 * (src/test/resources/ai/katrain-reference.json).
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
 *
 * Floating point: StrictMath (fdlibm) is used for log/pow/exp so that results are reproducible across JVMs and
 * match the recorded reference results bit for bit.
 */
package com.gamego.ai;

import java.util.ArrayList;
import java.util.List;
import java.util.function.DoubleSupplier;

/** KaTrain RankStrategy / PolicyStrategy 的移植（纯函数，rng 由调用方注入）。 */
public final class RankStrategy {
  private RankStrategy() {}

  public static final int PASS = -1;

  /** One entry of GameNode.policy_ranking / generate_weighted_coords: (p, wt, x, y) plus our idx. */
  private record Cand(double p, double wt, int x, int y, int idx) {}

  /** Result of {@link #pickRankMoveDetailed}; nMoves / picked are null when the sampling step was not reached. */
  public record RankDecision(
      int move, String reason, double override, double overridetwo, int nLegal, Integer nMoves, Integer picked) {}

  // JS `a - b` used as a comparator: sign of the difference (keeps -0 / 0 ties identical to the JS/Python port)
  private static int sign(double d) {
    return d > 0 ? 1 : d < 0 ? -1 : 0;
  }

  /** Python 3 round(): round half to even (KaTrain uses `round(n_moves)` in ai.py L1380). */
  public static long pyRound(double x) {
    double f = Math.floor(x);
    double diff = x - f;
    if (diff > 0.5) return (long) f + 1;
    if (diff < 0.5) return (long) f;
    return ((long) f) % 2 == 0 ? (long) f : (long) f + 1;
  }

  // Lexicographic tuple comparison of (p, wt, x, y), as Python does when heapq.nlargest compares tuples.
  private static int cmpTuple(Cand a, Cand b) {
    int c = sign(a.p - b.p);
    if (c != 0) return c;
    c = sign(a.wt - b.wt);
    if (c != 0) return c;
    c = Integer.compare(a.x, b.x);
    if (c != 0) return c;
    return Integer.compare(a.y, b.y);
  }

  private static void checkSize(int sx, int sy) {
    if (sx < 2 || sy < 2) throw new IllegalArgumentException("invalid board size");
  }

  // GameNode.policy_ranking (game_node.py L453-459): x outer, y inner, then pass; stable sort by -policy.
  // KaTrain y=0 is the bottom row; KataGo index row 0 is the top row => idx = (sy-1-y)*sx + x.
  private static List<Cand> policyRanking(double[] policy, int sx, int sy) {
    List<Cand> ranking = new ArrayList<>(sx * sy + 1);
    for (int x = 0; x < sx; x++) {
      for (int y = 0; y < sy; y++) {
        int idx = (sy - 1 - y) * sx + x;
        ranking.add(new Cand(policy[idx], 1, x, y, idx));
      }
    }
    ranking.add(new Cand(policy[sx * sy], 1, -1, -1, PASS));
    ranking.sort((a, b) -> sign(b.p - a.p)); // List.sort is stable (TimSort), like Python's sorted()
    return ranking;
  }

  /**
   * RankStrategy.get_n_moves (ai.py L1341-1384): how many random legal moves the bot "sees".
   *
   * @param nLegal number of legal non-pass moves with policy &gt; 0
   * @param boardSquares boardXSize * boardYSize
   * @param kyuRank 18 = 18k ... 1 = 1k, 0 = 1d, -1 = 2d, -2 = 3d (KaTrain convention: dan = 1 - kyu)
   */
  public static int rankNMoves(int nLegal, int boardSquares, double kyuRank) {
    double normLegMoves = (double) nLegal / boardSquares; // L1347
    // L1355-1357
    double origCalibAvemodrank =
        0.063015 + (0.7624 * boardSquares) / StrictMath.pow(10, -0.05737 * kyuRank + 1.9482);
    // L1363-1365
    double exponentTerm = 3.002 * normLegMoves * normLegMoves - normLegMoves - 0.034889 * kyuRank - 0.5097;
    // L1368-1370
    double modifiedCalibAvemodrank =
        (0.3931 + 0.6559 * normLegMoves * StrictMath.exp(-1 * (exponentTerm * exponentTerm)) - 0.01093 * kyuRank)
            * origCalibAvemodrank;
    double denominator = 1.31165 * (modifiedCalibAvemodrank + 1) - 0.082653; // L1376
    double nMoves = (boardSquares * normLegMoves) / denominator; // L1379
    return (int) Math.max(1, pyRound(nMoves)); // L1380
  }

  /** Square board convenience overload. */
  public static RankDecision pickRankMoveDetailed(double[] policy, int boardSize, double kyuRank, DoubleSupplier rng) {
    return pickRankMoveDetailed(policy, boardSize, boardSize, kyuRank, rng);
  }

  /** Detailed version. move is our board idx (== KataGo policy index) or -1 for pass. */
  public static RankDecision pickRankMoveDetailed(
      double[] policy, int sx, int sy, double kyuRank, DoubleSupplier rng) {
    checkSize(sx, sy);
    int boardSquares = sx * sy;
    if (policy == null || policy.length != boardSquares + 1) {
      // KaTrain falls back to DefaultStrategy (full KataGo top move) when no policy is available (ai.py L1246-1250).
      throw new IllegalArgumentException("policy must be an array of length " + (boardSquares + 1));
    }
    if (!Double.isFinite(kyuRank)) throw new IllegalArgumentException("kyuRank must be a finite number");

    double passPolicy = policy[boardSquares]; // pass_policy = self.cn.policy[-1] (L1253)
    List<Cand> ranking = policyRanking(policy, sx, sy);

    Cand top = ranking.get(0); // top_policy_move = policy_moves[0][1]
    boolean topFivePass = false; // L1265
    for (int i = 0; i < Math.min(5, ranking.size()); i++) if (ranking.get(i).idx == PASS) topFivePass = true;
    // legal_policy_moves = [(pol, mv) for pol, mv in policy_moves if not mv.is_pass and pol > 0]  (L1285 / L1392)
    int nLegal = 0;
    for (Cand m : ranking) if (m.idx != PASS && m.p > 0) nLegal++;

    // RankStrategy.should_play_top_move (L1386-1412): calibrated override thresholds
    double override = 0.8 * (1 - 0.5 * ((double) (boardSquares - nLegal) / boardSquares)); // L1400-1401
    double overridetwo = 0.85 + Math.max(0, 0.02 * (kyuRank - 8)); // L1406

    // AIStrategy.should_play_top_move (L316-354)
    if (topFivePass) {
      return new RankDecision(top.idx, "pass-in-top-5 -> top policy move", override, overridetwo, nLegal, null, null);
    }
    if (ranking.get(0).p > override) {
      return new RankDecision(top.idx, "top policy > override", override, overridetwo, nLegal, null, null);
    }
    if (ranking.get(0).p + ranking.get(1).p > overridetwo) {
      return new RankDecision(top.idx, "top-2 policy sum > overridetwo", override, overridetwo, nLegal, null, null);
    }

    // RankStrategy.handle_endgame returns (None, "", None, False) (L1414-1415): no endgame special case.

    // PickBasedStrategy.generate_weighted_coords (L1126-1128):
    // [(policy_grid[y][x], 1, x, y) for x in range(size[0]) for y in range(size[1]) if policy_grid[y][x] > 0]
    List<Cand> weighted = new ArrayList<>();
    for (int x = 0; x < sx; x++) {
      for (int y = 0; y < sy; y++) {
        int idx = (sy - 1 - y) * sx + x;
        double p = policy[idx];
        if (p > 0) weighted.add(new Cand(p, 1, x, y, idx));
      }
    }

    int nMoves = rankNMoves(nLegal, boardSquares, kyuRank); // RankStrategy.get_n_moves (L1308 -> L1341)

    // utils.weighted_selection_without_replacement (utils.py L92-95):
    //   elt = [(math.log(random.random()) / (item[1] + 1e-18), item) for item in items]
    //   return [e[1] for e in heapq.nlargest(pick_n, elt)]
    // With all weights == 1 this is a uniformly random subset of min(nMoves, len) legal moves.
    int count = weighted.size();
    double[] keys = new double[count];
    Integer[] order = new Integer[count];
    for (int i = 0; i < count; i++) {
      keys[i] = StrictMath.log(rng.getAsDouble()) / (weighted.get(i).wt + 1e-18);
      order[i] = i;
    }
    java.util.Arrays.sort(
        order,
        (a, b) -> {
          int c = sign(keys[b] - keys[a]);
          return c != 0 ? c : cmpTuple(weighted.get(b), weighted.get(a));
        });
    int pickedCount = Math.min(nMoves, count);

    // PickBasedStrategy.select_from_weighted_coords (L1175-1239)
    if (pickedCount > 0) {
      // new_top = heapq.nlargest(5, pick_moves) -> best = max by tuple (policy, wt, x, y)   (L1188, L1198)
      Cand best = weighted.get(order[0]);
      for (int i = 0; i < pickedCount; i++) {
        Cand m = weighted.get(order[i]);
        if (cmpTuple(m, best) > 0) best = m;
      }
      if (best.p < passPolicy) {
        // L1207-1217: pass rated higher than the chosen move -> play top policy move instead
        return new RankDecision(
            top.idx,
            "picked move policy < pass policy -> top policy move",
            override,
            overridetwo,
            nLegal,
            nMoves,
            pickedCount);
      }
      return new RankDecision(
          best.idx,
          "best of " + pickedCount + " random legal moves",
          override,
          overridetwo,
          nLegal,
          nMoves,
          pickedCount);
    }
    // L1224-1235: no legal moves picked -> top policy move (which is pass if nothing on the board is legal)
    return new RankDecision(
        top.idx, "no legal moves -> top policy move", override, overridetwo, nLegal, nMoves, pickedCount);
  }

  /** Returns our board idx (== KataGo policy index) or -1 for pass. */
  public static int pickRankMove(double[] policy, int boardSize, double kyuRank, DoubleSupplier rng) {
    return pickRankMoveDetailed(policy, boardSize, boardSize, kyuRank, rng).move();
  }

  /**
   * Port of KaTrain's "Policy" AI (ai:policy, PolicyStrategy ai.py L957-1017) incl. its opening randomisation, which
   * delegates to WeightedStrategy (L1020-1096) with {"pick_override": 0.9, "weaken_fac": 1, "lower_bound": 0.02}.
   * movesPlayed = number of moves already on the game record (KaTrain's cn.depth). Returns our idx or -1 for pass.
   */
  public static int pickPolicyMove(
      double[] policy, int boardSize, int movesPlayed, int openingMoves, DoubleSupplier rng) {
    int sx = boardSize;
    int sy = boardSize;
    checkSize(sx, sy);
    int n = sx * sy;
    if (policy == null || policy.length != n + 1) {
      throw new IllegalArgumentException("policy must have length " + (n + 1));
    }
    List<Cand> ranking = policyRanking(policy, sx, sy);
    Cand top = ranking.get(0);
    boolean topFivePass = false;
    for (int i = 0; i < Math.min(5, ranking.size()); i++) if (ranking.get(i).idx == PASS) topFivePass = true;
    if (movesPlayed <= openingMoves) {
      // WeightedStrategy with pick_override 0.9, weaken_fac 1, lower_bound 0.02 (L993-997 -> L1047-1096)
      // should_play_top_move (L316-354), overridetwo default 1.0
      if (topFivePass || top.p > 0.9 || top.p + ranking.get(1).p > 1.0) return top.idx;
      double bestKey = Double.NEGATIVE_INFINITY;
      Cand best = null;
      for (Cand m : ranking) {
        if (!(m.p > 0.02) || m.idx == PASS) continue; // L1072-1074, weight = pv ** (1/1)
        double key = StrictMath.log(rng.getAsDouble()) / (m.p + 1e-18); // weighted_selection_without_replacement(.., 1)
        if (key > bestKey) {
          bestKey = key;
          best = m;
        }
      }
      if (best == null) return top.idx; // L1088-1093
      return best.idx;
    }
    return top.idx; // L1000-1017: top policy move (also when pass is in the top 5)
  }

  /** {@link #pickPolicyMove(double[], int, int, int, DoubleSupplier)} with KaTrain's default of 22 opening moves. */
  public static int pickPolicyMove(double[] policy, int boardSize, int movesPlayed, DoubleSupplier rng) {
    return pickPolicyMove(policy, boardSize, movesPlayed, 22, rng);
  }
}
