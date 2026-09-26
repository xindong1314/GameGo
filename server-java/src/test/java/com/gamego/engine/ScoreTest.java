package com.gamego.engine;

import static com.gamego.engine.Diagrams.fromDiagram;
import static com.gamego.engine.Diagrams.toDiagram;
import static com.gamego.engine.Go.BLACK;
import static com.gamego.engine.Go.EMPTY;
import static com.gamego.engine.Go.WHITE;
import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertNull;

import com.gamego.engine.Score.ScoreResult;
import java.util.Arrays;
import org.junit.jupiter.api.Test;

/** 移植自 test/engine-score.test.js 与 test/score-area.test.js */
class ScoreTest {

    // 9 路终局：黑占左边、白占右边，(3,4)(4,4) 是双方都挨着的公气。
    // 黑子 17、白子 16；黑地 3+1+5+10 = 19，白地 12+15 = 27。
    private static final String FINAL_9 = """
            . . X O . . . . .
            . X . X O . . O .
            X X X X O . . . .
            . . . X O O O O O
            . . X . . O . . .
            X X X X X O . O .
            . . . . X O . . .
            . . . X O O . . .
            . . . X O . . . .
            """;

    private static final String WITH_DEAD = """
            . . X O . . . . .
            . . X O . . X . .
            . X X O O . . . .
            X X O O . . . . .
            X O O . . . . . .
            X O . . . . . . .
            X O . . . . . . .
            X O . . . . . . .
            X O . . . . . . .
            """;

    /** 比较七个计分字段 */
    private static void assertSameScore(ScoreResult want, ScoreResult got) {
        assertEquals(want.black(), got.black());
        assertEquals(want.white(), got.white());
        assertEquals(want.winner(), got.winner());
        assertEquals(want.blackStones(), got.blackStones());
        assertEquals(want.whiteStones(), got.whiteStones());
        assertEquals(want.blackArea(), got.blackArea());
        assertEquals(want.whiteArea(), got.whiteArea());
    }

    private static ScoreResult plain(double black, double white, int winner, int bs, int ws, int ba, int wa) {
        return new ScoreResult(black, white, winner, bs, ws, ba, wa, null, null);
    }

    @Test
    void 空盘_贴目决定胜负() {
        Board b = new Board(9);
        ScoreResult s = Score.score(b, 7.5);
        assertEquals(plain(0, 7.5, WHITE, 0, 0, 0, 0), s);
        assertEquals(0, Score.score(b, 0).winner());
    }

    @Test
    void score不给owner与dead_不改棋盘() {
        Board b = fromDiagram(FINAL_9);
        String before = toDiagram(b);
        ScoreResult s = Score.score(b, 7.5);
        assertNull(s.owner());
        assertNull(s.dead());
        assertEquals(before, toDiagram(b));
    }

    @Test
    void 纯黑() {
        Board b = new Board(9);
        b.set(40, BLACK);
        ScoreResult s = Score.score(b, 7.5);
        assertEquals(1, s.blackStones());
        assertEquals(80, s.blackArea());
        assertEquals(81, s.black());
        assertEquals(7.5, s.white());
        assertEquals(BLACK, s.winner());
    }

    @Test
    void 纯白() {
        Board b = fromDiagram("""
                O . .
                . . .
                . . O
                """);
        ScoreResult s = Score.score(b, 0);
        assertEquals(2, s.whiteStones());
        assertEquals(7, s.whiteArea());
        assertEquals(9, s.white());
        assertEquals(0, s.black());
        assertEquals(WHITE, s.winner());
    }

    @Test
    void 无主区() {
        Board b = fromDiagram("""
                X . O
                X . O
                X . O
                """);
        ScoreResult s = Score.score(b, 0);
        assertEquals(0, s.blackArea());
        assertEquals(0, s.whiteArea());
        assertEquals(3, s.black());
        assertEquals(3, s.white());
        assertEquals(0, s.winner());
    }

    @Test
    void 分隔开的空区各自判定归属() {
        Board b = fromDiagram("""
                . . X . .
                . . X . .
                X X X . .
                . . . O O
                . . . O .
                """);
        assertEquals(plain(9, 4, BLACK, 5, 3, 4, 1), Score.score(b, 0));
    }

