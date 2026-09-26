package com.gamego.db;

import java.math.BigDecimal;
import java.math.RoundingMode;

/**
 * 结果文本（与引擎 record.js 的 resultText 相同，采用 SGF RE 的写法）：B+R / W+T / B+3.5 / 0（和棋）/ Void（作废）。
 * games.finish 省略 resultText 时用它生成。
 */
public final class ResultTexts {
  private ResultTexts() {}

  public static String resultText(int winner, String reason, Double black, Double white) {
    if ("abort".equals(reason)) return "Void";
    if (winner == 0) return "0";
    String side = winner == 1 ? "B" : winner == 2 ? "W" : "?";
    if ("resign".equals(reason)) return side + "+R";
    if ("timeout".equals(reason)) return side + "+T";
    if ("score".equals(reason) && black != null && white != null) {
      return side + "+" + formatNumber(Math.abs(black - white));
    }
    return side + "+";
  }

  /** 与 JS 的 {@code Number.isInteger(x) ? String(x) : String(Number(x.toFixed(1)))} 相同。 */
  static String formatNumber(double x) {
    if (x == Math.rint(x) && !Double.isInfinite(x)) return BigDecimal.valueOf((long) x).toPlainString();
    BigDecimal v = new BigDecimal(x).setScale(1, RoundingMode.HALF_UP).stripTrailingZeros();
    if (v.signum() == 0) return "0";
    return v.toPlainString();
  }
}
