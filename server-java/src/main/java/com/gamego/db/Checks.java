package com.gamego.db;

import java.util.List;

/** 仓储层的参数校验（对应 Node 版抛 TypeError 的检查），失败抛 IllegalArgumentException。 */
final class Checks {
  private Checks() {}

  static void userId(Long id, String fn, String name) {
    if (id == null || id <= 0) throw new IllegalArgumentException(fn + ": " + name + " 必须是正整数，收到 " + id);
  }

  static void string(String v, String fn, String name, int max, boolean allowEmpty) {
    if (v == null) throw new IllegalArgumentException(fn + ": " + name + " 必须是字符串");
    if (!allowEmpty && v.isEmpty()) throw new IllegalArgumentException(fn + ": " + name + " 不能为空");
    if (v.length() > max) throw new IllegalArgumentException(fn + ": " + name + " 过长");
  }

  static void moves(List<Integer> moves, String fn) {
    if (moves == null || moves.stream().anyMatch(m -> m == null || m < -1)) {
      throw new IllegalArgumentException(fn + ": moves 必须是整数数组（pass 为 -1）");
    }
  }

  static void idxArray(List<Integer> arr, String fn, String name) {
    if (arr == null || arr.stream().anyMatch(m -> m == null || m < 0)) {
      throw new IllegalArgumentException(fn + ": " + name + " 必须是非负整数数组");
    }
  }
}
