package com.gamego.ai;

import static com.gamego.ai.TestUtil.code;
import static com.gamego.ai.TestUtil.get;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.gamego.engine.Board;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import org.junit.jupiter.api.Test;

/** 移植自 server/test/ai/fallback.test.js。 */
class FallbackAiServiceTest {
  static final int BLACK = 1;
  static final int WHITE = 2;

  static FallbackAiService ai(int seed) {
    return new FallbackAiService(0L, new CaptureLog(), new Mulberry32(seed), AiCommon.Sleeper.REAL, System::currentTimeMillis);
  }

  static Board board(int size, int[][] stones) {
    Board b = new Board(size);
    for (int[] s : stones) b.set(s[0], s[1]);
    return b;
  }

  static AiMoveRequest req(int size, int[] moves, int color, String level) {
    return new AiMoveRequest(size, 7.5, moves, color, level, false);
  }

  @Test
  void interfaceAndLevels() {
    FallbackAiService s = ai(1);
    assertTrue(s.available());
    assertEquals(List.of(new AiLevel("basic", "内置练习 AI", FallbackAiService.BASIC_LEVEL.desc())), s.levels());
    assertTrue(FallbackAiService.BASIC_LEVEL.desc().contains("KataGo"));
    assertEquals("ai_unavailable", code(s.judgeDead(9, 7.5, new int[] {-1, -1})));
    assertEquals("fallback", s.kind());
    s.shutdown();
    assertFalse(s.available());
    assertEquals("ai_unavailable", code(s.chooseMove(req(9, new int[0], BLACK, "basic"))));
  }

  @Test
  void validationMatchesRealServiceAndAcceptsKataGoLevelIds() {
    FallbackAiService s = ai(1);
    assertEquals("bad_request", code(s.chooseMove(req(9, new int[0], WHITE, "basic"))));
    assertEquals("bad_request", code(s.chooseMove(req(9, new int[0], BLACK, "zzz"))));
    assertEquals("bad_request", code(s.chooseMove(req(8, new int[0], BLACK, "basic"))));
    AiMove r = get(s.chooseMove(req(9, new int[0], BLACK, "k8")));
    assertFalse(r.resign());
    assertTrue(r.move() >= 0 && r.move() < 81);
  }

  @Test
  void capturesWhenPossibleMostStonesFirst() {
    // 黑 0 只剩一口气（白 1 已贴住），白走 9 提掉
    for (int seed = 1; seed <= 5; seed++) {
      assertEquals(9, get(ai(seed).chooseMove(req(9, new int[] {0, 1, 80}, WHITE, "basic"))).move());
    }
    // 两处可提：提 2 子的优先
    Board b =
        board(
            9,
            new int[][] {
              {0, BLACK}, {1, WHITE}, {30, BLACK}, {31, BLACK}, {21, WHITE}, {22, WHITE}, {29, WHITE}, {39, WHITE}, {40, WHITE}
            });
    assertEquals(32, FallbackAiService.chooseFallbackMove(b, WHITE, null, false, new Mulberry32(3), null));
    assertEquals(32, FallbackAiService.chooseFallbackMove(b, WHITE, null, true, new Mulberry32(3), null), "对方 pass 后有子可提仍然提");
  }

  @Test
  void doesNotFillOwnEyeOrSelfAtari() {
    Board b = board(9, new int[][] {{1, WHITE}, {9, WHITE}});
    assertTrue(FallbackAiService.isOwnEye(b, 0, WHITE));
    assertFalse(FallbackAiService.isOwnEye(b, 0, BLACK));
    Board b2 = board(9, new int[][] {{1, WHITE}});
    Mulberry32 rng = new Mulberry32(11);
    for (int i = 0; i < 300; i++) {
      assertNotEquals(0, FallbackAiService.chooseFallbackMove(b, WHITE, null, false, rng, null));
      assertNotEquals(0, FallbackAiService.chooseFallbackMove(b2, BLACK, null, false, rng, null));
    }
  }

  @Test
  void passesWhenNoReasonableMoveOrOpponentPassedWithNothingToCapture() {
    int size = 9;
    Set<Integer> eyes = Set.of(0, 20, 44, 80);
    List<int[]> stones = new ArrayList<>();
    for (int i = 0; i < size * size; i++) if (!eyes.contains(i)) stones.add(new int[] {i, WHITE});
    Board full = board(size, stones.toArray(new int[0][]));
    assertEquals(-1, FallbackAiService.chooseFallbackMove(full, WHITE, null, false, new Mulberry32(1), null));
    assertEquals(-1, FallbackAiService.chooseFallbackMove(full, BLACK, null, false, new Mulberry32(1), null));
    assertEquals(-1, FallbackAiService.chooseFallbackMove(new Board(9), BLACK, null, true, Math::random, null));
  }

  @Test
  void twoFallbackAisFinishAWholeGameWithLegalMoves() {
    for (int size : new int[] {9, 13}) {
      AiService s =
          AiServiceFactory.create(new AiServiceFactory.Settings(null, null, null, true, 0L, null), AiLog.SILENT);
      assertEquals("fallback", s.kind());
      List<Integer> moves = new ArrayList<>();
      int passes = 0;
      while (passes < 2) {
        assertTrue(moves.size() < size * size * 4, "对局应当能结束");
        int color = moves.size() % 2 == 0 ? BLACK : WHITE;
        boolean hjp = !moves.isEmpty() && moves.get(moves.size() - 1) == -1;
        int[] arr = moves.stream().mapToInt(Integer::intValue).toArray();
        AiMove r = get(s.chooseMove(new AiMoveRequest(size, 7.5, arr, color, "basic", hjp)));
        assertFalse(r.resign());
        if (r.move() != -1) {
          assertTrue(AiCommon.isLegal(AiCommon.replayMoves(size, 7.5, arr), color, r.move()), size + " 路第 " + (moves.size() + 1) + " 手");
        }
        passes = r.move() == -1 ? passes + 1 : 0;
        moves.add(r.move());
      }
      assertTrue(moves.size() > size * 2, size + " 路下了 " + moves.size() + " 手");
      s.shutdown();
    }
  }

  @Test
  void minimumThinkTime() {
    List<Long> sleeps = new ArrayList<>();
    FallbackAiService s =
        new FallbackAiService(
            null,
            AiLog.SILENT,
            Math::random,
            ms -> {
              sleeps.add(ms);
              return CompletableFuture.completedFuture(null);
            },
            () -> 0L);
    get(s.chooseMove(req(9, new int[0], BLACK, "basic")));
    assertEquals(List.of(600L), sleeps);
  }
}
