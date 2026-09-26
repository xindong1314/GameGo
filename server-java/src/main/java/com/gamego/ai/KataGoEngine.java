package com.gamego.ai;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Deque;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * KataGoEngine：管理一个 {@code katago analysis -config <cfg> -model <model>} 子进程（设计文档 7.2 / 7.4，移植自
 * server/src/ai/katago.js）。
 *
 * <ul>
 *   <li>协议：stdin 每行一个 JSON 请求，stdout 每行一个 JSON 响应（按字符串 id 匹配），stderr 只是日志 （只从中找就绪行
 *       "Started, ready to begin handling requests"，其余按 debug 级别记录）。
 *   <li>响应处理：warning 只记 debug；isDuringSearch 中间结果忽略；带 id 的 error → 该请求失败；没有 id 的 error（非法
 *       JSON、未知 action）只能记日志，对应请求靠超时兜底；noResults（被 terminate 的请求）→ 失败。
 *   <li>每个请求都有超时：到时发 {action:'terminate', terminateId} 并失败。连续 hangTimeouts 个请求超时， 而且这些请求发出之后
 *       stdout 再没有任何输出（按 stdout 行计数判断）→ 认为进程卡死，杀掉重启。只是忙（请求在 KataGo 内部排队、
 *       别的请求照常出结果）时的超时不算，否则会误杀正在为其他对局搜索的进程。
 *   <li>进程退出（崩溃/被杀）→ 所有已发出的请求失败，按指数退避（1s、2s、4s…最多 30s）自动重启； 进程稳定运行 stableMs
 *       以上再退出时退避从 1s 重新开始。
 *   <li>连续 maxStartupFailures 次启动失败（或可执行文件不存在等明显的配置错误）→ available() 变为 false，
 *       排队中的请求立即失败，之后每 slowRetryMs 慢速重试一次，成功后恢复可用。
 *   <li>进程未就绪（启动中、重启退避中）时请求先排队，就绪后再发送；排队时间计入该请求的超时。
 *   <li>shutdown()：发 terminate_all、关闭 stdin，等待退出，超时则 destroy / destroyForcibly；JVM 退出时（shutdown hook）
 *       也会结束所有仍存活的子进程。（JVM 被强杀时来不及做，但 stdin 管道随之关闭，KataGo 会自己退出。）
 *   <li>任何 KataGo 问题都不会以异常抛给调用方之外：只体现为请求 future 失败与日志。
 * </ul>
 *
 * <p>线程：每个进程一个 stdout 读线程、一个 stderr 读线程、一个 stdin 写线程（写入不持锁，KataGo 卡住不读 stdin
 * 时也不会拖住整个引擎）；一个定时器线程处理超时与重启；future 在单独的线程池里完成（不在锁内回调）。
 */
public class KataGoEngine implements AnalysisEngine {
  public static final String READY_LINE = "Started, ready to begin handling requests";

  /** 可调参数与启动参数。 */
  public static final class Options {
    String path;
    String model;
    String config;
    List<String> argsPrefix = List.of();
    List<String> args = List.of();
    Map<String, String> env = Map.of();
    File cwd;
    AiLog log = AiLog.SILENT;
    ProcessStarter starter = ProcessBuilder::start;
    long startupTimeoutMs = 60000; // 从启动到出现就绪行的最长时间（大模型在慢机器上加载较慢）
    long queryTimeoutMs = 30000; // query 未指定超时时的默认值
    long backoffInitialMs = 1000;
    long backoffMaxMs = 30000;
    int maxStartupFailures = 4; // 连续启动失败这么多次后标记为不可用（1+2+4 秒退避，约 10 秒内判定）
    long slowRetryMs = 60000; // 标记不可用后的重试间隔
    long stableMs = 60000; // 进程运行超过这么久再退出，退避从头开始
    long shutdownGraceMs = 3000; // shutdown 时等待进程自行退出的时间，超时 destroy
    long killWaitMs = 3000; // destroy 后等待退出的时间，超时 destroyForcibly
    int hangTimeouts = 2; // 连续这么多个请求超时、且它们发出后 stdout 再无任何输出 → 判定卡死并重启
    int stderrTailLines = 30; // 启动失败时在日志里附上的 stderr 末尾行数

