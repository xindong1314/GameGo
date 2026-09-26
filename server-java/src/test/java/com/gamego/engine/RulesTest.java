package com.gamego.engine;

import static com.gamego.engine.Diagrams.fromDiagram;
import static com.gamego.engine.Diagrams.toDiagram;
import static com.gamego.engine.Go.BLACK;
import static com.gamego.engine.Go.EMPTY;
import static com.gamego.engine.Go.WHITE;
import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.gamego.engine.Rules.PlayResult;
import java.util.stream.IntStream;
import org.junit.jupiter.api.Test;

/** 移植自 test/engine-rules.test.js */
class RulesTest {

    private static final String KO_SHAPE = """
            . X O .
            X O . O
            . X O .
            . . . .
            """;

    private static void assertRejected(String reason, PlayResult r) {
        assertFalse(r.ok());
        assertEquals(reason, r.reason());
        assertNull(r.captured());
        assertNull(r.koAfter());
    }

    @Test
    void 普通落子_成功_无提子_无劫() {
        Board b = new Board(9);
        PlayResult r = Rules.tryPlay(b, BLACK, null, 40);
        assertTrue(r.ok());
        assertNull(r.reason());
        assertArrayEquals(new int[0], r.captured());
        assertNull(r.koAfter());
        assertEquals(BLACK, b.get(40));
    }

    @Test
    void 提单子_中腹() {
        Board b = fromDiagram("""
                . X .
                X O X
                . . .
                """);
        PlayResult r = Rules.tryPlay(b, BLACK, null, b.toIdx(1, 2));
        assertTrue(r.ok());
        assertArrayEquals(new int[] {4}, r.captured());
        assertNull(r.koAfter()); // 提子后落下的子有 3 口气，不是劫
        assertEquals(". X .\nX . X\n. X .", toDiagram(b));
    }

    @Test
    void 提角上的单子() {
        Board b = fromDiagram("""
                O X .
                . . .
                . . .
                """);
        PlayResult r = Rules.tryPlay(b, BLACK, null, 3);
        assertTrue(r.ok());
        assertArrayEquals(new int[] {0}, r.captured());
        assertEquals(EMPTY, b.get(0));
    }

    @Test
    void 提多子_一整块() {
        Board b = fromDiagram("""
                . X X .
                X O O X
                . X . .
                . . . .
                """);
        PlayResult r = Rules.tryPlay(b, BLACK, null, b.toIdx(2, 2));
        assertTrue(r.ok());
        assertArrayEquals(new int[] {5, 6}, r.captured());
        assertNull(r.koAfter());
        assertEquals(EMPTY, b.get(5));
        assertEquals(EMPTY, b.get(6));
    }

    @Test
    void 一手同时提掉多块() {
        Board b = fromDiagram("""
                . O X . .
                O X . . .
                X . . . .
                . . . . .
                . . . . .
                """);
        PlayResult r = Rules.tryPlay(b, BLACK, null, 0);
        assertTrue(r.ok());
        assertArrayEquals(new int[] {1, 5}, r.captured());
        assertNull(r.koAfter());
        assertEquals(EMPTY, b.get(1));
        assertEquals(EMPTY, b.get(5));
        assertEquals(BLACK, b.get(0));
    }

    @Test
    void 同一块与落点多处相邻时只提一次() {
        Board b = fromDiagram("""
                . X X X .
                X O O O X
                X O . O X
                X O O O X
                . X X X .
                """);
        PlayResult r = Rules.tryPlay(b, BLACK, null, b.toIdx(2, 2));
        assertTrue(r.ok());
        assertEquals(8, r.captured().length);
        assertEquals(8, IntStream.of(r.captured()).distinct().count());
        assertEquals(4, b.group(b.toIdx(2, 2)).liberties().length);
    }

    @Test
    void 只提没气的对方块() {
        Board b = fromDiagram("""
                . X O .
                X O . .
                . X . .
                . . . .
                """);
        PlayResult r = Rules.tryPlay(b, BLACK, null, b.toIdx(2, 1));
        assertTrue(r.ok());
        assertArrayEquals(new int[] {5}, r.captured());
        assertEquals(WHITE, b.get(b.toIdx(2, 0)));
    }

