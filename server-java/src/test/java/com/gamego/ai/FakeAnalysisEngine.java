package com.gamego.ai;

import static com.gamego.ai.AiCommon.BLACK;
import static com.gamego.ai.AiCommon.JSON;
import static com.gamego.ai.AiCommon.PASS;
import static com.gamego.ai.AiCommon.WHITE;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.gamego.engine.Coords;
import com.gamego.engine.GameState;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

/**
 * 模拟 KataGo 分析引擎（与 KataGoEngine 同接口），按请求合成 policy / moveInfos / rootInfo / ownership，
 * 让 KataGoAiService 的逻辑不依赖可执行文件就能单测（移植自 server/src/ai/fake.js 的 FakeEngine）。
 * 各选项都可以是固定值，也可以按 (query, ctx) 计算。
 */
class FakeAnalysisEngine implements AnalysisEngine {
  /** 请求里的局面。 */
  record Ctx(int size, int[] moves, GameState state, int toPlay, String perspective) {
    boolean legal(int idx) {
      return AiCommon.isLegal(state, toPlay, idx);
    }
  }

  /** 黑方视角的 rootInfo；visits 为 null 时用 maxVisits。 */
  record RootInfo(double winrate, double scoreLead, Integer visits) {
    RootInfo(double winrate, double scoreLead) {
      this(winrate, scoreLead, null);
    }
  }

  interface Val<T> {
    T get(ObjectNode q, Ctx ctx);
  }

  interface Respond {
    /** 返回非 null 时直接作为响应；抛异常即请求失败。 */
    JsonNode respond(ObjectNode q, Ctx ctx);
  }

  record Rec(ObjectNode query, long timeoutMs) {}

  volatile boolean available = true;
  volatile long delayMs;
  volatile double passPolicy = 1e-4;
  volatile Val<RootInfo> rootInfo = (q, c) -> new RootInfo(0.5, 0);
  volatile Val<double[]> policy;
  /** 每项为 GTP 字符串或 ObjectNode（会补上 order 等字段）。 */
  volatile Val<List<Object>> moveInfos;
  volatile Val<Integer> searchMove;
  volatile Val<double[]> ownership;
  volatile Respond respond;
  final List<Rec> queries = new CopyOnWriteArrayList<>();
  volatile boolean started;
  volatile boolean stopped;

  // ---------- 配置（链式） ----------
  FakeAnalysisEngine rootInfo(RootInfo v) {
    rootInfo = (q, c) -> v;
    return this;
  }

  FakeAnalysisEngine rootInfoFn(Val<RootInfo> v) {
    rootInfo = v;
    return this;
  }

  FakeAnalysisEngine policy(double[] v) {
    policy = (q, c) -> v.clone();
    return this;
  }

  FakeAnalysisEngine moveInfos(Object... v) {
    List<Object> list = List.of(v);
    moveInfos = (q, c) -> list;
    return this;
  }

  FakeAnalysisEngine searchMove(int v) {
    searchMove = (q, c) -> v;
    return this;
  }

  FakeAnalysisEngine ownership(double[] v) {
    ownership = (q, c) -> v.clone();
    return this;
  }

  FakeAnalysisEngine respond(Respond v) {
    respond = v;
    return this;
  }

  FakeAnalysisEngine available(boolean v) {
    available = v;
    return this;
  }

  /** 构造 moveInfos 里的对象项，如 mi("H4", "scoreLead", 1.5)。 */
  static ObjectNode mi(String move, Object... kv) {
    ObjectNode o = JSON.createObjectNode().put("move", move);
    for (int i = 0; i < kv.length; i += 2) o.set((String) kv[i], JSON.valueToTree(kv[i + 1]));
    return o;
  }

  ObjectNode lastQuery() {
    return queries.isEmpty() ? null : queries.get(queries.size() - 1).query();
  }

  // ---------- AnalysisEngine ----------

  @Override
  public boolean available() {
    return !stopped && available;
  }

  @Override
  public CompletableFuture<Void> start() {
    started = true;
    return CompletableFuture.completedFuture(null);
  }

  @Override
  public CompletableFuture<Void> shutdown() {
    stopped = true;
    return CompletableFuture.completedFuture(null);
  }

  @Override
  public CompletableFuture<JsonNode> query(ObjectNode query, long timeoutMs) {
    queries.add(new Rec(query.deepCopy(), timeoutMs));
    if (stopped) return CompletableFuture.failedFuture(AiException.unavailable("FakeEngine 已关闭"));
    if (!available) return CompletableFuture.failedFuture(AiException.unavailable("FakeEngine 不可用"));
    java.util.concurrent.Executor ex =
        delayMs > 0 ? CompletableFuture.delayedExecutor(delayMs, TimeUnit.MILLISECONDS) : Runnable::run;
    return AiCommon.async(
        ex,
        () -> {
          Ctx ctx = context(query);
          Respond r = respond;
          if (r != null) {
            JsonNode out = r.respond(query, ctx);
            if (out != null) return out;
          }
          return synthesize(query, ctx);
        });
  }