    public Options(String path, String model, String config) {
      this.path = path;
      this.model = model;
      this.config = config;
    }

    /** 放在 "analysis" 之前的参数（测试里用来运行模拟进程：java -cp ... FakeKataGo analysis ...）。 */
    public Options argsPrefix(List<String> v) {
      argsPrefix = List.copyOf(v);
      return this;
    }

    /** 追加在命令行末尾的参数。 */
    public Options args(List<String> v) {
      args = List.copyOf(v);
      return this;
    }

    /** 额外的环境变量（在继承的环境之上覆盖）。 */
    public Options env(Map<String, String> v) {
      env = Map.copyOf(v);
      return this;
    }

    public Options cwd(File v) {
      cwd = v;
      return this;
    }

    public Options log(AiLog v) {
      log = v == null ? AiLog.SILENT : v;
      return this;
    }

    /** 自定义进程启动（测试用：按启动次数改环境变量等）。 */
    public Options starter(ProcessStarter v) {
      starter = Objects.requireNonNull(v);
      return this;
    }

    public Options startupTimeoutMs(long v) {
      startupTimeoutMs = nonNeg("startupTimeoutMs", v);
      return this;
    }

    public Options queryTimeoutMs(long v) {
      queryTimeoutMs = nonNeg("queryTimeoutMs", v);
      return this;
    }

    public Options backoffInitialMs(long v) {
      backoffInitialMs = nonNeg("backoffInitialMs", v);
      return this;
    }

    public Options backoffMaxMs(long v) {
      backoffMaxMs = nonNeg("backoffMaxMs", v);
      return this;
    }

    public Options maxStartupFailures(int v) {
      maxStartupFailures = (int) nonNeg("maxStartupFailures", v);
      return this;
    }

    public Options slowRetryMs(long v) {
      slowRetryMs = nonNeg("slowRetryMs", v);
      return this;
    }

    public Options stableMs(long v) {
      stableMs = nonNeg("stableMs", v);
      return this;
    }

    public Options shutdownGraceMs(long v) {
      shutdownGraceMs = nonNeg("shutdownGraceMs", v);
      return this;
    }

    public Options killWaitMs(long v) {
      killWaitMs = nonNeg("killWaitMs", v);
      return this;
    }

    public Options hangTimeouts(int v) {
      hangTimeouts = (int) nonNeg("hangTimeouts", v);
      return this;
    }

    public Options stderrTailLines(int v) {
      stderrTailLines = (int) nonNeg("stderrTailLines", v);
      return this;
    }

    private static long nonNeg(String name, long v) {
      if (v < 0) throw new IllegalArgumentException("KataGoEngine: " + name + " 必须是非负数");
      return v;
    }
  }

  /** 启动进程（默认 {@code ProcessBuilder::start}）。 */
  @FunctionalInterface
  public interface ProcessStarter {
    Process start(ProcessBuilder pb) throws IOException;
  }

  /** 事件（仅供观察/测试），在单独的事件线程上按顺序回调。 */
  public interface Listener {
    default void onSpawn(long pid) {}

    default void onReady(long pid) {}

    /** restartInMs 为 null 表示已关闭、不再重启。code 为 null 表示进程没能启动。 */
    default void onExit(Integer code, boolean ready, Long restartInMs) {}

    default void onUnavailable() {}
  }

  /** 统计快照。 */
  public record Stats(int starts, int readies, int crashes, int startupFailures, int timeouts, int hangs) {}

  enum State {
    IDLE,
    STARTING,
    READY,
    WAITING,
    STOPPED
  }

  /** 一次进程运行的记录。 */
  private static final class Run {
    Process process;
    boolean ready;
    boolean gone;
    long startedAt;
    long readyAt;
    final Deque<String> stderrTail = new ArrayDeque<>();
    Throwable startupError;
    boolean fatal; // 可执行文件不存在等明显的配置错误
    ScheduledFuture<?> startupTimer;
    ScheduledFuture<?> closeFallback;
    final List<Runnable> goneWaiters = new ArrayList<>();
    final BlockingQueue<Object> writeQueue = new LinkedBlockingQueue<>();
  }

