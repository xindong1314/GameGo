package com.gamego.engine;

import static com.gamego.engine.Go.BLACK;
import static com.gamego.engine.Go.PASS;
import static com.gamego.engine.Go.WHITE;
import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/** 移植自 test/record.test.js（含坐标换算） */
class RecordTest {

    @Test
    void GTP坐标_跳过I_行号自下而上() {
        assertEquals("A19", Coords.idxToGtp(0, 19));
        assertEquals("T19", Coords.idxToGtp(18, 19));
        assertEquals("T1", Coords.idxToGtp(19 * 19 - 1, 19));
        assertEquals("J19", Coords.idxToGtp(8, 19));
        assertEquals("Q16", Coords.idxToGtp(3 * 19 + 15, 19));
        assertEquals("pass", Coords.idxToGtp(PASS, 9));
        assertEquals("J1", Coords.idxToGtp(80, 9));
    }

    @Test
    void GTP坐标往返一致_非法输入抛错() {
        for (int n : new int[] {9, 13, 19}) {
            for (int i = 0; i < n * n; i++) assertEquals(i, Coords.gtpToIdx(Coords.idxToGtp(i, n), n));
        }
        assertEquals(PASS, Coords.gtpToIdx("pass", 19));
        assertEquals(PASS, Coords.gtpToIdx("PASS", 19));
        assertEquals(3 * 19 + 15, Coords.gtpToIdx("q16", 19));
        assertEquals(3 * 19 + 15, Coords.gtpToIdx(" q16 ", 19));
        assertThrows(IllegalArgumentException.class, () -> Coords.gtpToIdx("I5", 19));
        assertThrows(IllegalArgumentException.class, () -> Coords.gtpToIdx("K5", 9));
        assertThrows(IllegalArgumentException.class, () -> Coords.gtpToIdx("A10", 9));
        assertThrows(IllegalArgumentException.class, () -> Coords.gtpToIdx("A0", 9));
        assertThrows(IllegalArgumentException.class, () -> Coords.gtpToIdx("", 9));
        assertThrows(IllegalArgumentException.class, () -> Coords.idxToGtp(81, 9));
        assertThrows(IllegalArgumentException.class, () -> Coords.idxToGtp(0, 20));
    }

    @Test
    void SGF坐标往返一致() {
        assertEquals("aa", Coords.idxToSgf(0, 19));
        assertEquals("pd", Coords.idxToSgf(3 * 19 + 15, 19));
        assertEquals("", Coords.idxToSgf(PASS, 19));
        for (int n : new int[] {9, 13, 19}) {
            for (int i = 0; i < n * n; i++) assertEquals(i, Coords.sgfToIdx(Coords.idxToSgf(i, n), n));
        }
        assertEquals(PASS, Coords.sgfToIdx("", 9));
        assertEquals(PASS, Coords.sgfToIdx("tt", 19));
        assertThrows(IllegalArgumentException.class, () -> Coords.sgfToIdx("jj", 9));
        assertThrows(IllegalArgumentException.class, () -> Coords.sgfToIdx(null, 9));
    }

    @Test
    void movesOf_replay往返_pass记为负一() {
        GameState g = Game.createGame(9, 7.5, true);
        Game.play(g, 40);
        Game.play(g, 41);
        Game.pass(g);
        Game.play(g, 50);
        int[] moves = Record.movesOf(g);
        assertArrayEquals(new int[] {40, 41, PASS, 50}, moves);
        GameState r = Record.replay(9, 7.5, moves);
        assertArrayEquals(g.board.cells, r.board.cells);
        assertEquals(g.toPlay, r.toPlay);
        assertFalse(r.autoScore);
    }

    @Test
    void replay_两次pass停在数子阶段_非法着手抛错并带位置() {
        assertEquals("scoring", Record.replay(9, 7.5, new int[] {40, PASS, PASS}).status);
        EngineException e1 = assertThrows(EngineException.class, () -> Record.replay(9, 7.5, new int[] {40, 40}));
        assertEquals(1, e1.getMoveIndex());
        assertEquals("occupied", e1.getReason());
        assertEquals("第 2 手非法：occupied", e1.getMessage());
        EngineException e2 = assertThrows(EngineException.class,
                () -> Record.replay(9, 7.5, new int[] {40, PASS, PASS, 40}));
        assertEquals(3, e2.getMoveIndex());
        assertEquals("occupied", e2.getReason());
    }

    @Test
    void replay_autoScore为真时两次pass直接终局_其后着手报ended() {
        GameState s = Record.replay(9, 7.5, new int[] {40, PASS, PASS}, true);
        assertEquals("ended", s.status);
        EngineException e = assertThrows(EngineException.class,
                () -> Record.replay(9, 7.5, new int[] {40, PASS, PASS, 41}, true));
        assertEquals(3, e.getMoveIndex());
        assertEquals("ended", e.getReason());
        assertEquals("playing", Record.replay(9, 7.5, null).status);
    }

