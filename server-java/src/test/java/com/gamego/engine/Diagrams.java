package com.gamego.engine;

import java.util.ArrayList;
import java.util.List;

/**
 * 测试工具（移植自 test/helpers.js）：用字符画描述棋盘。X 黑、O 白、. 空，第一行是棋盘最上面一行。
 * 行内空白随意，空行忽略；行数就是路数。
 */
final class Diagrams {

    /** 下标即颜色值 */
    private static final String SYMBOLS = ".XO";

    private Diagrams() {
    }

    private static List<String> meaningfulRows(String text) {
        List<String> rows = new ArrayList<>();
        for (String raw : String.valueOf(text).split("\\r?\\n", -1)) {
            String row = raw.replaceAll("\\s", "");
            if (!row.isEmpty()) rows.add(row);
        }
        return rows;
    }

    static Board fromDiagram(String text) {
        List<String> rows = meaningfulRows(text);
        int n = rows.size();
        if (n == 0) throw new IllegalArgumentException("fromDiagram：字符画里没有任何棋盘行");
        for (int i = 0; i < n; i++) {
            if (rows.get(i).length() != n) {
                throw new IllegalArgumentException("fromDiagram：共 " + n + " 行，但第 " + (i + 1) + " 行有 "
                        + rows.get(i).length() + " 个点（应为方形棋盘）");
            }
        }
        // 按行拼接后的第 k 个字符恰好对应索引 k（idx = y * n + x）
        String flat = String.join("", rows);
        Board board = new Board(n);
        for (int k = 0; k < flat.length(); k++) {
            int color = SYMBOLS.indexOf(flat.charAt(k));
            if (color == -1) {
                throw new IllegalArgumentException("fromDiagram：不认识的字符 \"" + flat.charAt(k) + "\"（位置 " + k + "）");
            }
            board.set(k, color);
        }
        return board;
    }

    static String toDiagram(Board board) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < board.cells.length; i++) {
            if (i > 0) sb.append(i % board.n == 0 ? '\n' : ' ');
            sb.append(SYMBOLS.charAt(board.cells[i]));
        }
        return sb.toString();
    }

    static int[] sorted(int[] a) {
        int[] c = a.clone();
        java.util.Arrays.sort(c);
        return c;
    }
}