  private static final Object CLOSE_STDIN = new Object();

  /** 一个请求。 */
  private static final class Entry {
    final String id;
    final String line;
    final int expected;
    final List<JsonNode> results = new ArrayList<>();
    final boolean isAction;
    final CompletableFuture<JsonNode> future = new CompletableFuture<>();
    boolean done;
    ScheduledFuture<?> timer;
    long outputSeqAtSend;

    Entry(String id, String line, int expected, boolean isAction) {
      this.id = id;
      this.line = line;
      this.expected = expected;
      this.isAction = isAction;
    }
  }

  // ---------- 所有存活的子进程；JVM 退出时统一结束 ----------
  private static final Set<Process> LIVE = ConcurrentHashMap.newKeySet();

  static {
    Runtime.getRuntime()
        .addShutdownHook(
            new Thread(
                () -> {
                  for (Process p : LIVE) {
                    try {
                      p.destroy();
                    } catch (RuntimeException ignored) {
                      // 进程已不存在
                    }
                  }
                },
                "katago-exit-hook"));
  }

  private final Options opts;
  private final AiLog log;
  private final Object lock = new Object();
  private final ScheduledThreadPoolExecutor timer;
  private final ExecutorService completer = AiCommon.daemonPool("katago-complete-");
  private final ThreadPoolExecutor events;
  private final List<Listener> listeners = new CopyOnWriteArrayList<>();

  // 以下字段都由 lock 保护
  private State state = State.IDLE;
  private boolean gaveUp;
  private Run run;
  private final Deque<Entry> queue = new ArrayDeque<>(); // 等待进程就绪的请求
  private final Map<String, Entry> pending = new LinkedHashMap<>(); // 已发给当前进程、等待结果的请求
  private final Set<String> terminated = new HashSet<>(); // 已超时并发了 terminate 的 id：迟到的结果安静丢弃
  private long seq;
  private int startupFailures;
  private int restartStreak;
  private int consecutiveTimeouts;
  private long outputSeq; // 从 stdout 读到的行数（判断卡死用：请求发出后这个数有没有变）
  private ScheduledFuture<?> restartTimer;
  private final List<CompletableFuture<Void>> attemptWaiters = new ArrayList<>();
  private CompletableFuture<Void> shutdownFuture;
  private int starts;
  private int readies;
  private int crashes;
  private int statStartupFailures;
  private int timeouts;
  private int hangs;

  public KataGoEngine(Options options) {
    Objects.requireNonNull(options, "options");
    if (isBlank(options.path) || isBlank(options.model) || isBlank(options.config)) {
      throw new IllegalArgumentException("KataGoEngine: 需要 path、model、config");
    }
    this.opts = options;
    this.log = options.log;
    this.timer =
        new ScheduledThreadPoolExecutor(
            1,
            r -> {
              Thread t = new Thread(r, "katago-timer");
              t.setDaemon(true);
              return t;
            });
    this.timer.setRemoveOnCancelPolicy(true);
    this.timer.setExecuteExistingDelayedTasksAfterShutdownPolicy(false);
    this.events =
        new ThreadPoolExecutor(
            0,
            1,
            5,
            TimeUnit.SECONDS,
            new LinkedBlockingQueue<>(),
            r -> {
              Thread t = new Thread(r, "katago-events");
              t.setDaemon(true);
              return t;
            });
  }

  private static boolean isBlank(String s) {
    return s == null || s.isBlank();
  }

  public void addListener(Listener l) {
    listeners.add(l);
  }

  // ---------- 状态查询 ----------

  @Override
  public boolean available() {
    synchronized (lock) {
      return state != State.STOPPED && !gaveUp;
    }
  }

  public boolean isReady() {
    synchronized (lock) {
      return state == State.READY;
    }
  }

  /** "idle" | "starting" | "ready" | "waiting"（退避中）| "stopped"。 */
  public String state() {
    synchronized (lock) {
      return state.name().toLowerCase(java.util.Locale.ROOT);
    }
  }

  /** 当前进程的 pid；没有存活的进程时为 null。 */
  public Long pid() {
    synchronized (lock) {
      return run != null && run.process != null && !run.gone ? run.process.pid() : null;
    }
  }

