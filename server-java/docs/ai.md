# AI 模块（Java 版，`com.gamego.ai`）

行为与 Node 版完全一致（接口契约见 [docs/online-design.md 第 7 节](../../docs/online-design.md)，原理、安装 KataGo、调参、排查见
[docs/ai.md](../../docs/ai.md)）。本文只说明 Java 版特有的部分。

## 文件对照

| Java | Node | 内容 |
|---|---|---|
| `AiService`（接口）、`AiLevel`、`AiMoveRequest`、`AiMove`、`AiMoveInfo`、`DeadResult`、`AiException` | `service.js` 的 AiService | 对外接口与数据类型 |
| `AiServiceFactory` / `AiConfig` | `createAiService` | 按配置选实现；Spring Bean（`AiService` 与 `com.gamego.api.AiLevelsProvider`） |
| `KataGoAiService` | `service.js` | KataGo 版：选点、终局检查、认输核实、判死 |
| `KataGoEngine`（实现 `AnalysisEngine`） | `katago.js` | `katago analysis` 子进程管理 |
| `Levels` / `RankStrategy` | `levels.js` / `rank.js` | 难度表 / KaTrain 算法移植（文件头保留 MIT 声明） |
| `FallbackAiService` / `UnavailableAiService` | `fallback.js` / `createUnavailableAiService` | 内置练习 AI / 不可用 |
| `FakeAiService` | `fake.js` 的 `createFakeAiService` | 给其他模块测试用的确定性替身 |
| `AiCommon` | `common.js` | 参数校验、重放（`com.gamego.engine`）、坐标与视角换算、按块判死 |

## 用法

```java
CompletableFuture<AiMove> f = ai.chooseMove(new AiMoveRequest(19, 7.5, moves, color, "k8", humanJustPassed));
f.whenComplete((mv, err) -> { /* err 为 AiException：getCode() = bad_request / ai_unavailable / katago_error / timeout */ });
ai.judgeDead(size, komi, moves).thenAccept(r -> r.dead());
```

- future 以 `AiException` 本身完成（`handle` / `whenComplete` 拿到的就是它；`join()` 会包一层 `CompletionException`，用
  `AiException.unwrap(e)` 取出）。参数错误也通过 future 返回，不会同步抛出。
- `shutdown()` 阻塞到 KataGo 退出（Spring 关闭时自动调用）。

## 配置

`AiConfig` 读取 `GameGoProperties`：`getKatago()`（KATAGO_PATH / KATAGO_MODEL / KATAGO_CONFIG 三项都配置才算）→ KataGo；
否则 `AI_FALLBACK` → 内置练习 AI；否则不可用。`JUDGE_TIMEOUT_MS` 同 Node 版（KataGo 请求超时为它减 1 秒）。
可选属性 `gamego.ai-min-think-ms`（默认 600）为 AI 最短思考时间。KataGo 配置文件：`server-java/katago/analysis.cfg`
（与 `server/katago/analysis.cfg` 相同）。

其他模块的测试需要确定性的 AI 时，提供一个 `@Primary` 的 `FakeAiService` Bean（可链式配置：`new FakeAiService().resign(true)`）。

## 与 Node 版的实现差异

- 进程：每个 KataGo 进程有 stdout / stderr 读线程和一个 stdin 写线程（写入不持锁，KataGo 不读 stdin 时不会拖住引擎）；
  超时、重启退避由一个定时器线程处理。future 在锁外完成，且等同一段处理结束后才完成（相当于 Node 的 promise 时序）。
- 进程退出码：Windows 上被 `destroy()` 的进程退出码为 1（Node 里是信号名）。
- 可执行文件不存在时 `ProcessBuilder.start()` 同步失败，立即标记不可用（同 Node 的 ENOENT）。
- 数值：`RankStrategy` 用 `StrictMath`，与 KaTrain 原版的 3000 组参考结果逐手一致。

## 测试

```
cd server-java
mvn -q -DbuildDir=target-ai test -Dtest='com.gamego.ai.**'
```

`KataGoEngineTest` 用 `FakeKataGo`（测试源码里的一个小 Java 程序，单独的 JVM 进程）模拟 KataGo 协议。
真实 KataGo 的集成测试 `KataGoRealTest` 只在设置了三个环境变量时运行（相对路径按 `server-java/` 解析）：

```
export KATAGO_PATH=../server/katago/katago.exe
export KATAGO_MODEL=../server/katago/kata1-b10c128-s1141046784-d204142634.txt.gz
export KATAGO_CONFIG=katago/analysis.cfg
mvn -q -DbuildDir=target-ai test -Dtest='com.gamego.ai.KataGoRealTest'
```

各请求的耗时以 `[katago-real]` 开头打印。
