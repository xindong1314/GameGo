package com.gamego.ai;

import static com.gamego.ai.AiCommon.BLACK;
import static com.gamego.ai.AiCommon.JSON;
import static com.gamego.ai.AiCommon.PASS;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.function.DoubleSupplier;
import java.util.function.LongSupplier;

/**
 * 基于 KataGo 分析引擎的 AiService（移植自 server/src/ai/service.js 的 createKataGoAiService，行为见设计文档第 7 节）。
 *
 * <ul>
 *   <li>rank / policy 档：1 次评估取 policy，按 KaTrain 策略选点（{@link RankStrategy}），本项目引擎校验合法性；
 *   <li>最强档：300 次搜索（friendlyPassOk:false），取 order 最小的合法着手；
 *   <li>人刚 pass：100 次搜索的终局检查（第一选点是 pass，或局面已定 → 也 pass）；
 *   <li>认输：AI 视角胜率 &lt; 2%、落后超过阈值、手数 &gt; 路数² × 0.4；rank / policy 档还要搜索核实；
 *   <li>judgeDead：200 次搜索的 ownership，按块取平均，本方视角 &lt;= -0.5 整块判死。
 * </ul>
 *
 * 每个请求在内部线程池里以阻塞方式编排（KataGo 请求本身是异步的），返回的 future 以 {@link AiException} 失败。
 */
public class KataGoAiService implements AiService {
  /** friendlyPassOk:false 的中国规则：与 'chinese' 预设的计分和合法性相同，但 AI 会先提净死子再 pass（7.4）。 */
  public static ObjectNode rulesNoFriendlyPass() {
    ObjectNode r = JSON.createObjectNode();
    r.put("ko", "SIMPLE");
    r.put("scoring", "AREA");
    r.put("tax", "NONE");
    r.put("suicide", false);
    r.put("hasButton", false);
    r.put("whiteHandicapBonus", "0");
    r.put("friendlyPassOk", false);
    return r;
  }

  // 认输：AI 视角胜率 < 2%，落后超过下列目数，且总手数 > 路数² × 0.4（7.5）。
  // rank / policy 档的 1 次评估满足条件时，还要 100 次搜索（终局检查同款）也满足才认输。
  public static final double RESIGN_WINRATE = 0.02;
  public static final double RESIGN_MIN_MOVE_FRACTION = 0.4;

  public static double resignLead(int size) {
    return switch (size) {
      case 9 -> 8;
      case 13 -> 15;
      case 19 -> 25;
      default -> Double.NaN;
    };
  }

  static final int MAX_REPICKS = 5; // 选出的点不合法时置 -1 重选的次数
  // 人刚 pass 时：假设现在就数子（死子按这次搜索的归属判定，与 judgeDead 同一规则），AI 的目差比继续下的预期
  // 少不到这么多 → 局面已定，AI 也 pass。见 settledForPass。
  static final double SETTLED_MARGIN = 1;
  static final int END_CHECK_VISITS = 100; // 人停一手后的"终局检查"；rank / policy 档认输前的核实搜索也用它
  static final int JUDGE_VISITS = 200;

  // 各类请求的超时（毫秒）；KataGo 内部排队的时间也算在内
  static final long TIMEOUT_POLICY = 15000;
  static final long TIMEOUT_END_CHECK = 20000;
  static final long TIMEOUT_SEARCH_EXTRA = 15000; // 搜索档：maxTime + 这么多

  // KataGo 请求优先级：1 次评估的请求插到长搜索前面
  static final int PRIORITY_POLICY = 10;
  static final int PRIORITY_END_CHECK = 5;
  static final int PRIORITY_JUDGE = 5;
  static final int PRIORITY_SEARCH = 0;

  private final AnalysisEngine engine;
  private final AiLog log;
  private final DoubleSupplier rng;
  private final AiCommon.Sleeper sleeper;
  private final LongSupplier now;
  private final long minThinkMs;
  private final long judgeTimeoutMs;
  private final ExecutorService executor = AiCommon.daemonPool("ai-katago-");
  private volatile boolean closed;

