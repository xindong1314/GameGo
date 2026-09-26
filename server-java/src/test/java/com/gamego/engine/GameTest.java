package com.gamego.engine;

import static com.gamego.engine.Diagrams.fromDiagram;
import static com.gamego.engine.Diagrams.toDiagram;
import static com.gamego.engine.Go.BLACK;
import static com.gamego.engine.Go.EMPTY;
import static com.gamego.engine.Go.WHITE;
import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/** 移植自 test/engine-game.test.js 与 test/phase.test.js */
class GameTest {

    private static final String KO_SHAPE = """
            . X O .
            X O . O
            . X O .
            . . . .
            """;

    private static final OpResult OK = new OpResult(true, null);

    private static GameState gameFrom(String diagram, int toPlay, double komi, boolean autoScore) {
        Board b = fromDiagram(diagram);
        GameState g = Game.createGame(b.n, komi, autoScore);
        System.arraycopy(b.cells, 0, g.board.cells, 0, b.cells.length);
        g.toPlay = toPlay;
        return g;
    }

    private static GameState gameFrom(String diagram) {
        return gameFrom(diagram, BLACK, 7.5, true);
    }

    private static void assertMove(Move m, int color, Integer idx, int[] captured, Integer koBefore, Integer koAfter,
                                   int passesBefore) {
        assertEquals(color, m.color());
        assertEquals(idx, m.idx());
        assertArrayEquals(captured, m.captured());
        assertEquals(koBefore, m.koBefore());
        assertEquals(koAfter, m.koAfter());
        assertEquals(passesBefore, m.passesBefore());
    }

    // ---------- engine-game.test.js ----------

    @Test
    void createGame_默认值与字段() {
        GameState g = Game.createGame();
        assertEquals(19, g.board.n);
        assertEquals(19, g.size);
        assertEquals(7.5, g.komi);
        assertTrue(g.autoScore);
        assertEquals(BLACK, g.toPlay);
        assertNull(g.ko);
        assertTrue(g.history.isEmpty());
        assertArrayEquals(new int[] {0, 0, 0}, g.captures);
        assertEquals(0, g.consecutivePasses);
        assertEquals("playing", g.status);
        assertNull(g.result);
    }

    @Test
    void createGame_自定义路数_贴目_autoScore() {
        GameState g = Game.createGame(9, 6.5, false);
        assertEquals(9, g.size);
        assertEquals(9, g.board.n);
        assertEquals(6.5, g.komi);
        assertFalse(g.autoScore);
    }

    @Test
    void 每局独立() {
        GameState a = Game.createGame(9, 7.5, true);
        GameState b = Game.createGame(9, 7.5, true);
        Game.play(a, 40);
        assertEquals(EMPTY, b.board.get(40));
        assertEquals(0, b.history.size());
        assertNotSame(a.captures, b.captures);
        assertNotSame(a.history, b.history);
    }

    @Test
    void 轮流落子_黑先() {
        GameState g = Game.createGame(9, 7.5, true);
        assertEquals(OK, Game.play(g, 40));
        assertEquals(BLACK, g.board.get(40));
        assertEquals(WHITE, g.toPlay);
        assertEquals(OK, Game.play(g, 41));
        assertEquals(WHITE, g.board.get(41));
        assertEquals(BLACK, g.toPlay);
    }

    @Test
    void history项字段() {
        GameState g = Game.createGame(9, 7.5, true);
        Game.play(g, 40);
        Game.pass(g);
        assertEquals(2, g.history.size());
        assertMove(g.history.get(0), BLACK, 40, new int[0], null, null, 0);
        assertMove(g.history.get(1), WHITE, null, new int[0], null, null, 0);
        assertTrue(g.history.get(1).isPass());
    }

    @Test
    void 非法落子原样返回原因_状态不变() {
        GameState g = Game.createGame(9, 7.5, true);
        Game.play(g, 40);
        assertEquals(OpResult.fail("occupied"), Game.play(g, 40));
        assertEquals(OpResult.fail("invalid"), Game.play(g, -1));
        assertEquals(OpResult.fail("invalid"), Game.play(g, 81));
        assertEquals(WHITE, g.toPlay);
        assertEquals(1, g.history.size());
    }