  public Stats stats() {
    synchronized (lock) {
      return new Stats(starts, readies, crashes, statStartupFailures, timeouts, hangs);
    }
  }

  // ---------- 对外操作 ----------

  @Override
  public CompletableFuture<Void> start() {
    synchronized (lock) {
      if (state == State.STOPPED) return CompletableFuture.failedFuture(AiException.unavailable("KataGo 已关闭"));
      if (state == State.READY) return CompletableFuture.completedFuture(null);
      CompletableFuture<Void> f = new CompletableFuture<>();
      attemptWaiters.add(f);
      if (state == State.IDLE) launch();
      return f;
    }
  }

  /** 用默认超时发请求。 */
  public CompletableFuture<JsonNode> query(ObjectNode request) {
    return query(request, 0);
  }

  @Override
  public CompletableFuture<JsonNode> query(ObjectNode request, long timeoutMs) {
    synchronized (lock) {
      if (state == State.STOPPED) return CompletableFuture.failedFuture(AiException.unavailable("KataGo 已关闭"));
      if (gaveUp) return CompletableFuture.failedFuture(AiException.unavailable("KataGo 不可用（启动失败）"));
      if (request == null) return CompletableFuture.failedFuture(new IllegalArgumentException("query 需要一个对象"));
      long ms = timeoutMs <= 0 ? opts.queryTimeoutMs : timeoutMs;
      String id = "q" + (++seq);
      ObjectNode copy = request.deepCopy();
      copy.put("id", id);
      String line;
      try {
        line = AiCommon.JSON.writeValueAsString(copy);
      } catch (JsonProcessingException e) {
        return CompletableFuture.failedFuture(e);
      }
      JsonNode turns = request.get("analyzeTurns");
      int expected = turns != null && turns.isArray() && turns.size() > 1 ? turns.size() : 1;
      boolean isAction = request.hasNonNull("action") && request.get("action").isTextual();
      Entry entry = new Entry(id, line, expected, isAction);
      entry.timer = timer.schedule(() -> onTimeout(entry, ms), ms, TimeUnit.MILLISECONDS);
      if (state == State.IDLE) launch();
      if (gaveUp) {
        // 进程没能启动（可执行文件不存在等）：launch 里已经标记为不可用
        settle(entry, AiException.unavailable("KataGo 不可用（启动失败）"), null);
      } else if (state == State.READY) {
        send(entry);
      } else {
        queue.add(entry);
      }
      return entry.future;
    }
  }

  @Override
  public CompletableFuture<Void> shutdown() {
    synchronized (lock) {
      if (shutdownFuture != null) return shutdownFuture;
      state = State.STOPPED;
      cancel(restartTimer);
      restartTimer = null;
      AiException err = AiException.unavailable("KataGo 已关闭");
      for (Entry e : new ArrayList<>(queue)) settle(e, err, null);
      queue.clear();
      for (Entry e : new ArrayList<>(pending.values())) settle(e, err, null);
      for (CompletableFuture<Void> w : drainWaiters()) completeLater(w, err);
      shutdownFuture = new CompletableFuture<>();
      CompletableFuture<Void> done = shutdownFuture;
      Run r = run;
      if (r == null || r.gone || r.process == null) {
        finishShutdown();
        return done;
      }
      Process child = r.process;
      List<ScheduledFuture<?>> timers = new ArrayList<>();
      Runnable finish =
          () -> {
            synchronized (lock) {
              if (done.isDone()) return;
              for (ScheduledFuture<?> t : timers) cancel(t);
              finishShutdown();
            }
          };
      r.goneWaiters.add(finish);
      // 先中止所有进行中的搜索，再关闭 stdin：KataGo 处理完手头的请求后自行退出
      r.writeQueue.add("{\"id\":\"shutdown\",\"action\":\"terminate_all\"}");
      r.writeQueue.add(CLOSE_STDIN);
      long grace = opts.shutdownGraceMs;
      long killWait = opts.killWaitMs;
      timers.add(
          timer.schedule(
              () -> {
                log.warn("KataGo（pid " + child.pid() + "）没有在 " + grace + "ms 内退出，强制结束");
                child.destroy();
              },
              grace,
              TimeUnit.MILLISECONDS));
      timers.add(timer.schedule(child::destroyForcibly, grace + killWait, TimeUnit.MILLISECONDS));
      // 无论如何不让关闭流程卡住
      timers.add(timer.schedule(finish, grace + 2 * killWait, TimeUnit.MILLISECONDS));
      return done;
    }
  }

