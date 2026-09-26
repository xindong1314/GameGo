package com.gamego.ai;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * 与 KaTrain 原版 Python 代码的逐手比对（移植自 server/test/ai/rank.test.js）：
 * 用同一个伪随机数生成器（mulberry32，种子 12345）重建 3000 组合成的 policy（9/13/19 路、0~100% 非法点、
 * 尖锐/平坦分布、pass 概率 0~0.3、人为制造的数值并列），以及每组要喂给 random.random() 的均匀随机数序列。
 * resources/ai/katrain-reference.json 记录了原版 RankStrategy / PolicyStrategy 在这些输入上选出的着手。
 */
class RankStrategyTest {
  record Case(int size, double kyu, double[] policy, double[] uniforms) {}

  static List<Case> cases;
  static JsonNode reference;

  @BeforeAll
  static void load() throws Exception {
    try (InputStream in = RankStrategyTest.class.getResourceAsStream("/ai/katrain-reference.json")) {
      reference = new ObjectMapper().readTree(in);
    }
    cases = buildCases();
  }

  static List<Case> buildCases() {
    Mulberry32 r = new Mulberry32(12345);
    java.util.function.DoubleSupplier openU =
        () -> {
          double u;
          do {
            u = r.getAsDouble();
          } while (u == 0);
          return u;
        };
    double[] illegalFracs = {0, 0.1, 0.4, 0.7, 0.95, 1};
    double[] sharps = {1, 3, 8, 20, 40};
    double[] passMasses = {0, 1e-4, 0.001, 0.02, 0.3};
    double[] roundTos = {0, 0, 1000, 100};
    double[] kyus = {18, 15, 12, 10, 8, 6, 4, 2, 1, 0, -1, -2, 7.5, 3.3};
    List<Case> out = new ArrayList<>();
    for (int k = 0; k < 3000; k++) {
      int size = new int[] {9, 13, 19}[k % 3];
      double illegalFrac = illegalFracs[(int) Math.floor(r.getAsDouble() * 6)];
      double sharp = sharps[(int) Math.floor(r.getAsDouble() * 5)];
      double passMass = passMasses[(int) Math.floor(r.getAsDouble() * 5)];
      double roundTo = roundTos[(int) Math.floor(r.getAsDouble() * 4)];
      // synthPolicy
      int n = size * size;
      double[] w = new double[n];
      for (int i = 0; i < n; i++) w[i] = StrictMath.pow(openU.getAsDouble(), sharp);
      boolean[] legal = new boolean[n];
      for (int i = 0; i < n; i++) legal[i] = r.getAsDouble() >= illegalFrac;
      double sum = 0;
      for (int i = 0; i < n; i++) if (legal[i]) sum += w[i];
      double[] pol = new double[n + 1];
      for (int i = 0; i < n; i++) pol[i] = legal[i] ? (w[i] / (sum != 0 ? sum : 1)) * (1 - passMass) : -1;
      pol[n] = passMass;
      boolean none = true;
      for (boolean l : legal) if (l) none = false;
      if (none) pol[n] = 1;
      if (roundTo != 0) {
        for (int i = 0; i <= n; i++) {
          if (pol[i] > 0) pol[i] = Math.max(1e-8, Math.round(pol[i] * roundTo) / roundTo);
        }
      }
      double kyu = kyus[(int) Math.floor(r.getAsDouble() * 14)];
      double[] uniforms = new double[n + 5];
      for (int i = 0; i < uniforms.length; i++) uniforms[i] = openU.getAsDouble();
      out.add(new Case(size, kyu, pol, uniforms));
    }
    return out;
  }

  static int fromPy(JsonNode v) {
    return v.isTextual() && v.asText().equals("pass") ? RankStrategy.PASS : v.asInt();
  }

  @Test
  void rankMatchesKaTrainReferenceOn3000CasesCoveringAllBranches() {
    JsonNode ref = reference.get("rank");
    assertEquals(cases.size(), ref.size());
    Map<String, Integer> reasons = new HashMap<>();
    List<String> mismatches = new ArrayList<>();
    for (int i = 0; i < cases.size(); i++) {
      Case c = cases.get(i);
      RankStrategy.RankDecision d =
          RankStrategy.pickRankMoveDetailed(c.policy, c.size, c.kyu, Mulberry32.seq(c.uniforms));
      reasons.merge(d.reason().replaceAll("\\d+", "N"), 1, Integer::sum);
      if (d.move() != fromPy(ref.get(i))) {
        mismatches.add("#" + i + " java=" + d.move() + " py=" + ref.get(i) + " (" + d.reason() + ")");
      }
    }
    assertEquals(List.of(), mismatches.subList(0, Math.min(5, mismatches.size())));
    for (String path :
        List.of(
            "pass-in-top-N -> top policy move",
            "top policy > override",
            "top-N policy sum > overridetwo",
            "picked move policy < pass policy -> top policy move",
            "best of N random legal moves")) {
      assertTrue(reasons.getOrDefault(path, 0) > 0, "分支没覆盖到：" + path);
    }
  }

  @Test
  void policyMatchesKaTrainReferenceIncludingOpeningRandomisation() {
    JsonNode ref = reference.get("policy");
    assertEquals(cases.size(), ref.size());
    int mismatches = 0;
    for (int i = 0; i < cases.size(); i++) {
      Case c = cases.get(i);
      int mv = RankStrategy.pickPolicyMove(c.policy, c.size, (i * 7) % 40, Mulberry32.seq(c.uniforms));
      if (mv != fromPy(ref.get(i))) mismatches++;
    }
    assertEquals(0, mismatches);
  }