    @Test
    void 提子计入captures() {
        GameState g = gameFrom("""
                . X .
                X O X
                . . .
                """);
        Game.play(g, 7);
        assertEquals(1, g.captures[BLACK]);
        assertEquals(0, g.captures[WHITE]);
        assertArrayEquals(new int[] {4}, g.history.get(0).captured());
        assertEquals(EMPTY, g.board.get(4));
    }

    @Test
    void 打劫_劫点记在状态与历史里() {
        GameState g = gameFrom(KO_SHAPE);
        Game.play(g, 6);
        assertEquals(5, g.ko);
        assertMove(g.history.get(0), BLACK, 6, new int[] {5}, null, 5, 0);
        assertEquals(OpResult.fail("ko"), Game.play(g, 5));
        assertEquals(WHITE, g.toPlay);
    }

    @Test
    void 打劫_别处落子后劫点解除() {
        GameState g = gameFrom(KO_SHAPE);
        Game.play(g, 6);
        Game.play(g, 15);
        assertNull(g.ko);
        assertEquals(5, g.history.get(1).koBefore());
        Game.play(g, 12);
        assertEquals(OK, Game.play(g, 5));
        assertEquals(6, g.ko);
        assertEquals(1, g.captures[WHITE]);
    }

    @Test
    void pass_换手_计数_解除劫点() {
        GameState g = gameFrom(KO_SHAPE);
        Game.play(g, 6);
        assertEquals(OK, Game.pass(g));
        assertEquals(BLACK, g.toPlay);
        assertNull(g.ko);
        assertEquals(1, g.consecutivePasses);
        assertMove(g.history.get(1), WHITE, null, new int[0], 5, null, 0);
        Game.play(g, 15);
        assertEquals(0, g.consecutivePasses);
        assertEquals(1, g.history.get(2).passesBefore());
    }

    @Test
    void autoScore为真_双方连续pass自动计分终局() {
        GameState g = Game.createGame(5, 0.5, true);
        Game.play(g, 12);
        Game.pass(g);
        assertEquals("playing", g.status);
        Game.pass(g);
        assertEquals("ended", g.status);
        assertEquals(2, g.consecutivePasses);
        assertEquals(new Result(BLACK, "score", 25.0, 0.5), g.result);
    }

    @Test
    void autoScore为真_空盘两次pass_贴目让白胜() {
        GameState g = Game.createGame(9, 7.5, true);
        Game.pass(g);
        Game.pass(g);
        assertEquals(new Result(WHITE, "score", 0.0, 7.5), g.result);
    }

    @Test
    void autoScore为假_进入数子阶段() {
        GameState g = Game.createGame(9, 7.5, false);
        Game.pass(g);
        Game.pass(g);
        assertEquals("scoring", g.status);
        assertNull(g.result);
        assertEquals(BLACK, g.toPlay);
    }

    @Test
    void 非对局中不能落子与pass() {
        GameState s = Game.createGame(9, 7.5, false);
        Game.pass(s);
        Game.pass(s);
        assertEquals(OpResult.fail("scoring"), Game.play(s, 40));
        assertEquals(OpResult.fail("scoring"), Game.pass(s));
        assertEquals(2, s.history.size());

        GameState e = Game.createGame(9, 7.5, true);
        Game.pass(e);
        Game.pass(e);
        assertEquals(OpResult.fail("ended"), Game.play(e, 40));
        assertEquals(OpResult.fail("ended"), Game.pass(e));
        assertEquals(2, e.history.size());
        assertEquals(EMPTY, e.board.get(40));
    }

