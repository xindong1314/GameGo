package com.gamego.db;

import com.fasterxml.jackson.databind.JsonNode;
import com.gamego.config.TimeControl;
import com.gamego.db.mapper.DbRows.CountRow;
import com.gamego.db.mapper.DbRows.GameDbRow;
import com.gamego.db.mapper.GameMapper;
import java.time.Clock;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.stereotype.Repository;

/** 对局仓储（设计文档 3.1 games）。 */
@Repository
public class GameRepository {

  public static final Pattern GAME_ID_RE = Pattern.compile("^[A-Za-z0-9_-]{1,64}$");
  /** 终局细分原因（games.cause）：小写字母与下划线。 */
  public static final Pattern CAUSE_RE = Pattern.compile("^[a-z_]{1,32}$");

  static final Set<String> GAME_MODES = Set.of("ranked", "friend", "ai");
  static final Set<String> GAME_STATUSES = Set.of("playing", "scoring", "ended");
  static final Set<String> END_REASONS = Set.of("score", "resign", "timeout", "abort");
  static final int MAX_LIST_LIMIT = 100;

  /** 人机战绩（作废的对局不算）。 */
  public record AiRecord(long games, long wins) {}

  private final GameMapper mapper;
  private final JsonCodec json;
  private final Clock clock;

  public GameRepository(GameMapper mapper, JsonCodec json, Clock clock) {
    this.mapper = mapper;
    this.json = json;
    this.clock = clock;
  }

  // ---------------------------------------------------------------- 行映射

  /** 某个 JSON 列损坏（strict 模式下）。 */
  static final class CorruptJson extends RuntimeException {
    CorruptJson(String msg) {
      super(msg);
    }
  }

  private interface Parser<T> {
    T parse(String text) throws Exception;
  }

  private <T> T parseField(GameDbRow row, String field, String text, T fallback, boolean lenient, Parser<T> p) {
    if (text == null) return fallback;
    try {
      T v = p.parse(text);
      return v == null ? fallback : v;
    } catch (Exception e) {
      if (lenient) return fallback;
      throw new CorruptJson("games." + field + " 的 JSON 已损坏（对局 " + row.id + "）：" + e.getMessage());
    }
  }

  /** lenient：损坏的 JSON 字段按空值返回（查看棋谱、列表等只读场景，一条坏记录不能让整个接口失败）。 */
  GameRow toGame(GameDbRow r, boolean lenient) {
    if (r == null) return null;
    TimeControl tc = parseField(r, "time_control", r.timeControl, null, lenient, json::parseTimeControl);
    List<Integer> moves = parseField(r, "moves", r.moves, List.of(), lenient, json::parseIntList);
    JsonNode clocks = parseField(r, "clocks", r.clocks, null, lenient, json::parseTree);
    List<Integer> dead = parseField(r, "dead", r.dead, null, lenient, json::parseIntList);
    // 附加状态坏了不影响读取与恢复（只是少了继续对局次数/保护），一律按 null
    JsonNode state = parseField(r, "state", r.state, null, true, json::parseTree);
    return new GameRow(
        r.id,
        r.mode,
        r.size,
        r.komi,
        r.blackId,
        r.whiteId,
        r.aiLevel,
        tc,
        r.status,
        List.copyOf(moves),
        clocks,
        dead == null ? null : List.copyOf(dead),
        r.winner,
        r.reason,
        r.scoreBlack,
        r.scoreWhite,
        r.resultText,
        r.counted != null && r.counted != 0,
        state,
        r.cause,
        r.createdAt,
        r.updatedAt,
        r.endedAt);
  }

  // ---------------------------------------------------------------- 写