  /** 构造参数。 */
  public static final class Builder {
    private final AnalysisEngine engine;
    private AiLog log = AiLog.slf4j(KataGoAiService.class);
    private DoubleSupplier rng = () -> ThreadLocalRandom.current().nextDouble();
    private AiCommon.Sleeper sleeper = AiCommon.Sleeper.REAL;
    private LongSupplier now = System::currentTimeMillis;
    private Long minThinkMs;
    private Long judgeTimeoutMs;

    public Builder(AnalysisEngine engine) {
      this.engine = Objects.requireNonNull(engine, "engine");
    }

    public Builder log(AiLog v) {
      log = v == null ? AiLog.SILENT : v;
      return this;
    }

    public Builder rng(DoubleSupplier v) {
      rng = Objects.requireNonNull(v);
      return this;
    }

    public Builder sleeper(AiCommon.Sleeper v) {
      sleeper = Objects.requireNonNull(v);
      return this;
    }

    public Builder clock(LongSupplier v) {
      now = Objects.requireNonNull(v);
      return this;
    }

    /** AI 落子的最短间隔（默认 600ms，null 表示默认）。 */
    public Builder minThinkMs(Long v) {
      minThinkMs = v;
      return this;
    }

    /** 数子阶段等待死子判断的总时间（默认 15000ms）；KataGo 请求的超时为它减 1 秒（至少 1 秒）。 */
    public Builder judgeTimeoutMs(Long v) {
      judgeTimeoutMs = v;
      return this;
    }

    public KataGoAiService build() {
      return new KataGoAiService(this);
    }
  }

  public static Builder builder(AnalysisEngine engine) {
    return new Builder(engine);
  }

  private KataGoAiService(Builder b) {
    this.engine = b.engine;
    this.log = b.log;
    this.rng = b.rng;
    this.sleeper = b.sleeper;
    this.now = b.now;
    this.minThinkMs = AiCommon.resolveMinThinkMs(b.minThinkMs);
    long jt = b.judgeTimeoutMs == null || b.judgeTimeoutMs <= 0 ? 15000 : b.judgeTimeoutMs;
    this.judgeTimeoutMs = Math.max(1000, jt - 1000);
  }

  /** 底层分析引擎（真实 KataGo 时为 {@link KataGoEngine}）。 */
  public AnalysisEngine engine() {
    return engine;
  }

  @Override
  public String kind() {
    return "katago";
  }

  @Override
  public boolean available() {
    return !closed && engine.available();
  }

  @Override
  public List<AiLevel> levels() {
    return Levels.publicLevels();
  }

  @Override
  public CompletableFuture<AiMove> chooseMove(AiMoveRequest req) {
    return AiCommon.async(
        executor,
        () -> {
          long startedAt = now.getAsLong();
          AiCommon.Parsed p = AiCommon.parseMoveRequest(req, Levels.LEVEL_IDS);
          ensureAvailable();
          Levels.Level level = Levels.get(p.level());
          AiMove out = Levels.KIND_SEARCH.equals(level.kind()) ? searchMove(p, level) : policyMove(p, level);
          AiCommon.waitMinThink(startedAt, minThinkMs, now, sleeper);
          return out;
        });
  }

  @Override
  public CompletableFuture<DeadResult> judgeDead(int size, double komi, int[] moves) {
    return AiCommon.async(
        executor,
        () -> {
          AiCommon.Position p = AiCommon.parseBoardRequest(size, komi, moves);
          ensureAvailable();
          ObjectNode q = base(p.size(), p.komi(), p.moves());
          q.put("rules", "chinese");
          q.put("maxVisits", JUDGE_VISITS);
          q.put("includeOwnership", true);
          q.put("priority", PRIORITY_JUDGE);
          q.putObject("overrideSettings").put("maxTime", 8).put("reportAnalysisWinratesAs", "BLACK");
          JsonNode res = AiCommon.await(engine.query(q, judgeTimeoutMs));
          double[] own = AiCommon.validOwnership(res == null ? null : res.get("ownership"), p.size() * p.size());
          if (own == null) throw new AiException(AiException.KATAGO_ERROR, "KataGo 返回的 ownership 格式不对");
          return new DeadResult(AiCommon.deadFromOwnership(p.state().board, own), DeadResult.SOURCE_KATAGO);
        });
  }