    @Test
    void resume_只在数子阶段有效_轮到谁不变() {
        GameState g = Game.createGame(9, 7.5, false);
        assertEquals(OpResult.fail("not-scoring"), Game.resume(g));
        Game.play(g, 40);
        Game.pass(g);
        Game.pass(g);
        assertEquals(WHITE, g.toPlay);
        assertEquals(OK, Game.resume(g));
        assertEquals("playing", g.status);
        assertEquals(0, g.consecutivePasses);
        assertEquals(WHITE, g.toPlay);
        assertEquals(OK, Game.play(g, 41));

        GameState e = Game.createGame(9, 7.5, true);
        Game.pass(e);
        Game.pass(e);
        assertEquals(OpResult.fail("not-scoring"), Game.resume(e));
        assertEquals("ended", e.status);
    }

    @Test
    void finish_对局中与数子阶段都可以() {
        GameState g = Game.createGame(9, 7.5, true);
        assertEquals(OK, Game.finish(g, new Result(WHITE, "timeout")));
        assertEquals("ended", g.status);
        assertEquals(new Result(WHITE, "timeout", null, null), g.result);
        assertEquals(OpResult.fail("ended"), Game.finish(g, new Result(BLACK, "timeout")));
        assertEquals(WHITE, g.result.winner());

        GameState s = Game.createGame(9, 7.5, false);
        Game.pass(s);
        Game.pass(s);
        assertEquals(OK, Game.finish(s, new Result(BLACK, "score", 45.0, 43.5)));
        assertEquals(new Result(BLACK, "score", 45.0, 43.5), s.result);

        GameState a = Game.createGame(9, 7.5, true);
        Game.finish(a, new Result(0, "abort"));
        assertEquals(new Result(0, "abort", null, null), a.result);

        assertThrows(NullPointerException.class, () -> Game.finish(Game.createGame(), null));
    }

    @Test
    void resign_默认当前行棋方认输() {
        GameState g = Game.createGame(9, 7.5, true);
        assertEquals(OK, Game.resign(g));
        assertEquals("ended", g.status);
        assertEquals(new Result(WHITE, "resign", null, null), g.result);

        GameState w = Game.createGame(9, 7.5, true);
        Game.play(w, 40);
        Game.resign(w, null);
        assertEquals(BLACK, w.result.winner());
    }

    @Test
    void resign_指定认输方_不是黑白时按当前行棋方() {
        GameState g = Game.createGame(9, 7.5, true);
        Game.resign(g, WHITE);
        assertEquals(BLACK, g.result.winner());

        GameState x = Game.createGame(9, 7.5, true);
        Game.resign(x, 7);
        assertEquals(WHITE, x.result.winner());
    }

    @Test
    void resign_数子阶段可以_终局后不行() {
        GameState s = Game.createGame(9, 7.5, false);
        Game.pass(s);
        Game.pass(s);
        assertEquals(OK, Game.resign(s, BLACK));
        assertEquals(WHITE, s.result.winner());
        assertEquals(OpResult.fail("ended"), Game.resign(s, WHITE));
        assertEquals(WHITE, s.result.winner());

        GameState e = Game.createGame(9, 7.5, true);
        Game.pass(e);
        Game.pass(e);
        Result before = e.result;
        assertEquals(OpResult.fail("ended"), Game.resign(e));
        assertSame(before, e.result);
    }

    @Test
    void undo_没有可撤回的返回false() {
        GameState g = Game.createGame(9, 7.5, true);
        assertFalse(Game.undo(g));
        assertEquals("playing", g.status);
    }

    @Test
    void undo_撤回落子_轮回该方() {
        GameState g = Game.createGame(9, 7.5, true);
        Game.play(g, 40);
        Game.play(g, 41);
        assertTrue(Game.undo(g));
        assertEquals(EMPTY, g.board.get(41));
        assertEquals(WHITE, g.toPlay);
        assertEquals(1, g.history.size());
        assertTrue(Game.undo(g));
        assertEquals(EMPTY, g.board.get(40));
        assertEquals(BLACK, g.toPlay);
        assertFalse(Game.undo(g));
    }

