package com.gamego.ai;

import java.util.function.DoubleSupplier;

/**
 * 确定性的伪随机数（mulberry32），与 server/test/ai/helpers.js 的 JS 版逐位一致。
 * 算法：Tommy Ettinger，2017，CC0 公有领域 https://gist.github.com/tommyettinger/46a874533244883189143505d203312c
 */
final class Mulberry32 implements DoubleSupplier {
  private int s;

  Mulberry32(int seed) {
    this.s = seed;
  }

  @Override
  public double getAsDouble() {
    s = s + 0x6d2b79f5;
    int t = (s ^ (s >>> 15)) * (1 | s);
    t = (t + ((t ^ (t >>> 7)) * (61 | t))) ^ t;
    return ((t ^ (t >>> 14)) & 0xFFFFFFFFL) / 4294967296.0;
  }

  /** 按顺序返回给定数组里的数（喂给 KaTrain 移植的 random.random() 序列）。 */
  static DoubleSupplier seq(double[] values) {
    int[] i = {0};
    return () -> values[i[0]++];
  }
}
