package com.gamego.game;

import com.fasterxml.jackson.databind.JsonNode;
import com.gamego.config.TimeControl;
import com.gamego.db.GameRow;
import com.gamego.db.RankedStats;
import com.gamego.db.UnfinishedGame;
import com.gamego.db.User;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 内存里的 {@link GameStore}（对应 Node 测试的 memory-repos）：调用记录（calls）、
 * failOn(name) 让下一次该调用抛错、事务失败整体回滚、applyRanked 的 counted 防重。
 */
public class MemoryStore implements GameStore {

  public static final long DAY_MS = 86400000L;

  /** 一次调用。 */
  public record Call(String name, Object arg) {}

  /** 一局的可变记录。 */
  public static final class Row implements Cloneable {
    public String id;
    public String mode;
    public int size;
    public double komi;
    public Long blackId;
    public Long whiteId;
    public String aiLevel;
    public TimeControl timeControl;
    public String status = "playing";
    public List<Integer> moves = List.of();
    public JsonNode clocks;
    public List<Integer> dead;
    public Integer winner;
    public String reason;
    public Double scoreBlack;
    public Double scoreWhite;
    public String resultText;
    public boolean counted;
    public JsonNode state;
    public String cause;
    public long createdAt;
    public long updatedAt;
    public Long endedAt;

    GameRow toGameRow() {
      return new GameRow(id, mode, size, komi, blackId, whiteId, aiLevel, timeControl, status, List.copyOf(moves), clocks,
          dead == null ? null : List.copyOf(dead), winner, reason, scoreBlack, scoreWhite, resultText, counted, state, cause,
          createdAt, updatedAt, endedAt);
    }

    @Override
    public Row clone() {
      try {
        return (Row) super.clone();
      } catch (CloneNotSupportedException e) {
        throw new IllegalStateException(e);
      }
    }
  }

  /** 排位统计的可变记录。 */
  static final class Stats implements Cloneable {
    long games;
    long wins;
    long losses;
    long draws;
    long curStreak;
    long maxStreak;
    Long curStreakAt;
    Long maxStreakAt;

    @Override
    public Stats clone() {
      try {
        return (Stats) super.clone();
      } catch (CloneNotSupportedException e) {
        throw new IllegalStateException(e);
      }
    }
  }

  public final Map<String, Row> games = new LinkedHashMap<>();
  public final Map<Long, User> users = new LinkedHashMap<>();
  final Map<Long, Stats> statsMap = new HashMap<>();
  public final List<Call> calls = new ArrayList<>();
  private final Map<String, Integer> failures = new HashMap<>();
  private final Map<String, RuntimeException> failErrors = new HashMap<>();
  private long nextUserId = 1;
  /** RANKED_PAIR_DAILY_MAX（0 = 不限）。 */
  public int rankedPairDailyMax = 3;

  // ---------------------------------------------------------------- 测试辅助

  public User createUser(String openid, String nickname, String avatar, long now) {
    User u = new User(nextUserId++, openid, nickname == null ? "" : nickname, avatar == null ? "" : avatar, now, now);
    users.put(u.id(), u);
    return u;
  }

  /** 让下一次 name 调用抛错。 */
  public void failOn(String name) {
    failOn(name, 1, new IllegalStateException("模拟 " + name + " 失败"));
  }

  public void failOn(String name, int times, RuntimeException err) {
    failures.put(name, times);
    failErrors.put(name, err);
  }

  public List<Call> callsOf(String name) {
    List<Call> out = new ArrayList<>();
    for (Call c : calls) if (c.name().equals(name)) out.add(c);
    return out;
  }

  public Call lastCall(String name) {
    List<Call> l = callsOf(name);
    return l.isEmpty() ? null : l.get(l.size() - 1);
  }

  public Row row(String id) {
    return games.get(id);
  }

  /** 直接放入一条记录（测试损坏数据等）。 */
  public void putRow(Row r) {
    games.put(r.id, r);
  }

  private void track(String name, Object arg) {
    calls.add(new Call(name, arg));
    Integer n = failures.get(name);
    if (n != null && n > 0) {
      if (n == 1) failures.remove(name);
      else failures.put(name, n - 1);
      throw failErrors.get(name);
    }
  }

  // ---------------------------------------------------------------- GameStore

  @Override
  public void insert(GameSession.InsertRow r) {
    track("games.insert", r);
    if (games.containsKey(r.id())) throw new IllegalStateException("games.insert: id 重复");
    Row row = new Row();
    row.id = r.id();
    row.mode = r.mode();
    row.size = r.size();
    row.komi = r.komi();
    row.blackId = r.blackId();
    row.whiteId = r.whiteId();
    row.aiLevel = r.aiLevel();
    row.timeControl = r.timeControl();
    row.status = r.status();
    row.moves = List.copyOf(r.moves());
    row.clocks = r.clocks() == null ? null : Json.tree(r.clocks());
    row.createdAt = r.createdAt();
    row.updatedAt = r.updatedAt();
    games.put(row.id, row);
  }