    @Test
    void undo_放回被提的子并扣回提子数() {
        GameState g = gameFrom("""
                . X X .
                X O O X
                . X . .
                . . . .
                """);
        String before = toDiagram(g.board);
        Game.play(g, 10);
        assertEquals(2, g.captures[BLACK]);
        assertTrue(Game.undo(g));
        assertEquals(before, toDiagram(g.board));
        assertEquals(0, g.captures[BLACK]);
        assertEquals(BLACK, g.toPlay);
    }

    @Test
    void undo_恢复劫点() {
        GameState g = gameFrom(KO_SHAPE);
        Game.play(g, 6);
        Game.play(g, 15);
        assertNull(g.ko);
        Game.undo(g);
        assertEquals(5, g.ko);
        assertEquals(OpResult.fail("ko"), Game.play(g, 5));
        Game.undo(g);
        assertNull(g.ko);
        assertEquals(WHITE, g.board.get(5));
        assertEquals(EMPTY, g.board.get(6));
        assertEquals(0, g.captures[BLACK]);
    }

    @Test
    void undo_撤回pass恢复劫点与连续pass计数() {
        GameState g = gameFrom(KO_SHAPE);
        Game.play(g, 6);
        Game.pass(g);
        assertNull(g.ko);
        Game.undo(g);
        assertEquals(5, g.ko);
        assertEquals(0, g.consecutivePasses);
        assertEquals(WHITE, g.toPlay);

        GameState h = Game.createGame(9, 7.5, false);
        Game.pass(h);
        Game.pass(h);
        Game.play(h, 40); // 不会成功：数子阶段
        Game.undo(h);
        assertEquals(1, h.consecutivePasses);
        Game.undo(h);
        assertEquals(0, h.consecutivePasses);
    }

    @Test
    void undo_自动计分终局后撤回_回到对局() {
        GameState g = Game.createGame(9, 7.5, true);
        Game.play(g, 40);
        Game.pass(g);
        Game.pass(g);
        assertEquals("ended", g.status);
        assertTrue(Game.undo(g));
        assertEquals("playing", g.status);
        assertNull(g.result);
        assertEquals(1, g.consecutivePasses);
        assertEquals(BLACK, g.toPlay);
    }

    @Test
    void undo_数子阶段撤回第二次pass() {
        GameState g = Game.createGame(9, 7.5, false);
        Game.pass(g);
        Game.pass(g);
        Game.undo(g);
        assertEquals("playing", g.status);
        assertEquals(1, g.consecutivePasses);
        assertEquals(WHITE, g.toPlay);
    }

    @Test
    void undo_认输后只撤销认输本身() {
        GameState g = Game.createGame(9, 7.5, true);
        Game.play(g, 40);
        Game.play(g, 41);
        Game.resign(g);
        assertTrue(Game.undo(g));
        assertEquals("playing", g.status);
        assertNull(g.result);
        assertEquals(2, g.history.size());
        assertEquals(WHITE, g.board.get(41));
        assertEquals(BLACK, g.toPlay);
        assertTrue(Game.undo(g));
        assertEquals(1, g.history.size());
        assertEquals(EMPTY, g.board.get(41));
    }

    @Test
    void undo_一手没下就认输也能撤销认输() {
        GameState g = Game.createGame(9, 7.5, true);
        Game.resign(g);
        assertTrue(Game.undo(g));
        assertEquals("playing", g.status);
        assertNull(g.result);
        assertFalse(Game.undo(g));
    }

    @Test
    void undo_外部裁定的终局撤回最后一手() {
        GameState g = Game.createGame(9, 7.5, true);
        Game.play(g, 40);
        Game.finish(g, new Result(BLACK, "timeout"));
        assertTrue(Game.undo(g));
        assertEquals("playing", g.status);
        assertNull(g.result);
        assertEquals(0, g.history.size());
        assertEquals(EMPTY, g.board.get(40));
    }