    @Test
    void 禁止自杀_单子() {
        Board b = fromDiagram("""
                . X .
                X . X
                . X .
                """);
        String before = toDiagram(b);
        assertRejected("suicide", Rules.tryPlay(b, WHITE, null, 4));
        assertEquals(before, toDiagram(b));
    }

    @Test
    void 禁止自杀_角上单子() {
        Board b = fromDiagram("""
                . X .
                X . .
                . . .
                """);
        assertRejected("suicide", Rules.tryPlay(b, WHITE, null, 0));
        assertEquals(EMPTY, b.get(0));
    }

    @Test
    void 禁止自杀_多子() {
        Board b = fromDiagram("""
                . X X X .
                X O . O X
                . X X X .
                . . . . .
                . . . . .
                """);
        String before = toDiagram(b);
        assertRejected("suicide", Rules.tryPlay(b, WHITE, null, b.toIdx(2, 1)));
        assertEquals(before, toDiagram(b));
    }

    @Test
    void 填自己最后一口气也是自杀() {
        Board b = fromDiagram("""
                O O X .
                . X X .
                X . . .
                . . . .
                """);
        assertRejected("suicide", Rules.tryPlay(b, WHITE, null, 4));
        assertEquals(EMPTY, b.get(4));
        assertEquals(WHITE, b.get(0));
    }

    @Test
    void 落下后本身没气但能提子不算自杀() {
        Board b = fromDiagram(KO_SHAPE);
        PlayResult r = Rules.tryPlay(b, BLACK, null, 6);
        assertTrue(r.ok());
        assertArrayEquals(new int[] {5}, r.captured());
        assertEquals(EMPTY, b.get(5));
        assertEquals(BLACK, b.get(6));
    }

    @Test
    void 打劫_不能立即回提_劫点解除后可以() {
        Board b = fromDiagram(KO_SHAPE);
        PlayResult r = Rules.tryPlay(b, BLACK, null, 6);
        assertEquals(5, r.koAfter());
        assertRejected("ko", Rules.tryPlay(b, WHITE, r.koAfter(), 5));
        assertEquals(EMPTY, b.get(5));
        assertEquals(OpResult.fail("ko"), Rules.canPlay(b, WHITE, r.koAfter(), 5));
        PlayResult back = Rules.tryPlay(b, WHITE, null, 5);
        assertTrue(back.ok());
        assertArrayEquals(new int[] {6}, back.captured());
        assertEquals(6, back.koAfter());
        assertEquals(EMPTY, b.get(6));
    }

    @Test
    void 劫点只禁止那一个点() {
        Board b = fromDiagram(KO_SHAPE);
        PlayResult r = Rules.tryPlay(b, BLACK, null, 6);
        assertTrue(Rules.tryPlay(b, WHITE, r.koAfter(), 15).ok());
    }

    @Test
    void 提两子不成劫() {
        Board b = fromDiagram("""
                X O O . O
                . X X O O
                . . . . .
                . . . . .
                . . . . .
                """);
        PlayResult r = Rules.tryPlay(b, BLACK, null, 3);
        assertTrue(r.ok());
        assertArrayEquals(new int[] {1, 2}, r.captured());
        assertNull(r.koAfter());
        assertArrayEquals(new int[] {2}, b.group(3).liberties());
        PlayResult back = Rules.tryPlay(b, WHITE, r.koAfter(), 2);
        assertTrue(back.ok());
        assertArrayEquals(new int[] {3}, back.captured());
        assertNull(back.koAfter());
    }

    @Test
    void 提一子但与己方连成一块不是劫() {
        Board b = fromDiagram("""
                . X O . .
                X O . O .
                . X X . .
                . . . . .
                . . . . .
                """);
        PlayResult r = Rules.tryPlay(b, BLACK, null, b.toIdx(2, 1));
        assertTrue(r.ok());
        assertArrayEquals(new int[] {b.toIdx(1, 1)}, r.captured());
        assertNull(r.koAfter());
    }

