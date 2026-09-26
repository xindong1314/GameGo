package com.gamego.engine;

import static com.gamego.engine.Diagrams.fromDiagram;
import static com.gamego.engine.Diagrams.sorted;
import static com.gamego.engine.Diagrams.toDiagram;
import static com.gamego.engine.Go.BLACK;
import static com.gamego.engine.Go.EMPTY;
import static com.gamego.engine.Go.WHITE;
import static com.gamego.engine.Go.opponent;
import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Arrays;
import java.util.stream.IntStream;
import org.junit.jupiter.api.Test;

/** 移植自 test/engine-board.test.js 与 test/engine-helpers.test.js */
class BoardTest {

    private static boolean contains(int[] a, int v) {
        return IntStream.of(a).anyMatch(x -> x == v);
    }

    @Test
    void 颜色常量与opponent() {
        assertEquals(0, EMPTY);
        assertEquals(1, BLACK);
        assertEquals(2, WHITE);
        assertEquals(-1, Go.PASS);
        assertEquals(WHITE, opponent(BLACK));
        assertEquals(BLACK, opponent(WHITE));
        assertEquals(EMPTY, opponent(EMPTY));
        assertEquals(EMPTY, opponent(7));
    }

    @Test
    void 新棋盘_路数_全空() {
        for (int n : new int[] {9, 13, 19}) {
            Board b = new Board(n);
            assertEquals(n, b.n);
            assertEquals(n * n, b.cells.length);
            for (byte c : b.cells) assertEquals(EMPTY, c);
        }
    }

    @Test
    void 非法路数抛错() {
        assertThrows(IllegalArgumentException.class, () -> new Board(0));
        assertThrows(IllegalArgumentException.class, () -> new Board(-3));
    }

    @Test
    void toIdx_toXY_按行展开_左上角为0() {
        Board b = new Board(9);
        assertEquals(0, b.toIdx(0, 0));
        assertEquals(8, b.toIdx(8, 0));
        assertEquals(9, b.toIdx(0, 1));
        assertEquals(40, b.toIdx(4, 4));
        assertEquals(80, b.toIdx(8, 8));
        assertEquals(new Board.XY(0, 0), b.toXY(0));
        assertEquals(new Board.XY(4, 4), b.toXY(40));
        assertEquals(new Board.XY(8, 1), b.toXY(17));
        for (int i = 0; i < 81; i++) {
            Board.XY p = b.toXY(i);
            assertEquals(i, b.toIdx(p.x(), p.y()));
        }
    }

    @Test
    void get_set读写cells() {
        Board b = new Board(5);
        b.set(7, BLACK);
        b.set(8, WHITE);
        assertEquals(BLACK, b.get(7));
        assertEquals(WHITE, b.get(8));
        assertEquals(BLACK, b.cells[7]);
        b.set(7, EMPTY);
        assertEquals(EMPTY, b.get(7));
        // 外部代码会直接写 cells
        System.arraycopy(new byte[] {1, 2, 1}, 0, b.cells, 0, 3);
        assertEquals(BLACK, b.get(0));
        assertEquals(WHITE, b.get(1));
    }

    @Test
    void neighbors_角2个_边3个_中间4个() {
        Board b = new Board(9);
        assertArrayEquals(new int[] {1, 9}, sorted(b.neighbors(0)));
        assertArrayEquals(new int[] {7, 17}, sorted(b.neighbors(8)));
        assertArrayEquals(new int[] {63, 73}, sorted(b.neighbors(72)));
        assertArrayEquals(new int[] {71, 79}, sorted(b.neighbors(80)));
        assertArrayEquals(new int[] {3, 5, 13}, sorted(b.neighbors(4)));
        assertArrayEquals(new int[] {27, 37, 45}, sorted(b.neighbors(36)));
        assertArrayEquals(new int[] {35, 43, 53}, sorted(b.neighbors(44)));
        assertArrayEquals(new int[] {67, 75, 77}, sorted(b.neighbors(76)));
        assertArrayEquals(new int[] {31, 39, 41, 49}, sorted(b.neighbors(40)));
        // 顺序与 JS 一致：上、下、左、右
        assertArrayEquals(new int[] {31, 49, 39, 41}, b.neighbors(40));
    }

    @Test
    void neighbors_越界返回空数组() {
        Board b = new Board(9);
        assertEquals(0, b.neighbors(-1).length);
        assertEquals(0, b.neighbors(81).length);
    }

    @Test
    void neighbors_不跨行() {
        Board b = new Board(5);
        assertFalse(contains(b.neighbors(4), 5));
        assertFalse(contains(b.neighbors(5), 4));
    }

    @Test
    void neighbors_相邻关系对称且总数正确() {
        for (int n : new int[] {1, 2, 9, 19}) {
            Board b = new Board(n);
            int count = 0;
            for (int i = 0; i < n * n; i++) {
                for (int j : b.neighbors(i)) {
                    assertTrue(contains(b.neighbors(j), i));
                    count += 1;
                }
            }
            assertEquals(4 * n * (n - 1), count); // 每条边算两次
        }
    }

    @Test
    void neighbors返回的数组可以随意修改() {
        Board b = new Board(9);
        int[] a = b.neighbors(40);
        Arrays.fill(a, -1);
        assertArrayEquals(new int[] {31, 49, 39, 41}, b.neighbors(40));
    }