    @Test
    void undo_继续对局后撤回_按passesBefore精确恢复计数() {
        GameState g = Game.createGame(9, 7.5, false);
        Game.play(g, 40);
        Game.pass(g);
        Game.pass(g);
        Game.resume(g);
        Game.play(g, 41);
        Game.undo(g);
        assertEquals(0, g.consecutivePasses);
        assertEquals("playing", g.status);
    }

    @Test
    void undo全部撤回后回到初始局面() {
        GameState g = gameFrom(KO_SHAPE);
        String start = toDiagram(g.board);
        Game.play(g, 6);
        Game.play(g, 15);
        Game.play(g, 12);
        Game.play(g, 5);
        Game.pass(g);
        Game.play(g, 3);
        while (Game.undo(g)) {
            // 一直撤回
        }
        assertEquals(start, toDiagram(g.board));
        assertArrayEquals(new int[] {0, 0, 0}, g.captures);
        assertNull(g.ko);
        assertEquals(BLACK, g.toPlay);
        assertEquals(0, g.consecutivePasses);
        assertEquals(0, g.history.size());
    }

    // ---------- phase.test.js ----------

    @Test
    void phase_autoScore默认开启_两次pass直接终局() {
        GameState g = Game.createGame(5, 7.5, true);
        Game.pass(g);
        Game.pass(g);
        assertEquals("ended", g.status);
        assertEquals("score", g.result.reason());
    }

    @Test
    void phase_autoScore为假_两次pass进入数子阶段() {
        GameState g = Game.createGame(5, 7.5, false);
        Game.play(g, 12);
        Game.pass(g);
        Game.pass(g);
        assertEquals("scoring", g.status);
        assertNull(g.result);
        assertEquals(WHITE, g.toPlay);
    }

    @Test
    void phase_resume后轮到最先pass的一方_再pass一次不会终局() {
        GameState g = Game.createGame(5, 7.5, false);
        Game.pass(g);
        Game.pass(g);
        assertEquals(OK, Game.resume(g));
        assertEquals("playing", g.status);
        assertEquals(0, g.consecutivePasses);
        assertEquals(BLACK, g.toPlay);
        Game.pass(g);
        assertEquals("playing", g.status);
        assertEquals(OpResult.fail("not-scoring"), Game.resume(g));
    }

    @Test
    void phase_finish由外部裁定终局() {
        GameState g = Game.createGame(5, 7.5, false);
        Game.pass(g);
        Game.pass(g);
        assertEquals(OK, Game.finish(g, new Result(WHITE, "score", 10.0, 22.5)));
        assertEquals("ended", g.status);
        assertEquals(new Result(WHITE, "score", 10.0, 22.5), g.result);
        assertEquals(OpResult.fail("ended"), Game.finish(g, new Result(BLACK, "timeout")));

        GameState t = Game.createGame(5, 7.5, false);
        Game.finish(t, new Result(BLACK, "timeout"));
        assertEquals(new Result(BLACK, "timeout", null, null), t.result);
    }

    @Test
    void phase_数子阶段悔棋撤回最后一次pass() {
        GameState g = Game.createGame(5, 7.5, false);
        Game.play(g, 12);
        Game.pass(g);
        Game.pass(g);
        assertTrue(Game.undo(g));
        assertEquals("playing", g.status);
        assertEquals(1, g.consecutivePasses);
        assertEquals(BLACK, g.toPlay);
    }

    @Test
    void phase_resign可指定认输方_数子阶段也可认输() {
        GameState g = Game.createGame(5, 7.5, false);
        Game.play(g, 12);
        assertEquals(OK, Game.resign(g, BLACK));
        assertEquals(WHITE, g.result.winner());

        GameState s = Game.createGame(5, 7.5, false);
        Game.pass(s);
        Game.pass(s);
        assertEquals(OK, Game.resign(s, WHITE));
        assertEquals(BLACK, s.result.winner());
        assertEquals("resign", s.result.reason());

        GameState l = Game.createGame(5, 7.5, true);
        Game.resign(l);
        assertEquals(WHITE, l.result.winner());
    }
}
