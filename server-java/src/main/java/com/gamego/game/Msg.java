package com.gamego.game;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 推送消息与快照用的 JSON 对象（有序 Map，值可以为 null）。
 *
 * <pre>
 * Msg.of("t", "game.move", "gameId", id, "n", 3)
 * </pre>
 *
 * 颜色做键的对象（Clocks、accepted、presence、stats …）的键是字符串 "1" / "2"，与 Node 版 JSON 完全一致。
 */
public final class Msg {
  private Msg() {}

  public static Map<String, Object> of(Object... kv) {
    if (kv.length % 2 != 0) throw new IllegalArgumentException("Msg.of: 需要成对的键值");
    Map<String, Object> m = new LinkedHashMap<>();
    for (int i = 0; i < kv.length; i += 2) m.put((String) kv[i], kv[i + 1]);
    return m;
  }

  /** {@code { "1": black, "2": white }}。 */
  public static Map<String, Object> byColor(Object black, Object white) {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("1", black);
    m.put("2", white);
    return m;
  }

  /** int[] → List（JSON 数组，复制一份）。 */
  public static List<Integer> list(int[] a) {
    List<Integer> out = new ArrayList<>(a.length);
    for (int v : a) out.add(v);
    return out;
  }

  public static int[] ints(List<Integer> l) {
    int[] out = new int[l.size()];
    for (int i = 0; i < out.length; i++) out[i] = l.get(i);
    return out;
  }
}