    @Test
    void group_空点与越界返回null() {
        Board b = new Board(9);
        assertNull(b.group(40));
        assertNull(b.group(-1));
        assertNull(b.group(81));
    }

    @Test
    void group_单子的气() {
        Board b = new Board(9);
        b.set(40, BLACK);
        assertArrayEquals(new int[] {40}, b.group(40).stones());
        assertArrayEquals(new int[] {31, 39, 41, 49}, sorted(b.group(40).liberties()));
        assertEquals(BLACK, b.group(40).color());

        b.set(0, WHITE);
        assertArrayEquals(new int[] {1, 9}, sorted(b.group(0).liberties()));
        b.set(1, BLACK);
        assertArrayEquals(new int[] {9}, b.group(0).liberties());
    }

    @Test
    void group_连通块的全部棋子与去重后的气() {
        Board b = fromDiagram("""
                . . . . .
                . X X . .
                . X O . .
                . . . . .
                . . . . .
                """);
        Board.Group g = b.group(b.toIdx(1, 1));
        assertEquals(BLACK, g.color());
        assertArrayEquals(new int[] {6, 7, 11}, sorted(g.stones()));
        assertArrayEquals(new int[] {1, 2, 5, 8, 10, 16}, sorted(g.liberties()));
        assertArrayEquals(new int[] {6, 7, 11}, sorted(b.group(b.toIdx(1, 2)).stones()));

        Board.Group w = b.group(b.toIdx(2, 2));
        assertEquals(WHITE, w.color());
        assertArrayEquals(new int[] {12}, w.stones());
        assertArrayEquals(new int[] {13, 17}, sorted(w.liberties()));
    }

    @Test
    void group_斜向不算相连_环形块内部空点只算一次气() {
        Board b = fromDiagram("""
                X . . . .
                . X X X .
                . X . X .
                . X X X .
                . . . . .
                """);
        assertArrayEquals(new int[] {0}, b.group(0).stones());
        Board.Group ring = b.group(b.toIdx(1, 1));
        assertEquals(8, ring.stones().length);
        int[] libs = sorted(ring.liberties());
        assertEquals(libs.length, IntStream.of(libs).distinct().count());
        assertTrue(contains(libs, b.toIdx(2, 2)));
        assertEquals(13, libs.length); // 外圈 12 + 中心 1
    }

    @Test
    void group_没有气的块() {
        Board b = fromDiagram("""
                O X .
                X . .
                . . .
                """);
        assertEquals(0, b.group(0).liberties().length);
    }

    @Test
    void group_19路整盘同色大块_不递归() {
        Board b = new Board(19);
        Arrays.fill(b.cells, (byte) BLACK);
        b.set(180, EMPTY);
        Board.Group g = b.group(0);
        assertEquals(360, g.stones().length);
        assertArrayEquals(new int[] {180}, g.liberties());
    }

    @Test
    void copy_深拷贝_互不影响() {
        Board b = new Board(9);
        b.set(10, BLACK);
        Board c = b.copy();
        assertEquals(9, c.n);
        assertNotSame(b.cells, c.cells);
        assertArrayEquals(b.cells, c.cells);
        c.set(20, WHITE);
        b.set(30, BLACK);
        assertEquals(EMPTY, b.get(20));
        assertEquals(EMPTY, c.get(30));
        assertEquals(BLACK, c.get(10));
    }

    // ---------- 测试工具本身（engine-helpers.test.js） ----------

    @Test
    void fromDiagram_X黑O白点空_左上角是索引0() {
        Board b = fromDiagram("""
                X . O
                . . .
                . O X
                """);
        assertEquals(3, b.n);
        assertArrayEquals(new byte[] {1, 0, 2, 0, 0, 0, 0, 2, 1}, b.cells);
    }

    @Test
    void fromDiagram_空白去掉_空行忽略() {
        Board a = fromDiagram("X.O\n...\n.OX");
        Board b = fromDiagram("\n\n  X   .O \n\t. . .\n\n .  O X  \n\n");
        assertArrayEquals(a.cells, b.cells);
    }

    @Test
    void toDiagram与fromDiagram往返一致() {
        Board b = new Board(3);
        b.set(b.toIdx(1, 0), BLACK);
        b.set(b.toIdx(2, 2), WHITE);
        assertEquals(". X .\n. . .\n. . O", toDiagram(b));
        String text = String.join("\n", "X O . . X", ". X O O .", "O . . X X", ". . O . .", "X X X O O");
        assertEquals(text, toDiagram(fromDiagram(text)));
    }

    @Test
    void fromDiagram_非法输入报错() {
        assertThrows(IllegalArgumentException.class, () -> fromDiagram("X .\n. . ."));
        assertThrows(IllegalArgumentException.class, () -> fromDiagram(". . .\n. .\n. . ."));
        assertThrows(IllegalArgumentException.class, () -> fromDiagram("x .\n. ."));
        assertThrows(IllegalArgumentException.class, () -> fromDiagram(""));
        assertThrows(IllegalArgumentException.class, () -> fromDiagram("\n  \n\t\n"));
    }
}
