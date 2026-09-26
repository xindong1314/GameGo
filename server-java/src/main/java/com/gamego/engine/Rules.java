package com.gamego.engine;

import static com.gamego.engine.Go.BLACK;
import static com.gamego.engine.Go.EMPTY;
import static com.gamego.engine.Go.WHITE;
import static com.gamego.engine.Go.opponent;

import java.util.Arrays;

/**
 * 单手棋的合法性判定与执行：提子、禁止自杀、劫（不许立即回提单个子）。移植自 rules.js。
 */
public final class Rules {

    /**
     * tryPlay 的结果。成功：ok=true、reason=null、captured 升序、koAfter 为下一手的劫点（可为 null）；
     * 失败：ok=false、reason ∈ invalid / occupied / ko / suicide，captured 与 koAfter 为 null。
     */
    public record PlayResult(boolean ok, String reason, int[] captured, Integer koAfter) {
        static PlayResult reject(String reason) {
            return new PlayResult(false, reason, null, null);
        }
    }

    private Rules() {
    }

    /**
     * 以 color 落在 idx 之后（子已放上），与 idx 相邻、已无气的对方棋块中的全部棋子。
     * 先把要提的块全部找出来再统一拿掉：对方两块只要互不相连，提掉其中一块不会影响另一块的气。
     */
    private static int[] doomedStones(Board board, int idx, int color) {
        int foe = opponent(color);
        boolean[] inspected = new boolean[board.cells.length]; // 已检查过的对方棋子，避免同一块被查两遍
        int[] doomed = new int[board.cells.length];
        int count = 0;
        for (int p : Board.adjacencyOf(board.n)[idx]) {
            if (inspected[p] || board.get(p) != foe) continue;
            Board.Group blk = board.group(p);
            for (int s : blk.stones()) inspected[s] = true;
            if (blk.liberties().length == 0) {
                for (int s : blk.stones()) doomed[count++] = s;
            }
        }
        return Arrays.copyOf(doomed, count);
    }

    /**
     * board 上由 color 落子于 idx；ko 为此刻不许落子的劫点（没有则为 null）。
     * 合法：直接改动 board；不合法：board 原样不动。
     */
    public static PlayResult tryPlay(Board board, int color, Integer ko, int idx) {
        int points = board.n * board.n;
        if (idx < 0 || idx >= points) return PlayResult.reject("invalid");
        if (color != BLACK && color != WHITE) return PlayResult.reject("invalid");
        if (board.get(idx) != EMPTY) return PlayResult.reject("occupied");
        if (ko != null && idx == ko) return PlayResult.reject("ko");

        board.set(idx, color);
        int[] captured = doomedStones(board, idx, color);
        for (int s : captured) board.set(s, EMPTY);

        Board.Group mine = board.group(idx);
        if (captured.length == 0 && mine.liberties().length == 0) {
            board.set(idx, EMPTY); // 一个子也没提到、自己却没气：自杀，不论单子多子，收回这手
            return PlayResult.reject("suicide");
        }

        Arrays.sort(captured);
        // 只提掉一个子，而落下的子孤立无援、仅剩的一口气正是被提的那个点：
        // 对方若立即回提就会还原局面，所以把这个点记为下一手的劫点
        boolean makesKo = captured.length == 1 && mine.stones().length == 1 && mine.liberties().length == 1;
        return new PlayResult(true, null, captured, makesKo ? Integer.valueOf(captured[0]) : null);
    }

    /** 只问能不能下：在副本上试一下，board 本身不受影响。成功时 reason 为 null */
    public static OpResult canPlay(Board board, int color, Integer ko, int idx) {
        PlayResult r = tryPlay(board.copy(), color, ko, idx);
        return r.ok() ? OpResult.OK : OpResult.fail(r.reason());
    }
}