  /** 解析请求里的局面。 */
  Ctx context(ObjectNode q) {
    int size = q.path("boardXSize").asInt();
    if (size != q.path("boardYSize").asInt()) throw new AiException(AiException.KATAGO_ERROR, "FakeEngine 只支持正方形棋盘");
    JsonNode mv = q.path("moves");
    int[] moves = new int[mv.size()];
    for (int i = 0; i < mv.size(); i++) {
      String player = mv.get(i).get(0).asText();
      String loc = mv.get(i).get(1).asText();
      if (!player.equals(i % 2 == 0 ? "B" : "W")) {
        throw new AiException(AiException.KATAGO_ERROR, "FakeEngine：第 " + (i + 1) + " 手颜色不交替");
      }
      Integer idx = AiCommon.parseKataMove(loc, size);
      if (idx == null) throw new AiException(AiException.KATAGO_ERROR, "Could not parse board location: " + loc);
      moves[i] = idx;
    }
    GameState state;
    try {
      state = AiCommon.replayMoves(size, q.path("komi").asDouble(), moves);
    } catch (AiException e) {
      throw new AiException(AiException.KATAGO_ERROR, "Illegal move: " + e.getMessage());
    }
    int toPlay = moves.length % 2 == 0 ? BLACK : WHITE;
    String perspective = q.path("overrideSettings").path("reportAnalysisWinratesAs").asText("BLACK");
    return new Ctx(size, moves, state, toPlay, perspective);
  }

  private static boolean flip(Ctx ctx) {
    return ctx.perspective.equals("WHITE") || (ctx.perspective.equals("SIDETOMOVE") && ctx.toPlay == WHITE);
  }

  private static int lineFromEdge(int idx, int n) {
    int x = idx % n;
    int y = (idx - x) / n;
    return Math.min(Math.min(x, y), Math.min(n - 1 - x, n - 1 - y));
  }

  /** 默认 policy：按离边距离给合法点加权，非法点 -1。 */
  double[] defaultPolicy(Ctx ctx) {
    int n = ctx.size * ctx.size;
    double[] w = new double[n];
    double sum = 0;
    for (int i = 0; i < n; i++) {
      if (ctx.legal(i)) {
        w[i] = 1 + lineFromEdge(i, ctx.size);
        sum += w[i];
      }
    }
    double[] policy = new double[n + 1];
    for (int i = 0; i < n; i++) policy[i] = w[i] > 0 ? (w[i] / sum) * (1 - passPolicy) : -1;
    policy[n] = sum > 0 ? passPolicy : 1;
    return policy;
  }

  JsonNode synthesize(ObjectNode q, Ctx ctx) {
    int n = ctx.size * ctx.size;
    boolean flip = flip(ctx);
    int visits = q.path("maxVisits").isInt() ? q.get("maxVisits").asInt() : 1;
    RootInfo ri = rootInfo.get(q, ctx);
    double bw = ri == null ? 0.5 : ri.winrate();
    double bl = ri == null ? 0 : ri.scoreLead();
    ObjectNode res = JSON.createObjectNode();
    if (q.has("id")) res.set("id", q.get("id"));
    res.put("isDuringSearch", false);
    res.put("turnNumber", ctx.moves.length);
    ObjectNode root = res.putObject("rootInfo");
    root.put("currentPlayer", ctx.toPlay == BLACK ? "B" : "W");
    root.put("visits", ri != null && ri.visits() != null ? ri.visits() : visits);
    root.put("winrate", flip ? 1 - bw : bw);
    root.put("scoreLead", flip ? -bl : bl);
    ArrayNode infosOut = res.putArray("moveInfos");

    double[] pol = policy != null ? policy.get(q, ctx) : defaultPolicy(ctx);
    if (q.path("includePolicy").asBoolean(false)) {
      ArrayNode pa = res.putArray("policy");
      for (double v : pol) pa.add(v);
    }

    if (visits > 1) {
      List<Object> infos = moveInfos != null ? moveInfos.get(q, ctx) : null;
      if (infos == null) {
        List<Integer> ranked = new ArrayList<>();
        for (int i = 0; i < n && i < pol.length; i++) if (pol[i] > 0) ranked.add(i);
        double[] pp = pol;
        ranked.sort(
            (a, b) -> {
              int c = Double.compare(pp[b], pp[a]);
              return c != 0 ? c : Integer.compare(a, b);
            });
        List<Integer> top = new ArrayList<>(ranked.subList(0, Math.min(5, ranked.size())));
        if (pol.length > n && pol[n] > 0) top.add(PASS);
        Integer sm = searchMove != null ? searchMove.get(q, ctx) : null;
        if (sm != null) {
          top.remove(sm);
          top.add(0, sm);
        }
        infos = new ArrayList<>();
        for (int idx : top) infos.add(Coords.idxToGtp(idx, ctx.size));
      }
      for (int order = 0; order < infos.size(); order++) {
        Object item = infos.get(order);
        ObjectNode o = item instanceof String s ? JSON.createObjectNode().put("move", s) : ((ObjectNode) item).deepCopy();
        ObjectNode m = JSON.createObjectNode();
        m.put("order", order);
        m.put("visits", Math.max(1, Math.round(visits / (double) (order + 2))));
        m.put("winrate", root.get("winrate").asDouble());
        m.put("scoreLead", root.get("scoreLead").asDouble());
        m.put("prior", 0);
        m.putArray("pv").add(o.get("move").asText());
        m.setAll(o);
        infosOut.add(m);
      }
    }

    if (q.path("includeOwnership").asBoolean(false)) {
      double[] own;
      if (ownership != null) {
        own = ownership.get(q, ctx);
      } else {
        own = new double[n];
        for (int i = 0; i < n; i++) {
          int c = ctx.state.board.get(i);
          own[i] = c == BLACK ? 1 : c == WHITE ? -1 : 0;
        }
      }
      ArrayNode oa = res.putArray("ownership");
      for (double v : own) oa.add(flip ? -v : v);
    }
    return res;
  }
}