  // lock 内调用
  private void finishShutdown() {
    CompletableFuture<Void> f = shutdownFuture;
    completer.execute(
        () -> {
          afterLockedSection();
          f.complete(null);
        });
    timer.shutdown();
  }

  // ---------- 进程管理（lock 内调用） ----------

  private void launch() {
    cancel(restartTimer);
    restartTimer = null;
    state = State.STARTING;
    starts++;
    Run r = new Run();
    r.startedAt = System.currentTimeMillis();
    run = r;
    List<String> cmd = new ArrayList<>();
    cmd.add(opts.path);
    cmd.addAll(opts.argsPrefix);
    cmd.addAll(List.of("analysis", "-config", opts.config, "-model", opts.model));
    cmd.addAll(opts.args);
    ProcessBuilder pb = new ProcessBuilder(cmd);
    if (opts.cwd != null) pb.directory(opts.cwd);
    pb.environment().putAll(opts.env);
    pb.redirectInput(ProcessBuilder.Redirect.PIPE);
    pb.redirectOutput(ProcessBuilder.Redirect.PIPE);
    pb.redirectError(ProcessBuilder.Redirect.PIPE);
    Process p;
    try {
      p = opts.starter.start(pb);
    } catch (IOException | RuntimeException e) {
      r.startupError = e;
      r.fatal = true; // 可执行文件不存在 / 没有权限等：重试也没用
      onGone(r, null);
      return;
    }
    r.process = p;
    LIVE.add(p);
    log.debug("KataGo 启动中：" + String.join(" ", cmd));

    Thread out = new Thread(() -> readStdout(r), "katago-stdout-" + p.pid());
    Thread err = new Thread(() -> readStderr(r), "katago-stderr-" + p.pid());
    Thread in = new Thread(() -> writeStdin(r), "katago-stdin-" + p.pid());
    for (Thread t : List.of(out, err, in)) {
      t.setDaemon(true);
      t.start();
    }
    // 进程退出：优先等 stdout 读完（readStdout 结束时处理）；个别情况下 stdout 迟迟不关闭，1 秒后兜底
    p.onExit()
        .thenRun(
            () -> {
              synchronized (lock) {
                if (!r.gone && !timer.isShutdown()) {
                  r.closeFallback = timer.schedule(() -> goneLocked(r), 1000, TimeUnit.MILLISECONDS);
                } else if (!r.gone) {
                  onGone(r, exitCode(p));
                }
              }
            });
    r.startupTimer =
        timer.schedule(
            () -> {
              synchronized (lock) {
                if (r.ready || r.gone) return;
                r.startupError = new Exception(opts.startupTimeoutMs + "ms 内没有就绪");
                p.destroy();
              }
            },
            opts.startupTimeoutMs,
            TimeUnit.MILLISECONDS);
    long pid = p.pid();
    emit(l -> l.onSpawn(pid));
  }

  private static Integer exitCode(Process p) {
    try {
      return p.exitValue();
    } catch (IllegalThreadStateException e) {
      return null;
    }
  }

  private void goneLocked(Run r) {
    synchronized (lock) {
      onGone(r, exitCode(r.process));
    }
  }

  private void readStdout(Run r) {
    Process p = r.process;
    try (BufferedReader br = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
      String line;
      while ((line = br.readLine()) != null) {
        synchronized (lock) {
          if (run == r && !r.gone) onStdout(line);
        }
      }
    } catch (IOException e) {
      log.debug("KataGo 管道错误：" + e.getMessage());
    }
    // stdout 已关闭：等进程真正退出后处理（相当于 Node 的 'close' 事件）
    p.onExit().thenRun(() -> goneLocked(r));
  }