    @Test
    void 失败原因_invalid_索引越界() {
        Board b = new Board(9);
        for (int idx : new int[] {-1, 81, 100, Integer.MIN_VALUE, Integer.MAX_VALUE}) {
            assertRejected("invalid", Rules.tryPlay(b, BLACK, null, idx));
            assertEquals(OpResult.fail("invalid"), Rules.canPlay(b, BLACK, null, idx));
        }
        for (byte c : b.cells) assertEquals(EMPTY, c);
    }

    @Test
    void 失败原因_invalid_颜色不是黑白() {
        Board b = new Board(9);
        assertRejected("invalid", Rules.tryPlay(b, EMPTY, null, 40));
        assertRejected("invalid", Rules.tryPlay(b, 3, null, 40));
        assertEquals(EMPTY, b.get(40));
    }

    @Test
    void 失败原因_occupied_棋盘不变() {
        Board b = new Board(9);
        Rules.tryPlay(b, BLACK, null, 40);
        String before = toDiagram(b);
        assertRejected("occupied", Rules.tryPlay(b, WHITE, null, 40));
        assertRejected("occupied", Rules.tryPlay(b, BLACK, null, 40));
        assertEquals(before, toDiagram(b));
        assertEquals(BLACK, b.get(40));
    }

    @Test
    void 判定顺序_有子优先于劫() {
        Board b = new Board(9);
        b.set(40, BLACK);
        assertRejected("occupied", Rules.tryPlay(b, WHITE, 40, 40));
    }

    @Test
    void 失败原因_ko_即使能提子也不行() {
        Board b = fromDiagram(KO_SHAPE);
        String before = toDiagram(b);
        assertRejected("ko", Rules.tryPlay(b, BLACK, 6, 6));
        assertEquals(before, toDiagram(b));
    }

    @Test
    void canPlay_只判断不落子_成功时reason为null() {
        Board b = fromDiagram(KO_SHAPE);
        String before = toDiagram(b);
        assertEquals(new OpResult(true, null), Rules.canPlay(b, BLACK, null, 6));
        assertEquals(before, toDiagram(b));
        assertEquals(new OpResult(true, null), Rules.canPlay(b, BLACK, null, 15));
        assertEquals(OpResult.fail("occupied"), Rules.canPlay(b, WHITE, null, 1));
        assertEquals(OpResult.fail("ko"), Rules.canPlay(b, BLACK, 6, 6));
        assertEquals(before, toDiagram(b));
    }

    @Test
    void canPlay_自杀点() {
        Board b = fromDiagram("""
                . X .
                X . X
                . X .
                """);
        assertEquals(OpResult.fail("suicide"), Rules.canPlay(b, WHITE, null, 4));
        assertEquals(OpResult.OK, Rules.canPlay(b, BLACK, null, 4));
        assertEquals(EMPTY, b.get(4));
    }

    /** 与 JS 测试同一个 LCG */
    private static final class Lcg {
        private int s;

        Lcg(int seed) {
            s = seed;
        }

        double next() {
            s = s * 1664525 + 1013904223;
            return Integer.toUnsignedLong(s) / 4294967296.0;
        }
    }

    @Test
    void 随机对局_每步之后盘上没有无气的块_提子数与棋盘一致() {
        Lcg rnd = new Lcg(20260925);
        Board b = new Board(19);
        int color = BLACK;
        Integer ko = null;
        int stonesOnBoard = 0;
        int totalCaptured = 0;
        for (int step = 0; step < 600; step++) {
            int idx = (int) Math.floor(rnd.next() * 361);
            OpResult legal = Rules.canPlay(b, color, ko, idx);
            PlayResult r = Rules.tryPlay(b, color, ko, idx);
            assertEquals(legal.ok(), r.ok());
            if (!r.ok()) {
                assertEquals(legal.reason(), r.reason());
                continue;
            }
            stonesOnBoard += 1 - r.captured().length;
            totalCaptured += r.captured().length;
            for (int i : r.captured()) assertEquals(EMPTY, b.get(i));
            ko = r.koAfter();
            color = Go.opponent(color);
            int count = 0;
            for (int i = 0; i < 361; i++) {
                if (b.get(i) != EMPTY) {
                    assertTrue(b.group(i).liberties().length > 0);
                    count++;
                }
            }
            assertEquals(stonesOnBoard, count);
        }
        assertTrue(totalCaptured > 0);
    }
}