    @Test
    void 贴目加在白方_可以反转胜负或成和() {
        Board b = fromDiagram("""
                . . . . X O . . .
                . . . . X O . . .
                . . . . X O . . .
                . . . . X O . . .
                . . . . X O . . .
                . . . . X O . . .
                . . . . X O . . .
                . . . . X O . . .
                . . . . X O . . .
                """);
        ScoreResult s = Score.score(b, 7.5);
        assertEquals(45, s.black());
        assertEquals(43.5, s.white());
        assertEquals(BLACK, s.winner());
        assertEquals(36, Score.score(b, 0).white());
        assertEquals(WHITE, Score.score(b, 9.5).winner());
        ScoreResult draw = Score.score(b, 9);
        assertEquals(45, draw.white());
        assertEquals(0, draw.winner());
    }

    @Test
    void 完整9路终局() {
        Board b = fromDiagram(FINAL_9);
        ScoreResult s = Score.score(b, 7.5);
        assertEquals(plain(36, 50.5, WHITE, 17, 16, 19, 27), s);
    }

    @Test
    void 完整9路终局_对局中连续pass自动计出同样的结果() {
        GameState g = Game.createGame(9, 7.5, true);
        System.arraycopy(fromDiagram(FINAL_9).cells, 0, g.board.cells, 0, 81);
        Game.pass(g);
        Game.pass(g);
        assertEquals(new Result(WHITE, "score", 36.0, 50.5), g.result);
    }

    @Test
    void 满盘没有空点_只数子() {
        Board b = fromDiagram("""
                X O X
                O X O
                X O X
                """);
        assertEquals(plain(5, 4.5, BLACK, 5, 4, 0, 0), Score.score(b, 0.5));
    }

    @Test
    void 路19整盘一块空区也能计分_不递归() {
        Board b = new Board(19);
        b.set(0, WHITE);
        ScoreResult s = Score.score(b, 0);
        assertEquals(360, s.whiteArea());
        assertEquals(361, s.white());
    }

    @Test
    void scoreArea_没有死子时与score一致_并给出owner与dead() {
        Board b = fromDiagram(FINAL_9);
        ScoreResult s = Score.score(b, 7.5);
        for (int[] dead : new int[][] {new int[0], null}) {
            ScoreResult a = Score.scoreArea(b, 7.5, dead);
            assertSameScore(s, a);
            assertArrayEquals(new int[0], a.dead());
            assertEquals(81, a.owner().length);
        }
        ScoreResult a = Score.scoreArea(b, 7.5, new int[0]);
        assertEquals(BLACK, a.owner()[b.toIdx(2, 0)]);
        assertEquals(WHITE, a.owner()[b.toIdx(3, 0)]);
        assertEquals(BLACK, a.owner()[b.toIdx(0, 0)]);
        assertEquals(WHITE, a.owner()[b.toIdx(8, 8)]);
        assertEquals(EMPTY, a.owner()[b.toIdx(3, 4)]);
        assertEquals(EMPTY, a.owner()[b.toIdx(4, 4)]);
    }

    @Test
    void scoreArea_黑地里的白死子按提掉计算() {
        Board b = fromDiagram(FINAL_9);
        int inv = b.toIdx(0, 7);
        b.set(inv, WHITE);
        ScoreResult alive = Score.scoreArea(b, 7.5, new int[0]);
        assertEquals(17, alive.whiteStones());
        assertEquals(9, alive.blackArea());
        assertEquals(WHITE, alive.owner()[inv]);
        assertEquals(EMPTY, alive.owner()[b.toIdx(0, 6)]);

        ScoreResult r = Score.scoreArea(b, 7.5, new int[] {inv});
        assertArrayEquals(new int[] {inv}, r.dead());
        assertEquals(16, r.whiteStones());
        assertEquals(19, r.blackArea());
        assertEquals(36, r.black());
        assertEquals(50.5, r.white());
        assertEquals(BLACK, r.owner()[inv]);
        assertEquals(BLACK, r.owner()[b.toIdx(0, 6)]);
        assertEquals(WHITE, b.get(inv));
    }

