# 人机对弈 AI（server-ai 模块）

服务端的 AI 模块负责两件事：

1. **人机对弈落子**：`chooseMove`，8 档难度，从"刚学会规则"到远超业余顶尖。
2. **终局死子判断**：`judgeDead`，联网对局和人机对局进入数子阶段时给出死子建议。

两件事都由 [KataGo](https://github.com/lightvector/KataGo) 的分析引擎（`katago analysis`）完成，它以子进程形式运行在服务器上。
弱档的"按段位落子"算法移植自 [KaTrain](https://github.com/sanderland/katrain) 的 Calibrated Rank AI（MIT 许可，见第 8 节）。

接口契约见 [online-design.md 第 7 节](online-design.md#7-ai-模块server-ai)。本文说明它怎么工作、怎么安装 KataGo、怎么调参。

---

## 1. 文件

| 文件 | 内容 |
|---|---|
| `server/src/ai/service.js` | `createAiService({ config, logger })`：对外的 AiService，按配置选择 KataGo / 内置弱 AI / 不可用 |
| `server/src/ai/katago.js` | `KataGoEngine`：管理 `katago analysis` 子进程（启动、请求、超时、崩溃重启、关闭） |
| `server/src/ai/levels.js` | 难度表 |
| `server/src/ai/rank.js` | KaTrain Calibrated Rank / Policy 策略的 JS 移植（文件头有 MIT 声明） |
| `server/src/ai/fallback.js` | 内置练习 AI（`AI_FALLBACK=1`，只供开发） |
| `server/src/ai/fake.js` | 测试替身：`createFakeAiService()`（给其他模块的测试）和 `FakeEngine`（模拟 KataGo 响应） |
| `server/src/ai/common.js` | 参数校验、着手重放、坐标与视角换算、按块判死 |
| `server/katago/analysis.cfg` | KataGo 配置（2~4 核服务器），每项都有中文注释 |

---

## 2. 难度分级

| id | 名称 | 策略 | 参数 | 19 路大致水平 | 每步 KataGo 开销 |
|---|---|---|---|---|---|
| `k18` | 入门 | rank | kyu 18 | 约 18 级（KaTrain 在 OGS 实测更弱，约 20 级以下） | 1 次评估 |
| `k12` | 初级 | rank | kyu 12 | 约 12 级 | 1 次评估 |
| `k8` | 中级 | rank | kyu 8 | 约 8 级 | 1 次评估 |
| `k4` | 中高级 | rank | kyu 4 | 约 4 级（KaTrain 默认档） | 1 次评估 |
| `k1` | 高级 | rank | kyu 1 | 约 1 级 | 1 次评估 |
| `d3` | 业余 3 段 | rank | kyu −2 | 约业余 3 段（KaTrain 最强校准档） | 1 次评估 |
| `d5` | 业余高段 | policy | 开局 22 手内加随机性 | 约业余 5 段（KaTrain 的估计） | 1 次评估 |
| `max` | 最强 | search | maxVisits 300，maxTime 8 秒 | 远超业余顶尖 | 最多 300 次搜索 |

### 2.1 rank 策略（KaTrain "Calibrated Rank"）

每步只让 KataGo 做 **1 次神经网络评估**（`maxVisits: 1` + `includePolicy: true`），拿到每个点的 policy（神经网络"第一感"的概率），然后：

1. pass 在 policy 前 5 名里 → 直接下 policy 第一（第一就是 pass 则 pass）。
2. policy 第一的概率大于阈值（空盘 0.8，随棋盘填满降到 0.4），或前两名之和大于 0.85（弱档更高）→ 直接下 policy 第一。
3. 否则按级位算出一个数 n（例如 19 路空盘 8 级 n = 55），从所有合法点里**等概率随机抽 n 个**，下其中 policy 最高的那个；
   如果它还不如 pass 的 policy，就改下 policy 第一。

级位越高（越弱），抽的点越少，越容易错过好点；开局相对强、中盘最弱、收官逐渐变强但不会变成"超人"。
公式来自 bale-go 用 GnuGo / Pachi 做的回归，KaTrain 作者说明它只在 19 路上校准过。

**小棋盘修正**：同样的参数在小棋盘上明显更强（9 路 8 级抽到 41% 的合法点，19 路只有 15%），
所以 13 路 kyu +5、9 路 kyu +10（上限 30）。这只是按"空盘时看到的比例相同"推出的初始值，**没有实测校准**，
上线后可以按排行数据里各档的人机胜率调整 `server/src/ai/levels.js` 的 `SIZE_KYU_OFFSET`。

### 2.2 policy 策略（`d5`）

直接下 policy 最高点。开局 22 手内按 KaTrain 的规则加随机性：在 policy > 2% 的点里按 policy 加权随机选，避免每盘开局都一样。

### 2.3 search 策略（`max`）

真正的搜索：`maxVisits: 300`，`overrideSettings.maxTime: 8`（秒）封顶，取 `order` 最小的着手。
使用 `friendlyPassOk: false` 的中国规则对象并关闭 `conservativePass`（见 2.4），`wideRootNoise: 0`。

### 2.4 pass

- KataGo 的 `chinese` 规则预设下 `friendlyPassOk = true`，实测它几乎从不把 pass 排第一（会在自己地里继续下无害的棋）。
  搜索时改用规则对象 `{"ko":"SIMPLE","scoring":"AREA","tax":"NONE","suicide":false,"hasButton":false,"whiteHandicapBonus":"0","friendlyPassOk":false}`
  加 `overrideSettings: { conservativePass: false, wideRootNoise: 0 }`：计分与合法性和 `chinese` 完全相同，但 AI 会先提净自己地里的死子，然后 pass。
- rank / policy 档按 KaTrain 的规则 pass（见 2.1）。另外，**玩家刚 pass 时**先做一次 100 次搜索的"终局检查"（同上规则，带 ownership），
  第一选点是 pass、**或者局面已定**，则 AI 也 pass，避免人停一手后 AI 在已定的局面里继续乱下；否则照常按难度选点。
- **"局面已定"**：假设现在就进入数子阶段，死子按这次搜索的归属判定（与 `judgeDead` 同一规则），按数子法算出 AI 视角的目差；
  它比继续下的预期（第一选点的 `scoreLead`）少不到 1 目（`service.js` 的 `SETTLED_MARGIN`）就算已定。最强档在玩家刚 pass 时也这样判断
  （它的 300 次搜索同时要 ownership）。
  原因：`friendlyPassOk:false` 下 KataGo 按 Tromp-Taylor 评价 pass，对方死子不提就算活子，所以只要对方死子还留在 AI 地里，
  它的第一选点总是"去提死子"。实测（黑墙 E 列、白墙 F 列，双方地里各一颗死子，人刚 pass）：最强档要跟着人 pass 4 次、d5 5 次、
  k8 9 次才 pass，k18 下了 30 手都没 pass（按 policy 随机选点，不一定去提）。本项目数子时按归属判死，这些死子不提也一样，
  现在各档都是下一手就 pass。这是对设计文档 7.5"第一选点是 pass 则 AI 也 pass"的补充。

### 2.5 合法性、认输、思考时间

- **合法性**：KataGo 对传入的着手序列很宽容（劫、多子自杀都不报错），所以每个选出的着手都用本项目引擎（`canPlay`）再校验一次；
  不合法就把该点的 policy 置 −1 重新选（最多 5 次），仍不行就下 policy 最高的合法点，都没有就 pass。搜索档按 `order` 依次尝试。
- **认输**：`rootInfo` 换算为 AI 视角后，胜率 < 2%，且落后超过 9 路 8 目 / 13 路 15 目 / 19 路 25 目，且总手数 > 路数² × 0.4 → 认输。
  rank / policy 档先看 1 次评估的 `rootInfo`（神经网络的直接判断）；满足条件时**再做一次 100 次搜索核实**（与终局检查同款请求；
  这一步已经做过终局检查就直接用它），搜索也满足条件才认输，否则照常落子（返回的 info 用搜索的结果）。
  原因：对杀、大块死活未定的局面里 1 次评估会严重误判，实测 19 路出现过 1 次评估判胜率 1%、落后 33 目，300 次搜索却是胜率 97%、
  领先 43 目的局面；自对弈中约 5% 的认输得不到搜索支持。核实搜索只在"想认输"时才发，平时每步仍只有 1 次评估；核实失败（超时等）时这一步不认输。
  最强档本身就是 300 次搜索，直接用它的 `rootInfo`。
- **返回的 info**：`{ winrate, scoreLead, visits }`，都是 **AI 视角**（KataGo 请求里统一用黑方视角，服务里再换算）。
- **最短思考时间**：从收到请求算起至少 `config.aiMinThinkMs` 毫秒才返回（默认 600，测试设 0），避免"秒下"。
  目前 `config.js` 没有对应的环境变量，需要调整时由 server-core 增加（例如 `AI_MIN_THINK_MS`）。

### 2.6 死子判断（`judgeDead`）

对终局局面（完整着手序列，含最后两次 pass）发一次分析请求：`maxVisits: 200`、`includeOwnership: true`、`rules: 'chinese'`、黑方视角。
以**块**（同色连通块）为单位求归属（ownership）平均值 `avg`，换算为本方视角 `own = 黑 ? avg : −avg`，`own <= −0.5` 则整块判死。
按块平均可以避免同一块棋被判得一半死一半活。KataGo 出错或超时则 reject；对局管理器会重试一次，仍失败才改为手动点选（设计文档 6.3）。
管理器每局同时最多一个在途的死子判断，结果按局面缓存（人机对局反复 pass / 悔棋回到同一局面不会重复请求）。

实测（9 路、白地里一颗黑死子、黑地里一颗白死子，终局后）：两颗死子都被判出，按数子法计分与手算一致（`W+16.5`）。

### 2.7 内置练习 AI（`AI_FALLBACK=1`）

未配置 KataGo 且 `AI_FALLBACK=1` 时使用，只为本地联调：能提子就提（提得多的优先）；否则在合法、不填自己单点眼、不自己送吃、
不让棋盘回到以前局面的点里随机下；没有这样的点或对方刚 pass 且无子可提就 pass；从不认输。
`levels()` 只有一档 `{ id: 'basic', name: '内置练习 AI' }`，`judgeDead` 直接 reject（数子阶段手动点选）。

---

## 3. KataGo 进程管理（`katago.js`）

- **启动**：`katago analysis -config <KATAGO_CONFIG> -model <KATAGO_MODEL>`（`windowsHide`，标准输入输出走管道）。
  stderr 出现 `Started, ready to begin handling requests` 即就绪（b10c128 约 0.9 秒，b6c96 约 0.4 秒）；
  60 秒内没就绪算启动失败。stderr 的其余内容按 debug 级别写进服务端日志（`LOG_LEVEL=debug` 可见）。
- **何时启动**：`createAiService` 创建时**立即在后台启动**，第一步棋不用等进程启动；启动失败不影响服务端本身。
- **请求**：stdin 每行一个 JSON，stdout 每行一个 JSON，按字符串 id 匹配。warning 只记 debug；`isDuringSearch` 中间结果忽略；
  带 id 的错误 → 该请求失败；没有 id 的错误（非法 JSON、未知 action）只能记日志，对应请求靠超时结束。
  1 次评估的请求优先级高于长搜索，多局同时思考时弱档不会被最强档拖慢。
- **超时**：每个请求都有超时（弱档 15 秒、终局检查 20 秒、搜索 maxTime + 15 秒、死子判断 `judgeTimeoutMs − 1` 秒）。
  超时后发 `{"action":"terminate","terminateId":...}` 中止该请求。连续 2 个请求超时，**而且它们发出之后 KataGo 的 stdout 再没有任何输出**
  → 判定卡死，杀掉重启。只是忙（多局同时思考，请求在 KataGo 内部排队、几个请求在同一时刻一起超时，但别的请求照常出结果）不算卡死，
  否则会把正在为其他对局搜索的进程杀掉。
- **崩溃**：进程退出时所有进行中的请求失败（对局模块会重试），按 1、2、4…最多 30 秒的间隔自动重启；
  重启期间的新请求排队，就绪后发送。
- **不可用**：连续 4 次启动失败（或可执行文件不存在、没有执行权限）→ `available()` 变为 false，排队的请求立即失败，
  客户端的人机入口显示不可用；之后每 60 秒重试一次，成功后自动恢复。
- **`available()` 的含义**：未关闭且没有因为反复启动失败而放弃。启动中、崩溃后重启中都算可用（请求会等待）。
- **关闭**：`shutdown()` 先发 `terminate_all`、关闭 stdin 等进程自己退出，3 秒后还不退出就 kill（实测有搜索在进行时约 0.1 秒退出）。
  Node 进程 `exit` 时也会杀掉所有仍存活的 KataGo 子进程。
  服务端被强杀（任务管理器结束进程、`taskkill /F`）时来不及做这些，但 KataGo 的 stdin 管道随之关闭，它会自己退出：
  Windows + v1.18.1 实测，空闲时约 0.5 秒、正在搜索时约 1 秒后退出。万一还有残留的 katago.exe，手动结束即可。

---

## 4. 安装 KataGo

需要两样东西：**可执行文件**和**神经网络权重**。推荐版本 v1.18.1——它是最后一个带 Eigen（纯 CPU）构建的版本
（v1.18.2 只有 CUDA 版）。服务器没有显卡，用 Eigen 版。

| 文件 | 下载地址 | 大小 | SHA-256 |
|---|---|---|---|
| Windows，Eigen AVX2 | https://github.com/lightvector/KataGo/releases/download/v1.18.1/katago-v1.18.1-eigenavx2-windows-x64.zip | 5,899,607 | `0d62ffa41ee04dd89dd1b80fe45e306c837231cb1e2dccb4f5780d0ca7c313db` |
| Windows，Eigen（CPU 不支持 AVX2 时） | https://github.com/lightvector/KataGo/releases/download/v1.18.1/katago-v1.18.1-eigen-windows-x64.zip | 5,903,072 | `074485cf150c38aa3bb14ac9f54f2952ffefbceb44673709bbb8a83650bf95d6` |
| Linux，Eigen AVX2 | https://github.com/lightvector/KataGo/releases/download/v1.18.1/katago-v1.18.1-eigenavx2-linux-x64.zip | 41,821,245 | `33e79780dbe3bf6ee859e16f64952cdfc90f7210c8f71ad978ffcba85ad20d79` |
| Linux，Eigen（不支持 AVX2 时） | https://github.com/lightvector/KataGo/releases/download/v1.18.1/katago-v1.18.1-eigen-linux-x64.zip | 41,780,528 | `993b642601e806037003d11e43775e7b4fc65281aed9b9469b7122f18fc16811` |
| 权重 b10c128（推荐） | https://media.katagotraining.org/uploaded/networks/models/kata1/kata1-b10c128-s1141046784-d204142634.txt.gz | 14,466,254 | `3d8a24697ba25fe4da39af4c2b6bd405907b0ad8295322f5a550fa2d8fe4a2f4` |
| 权重 b6c96（更小更快、更弱） | https://media.katagotraining.org/uploaded/networks/models/kata1/kata1-b6c96-s175395328-d26788732.txt.gz | 4,967,720 | `48d6754de3c4754f95bf6a5ca40957a49e5e915aaaeede133a17b9ccf8fa5fcb` |

- 不要下带 `+bs50` 的包（那是给大于 19 路的棋盘用的）。
- 权重选择：弱档每步只评估 1 次，b10c128 在 CPU 上足够快；最强档用 b10c128 已远超业余顶尖。更大的 b18 权重（约 98MB）在 CPU 上会慢很多，未测试。
- 文件建议放在 `server/katago/` 下（该目录除 `analysis.cfg` 外都被 `.gitignore` 忽略，不会提交进仓库）。
  `.env` 里的相对路径按 `server/` 目录解析，与启动时的工作目录无关。

### 4.1 Windows（开发机）

1. 下载 AVX2 版 zip，**整个解压**到 `server/katago/`（`katago.exe` 旁边的 dll 都要保留）。
2. 下载 b10c128 权重放到同一目录。
3. 检查：
   ```powershell
   cd server\katago
   .\katago.exe version        # 应显示 KataGo v1.18.1 … Compiled with AVX2 and FMA instructions
   .\katago.exe analysis -config analysis.cfg -model kata1-b10c128-s1141046784-d204142634.txt.gz
   # 看到 "Started, ready to begin handling requests" 后按 Ctrl+C 退出
   ```
   如果启动就崩溃或提示非法指令，说明 CPU 不支持 AVX2，改用 `eigen` 版。
4. `server/.env`：
   ```ini
   KATAGO_PATH=./katago/katago.exe
   KATAGO_MODEL=./katago/kata1-b10c128-s1141046784-d204142634.txt.gz
   # KATAGO_CONFIG 默认就是 ./katago/analysis.cfg，一般不用写
   ```
5. 启动服务端，日志里出现 `KataGo 已就绪` 即可；`GET /api/ai/levels` 返回 `available: true` 和 8 档难度。

### 4.2 Linux（生产服务器）

以下命令按 KataGo 官方发布说明整理，**未在本项目的服务器上实际运行过**，请按实际情况调整：

```bash
cd /path/to/GameGo/server/katago
grep -m1 -o avx2 /proc/cpuinfo          # 有输出 → 用 eigenavx2 版；没有 → 用 eigen 版
wget https://github.com/lightvector/KataGo/releases/download/v1.18.1/katago-v1.18.1-eigenavx2-linux-x64.zip
unzip katago-v1.18.1-eigenavx2-linux-x64.zip -d katago-1.18.1
chmod +x katago-1.18.1/katago
wget https://media.katagotraining.org/uploaded/networks/models/kata1/kata1-b10c128-s1141046784-d204142634.txt.gz
sha256sum katago-v1.18.1-eigenavx2-linux-x64.zip kata1-b10c128-s1141046784-d204142634.txt.gz   # 对照上表
APPIMAGE_EXTRACT_AND_RUN=1 ./katago-1.18.1/katago version
```

- Linux 版是 **AppImage**。系统缺 FUSE（`libfuse2`，Ubuntu 24.04 上叫 `libfuse2t64`）时无法直接运行：
  要么安装它，要么设置环境变量 `APPIMAGE_EXTRACT_AND_RUN=1`（每次启动自动解包到临时目录再运行）。
  服务端启动 KataGo 时会继承自己的环境变量，所以用 systemd 时在服务单元里加 `Environment=APPIMAGE_EXTRACT_AND_RUN=1`。
- 也可以用 `./katago --appimage-extract` 一次性解包，把 `KATAGO_PATH` 指向解包出来的可执行文件（在 `squashfs-root/` 下，具体路径以实际为准）。
  这样不依赖 FUSE，启动更快，服务端 kill 的也就是 KataGo 本身。
- `server/.env`：
  ```ini
  KATAGO_PATH=./katago/katago-1.18.1/katago
  KATAGO_MODEL=./katago/kata1-b10c128-s1141046784-d204142634.txt.gz
  ```
- 用真实引擎跑一遍集成测试确认（见第 7 节）。

---

## 5. 环境变量与调参

### 5.1 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `KATAGO_PATH` | 空 | KataGo 可执行文件。不含路径分隔符时（如 `katago`）按 PATH 查找 |
| `KATAGO_MODEL` | 空 | 神经网络权重文件 |
| `KATAGO_CONFIG` | `./katago/analysis.cfg` | KataGo 配置文件 |
| `AI_FALLBACK` | `0` | 未配置 KataGo 时是否用内置练习 AI（仅开发） |
| `LOG_LEVEL` | `info` | 设为 `debug` 可以看到 KataGo 的 stderr 日志、warning、重选等细节 |
| `APPIMAGE_EXTRACT_AND_RUN` | — | Linux AppImage 缺 FUSE 时设为 `1`（KataGo 子进程继承） |

`KATAGO_PATH` 和 `KATAGO_MODEL` 都配置了才启用 KataGo。

### 5.2 线程（`server/katago/analysis.cfg`）

| 配置项 | 2 核 | 4 核 | 作用 |
|---|---|---|---|
| `numAnalysisThreads` | 1~2 | 2 | 同时分析的局面数（多局人机同时思考） |
| `numSearchThreadsPerAnalysisThread` | 1 | 2 | 每个局面的搜索线程，只影响最强档与死子判断 |
| `numEigenThreadsPerModel` | 2 | 4 | 神经网络计算线程，设为物理核数 |
| `nnMaxBatchSize` | ≥ 上面两项之积 | 4 | 批大小 |
| `nnCacheSizePowerOfTwo` | 18~20 | 20 | 缓存，20 时常驻内存约 120~150MB |

### 5.3 visits 与时间（`server/src/ai/levels.js`、`service.js`）

- 最强档：`maxVisits: 300`、`maxTimeSec: 8`（`levels.js` 里的 `max` 档）。云服务器比桌面 CPU 慢，`maxTime` 保证每步不超过 8 秒；
  想更快可以降到 150~200 次，强度仍远超业余。
- 终局检查 100 次（rank / policy 档认输前的核实也用它）、死子判断 200 次（`service.js` 顶部常量）。死子判断的请求超时为 `judgeTimeoutMs − 1` 秒（默认 14 秒），并用 `maxTime: 8` 封顶。
- 弱档每步 1 次评估，与 visits 无关。

实测耗时（i7-12650H 桌面 CPU，Windows，AVX2 版，本仓库的 `analysis.cfg`，局面首次计算、不命中缓存）：

| 权重 | 启动 | rank / policy 档每步 | 最强档每步（300 次） | 死子判断（200 次） |
|---|---|---|---|---|
| b10c128 | 0.9 秒 | 约 25~35ms | 约 3.4~3.7 秒 | 约 2.5 秒 |
| b6c96 | 0.4 秒 | 约 13~19ms | 约 1.5~1.7 秒 | 约 1.1 秒 |

人停一手后弱档的终局检查（100 次搜索）约 1.0~1.4 秒（b10c128）。多局同时思考时，1 次评估的请求优先级更高：
24 个请求（3 种路数 × 8 档）同时发出，弱档都在 30~80ms 内返回，3 个最强档请求排队，最慢的约 8 秒。

云服务器的 vCPU 通常更慢，请在自己的服务器上用 `test/katago.real.test.js` 和日志里的耗时确认。

### 5.4 只下 9 路时的提速

KataGo 默认按 19×19 的缓冲区计算神经网络，9 路和 19 路一样慢。只提供 9 路时可以在 `analysis.cfg` 打开
`maxBoardXSizeForNNBuffer = 9` 等三行，约快 2 倍；但之后任何 13/19 路请求都永远没有结果（超时），并且卡住 KataGo 的一个分析线程，
所有分析线程都卡住后服务端才会判定卡死并重启进程（实测如此）。混合路数时不要打开。

### 5.5 强度微调

- 某档太强/太弱：改 `levels.js` 里的 `kyu`（rank 档）或小棋盘修正 `SIZE_KYU_OFFSET`。KaTrain 的公式在 kyu ≥ 36 左右会退化，代码里上限 30。
- 认输阈值：`service.js` 的 `RESIGN_WINRATE`、`RESIGN_LEAD`、`RESIGN_MIN_MOVE_FRACTION`。

---

## 6. 排查

| 现象 | 原因与处理 |
|---|---|
| `/api/ai/levels` 返回 `available: false`，`levels: []` | 没配置 `KATAGO_PATH`/`KATAGO_MODEL`，也没开 `AI_FALLBACK` |
| `available: false` 但列出 8 档难度 | KataGo 连续启动失败。看日志里 `KataGo 启动失败：…` 后面附的 stderr 末尾几行 |
| 日志 `spawn … ENOENT` | `KATAGO_PATH` 写错，或 Linux 上文件没有执行权限 |
| stderr 提示找不到模型文件 | `KATAGO_MODEL` 路径不对（相对路径按 `server/` 解析） |
| 启动立即崩溃（非法指令） | CPU 不支持 AVX2，换 `eigen` 版 |
| Linux 提示 `fuse: failed to exec fusermount` 之类 | 见 4.2：装 libfuse2 或设 `APPIMAGE_EXTRACT_AND_RUN=1` |
| AI 下得很慢、请求超时 | 服务器太慢或同时思考的对局太多：降低最强档 visits、调整线程数；日志里有 `KataGo 请求 … 超时` |
| Windows 上服务端退出后还有 katago.exe | 正常情况下 stdin 关闭后 KataGo 会在 1 秒左右自行退出；仍有残留（例如 stdin 被别的进程继承）就手动结束 |
| 日志 `判定为卡死，重启进程` | KataGo 连续 2 个请求超时且期间完全没有输出。常见原因是打开了 5.4 的 9 路缓冲区又收到 13/19 路请求 |

---

## 7. 测试

```bash
cd server
node --disable-warning=ExperimentalWarning --test test/ai/            # 单元测试，不需要 KataGo
```

- `test/ai/rank.test.js`：用同一个伪随机数种子重建 3000 组合成 policy，与 KaTrain 原版 Python 代码的结果逐手比对（rank 与 policy 两种策略、n_moves 公式）。
- `test/ai/service.test.js`：用 `FakeEngine` 测各档选点、pass 与终局检查、非法着手重选、认输、视角换算、死子分块与阈值、参数校验、最短思考时间。
- `test/ai/katago.test.js`：用 `test/ai/fixtures/fake-katago.js`（一个说 KataGo 协议的 node 脚本）测进程管理：超时与 terminate、崩溃重启与退避、启动失败与不可用、卡死、关闭。
- `test/ai/fallback.test.js`、`fake.test.js`、`levels.test.js`。

真实 KataGo 的集成测试（设置了三个环境变量才运行，否则跳过）：

```bash
KATAGO_PATH=./katago/katago.exe \
KATAGO_MODEL=./katago/kata1-b10c128-s1141046784-d204142634.txt.gz \
KATAGO_CONFIG=./katago/analysis.cfg \
node --disable-warning=ExperimentalWarning --test test/katago.real.test.js
```

上面是 bash / Git Bash 的写法；Windows PowerShell 和 cmd 不支持 `VAR=… 命令`，要先设环境变量（只对当前窗口有效）：

```powershell
$env:KATAGO_PATH = './katago/katago.exe'
$env:KATAGO_MODEL = './katago/kata1-b10c128-s1141046784-d204142634.txt.gz'
$env:KATAGO_CONFIG = './katago/analysis.cfg'
node --disable-warning=ExperimentalWarning --test test/ai/ test/katago.real.test.js
```

```bat
rem cmd
set KATAGO_PATH=./katago/katago.exe
set KATAGO_MODEL=./katago/kata1-b10c128-s1141046784-d204142634.txt.gz
set KATAGO_CONFIG=./katago/analysis.cfg
node --disable-warning=ExperimentalWarning --test test/ai/ test/katago.real.test.js
```

它检查：协议细节、负载高时排队请求一起超时不会被误判为卡死、8 档难度在 9/13/19 路都给出合法着手、局面已定且人停一手后 AI 也 pass（包括对方死子还留在 AI 地里时）、
弱档不会凭 1 次评估认输一盘搜索认为能赢的棋、终局判出死子（9/13/19 路，黑白双方、多子块）且数子结果正确、双活不判死、没有死子时返回空数组、
进程被杀后自动重启并继续服务。在上面那台开发机上约 40 秒跑完（连同 `test/ai/` 约 47 秒）。

**完整对局验证**（真实 KataGo v1.18.1，b10c128，本仓库的 `analysis.cfg`，2026-09-25）：通过 `createAiService` 让各档互相下完整盘
（直到双方 pass 或认输），每一手都用本项目引擎校验合法性，双方 pass 后调用 `judgeDead` 并按数子法计分，再与 KataGo 自己 200 次搜索的归属计数对比。
9 路各档循环赛（每对双方各执黑一次）、各档对最强档、各档对随机 / 内置练习 AI，以及 13/19 路若干盘，共 169 盘：

- 没有非法着手，没有返回格式错误，没有不终止的对局（9 路最长 165 手、13 路 260 手，都在 2.5 × 路数² 以内）；
- 不同难度对局 136 盘里难度高的一方胜 125 盘；爆冷的 11 盘都在 9 路 k12～d5 之间、相差 1～3 档（如 k8 胜 k1、d3 各 2 盘），
  说明 9 路上中间几档的差距偏小（小棋盘级位修正未经校准，见 2.1）；k18 与最强档的对局、各档对随机 / 内置练习 AI 全部符合预期；
- 双方 pass 结束的 34 盘里 33 盘的数子结果与 KataGo 的归属计数完全一致；例外是 19 路 k18 对内置练习 AI：k18 大优时在第 110 手左右
  就 pass（policy 第一是 pass，KaTrain 规则如此），对方也 pass，盘面还有大片未定，数子结果胜负正确但目差偏小；
- 认输前的核实搜索加上之后，43 盘认输全部得到 400 次搜索的支持（之前 96 盘里有 5 盘不支持，另有 1 盘是能赢的棋）；
- "局面已定就 pass"加上之后，各档对随机 / 内置练习 AI 的 51 盘（9 路与 13 路）里，对方第一次 pass 后 AI 都是下一手就 pass
  （之前弱档常要再下 8~20 手），全部获胜；其中核对过的 21 盘，数子结果与 KataGo 的归属计数完全一致、终局没有未定的点。

其他模块的测试用 `require('../src/ai/fake').createFakeAiService()`（与 AiService 同接口、确定性、不需要 KataGo）。

---

## 8. 许可与致谢

### 8.1 KataGo

- 作者 David J Wu（"lightvector"）等，https://github.com/lightvector/KataGo 。代码采用 MIT 许可
  （"Copyright 2025 David J Wu ("lightvector") and/or other authors"），另含若干第三方库，各有自己的许可（见其仓库 `LICENSE` 与 `cpp/external/`）。
- 本项目**不修改、不打包** KataGo，只在服务器上作为独立进程调用。分发或部署 KataGo 可执行文件时请保留其版权与许可声明。
- 神经网络权重（katagotraining.org 的 kata1 系列）同样是 MIT 风格的许可，版权人 David J Wu，要求在副本中保留版权与许可声明，
  详见 https://katagotraining.org/network_license/ （更早的 g170 系列为 CC0）。

### 8.2 KaTrain（弱档算法）

`server/src/ai/rank.js` 移植自 KaTrain（https://github.com/sanderland/katrain ，commit `f4981cf905cece90085ce4e3967415d0c16d525f`）
的 `RankStrategy`、`PolicyStrategy` 及相关辅助函数；段位校准公式的作者是 bale-go（https://github.com/bale-go ，
见 KaTrain issue #44、#74）。文件头保留了完整的版权与许可声明，原文如下：

```
Copyright 2020 Sander Land and/or other authors of the content in this repository.
(See 'CONTRIBUTIONS.md' file for a list of authors as well as other indirect contributors).

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

建议在小程序的"关于 / 开源许可"页面注明："人机对弈使用 KataGo（MIT）；AI 难度算法移植自 KaTrain（MIT），段位校准公式作者 bale-go。"

完整的第三方声明（KaTrain、KataGo 程序与权重的许可原文、ws 等）见仓库根目录的 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。
