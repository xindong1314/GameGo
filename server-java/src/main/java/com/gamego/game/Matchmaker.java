package com.gamego.game;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.LongSupplier;

/**
 * 快速匹配队列（移植自 Node 版 game/matchmaker.js）：每个路数一个先进先出队列，一个用户同时最多在一个队列里。
 * 只负责排队与配对；配对成功后由调用方（Lobby）创建排位对局。
 */
public class Matchmaker {

  /** join 的结果：pair 为配对成功的 [先排队者, 后排队者]，否则为 null。 */
  public record JoinResult(int size, long[] pair) {}

  private record Entry(int size, long joinedAt) {}

  private final LongSupplier now;
  private final Map<Integer, Deque<Long>> queues = new LinkedHashMap<>();
  private final Map<Long, Entry> entries = new HashMap<>();

  public Matchmaker(List<Integer> sizes, LongSupplier now) {
    this.now = now;
    for (int s : sizes) queues.put(s, new ArrayDeque<>());
  }

  public Matchmaker(LongSupplier now) {
    this(GameSettings.SIZES, now);
  }

  /** 加入 size 路的队列（已在别的队列里则先移出）。 */
  public JoinResult join(long userId, int size) {
    Deque<Long> queue = queues.get(size);
    if (queue == null) throw new IllegalArgumentException("不支持的路数 " + size);
    Entry cur = entries.get(userId);
    if (cur != null && cur.size() == size) return new JoinResult(size, null);
    if (cur != null) cancel(userId);
    queue.addLast(userId);
    entries.put(userId, new Entry(size, now.getAsLong()));
    return new JoinResult(size, tryPair(size));
  }

  private long[] tryPair(int size) {
    Deque<Long> queue = queues.get(size);
    if (queue.size() < 2) return null;
    long a = queue.pollFirst();
    long b = queue.pollFirst();
    entries.remove(a);
    entries.remove(b);
    return new long[] {a, b};
  }

  /** 退出队列；返回是否确实在队列中。 */
  public boolean cancel(long userId) {
    Entry cur = entries.remove(userId);
    if (cur == null) return false;
    queues.get(cur.size()).remove(userId);
    return true;
  }

  /** 配对后建局失败时，把先排队的人放回队首。 */
  public void requeueFront(long userId, int size) {
    Deque<Long> queue = queues.get(size);
    if (queue == null || entries.containsKey(userId)) return;
    queue.addFirst(userId);
    entries.put(userId, new Entry(size, now.getAsLong()));
  }

  /** { size } 或 null。 */
  public Map<String, Object> statusOf(long userId) {
    Entry cur = entries.get(userId);
    return cur != null ? Msg.of("size", cur.size()) : null;
  }

  public int queueLength(int size) {
    Deque<Long> queue = queues.get(size);
    return queue != null ? queue.size() : 0;
  }

  public void clear() {
    for (Deque<Long> q : queues.values()) q.clear();
    entries.clear();
  }
}
