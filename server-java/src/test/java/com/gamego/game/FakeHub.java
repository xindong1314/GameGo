package com.gamego.game;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** 管理器单测用的假推送通道（对应 Node 测试的 createFakeHub）：记录所有推送；online 集合决定 isOnline。 */
public class FakeHub implements GamePush {

  public record Sent(long userId, String gameId, Map<String, Object> msg) {}

  public final Set<Long> online = new HashSet<>();
  public final List<Sent> sent = new ArrayList<>();

  @Override
  public void send(long userId, Map<String, Object> msg) {
    sent.add(new Sent(userId, null, msg));
  }

  @Override
  public void sendGame(long userId, String gameId, Map<String, Object> msg) {
    sent.add(new Sent(userId, gameId, msg));
  }

  @Override
  public boolean isOnline(long userId) {
    return online.contains(userId);
  }

  /** 某用户（null = 所有人）收到的某类推送。 */
  public List<Map<String, Object>> of(String t, Long userId) {
    List<Map<String, Object>> out = new ArrayList<>();
    for (Sent s : sent) {
      if (t.equals(s.msg().get("t")) && (userId == null || s.userId() == userId)) out.add(s.msg());
    }
    return out;
  }

  public List<Map<String, Object>> of(String t) {
    return of(t, null);
  }

  /** 最后一条。 */
  public Map<String, Object> last(String t, Long userId) {
    List<Map<String, Object>> l = of(t, userId);
    return l.isEmpty() ? null : l.get(l.size() - 1);
  }

  public List<String> types(Long userId) {
    List<String> out = new ArrayList<>();
    for (Sent s : sent) if (userId == null || s.userId() == userId) out.add((String) s.msg().get("t"));
    return out;
  }

  public void clear() {
    sent.clear();
  }
}