  @Override
  public void shutdown() {
    closed = true;
    try {
      engine.shutdown().get(30, TimeUnit.SECONDS);
    } catch (Exception e) {
      log.warn("关闭 KataGo 时出错：" + AiException.unwrap(e));
    } finally {
      executor.shutdown();
    }
  }

  // ---------------------------------------------------------------------------------------------

  static boolean shouldResign(AiMoveInfo info, int size, int moveCount) {
    if (info == null) return false;
    return info.winrate() < RESIGN_WINRATE
        && info.scoreLead() < -resignLead(size)
        && moveCount > size * size * RESIGN_MIN_MOVE_FRACTION;
  }

  private void ensureAvailable() {
    if (closed) throw AiException.unavailable("AI 已关闭");
    if (!engine.available()) throw AiException.unavailable("KataGo 不可用");
  }

  private static ObjectNode base(int size, double komi, int[] moves) {
    ObjectNode q = JSON.createObjectNode();
    q.put("boardXSize", size);
    q.put("boardYSize", size);
    q.put("komi", komi);
    q.set("moves", AiCommon.toKataMoves(moves, size));
    return q;
  }

  private static ObjectNode base(AiCommon.Parsed p) {
    return base(p.size(), p.komi(), p.moves());
  }

  private static double[] checkPolicy(JsonNode res, int size) {
    JsonNode pol = res == null ? null : res.get("policy");
    int n = size * size + 1;
    if (pol == null || !pol.isArray() || pol.size() != n) {
      throw new AiException(AiException.KATAGO_ERROR, "KataGo 返回的 policy 格式不对");
    }
    double[] out = new double[n];
    for (int i = 0; i < n; i++) {
      double v = AiCommon.num(pol.get(i));
      if (Double.isNaN(v)) throw new AiException(AiException.KATAGO_ERROR, "KataGo 返回的 policy 格式不对");
      out[i] = v;
    }
    return out;
  }

  /** moveInfos 里 move 为字符串的项，按 order 升序（稳定排序）。 */
  static List<JsonNode> topMoveInfo(JsonNode res) {
    List<JsonNode> infos = new ArrayList<>();
    JsonNode arr = res == null ? null : res.get("moveInfos");
    if (arr != null && arr.isArray()) {
      for (JsonNode m : arr) if (m != null && m.isObject() && m.path("move").isTextual()) infos.add(m);
    }
    infos.sort((a, b) -> Double.compare(orderOf(a), orderOf(b)));
    return infos;
  }

  private static double orderOf(JsonNode m) {
    double v = AiCommon.num(m.get("order"));
    return Double.isNaN(v) ? 0 : v;
  }

  /**
   * 人刚 pass 时判断局面是否已定（res 为带 includeOwnership 的搜索结果）。 friendlyPassOk:false 规则下 KataGo 按 Tromp-Taylor
   * 评价 pass（死子不提就算活子），所以对方死子还留在 AI 地里时它总要先把死子一颗颗提干净才肯 pass。 而本项目数子阶段会按归属判死
   * （judgeDead），这些死子不提也不影响结果。所以：假设现在就终局、死子按这次搜索的归属判定，算出 AI 视角的目差；
   * 它不比继续下的预期（第一选点的 scoreLead）少 SETTLED_MARGIN 目以上 → 已定。
   */
  private static boolean settledForPass(AiCommon.Parsed p, JsonNode res) {
    double[] own = AiCommon.validOwnership(res == null ? null : res.get("ownership"), p.size() * p.size());
    if (own == null) return false;
    List<JsonNode> top = topMoveInfo(res);
    double blackLead = top.isEmpty() ? Double.NaN : AiCommon.num(top.get(0).get("scoreLead"));
    if (Double.isNaN(blackLead)) blackLead = AiCommon.num(res.path("rootInfo").get("scoreLead"));
    if (Double.isNaN(blackLead)) return false;
    double expected = p.color() == BLACK ? blackLead : 0.0 - blackLead;
    return AiCommon.areaMarginIfEnded(p.board(), p.komi(), own, p.color()) >= expected - SETTLED_MARGIN;
  }