    @Test
    void scoreArea_双方都有死子() {
        Board b = fromDiagram("""
                . X . O .
                . X O O .
                . X . O X
                . X . O .
                O X . O .
                """);
        int blackDead = b.toIdx(4, 2);
        int whiteDead = b.toIdx(0, 4);
        ScoreResult r = Score.scoreArea(b, 0, new int[] {whiteDead, blackDead});
        int[] want = {blackDead, whiteDead};
        Arrays.sort(want);
        assertArrayEquals(want, r.dead());
        assertEquals(5, r.blackStones());
        assertEquals(6, r.whiteStones());
        assertEquals(5, r.blackArea());
        assertEquals(5, r.whiteArea());
        assertEquals(BLACK, r.owner()[whiteDead]);
        assertEquals(WHITE, r.owner()[blackDead]);
        assertEquals(EMPTY, r.owner()[b.toIdx(2, 0)]);
        assertEquals(WHITE, r.winner());
    }

    @Test
    void scoreArea_一整块死子() {
        Board b = fromDiagram("""
                . . . . .
                . O O . .
                . . . . .
                X X X X X
                . . . . .
                """);
        ScoreResult r = Score.scoreArea(b, 0, new int[] {b.toIdx(1, 1), b.toIdx(2, 1)});
        assertEquals(0, r.whiteStones());
        assertEquals(5, r.blackStones());
        assertEquals(20, r.blackArea());
        assertEquals(25, r.black());
        for (int o : r.owner()) assertEquals(BLACK, o);
    }

    @Test
    void scoreArea_越界值_空点_重复值被忽略_结果升序() {
        Board b = fromDiagram("""
                X . O
                . . .
                O . X
                """);
        ScoreResult r = Score.scoreArea(b, 0, new int[] {8, 8, 2, 6, -1, 9, 4, 0});
        assertArrayEquals(new int[] {0, 2, 6, 8}, r.dead());
        assertEquals(0, r.blackStones());
        assertEquals(0, r.whiteStones());

        ScoreResult r2 = Score.scoreArea(b, 0, new int[] {8, 8, 2, -1, 9, 4, 0});
        assertArrayEquals(new int[] {0, 2, 8}, r2.dead());
        assertEquals(0, r2.blackStones());
        assertEquals(1, r2.whiteStones());
        assertEquals(8, r2.whiteArea());
    }

    @Test
    void scoreArea_不修改传入的dead数组() {
        Board b = fromDiagram("""
                X . O
                . . .
                O . X
                """);
        int[] dead = {8, 0, 8};
        Score.scoreArea(b, 0, dead);
        assertArrayEquals(new int[] {8, 0, 8}, dead);
    }

    @Test
    void toggleDead_点一块标死_再点取消() {
        Board b = fromDiagram("""
                . . . . .
                . O O . .
                . O . . .
                X X X X X
                . . . . .
                """);
        int[] d1 = Score.toggleDead(b, new int[0], b.toIdx(2, 1));
        assertArrayEquals(new int[] {6, 7, 11}, d1);
        assertArrayEquals(new int[0], Score.toggleDead(b, d1, b.toIdx(1, 2)));
    }

    @Test
    void toggleDead_不修改传入数组_返回去重升序的新数组() {
        Board b = fromDiagram("""
                X . O
                . . .
                . . .
                """);
        int[] dead = {2, 2};
        int[] next = Score.toggleDead(b, dead, 0);
        assertArrayEquals(new int[] {0, 2}, next);
        assertArrayEquals(new int[] {2, 2}, dead);
        assertNotSame(dead, next);
    }

    @Test
    void toggleDead_部分标死时整块标死_整块标死时整块取消() {
        Board b = fromDiagram("""
                O O O
                . . .
                X . .
                """);
        assertArrayEquals(new int[] {0, 1, 2}, Score.toggleDead(b, new int[] {1}, 0));
        assertArrayEquals(new int[] {6}, Score.toggleDead(b, new int[] {0, 1, 2, 6}, 1));
    }

