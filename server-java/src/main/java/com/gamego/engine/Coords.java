package com.gamego.engine;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 坐标换算（移植自 coords.js）。内部索引 idx = y * n + x，(0,0) 为左上角；-1 表示 pass。
 * GTP（KataGo 使用）：列字母跳过 I，行号从下往上数，如 19 路左上角为 "A19"。
 * SGF：两个小写字母，列在前行在后，左上角为 "aa"；pass 记为空串。
 * 非法输入抛出 IllegalArgumentException。
 */
public final class Coords {

    public static final int PASS = Go.PASS;
    public static final String GTP_LETTERS = "ABCDEFGHJKLMNOPQRST";

    private static final Pattern GTP = Pattern.compile("^([A-HJ-T])(\\d{1,2})$");
    private static final Pattern SGF = Pattern.compile("^[a-s]{2}$");

    private Coords() {
    }

    private static void assertSize(int n) {
        if (n < 2 || n > GTP_LETTERS.length()) {
            throw new IllegalArgumentException("不支持的路数 " + n);
        }
    }

    /** 与 JS String.prototype.trim 相同的空白集合（比 Java strip 多了  、﻿ 等） */
    private static boolean isJsSpace(char c) {
        switch (c) {
            case '\t': case '\n': case 0x0B: case '\f': case '\r': case ' ':
            case 0x00A0: case 0x1680: case 0x2028: case 0x2029: case 0x202F:
            case 0x205F: case 0x3000: case 0xFEFF:
                return true;
            default:
                return c >= 0x2000 && c <= 0x200A;
        }
    }

    private static String jsTrim(String s) {
        int start = 0;
        int end = s.length();
        while (start < end && isJsSpace(s.charAt(start))) start++;
        while (end > start && isJsSpace(s.charAt(end - 1))) end--;
        return s.substring(start, end);
    }

    public static String idxToGtp(int idx, int n) {
        assertSize(n);
        if (idx == PASS) return "pass";
        if (idx < 0 || idx >= n * n) throw new IllegalArgumentException("非法索引 " + idx);
        int x = idx % n;
        int y = (idx - x) / n;
        return GTP_LETTERS.charAt(x) + String.valueOf(n - y);
    }

    public static int gtpToIdx(String str, int n) {
        assertSize(n);
        String s = jsTrim(String.valueOf(str)).toUpperCase(Locale.ROOT);
        if (s.equals("PASS")) return PASS;
        Matcher m = GTP.matcher(s);
        if (!m.matches()) throw new IllegalArgumentException("非法 GTP 坐标 " + str);
        int x = GTP_LETTERS.indexOf(m.group(1));
        int row = Integer.parseInt(m.group(2));
        if (x >= n || row < 1 || row > n) {
            throw new IllegalArgumentException("GTP 坐标 " + str + " 超出 " + n + " 路棋盘");
        }
        return (n - row) * n + x;
    }

    public static String idxToSgf(int idx, int n) {
        assertSize(n);
        if (idx == PASS) return "";
        if (idx < 0 || idx >= n * n) throw new IllegalArgumentException("非法索引 " + idx);
        int x = idx % n;
        int y = (idx - x) / n;
        return String.valueOf((char) ('a' + x)) + (char) ('a' + y);
    }

    public static int sgfToIdx(String str, int n) {
        assertSize(n);
        if ("".equals(str) || (n <= 19 && "tt".equals(str))) return PASS;
        if (str == null || !SGF.matcher(str).matches()) throw new IllegalArgumentException("非法 SGF 坐标 " + str);
        int x = str.charAt(0) - 'a';
        int y = str.charAt(1) - 'a';
        if (x >= n || y >= n) throw new IllegalArgumentException("SGF 坐标 " + str + " 超出 " + n + " 路棋盘");
        return y * n + x;
    }
}