  /** 插入一局并返回插入后的记录。参数不合法抛 IllegalArgumentException，id 重复抛 DuplicateKeyException。 */
  public GameRow insert(NewGame g) {
    String fn = "games.insert";
    if (g == null) throw new IllegalArgumentException(fn + ": 需要对象");
    if (g.id == null || !GAME_ID_RE.matcher(g.id).matches()) throw new IllegalArgumentException(fn + ": id 不合法");
    if (!GAME_MODES.contains(g.mode)) throw new IllegalArgumentException(fn + ": mode 必须是 ranked/friend/ai");
    if (g.size == null || g.size < 2 || g.size > 19) throw new IllegalArgumentException(fn + ": size 不合法");
    if (g.komi == null || !Double.isFinite(g.komi)) throw new IllegalArgumentException(fn + ": komi 不合法");
    if (g.blackId != null) Checks.userId(g.blackId, fn, "blackId");
    if (g.whiteId != null) Checks.userId(g.whiteId, fn, "whiteId");
    if (g.mode.equals("ai")) {
      if ((g.blackId == null) == (g.whiteId == null)) {
        throw new IllegalArgumentException(fn + ": 人机对局必须恰好一方为 AI（id 为 null）");
      }
      if (g.aiLevel == null || g.aiLevel.isEmpty()) throw new IllegalArgumentException(fn + ": 人机对局需要 aiLevel");
    } else {
      if (g.blackId == null || g.whiteId == null) throw new IllegalArgumentException(fn + ": 真人对局需要 blackId 与 whiteId");
      if (g.blackId.equals(g.whiteId)) throw new IllegalArgumentException(fn + ": 黑白不能是同一人");
    }
    String status = g.status == null ? "playing" : g.status;
    if (!GAME_STATUSES.contains(status)) throw new IllegalArgumentException(fn + ": status 不合法");
    List<Integer> moves = g.moves == null ? List.of() : g.moves;
    Checks.moves(moves, fn);
    if (g.dead != null) Checks.idxArray(g.dead, fn, "dead");
    if (g.winner != null && (g.winner < 0 || g.winner > 2)) throw new IllegalArgumentException(fn + ": winner 必须是 0/1/2");
    if (g.reason != null && !END_REASONS.contains(g.reason)) throw new IllegalArgumentException(fn + ": reason 不合法");
    if (g.cause != null && !CAUSE_RE.matcher(g.cause).matches()) throw new IllegalArgumentException(fn + ": cause 不合法");
    long createdAt = g.createdAt == null ? clock.millis() : g.createdAt;

    GameDbRow r = new GameDbRow();
    r.id = g.id;
    r.mode = g.mode;
    r.size = g.size;
    r.komi = g.komi;
    r.blackId = g.blackId;
    r.whiteId = g.whiteId;
    r.aiLevel = g.aiLevel;
    r.timeControl = json.toJsonOrNull(g.timeControl);
    r.status = status;
    r.moves = json.toJsonOrNull(moves);
    r.clocks = json.toJsonOrNull(g.clocks);
    r.dead = json.toJsonOrNull(g.dead);
    r.winner = g.winner;
    r.reason = g.reason;
    r.scoreBlack = g.scoreBlack;
    r.scoreWhite = g.scoreWhite;
    r.resultText = g.resultText;
    r.counted = g.counted ? 1 : 0;
    r.createdAt = createdAt;
    r.updatedAt = g.updatedAt == null ? createdAt : g.updatedAt;
    r.endedAt = g.endedAt;
    r.state = json.toJsonOrNull(g.state);
    r.cause = g.cause;
    mapper.insert(r);
    return findById(g.id);
  }

  /**
   * 进行中的对局每一手后保存（只更新 p 里给出的字段）。已结束的对局不会被改回；返回是否更新了一行。
   */
  public boolean saveProgress(String id, GameProgress p, long now) {
    String fn = "games.saveProgress";
    if (id == null) throw new IllegalArgumentException(fn + ": id 必须是字符串");
    GameProgress q = p == null ? GameProgress.of() : p;
    Map<String, Object> m = new HashMap<>();
    m.put("id", id);
    m.put("now", now);
    m.put("setStatus", q.statusSet);
    m.put("setMoves", q.movesSet);
    m.put("setClocks", q.clocksSet);
    m.put("setState", q.stateSet);
    if (q.statusSet) {
      if (!"playing".equals(q.status) && !"scoring".equals(q.status)) {
        throw new IllegalArgumentException(fn + ": status 只能是 playing/scoring（终局请用 games.finish）");
      }
      m.put("status", q.status);
    }
    if (q.movesSet) {
      Checks.moves(q.moves, fn);
      m.put("moves", json.toJsonOrNull(q.moves));
    }
    if (q.clocksSet) m.put("clocks", json.toJsonOrNull(q.clocks));
    if (q.stateSet) m.put("state", json.toJsonOrNull(q.state));
    return mapper.saveProgress(m) > 0;
  }

