package com.gamego.engine;

/**
 * 引擎公用常量（对应 JS 的 board.js 与 coords.js 导出的常量）。
 * 建议 {@code import static com.gamego.engine.Go.*;} 使用。
 */
public final class Go {
    /** 空点 */
    public static final int EMPTY = 0;
    /** 黑 */
    public static final int BLACK = 1;
    /** 白 */
    public static final int WHITE = 2;
    /** 着手序列中的停一手 */
    public static final int PASS = -1;

    private Go() {
    }

    /** 对方颜色；传入的不是黑白则返回 EMPTY */
    public static int opponent(int color) {
        if (color == BLACK) return WHITE;
        if (color == WHITE) return BLACK;
        return EMPTY;
    }
}
