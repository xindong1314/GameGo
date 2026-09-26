package com.gamego.engine;

import static com.gamego.engine.Go.EMPTY;

import java.util.Arrays;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 棋盘数据结构（移植自 miniprogram/utils/engine/board.js）。
 * 交叉点按行展开成一维：idx = y * n + x，(0,0) 是左上角。
 * cells 中 0 空、1 黑、2 白；外部代码可以直接读写它，布局不能改。
 */
public final class Board {

    /** 某点的坐标 */
    public record XY(int x, int y) {
    }

    /**
     * 同色连通块。stones 按广度优先的发现顺序排列（与 JS 完全一致），liberties 同样按发现顺序、已去重。
     */
    public record Group(int color, int[] stones, int[] liberties) {
    }

    /** 每种路数的相邻表只算一次：ADJACENCY.get(n)[idx] 为 idx 的上下左右（盘内），顺序为 上、下、左、右 */
    private static final ConcurrentHashMap<Integer, int[][]> ADJACENCY = new ConcurrentHashMap<>();

    static int[][] adjacencyOf(int n) {
        return ADJACENCY.computeIfAbsent(n, Board::buildAdjacency);
    }

    private static int[][] buildAdjacency(int n) {
        int[][] table = new int[n * n][];
        int[] buf = new int[4];
        for (int y = 0; y < n; y++) {
            for (int x = 0; x < n; x++) {
                int i = y * n + x;
                int k = 0;
                if (y > 0) buf[k++] = i - n;
                if (y < n - 1) buf[k++] = i + n;
                if (x > 0) buf[k++] = i - 1;
                if (x < n - 1) buf[k++] = i + 1;
                table[i] = Arrays.copyOf(buf, k);
            }
        }
        return table;
    }

    /** 路数 */
    public final int n;
    /** 各交叉点的颜色 */
    public final byte[] cells;

    public Board(int n) {
        if (n < 1) throw new IllegalArgumentException("棋盘路数必须是正整数：" + n);
        this.n = n;
        this.cells = new byte[n * n];
    }

    public int toIdx(int x, int y) {
        return y * n + x;
    }

    public XY toXY(int idx) {
        int x = idx % n;
        return new XY(x, (idx - x) / n);
    }

    public int get(int idx) {
        return cells[idx];
    }

    public void set(int idx, int color) {
        cells[idx] = (byte) color;
    }

    private boolean inBoard(int idx) {
        return idx >= 0 && idx < cells.length;
    }

    /** 上下左右在盘内的相邻点。返回新数组，调用方可以随意修改；越界时返回空数组 */
    public int[] neighbors(int idx) {
        if (!inBoard(idx)) return new int[0];
        return adjacencyOf(n)[idx].clone();
    }

    /**
     * idx 所在的同色连通块；idx 上没有棋子或不在盘内时为 null。
     * 用 stones 数组本身充当广度优先的队列，不递归。
     */
    public Group group(int idx) {
        if (!inBoard(idx)) return null;
        int color = cells[idx];
        if (color == EMPTY) return null;
        int[][] adj = adjacencyOf(n);
        int total = cells.length;
        // 0 未访问；1 已收入本块；2 已记为气
        byte[] seen = new byte[total];
        int[] stones = new int[total];
        int[] liberties = new int[total];
        int stoneCount = 0;
        int libCount = 0;
        stones[stoneCount++] = idx;
        seen[idx] = 1;
        for (int head = 0; head < stoneCount; head++) {
            int[] around = adj[stones[head]];
            for (int nb : around) {
                if (seen[nb] != 0) continue;
                int c = cells[nb];
                if (c == color) {
                    seen[nb] = 1;
                    stones[stoneCount++] = nb;
                } else if (c == EMPTY) {
                    seen[nb] = 2;
                    liberties[libCount++] = nb;
                }
            }
        }
        return new Group(color, Arrays.copyOf(stones, stoneCount), Arrays.copyOf(liberties, libCount));
    }

    /** 深拷贝（对应 JS 的 clone） */
    public Board copy() {
        Board b = new Board(n);
        System.arraycopy(cells, 0, b.cells, 0, cells.length);
        return b;
    }
}
