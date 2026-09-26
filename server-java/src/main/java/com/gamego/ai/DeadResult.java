package com.gamego.ai;

import java.util.Arrays;

/** judgeDead 的结果：死子 idx（升序），source 目前恒为 "katago"。 */
public record DeadResult(int[] dead, String source) {
  public static final String SOURCE_KATAGO = "katago";

  @Override
  public boolean equals(Object o) {
    return o instanceof DeadResult r && Arrays.equals(r.dead, dead) && java.util.Objects.equals(r.source, source);
  }

  @Override
  public int hashCode() {
    return 31 * Arrays.hashCode(dead) + java.util.Objects.hashCode(source);
  }

  @Override
  public String toString() {
    return "DeadResult[dead=" + Arrays.toString(dead) + ", source=" + source + "]";
  }
}