  private void readStderr(Run r) {
    try (BufferedReader br =
        new BufferedReader(new InputStreamReader(r.process.getErrorStream(), StandardCharsets.UTF_8))) {
      String line;
      while ((line = br.readLine()) != null) {
        synchronized (lock) {
          onStderr(r, line);
        }
      }
    } catch (IOException e) {
      log.debug("KataGo 管道错误：" + e.getMessage());
    }
  }

  private void writeStdin(Run r) {
    OutputStream os = r.process.getOutputStream();
    try {
      while (true) {
        Object item = r.writeQueue.take();
        if (item == CLOSE_STDIN) break;
        os.write((item + "\n").getBytes(StandardCharsets.UTF_8));
        os.flush();
      }
    } catch (IOException e) {
      // 进程正在退出；已发出的请求会在退出处理里失败
      log.debug("写入 KataGo 失败：" + e.getMessage());
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
    } finally {
      try {
        os.close();
      } catch (IOException ignored) {
        // 已关闭
      }
    }
  }

  private void onStderr(Run r, String line) {
    if (!r.ready) {
      r.stderrTail.add(line);
      if (r.stderrTail.size() > opts.stderrTailLines) r.stderrTail.removeFirst();
      if (line.contains(READY_LINE)) onReady(r);
    }
    log.debug("[katago] " + line);
  }

  private void onReady(Run r) {
    if (r.gone || run != r || state == State.STOPPED) return;
    r.ready = true;
    r.readyAt = System.currentTimeMillis();
    cancel(r.startupTimer);
    state = State.READY;
    startupFailures = 0;
    consecutiveTimeouts = 0;
    readies++;
    if (gaveUp) {
      gaveUp = false;
      log.info("KataGo 恢复可用");
    }
    long pid = r.process.pid();
    log.info("KataGo 已就绪（pid " + pid + "，启动用时 " + (r.readyAt - r.startedAt) + "ms）");
    for (CompletableFuture<Void> w : drainWaiters()) completeLater(w, null);
    List<Entry> queued = new ArrayList<>(queue);
    queue.clear();
    for (Entry e : queued) send(e);
    emit(l -> l.onReady(pid));
  }

  private List<CompletableFuture<Void>> drainWaiters() {
    List<CompletableFuture<Void>> out = new ArrayList<>(attemptWaiters);
    attemptWaiters.clear();
    return out;
  }

  private void onGone(Run r, Integer code) {
    if (r.gone) return;
    r.gone = true;
    cancel(r.startupTimer);
    cancel(r.closeFallback);
    if (r.process != null) LIVE.remove(r.process);
    r.writeQueue.add(CLOSE_STDIN); // 让写线程结束
    List<Runnable> waiters = new ArrayList<>(r.goneWaiters);
    r.goneWaiters.clear();
    for (Runnable w : waiters) w.run();
    if (run != r) return;

    String how = "退出码 " + code;
    terminated.clear();
    consecutiveTimeouts = 0;
    // 已发给这个进程的请求不会再有结果
    for (Entry e : new ArrayList<>(pending.values())) {
      settle(e, new AiException(AiException.KATAGO_ERROR, "KataGo 进程已退出（" + how + "）"), null);
    }

    if (state == State.STOPPED) {
      log.info("KataGo 已退出（" + how + "）");
      boolean ready = r.ready;
      emit(l -> l.onExit(code, ready, null));
      return;
    }

    if (!r.ready) {
      startupFailures++;
      statStartupFailures++;
      String reason =
          r.startupError != null ? String.valueOf(r.startupError.getMessage()) : "启动过程中退出（" + how + "）";
      List<String> tail = List.copyOf(r.stderrTail);
      AiException err = new AiException(AiException.AI_UNAVAILABLE, "KataGo 启动失败：" + reason, tail);
      String tailText = tail.isEmpty() ? "" : "\n  " + String.join("\n  ", tail);
      log.warn(err.getMessage() + "（第 " + startupFailures + " 次）" + tailText);
      for (CompletableFuture<Void> w : drainWaiters()) completeLater(w, err);
      if (!gaveUp && (r.fatal || startupFailures >= opts.maxStartupFailures)) {
        gaveUp = true;
        log.error(
            "KataGo 无法启动（连续 "
                + startupFailures
                + " 次失败），AI 标记为不可用；之后每 "
                + Math.round(opts.slowRetryMs / 1000.0)
                + " 秒重试一次");
        AiException unav = AiException.unavailable("KataGo 不可用（启动失败）");
        for (Entry e : new ArrayList<>(queue)) settle(e, unav, null);
        queue.clear();
        emit(Listener::onUnavailable);
      }
    } else {
      crashes++;
      log.warn("KataGo 进程意外退出（" + how + "），将自动重启");
      if (System.currentTimeMillis() - r.readyAt >= opts.stableMs) restartStreak = 0;
    }

    restartStreak++;
    long delay =
        gaveUp
            ? opts.slowRetryMs
            : Math.min(opts.backoffMaxMs, opts.backoffInitialMs * (1L << Math.min(30, restartStreak - 1)));
    state = State.WAITING;
    restartTimer =
        timer.schedule(
            () -> {
              synchronized (lock) {
                restartTimer = null;
                if (state == State.WAITING) launch();
              }
            },
            delay,
            TimeUnit.MILLISECONDS);
    boolean ready = r.ready;
    emit(l -> l.onExit(code, ready, delay));
  }