    @Test
    void replay_数子阶段之后的着手视为继续对局() {
        GameState r = Record.replay(9, 7.5, new int[] {40, PASS, PASS, 41});
        assertEquals("playing", r.status);
        assertEquals(WHITE, r.board.get(41));
        assertEquals(0, r.consecutivePasses);
        assertEquals(BLACK, r.toPlay);
        assertEquals("playing", Record.replay(9, 7.5, new int[] {40, PASS, PASS, 41, PASS}).status);
        assertEquals("scoring", Record.replay(9, 7.5, new int[] {40, PASS, PASS, 41, PASS, PASS}).status);
        assertEquals("scoring", Record.replay(9, 7.5, new int[] {40, PASS, PASS, PASS, PASS}).status);
    }

    @Test
    void 继续对局后悔棋_精确恢复连续pass计数() {
        GameState g = Record.replay(9, 7.5, new int[] {40, PASS, PASS, 41});
        assertTrue(Game.undo(g));
        assertEquals("playing", g.status);
        assertEquals(0, g.consecutivePasses);
        assertEquals(WHITE, g.toPlay);
        Game.pass(g);
        assertEquals("playing", g.status);
        GameState s = Record.replay(9, 7.5, new int[] {40, PASS, PASS});
        Game.undo(s);
        assertEquals("playing", s.status);
        assertEquals(1, s.consecutivePasses);
    }

    @Test
    void replay正确处理提子() {
        GameState r = Record.replay(9, 7.5, new int[] {9, 0, 1});
        assertEquals(0, r.board.get(0));
        assertEquals(1, r.captures[BLACK]);
    }

    @Test
    void resultText与resultLabel() {
        assertEquals("B+R", Record.resultText(new Result(BLACK, "resign")));
        assertEquals("W+T", Record.resultText(new Result(WHITE, "timeout")));
        assertEquals("W+8.5", Record.resultText(new Result(WHITE, "score", 180.0, 188.5)));
        assertEquals("B+7", Record.resultText(new Result(BLACK, "score", 44.0, 37.0)));
        assertEquals("0", Record.resultText(new Result(0, "score", 40.0, 40.0)));
        assertEquals("Void", Record.resultText(new Result(0, "abort")));
        assertEquals("", Record.resultText(null));
        assertEquals("B+", Record.resultText(new Result(BLACK, "score")));
        assertEquals("?+R", Record.resultText(new Result(3, "resign")));
        assertEquals("黑中盘胜（对方认输）", Record.resultLabel(new Result(BLACK, "resign")));
        assertEquals("白胜（对方超时）", Record.resultLabel(new Result(WHITE, "timeout")));
        assertEquals("白胜 8.5 目", Record.resultLabel(new Result(WHITE, "score", 180.0, 188.5)));
        assertEquals("对局作废", Record.resultLabel(new Result(0, "abort")));
        assertEquals("和棋", Record.resultLabel(new Result(0, "score", 40.0, 40.0)));
        assertEquals("黑胜", Record.resultLabel(new Result(BLACK, "score")));
        assertEquals("", Record.resultLabel(null));
    }

    @Test
    void formatNumber与JS_toFixed一致() {
        assertEquals("7", Record.formatNumber(7));
        assertEquals("7.5", Record.formatNumber(7.5));
        assertEquals("0.3", Record.formatNumber(0.25)); // 恰好一半：取较大者
        assertEquals("0.3", Record.formatNumber(0.35)); // 0.35 的 double 实际略小于 0.35
        assertEquals("2", Record.formatNumber(1.96));
        assertEquals("0", Record.formatNumber(0.04));
        assertEquals("0", Record.formatNumber(-0.04));
        assertEquals("-2.5", Record.formatNumber(-2.5));
        assertEquals("0", Record.formatNumber(-0.0));
    }

    @Test
    void toSgf() {
        String sgf = Record.toSgf(9, 7.5, new int[] {40, PASS, 0}, "小明", "a]b",
                new Result(BLACK, "resign"), "2026-09-25");
        assertEquals("(;FF[4]GM[1]CA[UTF-8]AP[GameGo]RU[Chinese]SZ[9]KM[7.5]PB[小明]PW[a\\]b]DT[2026-09-25]RE[B+R];B[ee];W[];B[aa])",
                sgf);
        assertEquals("(;FF[4]GM[1]CA[UTF-8]AP[GameGo]RU[Chinese]SZ[19]KM[0])",
                Record.toSgf(19, 0, null, null, "", null, null));
    }
}