  /**
   * 终局。已结束的对局不会被再次修改（返回 false）。不写 counted（只由 {@link StatsRepository#applyRanked} 置 1），
   * 同时清空 state；resultText 省略时按引擎规则生成。
   */
  public boolean finish(String id, GameFinish f, long now) {
    String fn = "games.finish";
    if (id == null) throw new IllegalArgumentException(fn + ": id 必须是字符串");
    if (f == null) throw new IllegalArgumentException(fn + ": 需要终局字段");
    if (f.winner < 0 || f.winner > 2) throw new IllegalArgumentException(fn + ": winner 必须是 0/1/2");
    if (!END_REASONS.contains(f.reason)) throw new IllegalArgumentException(fn + ": reason 必须是 score/resign/timeout/abort");
    if (f.cause != null && !CAUSE_RE.matcher(f.cause).matches()) throw new IllegalArgumentException(fn + ": cause 不合法");
    if (f.scoreBlack != null && !Double.isFinite(f.scoreBlack)) throw new IllegalArgumentException(fn + ": scoreBlack 必须是数字或 null");
    if (f.scoreWhite != null && !Double.isFinite(f.scoreWhite)) throw new IllegalArgumentException(fn + ": scoreWhite 必须是数字或 null");
    String text = f.resultText != null ? f.resultText : ResultTexts.resultText(f.winner, f.reason, f.scoreBlack, f.scoreWhite);
    Map<String, Object> m = new HashMap<>();
    m.put("id", id);
    m.put("now", now);
    m.put("winner", f.winner);
    m.put("reason", f.reason);
    m.put("scoreBlack", f.scoreBlack);
    m.put("scoreWhite", f.scoreWhite);
    m.put("resultText", text);
    m.put("cause", f.cause);
    m.put("setMoves", f.movesSet);
    m.put("setDead", f.deadSet);
    if (f.movesSet) {
      Checks.moves(f.moves, fn);
      m.put("moves", json.toJsonOrNull(f.moves));
    }
    if (f.deadSet) {
      if (f.dead != null) Checks.idxArray(f.dead, fn, "dead");
      m.put("dead", json.toJsonOrNull(f.dead));
    }
    return mapper.finish(m) > 0;
  }

  /** 删除一局未结束的对局（玩家还没下过子就被新开局顶替的人机对局）。已结束的不删；返回是否删除。 */
  public boolean discard(String id) {
    if (id == null || !GAME_ID_RE.matcher(id).matches()) return false;
    return mapper.discard(id) > 0;
  }

  // ---------------------------------------------------------------- 读

  /** 只读查看：JSON 损坏的字段按空值返回，不抛错；id 不合法或不存在返回 null。 */
  public GameRow findById(String id) {
    if (id == null || !GAME_ID_RE.matcher(id).matches()) return null;
    return toGame(mapper.findById(id), true);
  }

  /**
   * 某用户参与的已结束对局，按 created_at 倒序；before 为游标（只返回 created_at &lt; before 的，null 表示不限），
   * limit 默认 20、截断到 [1, 101]。执黑、执白两路各走索引取前 N 条再合并。
   */
  public List<GameRow> listByUser(long userId, Long before, Integer limit) {
    Checks.userId(userId, "games.listByUser", "userId");
    long cursor = before == null ? Long.MAX_VALUE : before;
    int n = limit == null ? 20 : Math.min(Math.max(limit, 1), MAX_LIST_LIMIT + 1);
    List<GameDbRow> rows = new ArrayList<>(mapper.listEndedAsBlack(userId, cursor, n));
    rows.addAll(mapper.listEndedAsWhite(userId, cursor, n));
    rows.sort(
        Comparator.comparing((GameDbRow r) -> r.createdAt).reversed().thenComparing((GameDbRow r) -> r.id, Comparator.reverseOrder()));
    List<GameRow> out = new ArrayList<>();
    for (GameDbRow r : rows) {
      if (out.size() >= n) break;
      out.add(toGame(r, true));
    }
    return out;
  }

  /**
   * 未结束的对局（重启恢复用），按 created_at 升序。解析不了的行不抛错，返回 broken 项，由恢复逻辑作废。
   */
  public List<UnfinishedGame> listUnfinished() {
    List<UnfinishedGame> out = new ArrayList<>();
    for (GameDbRow r : mapper.listUnfinished()) {
      try {
        out.add(new UnfinishedGame(r.id, toGame(r, false), null));
      } catch (RuntimeException e) {
        out.add(new UnfinishedGame(r.id, null, e.getMessage()));
      }
    }
    return out;
  }

  /** 最近（created_at >= since）两人之间已计入排行的排位赛局数（不分黑白），同一对手每日计入上限用（6.6）。 */
  public long countCountedBetween(long a, long b, long since) {
    Checks.userId(a, "games.countCountedBetween", "a");
    Checks.userId(b, "games.countCountedBetween", "b");
    return mapper.countCountedPair(a, b, since) + mapper.countCountedPair(b, a, since);
  }

  /** 人机战绩（作废的对局不算）。 */
  public AiRecord aiRecord(long userId) {
    Checks.userId(userId, "games.aiRecord", "userId");
    CountRow b = mapper.aiRecordAsBlack(userId);
    CountRow w = mapper.aiRecordAsWhite(userId);
    long games = nz(b == null ? null : b.games) + nz(w == null ? null : w.games);
    long wins = nz(b == null ? null : b.wins) + nz(w == null ? null : w.wins);
    return new AiRecord(games, wins);
  }

  private static long nz(Long v) {
    return v == null ? 0 : v;
  }
}