  @Override
  public void saveProgress(String id, GameSession.Progress p, long now) {
    track("games.saveProgress", p);
    Row row = games.get(id);
    if (row == null || "ended".equals(row.status)) return;
    row.status = p.status();
    row.moves = List.copyOf(p.moves());
    row.clocks = p.clocks() == null ? null : Json.tree(p.clocks());
    row.state = p.state() == null ? null : Json.tree(p.state());
    row.updatedAt = now;
  }

  @Override
  public GameRow findById(String id) {
    track("games.findById", id);
    Row row = games.get(id);
    return row == null ? null : row.toGameRow();
  }

  @Override
  public List<UnfinishedGame> listUnfinished() {
    track("games.listUnfinished", null);
    List<Row> rows = new ArrayList<>();
    for (Row r : games.values()) if (!"ended".equals(r.status)) rows.add(r);
    rows.sort(Comparator.comparingLong(r -> r.createdAt));
    List<UnfinishedGame> out = new ArrayList<>();
    for (Row r : rows) out.add(new UnfinishedGame(r.id, r.toGameRow(), null));
    return out;
  }

  @Override
  public boolean discard(String id) {
    track("games.discard", id);
    Row row = games.get(id);
    if (row == null || "ended".equals(row.status)) return false;
    games.remove(id);
    return true;
  }

  @Override
  public void finish(String id, GameSession.FinishFields f, RankedApply ranked, long now) {
    track("transaction", null);
    Map<String, Row> gamesBefore = new LinkedHashMap<>();
    for (Map.Entry<String, Row> e : games.entrySet()) gamesBefore.put(e.getKey(), e.getValue().clone());
    Map<Long, Stats> statsBefore = new HashMap<>();
    for (Map.Entry<Long, Stats> e : statsMap.entrySet()) statsBefore.put(e.getKey(), e.getValue().clone());
    try {
      track("games.finish", f);
      Row row = games.get(id);
      if (row != null && !"ended".equals(row.status)) {
        row.status = "ended";
        if (f.moves() != null) row.moves = List.copyOf(f.moves());
        row.dead = f.dead() == null ? null : List.copyOf(f.dead());
        row.winner = f.winner();
        row.reason = f.reason();
        row.scoreBlack = f.scoreBlack();
        row.scoreWhite = f.scoreWhite();
        row.resultText = f.resultText();
        row.cause = f.cause();
        row.state = null;
        row.updatedAt = now;
        row.endedAt = now;
      }
      if (ranked != null) {
        track("stats.applyRanked", ranked);
        applyRanked(ranked, now);
      }
    } catch (RuntimeException err) {
      games.clear();
      games.putAll(gamesBefore);
      statsMap.clear();
      statsMap.putAll(statsBefore);
      throw err;
    }
  }

  private void applyRanked(RankedApply r, long now) {
    Row game = games.get(r.gameId());
    if (game == null) throw new IllegalStateException("stats.applyRanked: 对局不存在");
    if (!"ranked".equals(game.mode)) throw new IllegalStateException("stats.applyRanked: 不是排位赛");
    if (game.counted) return;
    game.counted = true;
    if (r.draw()) {
      for (long uid : r.userIds()) {
        Stats s = statsMap.computeIfAbsent(uid, k -> new Stats());
        s.games += 1;
        s.draws += 1;
      }
      return;
    }
    Stats w = statsMap.computeIfAbsent(r.winnerId(), k -> new Stats());
    w.games += 1;
    w.wins += 1;
    w.curStreak += 1;
    w.curStreakAt = now;
    if (w.curStreak > w.maxStreak) {
      w.maxStreak = w.curStreak;
      w.maxStreakAt = now;
    }
    Stats l = statsMap.computeIfAbsent(r.loserId(), k -> new Stats());
    l.games += 1;
    l.losses += 1;
    l.curStreak = 0;
    l.curStreakAt = null;
  }

  @Override
  public boolean pairLimitReached(long a, long b, long now) {
    track("games.countCountedBetween", null);
    if (rankedPairDailyMax <= 0) return false;
    long since = now - DAY_MS;
    int n = 0;
    for (Row r : games.values()) {
      if (!"ranked".equals(r.mode) || !r.counted || r.createdAt < since) continue;
      boolean pair = (Long.valueOf(a).equals(r.blackId) && Long.valueOf(b).equals(r.whiteId))
          || (Long.valueOf(b).equals(r.blackId) && Long.valueOf(a).equals(r.whiteId));
      if (pair) n += 1;
    }
    return n >= rankedPairDailyMax;
  }

  @Override
  public RankedStats stats(long userId) {
    track("stats.get", userId);
    Stats s = statsMap.get(userId);
    if (s == null) return RankedStats.empty();
    return new RankedStats(s.games, s.wins, s.losses, s.draws, s.games > 0 ? (double) s.wins / s.games : 0, s.curStreak,
        s.maxStreak, s.curStreakAt, s.maxStreakAt);
  }

  @Override
  public User findUser(long userId) {
    track("users.findById", userId);
    return users.get(userId);
  }

  public int statsCount() {
    return statsMap.size();
  }
}