  // ---------- 请求（lock 内调用） ----------

  private void send(Entry entry) {
    if (entry.done) return;
    entry.outputSeqAtSend = outputSeq;
    pending.put(entry.id, entry);
    writeLine(entry.line);
  }

  private void writeLine(String line) {
    Run r = run;
    if (r == null || r.gone || r.process == null) return;
    r.writeQueue.add(line);
  }

  private void settle(Entry entry, Throwable err, JsonNode value) {
    if (entry.done) return;
    entry.done = true;
    cancel(entry.timer);
    pending.remove(entry.id);
    CompletableFuture<JsonNode> f = entry.future;
    completer.execute(
        () -> {
          afterLockedSection();
          if (err != null) f.completeExceptionally(err);
          else f.complete(value);
        });
  }

  /**
   * 在完成线程里等当前持锁的一段处理整个结束后再完成 future（相当于 Node 里 promise 回调总在当前事件处理完之后才运行），
   * 这样调用方看到结果时，同一段处理里的日志、状态变更都已完成。
   */
  private void afterLockedSection() {
    synchronized (lock) {
      lock.notifyAll(); // 只为取得一次锁
    }
  }

  private void completeLater(CompletableFuture<Void> f, Throwable err) {
    completer.execute(
        () -> {
          afterLockedSection();
          if (err != null) f.completeExceptionally(err);
          else f.complete(null);
        });
  }

  private void onTimeout(Entry entry, long ms) {
    synchronized (lock) {
      if (entry.done) return;
      timeouts++;
      if (queue.remove(entry)) {
        settle(entry, new AiException(AiException.TIMEOUT, "KataGo 在 " + ms + "ms 内没有就绪"), null);
        return;
      }
      boolean sent = pending.containsKey(entry.id);
      settle(entry, new AiException(AiException.TIMEOUT, "KataGo 请求超时（" + ms + "ms）"), null);
      if (!sent) return;
      log.warn("KataGo 请求 " + entry.id + " 超时（" + ms + "ms）");
      if (!entry.isAction) {
        terminated.add(entry.id);
        writeLine("{\"id\":\"t" + (++seq) + "\",\"action\":\"terminate\",\"terminateId\":\"" + entry.id + "\"}");
      }
      // 只有"发出之后 KataGo 再也没有任何输出"的超时才算卡死的迹象。
      // 负载高时请求在 KataGo 内部排队，几个同时发出的请求会在同一时刻一起超时，
      // 但期间别的请求照常出结果——这不是卡死，不能因此杀掉进程（会连带杀掉其他对局正在进行的搜索）。
      if (outputSeq != entry.outputSeqAtSend) return;
      consecutiveTimeouts++;
      Run r = run;
      if (consecutiveTimeouts >= opts.hangTimeouts && r != null && !r.gone && r.process != null) {
        hangs++;
        consecutiveTimeouts = 0;
        log.warn("KataGo 连续 " + opts.hangTimeouts + " 个请求超时且没有任何输出，判定为卡死，重启进程");
        Process child = r.process;
        child.destroy();
        timer.schedule(
            () -> {
              synchronized (lock) {
                if (!r.gone) child.destroyForcibly();
              }
            },
            opts.killWaitMs,
            TimeUnit.MILLISECONDS);
      }
    }
  }

