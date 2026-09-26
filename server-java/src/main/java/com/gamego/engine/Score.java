package com.gamego.engine;

import static com.gamego.engine.Go.BLACK;
import static com.gamego.engine.Go.EMPTY;
import static com.gamego.engine.Go.WHITE;

import java.util.TreeSet;

/**
 * 数子法计分（区域计分），移植自 score.js。
 * score：Tromp-Taylor，棋盘上的子全算活子；
 * scoreArea：先把 dead 里的子当作已提掉，再按同样的办法计分，并给出每个点的归属。
 */
public final class Score {

    /**
     * 计分结果。black = 黑子 + 黑地；white = 白子 + 白地 + 贴目；winner 0 表示平局。
     * owner（每个点归属：0 无主、1 黑、2 白）与 dead（生效的死子，升序）只有 scoreArea 给出，score 中为 null。
     */
    public record ScoreResult(double black, double white, int winner,
                              int blackStones, int whiteStones, int blackArea, int whiteArea,
                              int[] owner, int[] dead) {
    }

    private Score() {
    }

    /** Tromp-Taylor 计分：盘上的子全算活子 */
    public static ScoreResult score(Board board, double komi) {
        ScoreResult t = tally(board, komi, null);
        return new ScoreResult(t.black(), t.white(), t.winner(),
                t.blackStones(), t.whiteStones(), t.blackArea(), t.whiteArea(), null, null);
    }

    /** 去掉死子后计分。dead 可为 null；其中越界、空点、重复的值被忽略，不修改传入数组 */
    public static ScoreResult scoreArea(Board board, double komi, int[] dead) {
        int[] list = effectiveDead(board, dead);
        boolean[] removed = new boolean[board.n * board.n];
        for (int i : list) removed[i] = true;
        ScoreResult t = tally(board, komi, removed);
        return new ScoreResult(t.black(), t.white(), t.winner(),
                t.blackStones(), t.whiteStones(), t.blackArea(), t.whiteArea(), t.owner(), list);
    }

    /**
     * 切换 idx 所在整块的死活，返回新的死子数组（去重升序，不改动传入的数组）。
     * 整块都已标死 → 全部取消；否则（没标或只标了一部分）→ 整块标死。空点或越界时返回原集合的去重升序副本。
     */
    public static int[] toggleDead(Board board, int[] dead, int idx) {
        TreeSet<Integer> set = new TreeSet<>();
        if (dead != null) {
            for (int d : dead) set.add(d);
        }
        Board.Group g = board.group(idx);
        if (g != null) {
            boolean allDead = true;
            for (int s : g.stones()) {
                if (!set.contains(s)) {
                    allDead = false;
                    break;
                }
            }
            for (int s : g.stones()) {
                if (allDead) set.remove(s);
                else set.add(s);
            }
        }
        return toArray(set);
    }

    private static int[] toArray(TreeSet<Integer> set) {
        int[] out = new int[set.size()];
        int k = 0;
        for (int v : set) out[k++] = v;
        return out;
    }

    /** 生效的死子：盘内、有子，去重升序 */
    private static int[] effectiveDead(Board board, int[] dead) {
        TreeSet<Integer> set = new TreeSet<>();
        if (dead != null) {
            int total = board.n * board.n;
            for (int i : dead) {
                if (i >= 0 && i < total && board.get(i) != EMPTY) set.add(i);
            }
        }
        return toArray(set);
    }

    /** 计分核心。removed[i] 为 true 表示该点的子按死子处理（当作空点）。迭代式泛洪，不递归 */
    private static ScoreResult tally(Board board, double komi, boolean[] removed) {
        int total = board.n * board.n;
        byte[] cells = board.cells;
        int[][] adj = Board.adjacencyOf(board.n);
        // 实际参与计分的颜色：死子处视为空点
        int[] colorAt = new int[total];
        for (int i = 0; i < total; i++) colorAt[i] = removed != null && removed[i] ? EMPTY : cells[i];

        int[] owner = new int[total];
        boolean[] visited = new boolean[total];
        int[] region = new int[total];
        int blackStones = 0;
        int whiteStones = 0;
        int blackArea = 0;
        int whiteArea = 0;

        for (int start = 0; start < total; start++) {
            int c = colorAt[start];
            if (c == BLACK || c == WHITE) {
                owner[start] = c;
                if (c == BLACK) blackStones += 1;
                else whiteStones += 1;
                continue;
            }
            if (visited[start]) continue;

            // 从 start 出发找出整片空区，并记下它接触到的颜色
            int len = 0;
            region[len++] = start;
            visited[start] = true;
            boolean seesBlack = false;
            boolean seesWhite = false;
            for (int head = 0; head < len; head++) {
                for (int nb : adj[region[head]]) {
                    int d = colorAt[nb];
                    if (d == BLACK) seesBlack = true;
                    else if (d == WHITE) seesWhite = true;
                    else if (!visited[nb]) {
                        visited[nb] = true;
                        region[len++] = nb;
                    }
                }
            }

            int who = EMPTY;
            if (seesBlack && !seesWhite) who = BLACK;
            else if (seesWhite && !seesBlack) who = WHITE;
            if (who == EMPTY) continue; // 无主（双方都挨着，或谁都不挨着）
            for (int k = 0; k < len; k++) owner[region[k]] = who;
            if (who == BLACK) blackArea += len;
            else whiteArea += len;
        }

        double black = blackStones + blackArea;
        double white = whiteStones + whiteArea + komi;
        int winner = EMPTY;
        if (black > white) winner = BLACK;
        else if (white > black) winner = WHITE;
        return new ScoreResult(black, white, winner, blackStones, whiteStones, blackArea, whiteArea, owner, null);
    }
}