    @Test
    void toggleDead_空点或无效索引返回原集合的去重升序副本() {
        Board b = fromDiagram("""
                X . O
                . . .
                . . .
                """);
        int[] dead = {2, 0, 2};
        for (int idx : new int[] {1, 4, -1, 9}) {
            int[] r = Score.toggleDead(b, dead, idx);
            assertArrayEquals(new int[] {0, 2}, r, String.valueOf(idx));
            assertNotSame(dead, r);
        }
        assertArrayEquals(new int[0], Score.toggleDead(b, null, 4));
        assertArrayEquals(new int[] {0}, Score.toggleDead(b, null, 0));
        // 不在盘内的值也原样保留（与 JS 一致：toggleDead 只去重排序，不过滤）
        assertArrayEquals(new int[] {-3, 0, 99}, Score.toggleDead(b, new int[] {99, -3}, 0));
    }

    @Test
    void toggleDead与scoreArea配合() {
        Board b = fromDiagram(FINAL_9);
        b.set(b.toIdx(1, 7), WHITE);
        b.set(b.toIdx(2, 7), WHITE);
        int[] dead = Score.toggleDead(b, new int[0], b.toIdx(1, 7));
        assertArrayEquals(new int[] {b.toIdx(1, 7), b.toIdx(2, 7)}, dead);
        ScoreResult r = Score.scoreArea(b, 7.5, dead);
        assertEquals(36, r.black());
        assertEquals(50.5, r.white());
    }

    // ---------- score-area.test.js ----------

    @Test
    void area_无死子时与score一致() {
        Board b = fromDiagram(WITH_DEAD);
        ScoreResult a = Score.scoreArea(b, 7.5, new int[0]);
        assertSameScore(Score.score(b, 7.5), a);
        assertArrayEquals(new int[0], a.dead());
    }

    @Test
    void area_白地里的黑死子() {
        Board b = fromDiagram(WITH_DEAD);
        int deadIdx = b.toIdx(6, 1);
        assertEquals(0, Score.scoreArea(b, 7.5, new int[0]).whiteArea());
        ScoreResult after = Score.scoreArea(b, 7.5, new int[] {deadIdx});
        assertArrayEquals(new int[] {deadIdx}, after.dead());
        assertEquals(11, after.blackStones());
        assertEquals(12, after.whiteStones());
        assertEquals(5, after.blackArea());
        assertEquals(53, after.whiteArea());
        assertEquals(12 + 53 + 7.5, after.white());
        assertEquals(WHITE, after.winner());
        assertEquals(WHITE, after.owner()[deadIdx]);
    }

    @Test
    void area_owner() {
        Board b = fromDiagram("""
                . X . . .
                X X . . .
                . . . . .
                . . . O O
                . . . O .
                """);
        ScoreResult r = Score.scoreArea(b, 0, new int[0]);
        assertEquals(BLACK, r.owner()[b.toIdx(0, 0)]);
        assertEquals(BLACK, r.owner()[b.toIdx(1, 0)]);
        assertEquals(EMPTY, r.owner()[b.toIdx(2, 2)]);
        assertEquals(WHITE, r.owner()[b.toIdx(3, 3)]);
        assertEquals(WHITE, r.owner()[b.toIdx(4, 4)]);
        assertEquals(25, r.owner().length);
    }

    @Test
    void area_toggleDead切换整块死活() {
        Board b = fromDiagram("""
                X X . O .
                . . . O .
                . . . . .
                . . . . .
                . . . . .
                """);
        int[] dead = Score.toggleDead(b, new int[0], b.toIdx(0, 0));
        assertArrayEquals(new int[] {b.toIdx(0, 0), b.toIdx(1, 0)}, dead);
        dead = Score.toggleDead(b, dead, b.toIdx(3, 1));
        assertArrayEquals(new int[] {b.toIdx(0, 0), b.toIdx(1, 0), b.toIdx(3, 0), b.toIdx(3, 1)}, dead);
        dead = Score.toggleDead(b, dead, b.toIdx(1, 0));
        assertArrayEquals(new int[] {b.toIdx(3, 0), b.toIdx(3, 1)}, dead);
        assertArrayEquals(dead, Score.toggleDead(b, dead, b.toIdx(2, 2)));
    }
}