  private void onStdout(String line) {
    String text = line.trim();
    if (text.isEmpty()) return;
    outputSeq++;
    JsonNode msg;
    try {
      msg = AiCommon.JSON.readTree(text);
    } catch (JsonProcessingException e) {
      log.debug("KataGo 输出了非 JSON 内容：" + truncate(text));
      return;
    }
    if (msg == null || !msg.isObject()) return;
    consecutiveTimeouts = 0;

    JsonNode idNode = msg.get("id");
    String id = idNode != null && idNode.isTextual() ? idNode.asText() : null;
    if (id == null) {
      if (msg.has("error")) log.warn("KataGo 报错（没有 id，对应的请求将超时）：" + textOf(msg.get("error")));
      else log.debug("忽略没有 id 的 KataGo 输出：" + truncate(text));
      return;
    }
    boolean duringSearch = isTrue(msg.get("isDuringSearch"));
    Entry entry = pending.get(id);
    if (entry == null) {
      if (terminated.contains(id)) {
        if (!duringSearch) terminated.remove(id);
        log.debug("丢弃已超时请求 " + id + " 的迟到结果");
      } else if (msg.has("error")) {
        log.warn("KataGo 报错（" + id + "）：" + textOf(msg.get("error")));
      } else {
        log.debug("忽略 KataGo 输出（id=" + id + "）");
      }
      return;
    }
    if (msg.has("error")) {
      settle(entry, katagoError(msg), null);
      return;
    }
    if (msg.has("warning")) {
      String field = msg.hasNonNull("field") ? "，字段 " + textOf(msg.get("field")) : "";
      log.debug("KataGo 警告（" + id + field + "）：" + textOf(msg.get("warning")));
      return;
    }
    if (entry.isAction) {
      settle(entry, null, msg);
      return;
    }
    if (duringSearch) return;
    if (isTrue(msg.get("noResults"))) {
      settle(entry, new AiException(AiException.KATAGO_ERROR, "KataGo 没有返回结果（请求被中止）", msg), null);
      return;
    }
    entry.results.add(msg);
    if (entry.results.size() >= entry.expected) {
      JsonNode res;
      if (entry.expected == 1) {
        res = entry.results.get(0);
      } else {
        List<JsonNode> sorted = new ArrayList<>(entry.results);
        sorted.sort((a, b) -> Integer.compare(a.path("turnNumber").asInt(), b.path("turnNumber").asInt()));
        ArrayNode arr = AiCommon.JSON.createArrayNode();
        sorted.forEach(arr::add);
        res = arr;
      }
      settle(entry, null, res);
    }
  }

  private static AiException katagoError(JsonNode msg) {
    String field = msg.hasNonNull("field") ? "（字段 " + textOf(msg.get("field")) + "）" : "";
    return new AiException(AiException.KATAGO_ERROR, "KataGo 拒绝请求" + field + "：" + textOf(msg.get("error")), msg);
  }

  private static boolean isTrue(JsonNode n) {
    return n != null && n.isBoolean() && n.booleanValue();
  }

  private static String textOf(JsonNode n) {
    return n == null ? "null" : n.isTextual() ? n.asText() : n.toString();
  }

  private static String truncate(String s) {
    return s.length() > 200 ? s.substring(0, 200) : s;
  }

  private static void cancel(ScheduledFuture<?> f) {
    if (f != null) f.cancel(false);
  }

  private void emit(java.util.function.Consumer<Listener> call) {
    if (listeners.isEmpty()) return;
    List<Listener> snapshot = Collections.unmodifiableList(new ArrayList<>(listeners));
    events.execute(
        () -> {
          for (Listener l : snapshot) {
            try {
              call.accept(l);
            } catch (RuntimeException e) {
              log.debug("KataGo 事件监听器出错：" + e);
            }
          }
        });
  }
}
