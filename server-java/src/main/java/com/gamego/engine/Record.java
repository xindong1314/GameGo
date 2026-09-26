package com.gamego.engine;

import static com.gamego.engine.Go.BLACK;
import static com.gamego.engine.Go.WHITE;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.List;

/**
 * 对局记录（移植自 record.js）：着手序列 moves 为整数数组，落子为 idx，pass 为 -1。
 * 联网协议、数据库、复盘都使用这种表示；黑先、轮流行棋，不记录颜色。
 * <p>
 * 注意：本类名与 java.lang.Record 同名。同包内直接用 {@code Record} 即指本类；
 * 其他包请显式 {@code import com.gamego.engine.Record;}（不要只依赖 {@code com.gamego.engine.*}）。
 */
public final class Record {

    /** 着手序列中的停一手（同 Go.PASS） */
    public static final int PASS = Go.PASS;

    private Record() {
    }

    /** 当前对局的着手序列 */
    public static int[] movesOf(GameState state) {
        List<Move> history = state.history;
        int[] out = new int[history.size()];
        for (int i = 0; i < out.length; i++) {
            Integer idx = history.get(i).idx();
            out[i] = idx == null ? PASS : idx;
        }
        return out;
    }

    /** 同 {@link #replay(int, double, int[], boolean)}，autoScore = false */
    public static GameState replay(int size, double komi, int[] moves) {
        return replay(size, komi, moves, false);
    }

    /**
     * 从着手序列重建对局状态。遇到非法着手抛出 {@link EngineException}（moveIndex 为出错位置，从 0 数）。
     * autoScore 为 false 时两次 pass 之后停在 scoring。
     * 着手序列不记录"继续对局"：数子阶段之后如果还有着手，说明当时有人选择了继续对局，
     * 这里先 resume() 再落下这一手。
     */
    public static GameState replay(int size, double komi, int[] moves, boolean autoScore) {
        GameState state = Game.createGame(size, komi, autoScore);
        if (moves == null) return state;
        for (int i = 0; i < moves.length; i++) {
            int mv = moves[i];
            if (GameState.SCORING.equals(state.status)) Game.resume(state);
            OpResult r = mv == PASS ? Game.pass(state) : Game.play(state, mv);
            if (!r.ok()) {
                throw new EngineException("第 " + (i + 1) + " 手非法：" + r.reason(), i, r.reason());
            }
        }
        return state;
    }

    /**
     * 与 JS formatNumber 一致：整数原样输出；否则按 toFixed(1) 四舍五入（基于 double 的精确十进制值）再去掉多余的 0。
     */
    static String formatNumber(double x) {
        if (Double.isNaN(x)) return "NaN";
        if (Double.isInfinite(x)) return x > 0 ? "Infinity" : "-Infinity";
        if (x == Math.rint(x) && Math.abs(x) < 1e15) return Long.toString((long) x);
        BigDecimal d = new BigDecimal(x).setScale(1, RoundingMode.HALF_UP);
        if (d.signum() == 0) return "0";
        return d.stripTrailingZeros().toPlainString();
    }

    private static boolean hasPoints(Result result) {
        return result.black() != null && result.white() != null;
    }

    /** 结果文本，采用 SGF RE 的写法：B+R / W+T / B+3.5 / 0（和棋）/ Void（作废）；null 为空串 */
    public static String resultText(Result result) {
        if (result == null) return "";
        if ("abort".equals(result.reason())) return "Void";
        if (result.winner() == 0) return "0";
        String side = result.winner() == BLACK ? "B" : result.winner() == WHITE ? "W" : "?";
        if ("resign".equals(result.reason())) return side + "+R";
        if ("timeout".equals(result.reason())) return side + "+T";
        if ("score".equals(result.reason()) && hasPoints(result)) {
            return side + "+" + formatNumber(Math.abs(result.black() - result.white()));
        }
        return side + "+";
    }

    /** 中文结果描述，供界面显示；null 为空串 */
    public static String resultLabel(Result result) {
        if (result == null) return "";
        if ("abort".equals(result.reason())) return "对局作废";
        if (result.winner() == 0) return "和棋";
        String side = result.winner() == BLACK ? "黑" : "白";
        if ("resign".equals(result.reason())) return side + "中盘胜（对方认输）";
        if ("timeout".equals(result.reason())) return side + "胜（对方超时）";
        if ("score".equals(result.reason()) && hasPoints(result)) {
            // 显示双方点数之差（多数围棋应用的"胜 X 目"写法）；换算成"子"需再除以 2
            return side + "胜 " + formatNumber(Math.abs(result.black() - result.white())) + " 目";
        }
        return side + "胜";
    }

    private static String escapeSgf(String text) {
        return (text == null ? "" : text).replace("\\", "\\\\").replace("]", "\\]");
    }

    private static boolean truthy(String s) {
        return s != null && !s.isEmpty();
    }

    /**
     * 生成 SGF 棋谱文本。blackName / whiteName / date 为 null 或空串时省略；result 为 null 时不写 RE。
     */
    public static String toSgf(int size, double komi, int[] moves, String blackName, String whiteName,
                               Result result, String date) {
        StringBuilder sb = new StringBuilder("(;");
        sb.append("FF[4]GM[1]CA[UTF-8]AP[GameGo]RU[Chinese]");
        sb.append("SZ[").append(size).append(']');
        sb.append("KM[").append(formatNumber(komi)).append(']');
        if (truthy(blackName)) sb.append("PB[").append(escapeSgf(blackName)).append(']');
        if (truthy(whiteName)) sb.append("PW[").append(escapeSgf(whiteName)).append(']');
        if (truthy(date)) sb.append("DT[").append(escapeSgf(date)).append(']');
        String re = resultText(result);
        if (!re.isEmpty()) sb.append("RE[").append(re).append(']');
        if (moves != null) {
            for (int i = 0; i < moves.length; i++) {
                sb.append(';').append(i % 2 == 0 ? 'B' : 'W')
                        .append('[').append(Coords.idxToSgf(moves[i], size)).append(']');
            }
        }
        return sb.append(')').toString();
    }
}
