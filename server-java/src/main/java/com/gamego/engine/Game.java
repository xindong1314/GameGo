package com.gamego.engine;

import static com.gamego.engine.Go.BLACK;
import static com.gamego.engine.Go.EMPTY;
import static com.gamego.engine.Go.WHITE;
import static com.gamego.engine.Go.opponent;

import java.util.List;
import java.util.Objects;

/**
 * 一局棋的操作（移植自 game.js）。每个操作都直接改写传入的 state，不另造新对象。
 */
public final class Game {

    public static final int DEFAULT_SIZE = 19;
    public static final double DEFAULT_KOMI = 7.5;

    private Game() {
    }

    /** 默认 19 路、贴 7.5、autoScore=true */
    public static GameState createGame() {
        return createGame(DEFAULT_SIZE, DEFAULT_KOMI, true);
    }

    public static GameState createGame(int size, double komi, boolean autoScore) {
        return new GameState(size, komi, autoScore);
    }

    /** 落子、停一手只能在 playing 阶段进行；其余阶段返回拒绝结果，playing 时返回 null */
    private static OpResult refuseUnlessPlaying(GameState state) {
        switch (state.status) {
            case GameState.PLAYING:
                return null;
            case GameState.SCORING:
                return OpResult.fail("scoring");
            default:
                return OpResult.fail("ended");
        }
    }

    /**
     * 往 history 里追加一手（idx 为 null 表示停一手）。
     * 必须在改动 state.ko / consecutivePasses 之前调用，koBefore、passesBefore 才是这手之前的值
     */
    private static void logMove(GameState state, int color, Integer idx, int[] captured, Integer koAfter) {
        state.history.add(new Move(color, idx, captured, state.ko, koAfter, state.consecutivePasses));
    }

    public static OpResult play(GameState state, int idx) {
        OpResult refused = refuseUnlessPlaying(state);
        if (refused != null) return refused;
        int mover = state.toPlay;
        Rules.PlayResult outcome = Rules.tryPlay(state.board, mover, state.ko, idx);
        if (!outcome.ok()) return OpResult.fail(outcome.reason());

        logMove(state, mover, idx, outcome.captured(), outcome.koAfter());
        state.captures[mover] += outcome.captured().length;
        state.ko = outcome.koAfter();
        state.toPlay = opponent(mover);
        state.consecutivePasses = 0;
        return OpResult.OK;
    }

    /** 双方接连停一手之后：交给外部数子，或者直接按 Tromp-Taylor 计分结束 */
    private static void closeAfterPasses(GameState state) {
        if (!state.autoScore) {
            state.status = GameState.SCORING;
            return;
        }
        Score.ScoreResult s = Score.score(state.board, state.komi);
        state.status = GameState.ENDED;
        state.result = new Result(s.winner(), "score", s.black(), s.white());
    }

    public static OpResult pass(GameState state) {
        OpResult refused = refuseUnlessPlaying(state);
        if (refused != null) return refused;
        int mover = state.toPlay;
        logMove(state, mover, null, new int[0], null);
        state.ko = null; // 隔了一手，原先的劫点不再禁着
        state.toPlay = opponent(mover);
        state.consecutivePasses += 1;
        if (state.consecutivePasses >= 2) closeAfterPasses(state);
        return OpResult.OK;
    }

    /** scoring → playing。停一手的计数清零，toPlay 保持原值 */
    public static OpResult resume(GameState state) {
        if (!GameState.SCORING.equals(state.status)) return OpResult.fail("not-scoring");
        state.status = GameState.PLAYING;
        state.consecutivePasses = 0;
        return OpResult.OK;
    }

    /**
     * 直接结束对局，结果由调用方给出（例如 new Result(winner, "timeout")）；没给的 black / white 为 null。
     * Result 是不可变的，直接保存即可（相当于 JS 中复制一份）。
     */
    public static OpResult finish(GameState state, Result result) {
        Objects.requireNonNull(result, "result");
        if (GameState.ENDED.equals(state.status)) return OpResult.fail("ended");
        state.status = GameState.ENDED;
        state.result = result;
        return OpResult.OK;
    }

    /** 当前行棋方认输 */
    public static OpResult resign(GameState state) {
        return resign(state, null);
    }

    /** 认输。color 是黑或白时由该方认输，否则（含 null）由当前该下的一方认输 */
    public static OpResult resign(GameState state, Integer color) {
        if (!GameState.PLAYING.equals(state.status) && !GameState.SCORING.equals(state.status)) {
            return OpResult.fail("ended");
        }
        int quitter = color != null && (color == BLACK || color == WHITE) ? color : state.toPlay;
        state.status = GameState.ENDED;
        state.result = new Result(opponent(quitter), "resign");
        return OpResult.OK;
    }

    // ---------- 悔棋 ----------

    private static void reopen(GameState state) {
        state.status = GameState.PLAYING;
        state.result = null;
    }

    /** 把一手落子从棋盘上拿掉，被它提走的对方棋子放回原处，提子数同步扣回 */
    private static void takeBack(GameState state, Move entry) {
        Board board = state.board;
        board.set(entry.idx(), EMPTY);
        int victim = opponent(entry.color());
        for (int p : entry.captured()) board.set(p, victim);
        state.captures[entry.color()] -= entry.captured().length;
    }

    /**
     * 认输后悔棋只取消认输本身，棋盘与记录都不动；否则撤回 history 的最后一手。
     * 什么都撤不了时返回 false
     */
    public static boolean undo(GameState state) {
        if (state.result != null && "resign".equals(state.result.reason())) {
            reopen(state);
            return true;
        }
        List<Move> history = state.history;
        if (history.isEmpty()) return false;
        Move entry = history.remove(history.size() - 1);
        if (entry.idx() != null) takeBack(state, entry);
        state.ko = entry.koBefore();
        state.toPlay = entry.color();
        state.consecutivePasses = entry.passesBefore();
        reopen(state);
        return true;
    }
}