  /**
   * 用 pick(policy) 选点，交给本项目引擎校验；不合法就把该点置 -1 重选，最多重选 MAX_REPICKS 次，
   * 仍不行则下 policy 最高的合法点，都没有就 pass。
   */
  private int pickLegal(AiCommon.Parsed p, double[] policy, java.util.function.ToIntFunction<double[]> pick) {
    double[] pol = policy.clone();
    for (int attempt = 0; attempt <= MAX_REPICKS; attempt++) {
      int mv = pick.applyAsInt(pol);
      if (mv == PASS) return PASS;
      if (AiCommon.isLegal(p.state(), p.color(), mv)) return mv;
      log.debug("AI 选出的着手 " + mv + " 不合法，重选");
      if (mv >= 0 && mv < pol.length - 1) pol[mv] = -1;
    }
    return bestLegalByPolicy(p, pol);
  }

  private static int bestLegalByPolicy(AiCommon.Parsed p, double[] policy) {
    int n = p.size() * p.size();
    List<Integer> order = new ArrayList<>();
    for (int i = 0; i < n; i++) if (policy[i] > 0) order.add(i);
    order.sort(
        (a, b) -> {
          int c = Double.compare(policy[b], policy[a]);
          return c != 0 ? c : Integer.compare(a, b);
        });
    for (int i : order) if (AiCommon.isLegal(p.state(), p.color(), i)) return i;
    return PASS;
  }

  private record EndCheck(boolean passTop, boolean shouldPass, AiMoveInfo info) {}

  /**
   * 人停一手后的终局检查：100 次搜索（friendlyPassOk:false）。第一选点是 pass，或局面已定（settledForPass），则 AI 也 pass。
   * rank / policy 档认输前的核实也用它（见 confirmResign）。
   */
  private EndCheck endCheck(AiCommon.Parsed p) {
    ObjectNode q = base(p);
    q.set("rules", rulesNoFriendlyPass());
    q.put("maxVisits", END_CHECK_VISITS);
    q.put("includeOwnership", true);
    q.put("priority", PRIORITY_END_CHECK);
    q.putObject("overrideSettings")
        .put("maxTime", 5)
        .put("conservativePass", false)
        .put("wideRootNoise", 0)
        .put("reportAnalysisWinratesAs", "BLACK");
    JsonNode res = AiCommon.await(engine.query(q, TIMEOUT_END_CHECK));
    List<JsonNode> top = topMoveInfo(res);
    boolean passTop =
        !top.isEmpty() && Integer.valueOf(PASS).equals(AiCommon.parseKataMove(top.get(0).get("move").asText(), p.size()));
    boolean shouldPass = passTop || (p.humanJustPassed() && settledForPass(p, res));
    return new EndCheck(passTop, shouldPass, AiCommon.infoForColor(res == null ? null : res.get("rootInfo"), p.color()));
  }

  private record Confirmed(boolean resign, AiMoveInfo info) {}

  /**
   * 1 次评估（神经网络的直接判断）说该认输时，先用一次搜索核实（本步已经做过终局检查就直接用它的结果）。
   * 对杀、大块死活未定的局面里 1 次评估可能严重误判：实测 19 路出现过 1 次评估判 AI 胜率 1%、落后 33 目，
   * 300 次搜索却是胜率 97%、领先 43 目的局面——不核实的话 AI 会认输一盘赢棋。核实用的搜索失败时不认输。
   */
  private Confirmed confirmResign(AiCommon.Parsed p, EndCheck searched) {
    EndCheck check = searched;
    if (check == null) {
      try {
        check = endCheck(p);
      } catch (RuntimeException err) {
        log.warn("认输前的核实搜索失败，这一步先不认输：" + err.getMessage());
        return new Confirmed(false, null);
      }
    }
    boolean resign = shouldResign(check.info(), p.size(), p.moves().length);
    if (!resign) {
      AiMoveInfo i = check.info();
      log.info(
          "1 次评估判断应认输，但搜索不支持（AI 视角胜率 "
              + (i != null ? String.format("%.3f", i.winrate()) : "?")
              + "、目差 "
              + (i != null ? String.format("%.1f", i.scoreLead()) : "?")
              + "），继续下");
    }
    return new Confirmed(resign, check.info());
  }