  @Test
  void nMovesFormulaMatchesOriginal() {
    JsonNode nm = reference.get("nmoves");
    assertEquals(195, nm.size());
    for (Map.Entry<String, JsonNode> e : nm.properties()) {
      String[] parts = e.getKey().split("\\|");
      int size = Integer.parseInt(parts[0]);
      double kyu = Double.parseDouble(parts[1]);
      double frac = Double.parseDouble(parts[2]);
      int nLegal = (int) RankStrategy.pyRound(frac * size * size);
      assertEquals(e.getValue().asInt(), RankStrategy.rankNMoves(nLegal, size * size, kyu), e.getKey());
    }
    // 几个研究报告里的数：19 路空盘 8 级看 55 个点，18 级 15 个，3 段 132 个
    assertEquals(55, RankStrategy.rankNMoves(361, 361, 8));
    assertEquals(15, RankStrategy.rankNMoves(361, 361, 18));
    assertEquals(132, RankStrategy.rankNMoves(361, 361, -2));
  }

  @Test
  void pyRoundIsBankersRounding() {
    long[] got = Arrays.stream(new double[] {0.5, 1.5, 2.5, 2.4, 2.6, 3.5}).mapToLong(RankStrategy::pyRound).toArray();
    assertEquals(Arrays.toString(new long[] {0, 2, 2, 2, 3, 4}), Arrays.toString(got));
  }

  @Test
  void indexConventionIsOurIdxAndPassIsMinusOne() {
    int n = 9;
    double[] policy = new double[n * n + 1];
    Arrays.fill(policy, 0.001);
    policy[2] = 0.95; // C9（第一行第 3 列）
    assertEquals(2, RankStrategy.pickRankMove(policy, 9, 18, new Mulberry32(1)));
    double[] passTop = new double[n * n + 1];
    Arrays.fill(passTop, -1);
    passTop[40] = 0.2;
    passTop[n * n] = 0.8;
    assertEquals(-1, RankStrategy.pickRankMove(passTop, 9, 8, new Mulberry32(1)));
    assertEquals(-1, RankStrategy.pickPolicyMove(passTop, 9, 50, Math::random));
  }

  @Test
  void passRules() {
    int n = 19;
    double[] policy = new double[n * n + 1];
    Arrays.fill(policy, -1);
    policy[0] = 0.4;
    policy[1] = 0.1;
    policy[n * n] = 0.5; // pass 排第一
    assertEquals(-1, RankStrategy.pickRankMoveDetailed(policy, 19, 8, new Mulberry32(1)).move());
    policy[n * n] = 0.3; // pass 排第二（前 5）→ 下第一的点
    RankStrategy.RankDecision d = RankStrategy.pickRankMoveDetailed(policy, 19, 8, new Mulberry32(1));
    assertEquals(0, d.move());
    assertTrue(d.reason().contains("pass-in-top-5"));
    // 没有任何合法点 → pass
    double[] none = new double[n * n + 1];
    Arrays.fill(none, -1);
    none[n * n] = 1;
    assertEquals(-1, RankStrategy.pickRankMove(none, 19, 8, new Mulberry32(1)));
  }

  @Test
  void strongerLevelsSampleMoreAndPickBetterRankedMoves() {
    int n = 19;
    double[] policy = new double[n * n + 1];
    double s = 0;
    for (int i = 0; i < n * n; i++) {
      policy[i] = Math.pow(0.9, i);
      s += policy[i];
    }
    for (int i = 0; i < n * n; i++) policy[i] /= s;
    policy[n * n] = 1e-6;
    java.util.function.DoubleUnaryOperator meanRank =
        kyu -> {
          Mulberry32 rng = new Mulberry32(99);
          double sum = 0;
          for (int t = 0; t < 3000; t++) sum += RankStrategy.pickRankMove(policy, 19, kyu, rng) + 1;
          return sum / 3000;
        };
    double r18 = meanRank.applyAsDouble(18);
    double r8 = meanRank.applyAsDouble(8);
    double rd3 = meanRank.applyAsDouble(-2);
    assertTrue(r18 > r8 && r8 > rd3, r18 + " > " + r8 + " > " + rd3);
    assertTrue(r18 > 15 && r18 < 30, "18 级平均名次约 22：" + r18);
    assertTrue(rd3 < 4, "3 段平均名次约 2.7：" + rd3);
  }

  @Test
  void argumentValidation() {
    IllegalArgumentException e1 =
        assertThrows(IllegalArgumentException.class, () -> RankStrategy.pickRankMove(new double[] {0.5, 0.5}, 9, 8, Math::random));
    assertTrue(e1.getMessage().contains("length 82"));
    double[] ok = new double[82];
    Arrays.fill(ok, 0.01);
    IllegalArgumentException e2 =
        assertThrows(IllegalArgumentException.class, () -> RankStrategy.pickRankMove(ok, 9, Double.NaN, Math::random));
    assertTrue(e2.getMessage().contains("kyuRank"));
    IllegalArgumentException e3 =
        assertThrows(IllegalArgumentException.class, () -> RankStrategy.pickPolicyMove(new double[0], 9, 0, Math::random));
    assertTrue(e3.getMessage().contains("length 82"));
  }
}