  /** rank / policy 档：1 次评估取 policy，按 KaTrain 策略选点。 */
  private AiMove policyMove(AiCommon.Parsed p, Levels.Level level) {
    EndCheck searched = null; // 本步已做的终局检查（100 次搜索）
    if (p.humanJustPassed()) {
      EndCheck check = endCheck(p);
      if (check.shouldPass()) {
        return new AiMove(PASS, shouldResign(check.info(), p.size(), p.moves().length), check.info());
      }
      searched = check;
    }
    ObjectNode q = base(p);
    q.put("rules", "chinese");
    q.put("maxVisits", 1);
    q.put("includePolicy", true);
    q.put("priority", PRIORITY_POLICY);
    q.putObject("overrideSettings").put("reportAnalysisWinratesAs", "BLACK");
    JsonNode res = AiCommon.await(engine.query(q, TIMEOUT_POLICY));
    double[] policy = checkPolicy(res, p.size());
    AiMoveInfo info = AiCommon.infoForColor(res.get("rootInfo"), p.color());
    if (shouldResign(info, p.size(), p.moves().length)) {
      Confirmed confirmed = confirmResign(p, searched);
      if (confirmed.resign()) return new AiMove(PASS, true, confirmed.info());
      if (confirmed.info() != null) info = confirmed.info(); // 搜索的判断比 1 次评估准
    }
    java.util.function.ToIntFunction<double[]> pick;
    if (Levels.KIND_RANK.equals(level.kind())) {
      int kyu = Levels.kyuFor(level, p.size());
      pick = pol -> RankStrategy.pickRankMove(pol, p.size(), kyu, rng);
    } else {
      int opening = level.openingMoves() == null ? 22 : level.openingMoves();
      pick = pol -> RankStrategy.pickPolicyMove(pol, p.size(), p.moves().length, opening, rng);
    }
    return new AiMove(pickLegal(p, policy, pick), false, info);
  }

  /** 最强档：真正的搜索，取 order 最小的合法着手。 */
  private AiMove searchMove(AiCommon.Parsed p, Levels.Level level) {
    ObjectNode q = base(p);
    q.set("rules", rulesNoFriendlyPass());
    q.put("maxVisits", level.maxVisits());
    q.put("includePolicy", true);
    if (p.humanJustPassed()) q.put("includeOwnership", true);
    q.put("priority", PRIORITY_SEARCH);
    q.putObject("overrideSettings")
        .put("maxTime", level.maxTimeSec())
        .put("conservativePass", false)
        .put("wideRootNoise", 0)
        .put("reportAnalysisWinratesAs", "BLACK");
    JsonNode res = AiCommon.await(engine.query(q, level.maxTimeSec() * 1000L + TIMEOUT_SEARCH_EXTRA));
    AiMoveInfo info = AiCommon.infoForColor(res == null ? null : res.get("rootInfo"), p.color());
    if (shouldResign(info, p.size(), p.moves().length)) return new AiMove(PASS, true, info);
    if (p.humanJustPassed() && settledForPass(p, res)) return new AiMove(PASS, false, info); // 见 settledForPass
    for (JsonNode mi : topMoveInfo(res)) {
      String s = mi.get("move").asText();
      Integer mv = AiCommon.parseKataMove(s, p.size());
      if (mv != null && mv == PASS) return new AiMove(PASS, false, info);
      if (mv != null && AiCommon.isLegal(p.state(), p.color(), mv)) return new AiMove(mv, false, info);
      log.debug("KataGo 搜索给出的着手 " + s + " 不合法，换下一个");
    }
    JsonNode pol = res == null ? null : res.get("policy");
    if (pol != null && pol.isArray() && pol.size() == p.size() * p.size() + 1) {
      double[] policy = new double[pol.size()];
      for (int i = 0; i < policy.length; i++) {
        double v = AiCommon.num(pol.get(i));
        policy[i] = Double.isNaN(v) ? -1 : v;
      }
      return new AiMove(bestLegalByPolicy(p, policy), false, info);
    }
    return new AiMove(PASS, false, info);
  }
}
