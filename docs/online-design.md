# 围棋小程序 v2 — 联网对弈 / 人机对弈 / 排行榜 设计文档

日期：2026-09-25
状态：实现中（本文件是各模块实现的**接口契约**，改接口必须先改这里）

## 0. 决策摘要

| 项 | 决定 |
|---|---|
| 客户端 | 原生微信小程序（沿用 v1 的 `miniprogram/`，保留本地对弈） |
| 服务端 | 自建服务器，Node.js ≥ 22.13，`node:http` + `ws`，SQLite（`node:sqlite`），单进程 |
| 连接 | REST（`wx.request`）做登录/资料/排行/棋谱；WebSocket（`wx.connectSocket`）做匹配、房间、对局 |
| 规则 | 中国规则：数子法、黑贴 7.5 目、简单劫、禁自杀；联网与人机对局服务端权威判定 |
| AI | 服务端 KataGo 分析引擎（`katago analysis`），多档难度；同时用它的归属判断（ownership）在终局判定死子 |
| 终局 | 双方连续 pass → 数子阶段：服务端给出死子建议 → 双方可点选修改 → 双方确认后按数子法计分；有异议可"继续对局" |
| 排行榜 | 只统计**快速匹配（排位）**的真人对局；好友房是友谊赛、人机对局都不计入。三个榜：当前连胜、最高连胜、胜率（≥10 局上榜） |
| 用时 | 排位与好友对局：基本时间 + 读秒（按路数预设）；人机对局不计时 |

## 1. 目录结构与模块归属

```
miniprogram/                       小程序（miniprogramRoot）
  app.js / app.json / app.wxss
  config.js                        服务器地址等配置                 [client-infra]
  utils/engine/                    纯 JS 规则引擎（客户端与服务端共用）[已完成]
    board.js rules.js game.js score.js coords.js record.js
  utils/net/                       网络层                           [client-infra]
    emitter.js api.js auth.js socket.js
  utils/clock.js                   读秒显示计算                      [client-infra]
  utils/format.js                  胜率/时间等格式化                  [client-infra]
  components/goboard/              棋盘（新增：死子/地盘标记、tap 事件、禁用触摸）[client-play]
  components/avatar/               头像（无头像时显示昵称首字）         [client-infra]
  pages/index/                     首页（入口导航）                   [client-pages]
  pages/local/                     本地对弈开局设置（v1 首页内容移到这里）[client-pages]
  pages/game/                      本地对弈对局页（v1，保持不变）
  pages/profile/                   头像昵称设置                      [client-pages]
  pages/match/                     快速匹配等待                      [client-pages]
  pages/room/                      好友房（创建 / 受邀加入 / 输入房号）  [client-pages]
  pages/ai/                        人机对弈设置（路数、难度、执子）     [client-pages]
  pages/play/                      联网 / 人机对局页                  [client-play]
  pages/leaderboard/               排行榜                            [client-pages]
  pages/me/                        我的战绩与对局列表                 [client-pages]
  pages/replay/                    棋谱复盘                          [client-play]
server/
  package.json                     依赖只有 ws（和可选的 busboy）      [server-core]
  .env.example                                                       [server-core]
  katago/analysis.cfg              KataGo 分析引擎配置模板             [server-ai]
  src/index.js                     入口：组装各模块                    [server-core]
  src/config.js                    读取环境变量                        [server-core]
  src/engine.js                    转出 ../../miniprogram/utils/engine  [server-core]
  src/logger.js                                                        [server-core]
  src/db/                          SQLite：迁移与仓储                  [server-core]
  src/auth/                        微信登录、开发登录、会话令牌          [server-core]
  src/http/                        REST 路由、头像上传、静态文件         [server-core]
  src/ws/                          WebSocket 连接、协议校验、消息路由    [server-game]
  src/game/                        读秒、对局会话、匹配、好友房、对局管理  [server-game]
  src/ai/                          KataGo 适配、分级策略、假引擎         [server-ai]
  test/                            服务端测试（node:test）             [各模块各写各的]
docs/online-design.md              本文件
docs/deploy.md                     部署文档                            [server-core]
docs/ai.md                         KataGo 安装、难度、调参、排查与测试   [server-ai]
README.md                          仓库总览与快速开始
test/                              引擎测试（已有）+ 客户端纯逻辑测试 test/client/ [client-infra]
```

方括号是实现时的文件归属，**只改自己名下的文件**；需要别人的接口时按本文档调用，发现本文档有问题时在交付说明里提出。

服务端通过 `server/src/engine.js` 引用小程序里的引擎（`require('../../miniprogram/utils/engine/...')`），部署时整个仓库一起上传，规则只有一份。

## 2. 共用引擎（已完成）

`miniprogram/utils/engine/`，全部 CommonJS，不依赖 wx API，Node 可直接 require。

| 模块 | 导出 |
|---|---|
| `board.js` | `Board`（`n`、`cells: Int8Array`、`toIdx/toXY/get/set/neighbors/group/clone`）、`EMPTY=0 BLACK=1 WHITE=2`、`opponent(c)` |
| `rules.js` | `tryPlay(board, color, ko, idx)`、`canPlay(board, color, ko, idx)` → `{ok, reason}`，reason ∈ `occupied / ko / suicide` |
| `game.js` | `createGame({size, komi, autoScore})`、`play(s, idx)`、`pass(s)`、`undo(s)`、`resign(s, color?)`、`resume(s)`、`finish(s, result)` |
| `score.js` | `score(board, komi)`（Tromp-Taylor）、`scoreArea(board, komi, dead)` → `{black, white, winner, blackStones, whiteStones, blackArea, whiteArea, owner[], dead[]}`、`toggleDead(board, dead, idx)` → 新 dead 数组 |
| `coords.js` | `PASS=-1`、`idxToGtp/gtpToIdx`（KataGo 坐标，如 `Q16`）、`idxToSgf/sgfToIdx` |
| `record.js` | `movesOf(state)`、`replay(size, komi, moves, {autoScore=false})`（非法着手抛错，`err.moveIndex`；数子阶段之后若还有着手，视为当时选择了"继续对局"，自动 `resume`）、`resultText(result)`（`B+R`/`W+T`/`B+3.5`/`0`/`Void`）、`resultLabel(result)`（中文）、`toSgf({...})` |

每手历史记录含 `passesBefore`（这一手之前的连续 pass 数），`undo` 据此精确恢复。
对局状态 `status` 取值：`playing` → `scoring`（仅 `autoScore:false`）→ `ended`。
`result = { winner: 0|1|2, reason: 'score'|'resign'|'timeout'|'abort', black: number|null, white: number|null }`。

**着手序列**：`moves: number[]`，落子为 idx（`y*n+x`，左上角为 0），pass 为 `-1`，黑先轮流。协议、数据库、复盘统一用它。第 k 手（从 1 数）的颜色 = k 为奇数时黑。

## 2.5 服务端模块组装接口（各模块之间只通过这些接口交互）

```js
// src/config.js  [server-core]
loadConfig(env = process.env) → Config          // 读取 server/.env（若存在）与环境变量
defaultConfig(overrides) → Config                // 测试用：全部默认值 + 覆盖
Config = {
  port, host, publicBaseUrl, dataDir, dbPath /* 可为 ':memory:' */, avatarDir,
  wx: { appId, secret },                         // 空串表示未配置
  devLogin: boolean,                             // 正式环境（NODE_ENV=production 或 https 对外地址）开启时拒绝启动，见第 9 节
  secCheck: 'off' | 'on' | 'strict',             // 昵称/头像的内容安全检测，见第 4 节
  katago: { path, model, config } | null,        // 三项都配置了才非 null
  aiFallback: boolean,
  komi: 7.5,
  timeControls: { 9: TC, 13: TC, 19: TC },       // TC = { mainMs, periods, periodMs }
  minMovesRanked: 10, minGamesWinrate: 10,
  rankedPairDailyMax: 3,                         // 同一对手 24 小时内最多计入排行的局数（0 = 不限），见 6.6
  firstMoveTimeoutMs: 60000, abandonMs: 90000, scoringTimeoutMs: 180000, judgeTimeoutMs: 15000,
  aiIdleTimeoutMs: 86400000, roomTtlMs: 1800000,
}

// src/logger.js  [server-core]
createLogger({ level = 'info' }) → { debug, info, warn, error }   // 测试传 silentLogger
silentLogger

// src/util/public-user.js  [server-core]
publicUser(user, publicBaseUrl) → { id, nickname, avatarUrl }      // REST 用
playerInfo(user, publicBaseUrl) → { userId, nickname, avatarUrl }  // 对局快照用

// src/ai/service.js  [server-ai]    见第 7 节
createAiService({ config, logger }) → AiService

// src/http/server.js  [server-core]
createHttpServer({ config, repos, ai, logger, now, getActiveGames /* (userId) → [{ id, mode }] */ }) → http.Server（未 listen）

// src/realtime.js  [server-game]
createRealtime({ httpServer, repos, ai, config, logger, now = Date.now, timers = { setTimeout, clearTimeout, setInterval, clearInterval } })
  → { activeGamesOf(userId) → [{ id, mode }], close() → Promise<void> }
// 在 httpServer 上挂 WebSocket（路径 /ws，upgrade 时用 repos.sessions.resolve 校验 token），
// 内部创建匹配队列、好友房、对局管理器，并恢复未结束的对局。

// src/app.js  [server-core]
startServer({ config, ai?, logger?, now? }) → Promise<{ url, port, repos, ai, close() }>
// 打开数据库、建 repos、未传 ai 时 createAiService、建 http 与 realtime、listen（port 0 表示随机端口）。
// 集成测试用它启动完整服务；src/index.js 用 loadConfig() 调它并处理 SIGINT/SIGTERM。
```

## 3. 数据库（server-core）

SQLite 单文件，WAL 模式。时间一律存毫秒时间戳（INTEGER）。

```sql
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  openid        TEXT UNIQUE,              -- 微信 openid；开发登录为 'dev:<deviceId>'
  nickname      TEXT NOT NULL DEFAULT '',
  avatar        TEXT NOT NULL DEFAULT '',  -- 头像文件名（不含域名），空串表示无
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,             -- 32 字节随机数的 hex
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL              -- 30 天，resolve 时滑动续期（剩余不足 15 天时续到 30 天）
);
CREATE TABLE games (
  id           TEXT PRIMARY KEY,           -- 12 位随机 base36
  mode         TEXT NOT NULL,              -- 'ranked' | 'friend' | 'ai'
  size         INTEGER NOT NULL,
  komi         REAL NOT NULL,
  black_id     INTEGER,                    -- AI 一方为 NULL
  white_id     INTEGER,
  ai_level     TEXT,                       -- 人机对局的难度 id，否则 NULL
  time_control TEXT,                       -- JSON {mainMs, periods, periodMs}，人机为 NULL
  status       TEXT NOT NULL,              -- 'playing' | 'scoring' | 'ended'
  moves        TEXT NOT NULL DEFAULT '[]', -- JSON 着手序列
  clocks       TEXT,                       -- JSON 读秒快照（重启恢复用）
  dead         TEXT,                       -- JSON 死子数组（终局时）
  winner       INTEGER,                    -- 0/1/2，未结束为 NULL
  reason       TEXT,                       -- 'score'|'resign'|'timeout'|'abort'
  score_black  REAL,
  score_white  REAL,
  result_text  TEXT,                       -- resultText()
  counted      INTEGER NOT NULL DEFAULT 0, -- 已计入排行统计则为 1
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  state        TEXT,                       -- 迁移 3：JSON 会话附加状态 { resumesUsed, guard }（见 6.5），进行中随进度保存，终局清空
  cause        TEXT                        -- 迁移 3：终局细分原因（Result.cause，见 5.4）
);
CREATE INDEX games_black ON games(black_id, created_at);
CREATE INDEX games_white ON games(white_id, created_at);
CREATE INDEX games_status ON games(status);
CREATE INDEX sessions_user ON sessions(user_id, created_at);   -- 迁移 2
CREATE INDEX sessions_expires ON sessions(expires_at);         -- 迁移 2
CREATE INDEX games_ai_black ON games(black_id, winner) WHERE mode = 'ai' AND status = 'ended' AND reason != 'abort';  -- 迁移 2，人机战绩
CREATE INDEX games_ai_white ON games(white_id, winner) WHERE mode = 'ai' AND status = 'ended' AND reason != 'abort';  -- 迁移 2
CREATE TABLE user_stats (                  -- 只统计排位赛
  user_id        INTEGER PRIMARY KEY REFERENCES users(id),
  games          INTEGER NOT NULL DEFAULT 0,
  wins           INTEGER NOT NULL DEFAULT 0,
  losses         INTEGER NOT NULL DEFAULT 0,
  draws          INTEGER NOT NULL DEFAULT 0,
  cur_streak     INTEGER NOT NULL DEFAULT 0,
  max_streak     INTEGER NOT NULL DEFAULT 0,
  cur_streak_at  INTEGER,                  -- 当前连胜达到现值的时间
  max_streak_at  INTEGER,                  -- 最高连胜达到现值的时间
  updated_at     INTEGER NOT NULL
);
```

迁移：`PRAGMA user_version` 记录版本，`migrations.js` 按序执行。

### 3.1 仓储接口 `createRepos(db)`

```js
{
  users: {
    findById(id) → User|null,
    findByOpenid(openid) → User|null,
    create({ openid, nickname = '', avatar = '' }, now) → User,
    updateProfile(id, { nickname?, avatar? }, now) → User,
    touchLogin(id, now),
  },
  sessions: {
    create(userId, now) → token,           // 每个用户只保留最新的 10 个令牌（更早的作废）
    resolve(token, now) → userId|null,     // 过期返回 null；滑动续期
    revoke(token),
    purgeExpired(now) → number,            // 删除所有过期令牌（服务启动时与每小时执行一次）
  },
  games: {
    insert(row),                           // row 字段同表（moves/clocks/... 传 JS 值，内部 JSON 化）
    saveProgress(id, { status, moves, clocks, state }, now),   // state：会话附加状态（JSON），见 6.5
    finish(id, { status: 'ended', moves, dead, winner, reason, scoreBlack, scoreWhite, resultText, cause }, now) → bool,  // 不写 counted，counted 只由 applyRanked 置 1；同时清空 state
    findById(id) → GameRow|null,           // JSON 字段已解析（损坏的 JSON 字段按空值返回，不抛错）
    listByUser(userId, { before, limit }) → GameRow[],  // 按 created_at 倒序，只返回 ended（执黑、执白两路各走索引再合并）
    listUnfinished() → (GameRow | { id, broken: true, error })[],  // status != 'ended'，重启恢复用；解析不了的行标 broken，由恢复逻辑作废（只是 state 坏了按 null，不算 broken）
    countCountedBetween(a, b, since) → number,  // 两人之间 created_at >= since、已计入排行的排位赛局数（不分黑白），同一对手每日上限用（6.6）
    discard(id) → bool,                    // 删除未结束的对局（玩家一手没下就被新开局顶替的人机对局）；已结束的不删
  },
  stats: {
    get(userId) → RankedStats,             // 不存在时返回全 0 对象；RankedStats 见第 4 节（另含 curStreakAt、maxStreakAt）
    applyRanked({ gameId, winnerId, loserId, draw, userIds }, now) → bool,  // 同一事务内：counted 0→1 守卫 + 更新双方；已计过返回 false
    leaderboard(type, limit) → [{ rank, userId, nickname, avatar, value, games, wins }],
    rankOf(type, userId) → { rank|null, value, games, wins, need }  // need：胜率榜还差几局上榜
  },
  transaction(fn) → fn 的返回值（BEGIN/COMMIT，异常时 ROLLBACK）
}
```

User 对象：`{ id, openid, nickname, avatar, createdAt, lastLoginAt }`。对外（REST/WS）只暴露 `{ id, nickname, avatarUrl }`，`avatarUrl = avatar ? PUBLIC_BASE_URL + '/avatars/' + avatar : ''`。

### 3.2 统计规则

排位赛结束且满足计入条件（见 6.6）时调用 `applyRanked`，在一个事务里：

- 胜者：`games+1, wins+1, cur_streak+1, cur_streak_at=now`；若 `cur_streak > max_streak` 则 `max_streak=cur_streak, max_streak_at=now`。
- 负者：`games+1, losses+1, cur_streak=0, cur_streak_at=NULL`。
- 和棋（整数贴目时才可能）：双方 `games+1, draws+1`，连胜不变。
- 同一局只计一次：`games.counted` 由 0 改 1 与统计更新在同一事务里（`UPDATE games SET counted=1 WHERE id=? AND counted=0`，changes=0 则不再更新统计）。

### 3.3 排行榜

| type | 条件 | 排序（依次） | value |
|---|---|---|---|
| `streak` 当前连胜 | `cur_streak > 0` | `cur_streak DESC, cur_streak_at ASC, user_id ASC` | cur_streak |
| `maxStreak` 最高连胜 | `max_streak > 0` | `max_streak DESC, max_streak_at ASC, user_id ASC` | max_streak |
| `winrate` 胜率 | `games >= MIN_GAMES_WINRATE`（默认 10） | `wins*1.0/games DESC, games DESC, user_id ASC` | 胜率，0~1 小数 |

名次为排序后的位置（1 起），不做并列。`rankOf` 用"比我严格靠前的人数 + 1"计算（与列表一致）；不满足条件时 `rank=null`，胜率榜额外给 `need = MIN_GAMES_WINRATE - games`。

## 4. REST API（server-core）

- 统一前缀 `/api`，请求与响应均为 JSON（头像上传除外）。
- 鉴权：`Authorization: Bearer <token>`；缺失或失效返回 401 `{ error: { code: 'unauthorized', msg } }`。
- 错误统一格式：HTTP 4xx/5xx + `{ error: { code, msg } }`；成功：HTTP 200 + 数据对象。
- 请求体上限 16KB（头像 2MB）。
- 限流（nginx 的 `limit_req` 之外应用层再兜一层）：登录接口（`login`/`dev-login`）按 IP 突发 30 次、之后每秒 1 次，同时在请求微信 code2Session 的最多 16 个；需要令牌的接口按用户突发 60 次、之后每秒 10 次；头像上传按用户突发 5 次、之后每 12 秒 1 次，全服同时最多处理 4 个。超出返回 429 `{ error: { code: 'rate_limited' } }` 并带 `Retry-After`（秒）。IP 取 TCP 对端地址，只有对端是本机（nginx）时才用 `X-Real-IP`。
- 内容安全（`SEC_CHECK`，默认 `on`，配置了 `WX_APPID/WX_SECRET` 才生效，开发登录的用户跳过）：昵称用 msgSecCheck 2.0（scene 1）、头像用 imgSecCheck 检测，判定违规返回 400 `content_risky`。
  - 用户自己能造成的情况在任何模式下都拒绝（否则直接调接口就能绕过检测）：头像超出 imgSecCheck 的送检限制（1MB、750×1334）→ 400 `bad_request`「头像图片太大」（客户端上传前应压缩）；msgSecCheck 返回 61010（该用户近两小时没有访问过小程序）→ 400 `sec_check_retry`「请重新打开小程序后再修改昵称」。
  - 微信那边出错（HTTP/网络/超时、-1、配额 45009 等）：`on` 放行，`strict` 拒绝（503 `sec_check_unavailable`）；两种模式都把微信的 errcode 记进日志。
  - imgSecCheck 是微信已停止更新的 1.0 同步接口（2.0 只有需要消息推送的异步 mediaCheckAsync），头像检测只算尽力而为，见 deploy.md 第 4 节。

| 方法 路径 | 鉴权 | 请求 | 响应 |
|---|---|---|---|
| `POST /api/auth/login` | 否 | `{ code }`（wx.login） | `{ token, user, needProfile }` |
| `POST /api/auth/dev-login` | 否 | `{ deviceId }`（仅 `DEV_LOGIN=1` 时存在，否则 404） | 同上 |
| `POST /api/auth/logout` | 是 | — | `{ ok: true }`（注销当前令牌；其他设备的令牌不受影响，已建立的 WebSocket 连接在断开前不受影响） |
| `GET /api/me` | 是 | — | `{ user, needProfile, stats: RankedStats, ai: { games, wins }, activeGameIds: string[] }` |
| `PUT /api/me/profile` | 是 | `{ nickname }`（1~16 个字符，去首尾空白，禁止控制字符；内容安全检测） | `{ user }` |
| `POST /api/me/avatar` | 是 | multipart/form-data，字段名 `file`，png/jpeg，≤2MB，宽高 ≤2048，结构完整（PNG 有 IHDR/IEND，JPEG 有帧头/EOI）；内容安全检测 | `{ user }` |
| `GET /api/leaderboard?type=streak\|maxStreak\|winrate&limit=50` | 是 | — | `{ type, items: [...], me: { rank, value, games, wins, need } , minGames }` |
| `GET /api/games?before=<ts>&limit=20` | 是 | — | `{ items: GameSummary[], next: ts|null }` |
| `GET /api/games/:id` | 是 | — | `GameRecord`（只能看自己参与的对局） |
| `GET /api/ai/levels` | 否 | — | `{ available: bool, levels: [{ id, name, desc }] }` |
| `GET /avatars/<file>` | 否 | — | 图片（仅 `[a-z0-9]+\.(png|jpg)` 文件名） |
| `GET /healthz` | 否 | — | `{ ok: true }` |

`needProfile = !user.nickname`。`RankedStats = { games, wins, losses, draws, winrate, curStreak, maxStreak }`（winrate 为 0~1，games=0 时为 0）。

`GameSummary = { id, mode, size, myColor, opponent: { id, nickname, avatarUrl } | { ai: true, level, levelName }, winner, reason, cause /* Result.cause，旧记录为 null */, resultText, myResult: 'win'|'loss'|'draw'|'void', moveCount, createdAt, endedAt }`
`GameRecord = GameSummary + { komi, moves, dead, players: { 1: PlayerInfo, 2: PlayerInfo }, scoreBlack, scoreWhite }`

登录流程：`/auth/login` 用 code 调微信 `jscode2session` 换 openid → 查找或创建用户 → 发令牌。微信接口失败返回 502 `{ error: { code: 'wx_login_failed', msg } }`。未配置 `WX_APPID/WX_SECRET` 时返回 503 `{ error: { code: 'wx_not_configured' } }`，客户端据此在开发模式下改走 dev-login。

## 5. WebSocket 协议（server-game 实现，client-infra/client-play 使用）

连接：`WS_URL`，令牌放在 `Authorization: Bearer <token>` 头里（推荐：不会出现在 nginx 访问日志里；`wx.connectSocket` 的 `header` 支持），或 `WS_URL?token=<token>`（兼容）。两者都有时以头为准。服务端在 HTTP upgrade 阶段校验令牌，失败直接回 401 并关闭（客户端收到 onClose/onError 后重新登录再连）。

- 同一用户建立连接的频率有限：突发 10 次、之后每 6 秒 1 次，超出回 429（客户端按退避重连即可）。
- 同一用户新连接建立后，旧连接收到 `{ t: 'kicked', reason: 'replaced' }` 并以 4001 关闭，客户端**不要**自动重连被踢的连接。顶替时该用户退出匹配队列（在匹配页上的客户端重连后收到 `ready` 会重新 `match.join`）；好友房保留。
- 服务端每 25 秒发 WebSocket ping，两次无 pong 断开。客户端每 20 秒发 `{ t: 'ping' }`，服务端回 `{ t: 'pong', ts }`，客户端 10 秒未收到 pong 视为断线并重连。
- 单条消息 ≤ 16KB；每个用户每秒 ≤ 20 条（按用户计，重连不清零），超出以 4008 关闭。
- 对方长期不读数据、服务端发送积压超过 1MB 的连接直接断开。

### 5.1 消息格式

客户端 → 服务端：`{ t: string, rid?: number, ...参数 }`。带 `rid` 的消息，服务端必须回一条
`{ t: 'res', rid, ok: true, data? }` 或 `{ t: 'res', rid, ok: false, err: { code, msg } }`。
服务端推送：`{ t: string, ...数据 }`（没有 rid）。

### 5.2 客户端请求

| t | 参数 | 成功 data | 说明 |
|---|---|---|---|
| `ping` | — | — | 回 `pong`（不回 res） |
| `hello` | — | `{ activeGames: [{ id, mode }], room: Room|null, matching: { size }|null }` | 连接建立后客户端首先发送，用于恢复页面 |
| `match.join` | `{ size }` 9/13/19 | `{ size }` | 已在排位/好友对局中 → `err.code='in_game'`；会取消该用户的好友房 |
| `match.cancel` | — | — | 不在队列中也返回 ok |
| `room.create` | `{ size, color: 'black'|'white'|'random' }` | `{ room }` | 已有房间则先关闭旧房间；会取消匹配 |
| `room.get` | `{ code }` | `{ room }` | 受邀者进入页面时查看房间；不存在 → `room_not_found`；同一用户找不到房间累计 10 次（之后每 6 秒恢复 1 次）→ `rate_limited`（防猜房号） |
| `room.join` | `{ code }` | `{ gameId }` | 加入即开局（房主不在线也可以，见 6.2"到场"）；自己的房间 → `own_room`；房间已开局/过期 → `room_not_found`；猜房号限流同 `room.get` |
| `room.leave` | — | — | 关闭自己创建的房间 |
| `ai.start` | `{ size, level, color: 'black'|'white'|'random' }` | `{ gameId }` | 已有进行中的人机对局会被作废（abort；玩家一手没下的直接删除，不留记录，仍推送 `game.end`）；在排位/好友对局中 → `in_game`；每个用户突发 5 次、之后每 10 秒 1 次，超出 → `rate_limited`；AI 不可用 → `ai_unavailable` |
| `game.sync` | `{ gameId }` | `{ game: Snapshot }` | 获取完整快照并订阅该局推送 |
| `game.move` | `{ gameId, n, idx }` | — | `n` = 这一手的序号（当前 moves.length + 1），不一致 → `stale`；非法 → `illegal`（msg 含原因） |
| `game.pass` | `{ gameId, n }` | — | 同上 |
| `game.resign` | `{ gameId }` | — | 对局中或数子阶段均可 |
| `game.undo` | `{ gameId }` | — | 仅人机对局：撤回到上一次轮到人的局面（人的上一手及 AI 的应手）；无可悔 → `nothing_to_undo` |
| `game.score.toggle` | `{ gameId, idx, version? }` | — | 数子阶段切换该块死活：真人对局；人机对局仅当 `scoring.source === 'manual'`（死子判断失败）时，否则 `bad_request`。`version`（可选，建议总是带上）：点选时看到的数子版本，不是当前版本 → `stale`，这样点选不会落在自己还没看到的修改之上 |
| `game.score.accept` | `{ gameId, version }` | — | version 不是当前版本 → `stale` |
| `game.score.resume` | `{ gameId }` | — | 不同意数子结果，回到对局。真人对局每方每局最多 1 次（`scoring.resumesLeft`，服务端重启不清零），用完 → `wrong_phase`；对手不在线 → `wrong_phase`（等自动确认） |

常见错误码：`bad_request`、`not_found`、`not_player`、`not_your_turn`、`illegal`、`stale`、`in_game`、`room_not_found`、`own_room`、`ai_unavailable`、`nothing_to_undo`、`wrong_phase`、`rate_limited`、`internal`。

### 5.3 服务端推送

| t | 数据 | 时机 |
|---|---|---|
| `pong` | `{ ts }` | 回应 ping |
| `kicked` | `{ reason }` | 被新连接顶替 |
| `match.found` | `{ gameId }` | 匹配成功（双方都收到） |
| `room.update` | `{ room }` | 房间状态变化（目前只有过期 `status:'closed'`） |
| `game.start` | `{ gameId, mode }` | 好友房开局（房主和加入者都收到） |
| `game.move` | `{ gameId, n, idx, color, captured: idx[], clocks }` | 任一方落子（包括 AI）。`idx=-1` 表示 pass |
| `game.undo` | `{ gameId, moves: number[] }` | 人机对局悔棋后的完整着手序列 |
| `game.ai` | `{ gameId, thinking: bool }` | AI 开始/结束思考 |
| `game.scoring` | `{ gameId, scoring: Scoring }` | 进入数子阶段、死子建议到达、有人点选、有人确认 |
| `game.resumed` | `{ gameId, toPlay, clocks }` | 有人选择继续对局 |
| `game.end` | `{ gameId, result: Result, stats?: { [color]: RankedStats } }` | 终局（排位赛附双方最新统计）。按数子终局时先推送一条 `game.scoring`（最终采用的死子）。终局结果写库失败时 `result.pending` 为 true、`counted` 为 false、不附 `stats`；服务端之后重试补写，成功后**再推送一次** `game.end`（`pending: false`、`counted` 为实际值，排位赛附 `stats`）——客户端对已终局的对局再收到 `game.end` 时，以新的 `result`/`stats` 为准 |
| `game.presence` | `{ gameId, color, online: bool, clocks?: Clocks }` | 对手上下线。有读秒的对局附当前 `Clocks`：到场（6.2）的一方上线时他的钟才开始走，对手据此更新显示 |

### 5.4 快照与数据结构

```js
Snapshot = {
  id, mode: 'ranked'|'friend'|'ai', size, komi,
  players: { 1: PlayerInfo, 2: PlayerInfo },
  myColor: 1|2,
  moves: number[],
  status: 'playing'|'scoring'|'ended',
  toPlay: 1|2,
  timeControl: { mainMs, periods, periodMs } | null,   // 人机为 null
  clocks: Clocks | null,
  scoring: Scoring | null,                             // 仅 scoring/ended
  result: Result | null,
  presence: { 1: bool, 2: bool },                      // AI 一方恒为 true
  aiThinking: bool,
  canUndo: bool,                                       // 人机对局且有可悔的着手
}
PlayerInfo = { userId, nickname, avatarUrl } | { ai: true, level, nickname /* 如 'AI · 5级' */, avatarUrl: '' }
Clocks = {
  1: { mainMs, periodsLeft, periodMs },
  2: { mainMs, periodsLeft, periodMs },
  running: 1|2|null,                                   // 正在走的一方；数子阶段/终局为 null
}
// 服务端在发送时刻计算好 running 一方的剩余量；客户端记下收到的本地时刻，自行倒数。
// 注意：running 一方已进入读秒时，periodMs 是"当前这一次读秒还剩的毫秒数"，用完后下一次读秒的长度取 timeControl.periodMs；
// 因此客户端调用 displayClock(clock, elapsed, timeControl)。
Scoring = {
  pending: bool,             // true：正在等 KataGo 判断死子，dead/owner 暂不可用
  source: 'katago'|'manual', // manual：AI 不可用时初始为无死子，需手动点选
  version: number,           // 每次死子集合变化 +1，确认时须带上
  dead: number[],
  owner: number[],           // scoreArea().owner，长度 size*size
  black: number, white: number, winner: 0|1|2,
  accepted: { 1: bool, 2: bool },
  deadline: number|null,     // 自动确认剩余毫秒（发送时刻计算），人机为 null；有人点选后可能顺延（见 6.3）
  resumesLeft: { 1: number, 2: number } | null,   // 双方各还能"继续对局"几次；人机为 null（不限）
  atDeadline: { void: false, dead: number[], black, white, winner, same: bool }  // 时限到仍未达成一致时会按这组死子计分（same：与当前显示的相同）
            | { void: true, cause: 'score_dispute' | 'arrival' }            // 或者会作废（手动数子有争议 / 有人还没到场，见 6.3 第 6 步）
            | null,                                                          // 没有自动确认时限（人机、正在判断、已终局）
}
// 客户端据 atDeadline 提示"时限到将按 … 计分 / 将作废"：单方面的点选不决定结果，same 为 false 时要让用户知道。
// version 只在同一份死子建议之内递增：每次给出新的建议（进入数子阶段、继续对局后再次数子、
// 服务端重启后重新判断死子）都从 1 重新开始，双方确认清零。所以 version 相同不代表是同一份建议：
// 客户端判断"我是否已同意"必须以推送/快照里的 accepted 为准，本地记录只能用来填补 accept 的 res 与随后 game.scoring 推送之间的空档。
Result = {
  winner: 0|1|2, reason: 'score'|'resign'|'timeout'|'abort', black: number|null, white: number|null,
  text: string /* resultText */, label: string /* resultLabel */, counted: bool,
  cause: string|null,          // 细分原因，见下表；旧记录、认输为 null
  uncounted: 'short'|'pair_limit'|null,  // 排位赛、不是作废、却没计入的原因：手数不足（6.6）/ 同一对手 24 小时内的计入局数已满；其他情况为 null
  pending: bool,               // 终局结果写库失败、正在重试（此时 counted 为 false；补写成功后再推送一次 game.end）
}
Room = { code: string /* 6 位数字 */, owner: { userId, nickname, avatarUrl }, size, color: 'black'|'white'|'random', status: 'waiting'|'closed', expiresIn: number /* ms */ }
```

`Result.cause`（客户端据此说明结果，不要再按手数、轮到谁去猜）：

| reason | cause | 含义 |
|---|---|---|
| `abort` | `first_move` | 黑方开局后 60 秒内没下第一手 |
| `abort` | `arrival` | 开局时不在线 / 服务端重启后没回来的一方超过 5 分钟没到场（6.2）；或手动数子时有人没到场（6.3） |
| `abort` | `abandon` | 轮到的一方掉线太久，而他还一手没下（6.2） |
| `abort` | `score_dispute` | 手动数子（没有 KataGo 建议）时双方对死子有争议，时限到仍未一致（6.3） |
| `abort` | `replaced` / `idle` / `ai_error` | 人机对局：开了新的人机对局 / 24 小时无操作 / AI 连续出错 |
| `abort` | `broken` | 对局记录损坏，重启时无法恢复 |
| `timeout` | `clock` / `abandon` | 读秒用完 / 轮到时掉线太久（6.2） |
| `score` | `agreed` / `deadline` | 双方确认 / 自动确认时限到（6.3 第 6 步） |
| `score` | `resume_undone` | 继续对局被撤销：已同意数子结果的一方在走下一手之前掉线或读秒用完，按当时的数子结果终局（6.3 第 5 步），继续对局之后的着手作废 |

客户端收到 `game.move` 时，若 `n !== 本地 moves.length + 1`，丢弃并重新 `game.sync`。

## 6. 对局规则细节（server-game）

### 6.1 用时（读秒）

预设（可用环境变量覆盖）：9 路 3 分钟 + 3×20 秒；13 路 6 分钟 + 3×30 秒；19 路 10 分钟 + 3×30 秒。

- 轮到某方时开始计时；落子/pass 时扣除耗时：先扣基本时间；基本时间用完后进入读秒，每超过一个完整读秒周期消耗一次，本手在周期内完成则周期重置。
- 剩余读秒次数用尽即超时判负（`reason: 'timeout'`）。服务端用定时器在"剩余基本时间 + 剩余次数×周期"到期时判负，判负前按当前时间再算一次，防止定时器误差。
- 数子阶段与终局后停止计时；继续对局后从轮到的一方重新计时。
- 读秒逻辑写成可注入 `now()` 的纯模块 `game/clock.js`，用假时间单测。

### 6.2 开局与弃局

- 排位赛随机分配黑白；好友房按房主选择（random 则随机）。
- 开局后黑方 60 秒内未下第一手 → 对局作废（`reason:'abort'`，`cause:'first_move'`，不计统计）。
- 轮到的一方**掉线** → 至少等 90 秒（`ABANDON_MS`），基本时间还没用完则等到基本时间用完（掉线期间照常走钟，但不给读秒）→ 判其超时负（`cause:'abandon'`，计入排行的条件见 6.6）；他还一手没下（总手数 < 2，相当于没开始）则作废（`cause:'abandon'`）。未轮到的一方掉线不影响对局。已在读秒中的一方掉线 90 秒判负。
- **到场**：开局时不在线的玩家（好友房房主切到后台时有人加入）与服务端重启后恢复的对局里的玩家，在上线之前：不走他的钟、首手计时不开始、轮到他时不按掉线判负；上线时从那一刻开始计时（等待的时间不计）。轮到还没到场的一方超过 5 分钟（`arrivalGraceMs`）→ 对局作废（`cause:'arrival'`，不计统计）。到场的一方上线时，对手收到的 `game.presence` 附读秒（他的钟从这时开始走）。所以停机、或开局时不在场，都不会变成计入排行的超时负。
- 人机对局：玩家可以随时离开，对局保留；24 小时无操作自动作废。

### 6.3 数子阶段（真人对局）

1. 双方连续 pass → `status='scoring'`，停钟，推送 `game.scoring { pending: true }`。
2. 服务端调用 `ai.judgeDead(...)` 取得死子建议（每次超时 15 秒；失败或超时**重试一次**）；仍失败或 AI 不可用 → `source:'manual'`、`dead: []`。局面与上次 KataGo 判断时完全相同（继续对局后没落子就又双方 pass、人机数子阶段悔棋后又 pass）时直接复用上次的结果，不再请求 AI；每局同时最多一个在途的判断（同一局面等在途的结果，别的局面排在后面），过期的结果也按局面记下供复用。计算 `scoreArea` 后推送（version=1，双方 accepted=false，deadline=180 秒）。这份最初的建议记为"原建议"。
3. 任一方 `game.score.toggle` → 用 `toggleDead` 更新死子，version+1，**双方 accepted 清零**，推送。自动确认时限顺延到至少 60 秒之后（让对方有时间回应），但从建议给出起总共不超过 360 秒。toggle 带了 `version` 而不是当前版本 → `stale`（不会点在自己没看到的修改之上）。
4. `game.score.accept { version }` 与当前 version 一致 → 记该方确认；双方都确认 → 按当前死子计分终局（`reason:'score'`，`cause:'agreed'`）。
5. `game.score.resume` → 回到对局（引擎 `resume`，轮到最先 pass 的一方），重新计时，推送 `game.resumed`。每方每局最多 1 次（随进度保存，重启不清零）；对手不在线时不能继续。若继续时对方已同意当时的建议，而对方在走下一手之前就掉线弃局（掉线 90 秒即处理，不等他的基本时间用完）、或读秒用完（**不论是否在线**：他同意了就该得到同意的结果，掉线也能得到），则撤销这次继续对局（之后的着手作废），回到当时的数子阶段并按第 6 步的规则终局（`cause:'resume_undone'`）。这个保护也随进度保存，重启后仍然有效。
6. 时限到仍未达成一致 → 自动终局（`cause:'deadline'`）。"认可"一个死子集合 = 确认过它，或点选出它且它与原建议的差别**全是自己改的**（点在对方的修改之上、改到一半的中间状态都不算，免得被对方立即确认变成"双方认可"）。
   - KataGo 给出的建议（中立）：当前版本就是原建议、或双方都认可过当前版本 → 当前版本；否则用最近一个双方都认可过的版本；再没有就用原建议。单方面的点选（尤其是最后一刻或趁对方不在时）不会决定结果。
   - 手动数子（manual，"无死子"不是中立的建议，只对死子的主人有利）：双方都认可过的版本照用；否则有人还没到场（重启后没回来）→ **作废**（`cause:'arrival'`）；谁都没有对"无死子"表示过异议（没点选过别的集合、没确认过别的集合）→ 无死子；有异议（包括第 5 步被撤销的继续对局）→ **作废**（`cause:'score_dispute'`，不计入排行）。这样不合作（掉线、不回应、同意后离开）的一方拿不到错误的胜局；想赢的一方应在 pass 之前提净对方的死子（数子法下在自己地里提子不亏）。
   终局前先推送一条 `game.scoring`（最终采用的死子，与当前显示的不同时 version+1）；作废时直接推送 `game.end`。数子阶段的 `Scoring.atDeadline` 随时告诉客户端时限到会怎样。

### 6.4 人机对局

- 玩家选择路数、难度、执黑/执白/随机；贴目 7.5；不计时。
- 轮到 AI → 推送 `game.ai {thinking:true}` → `ai.chooseMove(...)` → 结果回来时若局面已变（悔棋/认输）则丢弃 → 否则落子或 pass 或认输，推送 `game.move`、`game.ai {thinking:false}`。
- 玩家 pass 后轮到 AI：AI 用 `humanJustPassed: true` 调用，若判断局面已定则 pass（进入数子阶段）。
- 数子阶段：`judgeDead` 的结果即为最终建议，AI 一方自动 accepted；**不允许点选修改**；玩家可确认（终局）或继续对局。死子判断失败（`source:'manual'`，如 `AI_FALLBACK`、KataGo 超时）时玩家可以点选死子，AI 一方保持已确认；没有自动确认时限。
- 悔棋：撤回到上一次轮到玩家的局面（玩家最近一手及其后的 AI 应手）；AI 思考中也可悔棋（思考结果作废）。数子阶段悔棋 = 撤回 pass 回到对局。
- AI 认输：由 AI 模块决定（见第 7 节），服务端照做。

### 6.5 连接与恢复

- 服务端内存中保存进行中的对局；每一手后 `games.saveProgress`（着手序列、读秒与附加状态 `state`：`{ resumesUsed: { 1, 2 }, guard: null | { color, movesLen, scoring } }`，即已用的"继续对局"次数与 6.3 第 5 步的继续对局保护）。
- 进程重启：`listUnfinished()` 恢复对局，读秒按保存值继续（停机时间不计入），继续对局次数与保护按 `state` 恢复（坏了就忽略），数子阶段重新请求死子建议（双方的确认与点选不保留）。恢复时所有玩家都还不在线，按 6.2 的"到场"处理：玩家重新连上之前不走他的钟、不判弃局，5 分钟内没回来的对局作废。无法解析的记录直接作废（记错误日志），不影响启动。
- 终局结果与排位统计写在同一个事务里；写库失败时推送的 `result.counted` 为 false、`result.pending` 为 true、不附统计，服务端按 1、5、15、60 秒…的间隔重试补写，成功后再推送一次 `game.end`（5.3），关机前再写一次。
- 内存里保留最近结束的对局（最多 2000 局、10 分钟）供断线重连的客户端 `game.sync`，更早的从数据库读。
- 玩家重连后发 `hello`，按返回的进行中对局跳转到对局页并 `game.sync`。

### 6.6 计入排行的条件

`mode === 'ranked'`，结果不是 `abort`，并且：

- 认输、超时（含掉线判负）：双方都至少下过一手（总手数 ≥ 2）。不能靠开局几手就认输、超时来躲开强手、保住连胜；自己还一手没下就认输/超时（相当于拒绝这盘棋）不计。
- 数子：落子数（不含 pass）≥ `MIN_MOVES_RANKED`（默认 10）。开局就双方 pass、确认刷不了胜局。
- 同一对手：24 小时内（按开局时间）两人之间已经计入 `RANKED_PAIR_DAILY_MAX` 局（默认 3，0 = 不限）之后，再下的排位赛不计（`uncounted:'pair_limit'`），防止两个账号反复匹配互刷连胜。

不满足则 `counted=false`（`Result.uncounted` 说明原因），只保存对局记录。

## 7. AI 模块（server-ai）

> 本节的 KataGo 协议细节以调研结论为准，见第 7.4 节。KataGo 的安装（各平台下载地址与 SHA-256）、难度、调参、排查与真实 KataGo 测试的说明见 [ai.md](ai.md)。

### 7.1 对外接口

```js
createAiService({ config, logger }) → AiService
AiService = {
  available() → bool,
  levels() → [{ id, name, desc }],
  chooseMove({ size, komi, moves, color, level, humanJustPassed }) → Promise<{ move: idx | -1, resign: bool, info?: { winrate, scoreLead, visits } }>,
  judgeDead({ size, komi, moves }) → Promise<{ dead: number[], source: 'katago' }>,   // 失败时 reject
  shutdown() → Promise<void>,
}
```

- `moves` 为着手序列；`color` 为 AI 执子颜色（必然等于轮到的一方）；`winrate/scoreLead` 统一换算为 **AI 视角**。
- 对局管理器限制在途的 `chooseMove`：每个玩家最多 2 个（被悔棋、认输、新开一局作废但 AI 还在算的也算，直到它结束或超时）、全服最多 16 个，超出的对局排队（仍显示"AI 思考中"），有名额时按先来后到派发。`judgeDead` 每局同时最多一个在途（6.3 第 2 步），结果按局面缓存。
- 服务端其他模块只依赖这个接口。测试用 `createFakeAiService()`（同接口，确定性、不需要 KataGo）。

### 7.2 实现组成

- `ai/katago.js`：`KataGoEngine`，管理 `katago analysis` 子进程：按行读取 stdout 的 JSON、按 id 匹配请求、忽略 stderr 日志；单请求超时；进程退出后自动重启（指数退避）；`shutdown()` 关闭 stdin 并等待退出。
- `ai/levels.js`：难度表。
- `ai/rank.js`：KaTrain "calibrated rank" 策略的 JavaScript 移植（MIT，文件头注明出处）。
- `ai/service.js`：`createAiService`：配置了 KataGo 就用它；否则 `AI_FALLBACK=1` 时用内置弱 AI（开发用）；否则 `available()=false`。
- `ai/fake.js`：`createFakeAiService()` 与一个模拟 KataGo 分析响应的 `FakeEngine`（给 `service.js` 的单测用）。

### 7.3 死子判定

对终局局面（完整着手序列，含最后两次 pass）发一次分析请求：`maxVisits: 200`、`includeOwnership: true`、`rules: 'chinese'`、`overrideSettings.reportAnalysisWinratesAs: 'BLACK'`（归属值 +1 = 黑）。
以"块"（同色连通块）为单位取归属平均值 `avg`，按块的颜色换算为本方视角 `own = color===BLACK ? avg : -avg`；`own <= -0.5` → 整块判死。

### 7.4 KataGo 调研结论（v1.18.1 实测，据此实现）

- 版本：v1.18.1 是最后一个带 Eigen（纯 CPU）构建的版本。优先使用 `eigenavx2` 版；CPU 不支持 AVX2 时用 `eigen` 版。Linux 版是 AppImage，缺 libfuse2 时设 `APPIMAGE_EXTRACT_AND_RUN=1`。
- 网络权重：推荐 `kata1-b10c128-s1141046784-d204142634.txt.gz`（14MB，CPU 上够快）；更小的有 `kata1-b6c96-s175395328-d26788732.txt.gz`（5MB）。
- 启动：`katago analysis -config <cfg> -model <net>`，stderr 出现 `Started, ready to begin handling requests` 即就绪（约 1 秒）。stdin 每行一个 JSON 请求，stdout 每行一个 JSON 响应，stderr 只是日志。
- 请求 `id` 必须是字符串。错误响应 `{ error, field, id }`；某些错误（非法 JSON、未知 action）**没有 id** → 每个请求必须有超时。发出 `{ id, action:'terminate', terminateId }` 可中止请求。实测父进程被强杀后 katago 会因 stdin 关闭在约 1 秒内自行退出；服务端关闭时仍主动 `proc.kill()` 兜底。
- 坐标：`moves: [['B','Q16'],['W','pass'],...]`，GTP 坐标（跳过 I），必须黑白交替（pass 也要写）。`policy` 长 n*n+1、`ownership` 长 n*n，都是行优先、从左上角开始，**下标与本项目 idx 完全一致**；`policy` 最后一项是 pass，非法点为 -1。
- 视角：`overrideSettings.reportAnalysisWinratesAs: 'BLACK'` 时 winrate / scoreLead / ownership 都是黑方视角。
- 规则：`chinese` 预设 = 简单劫、数子、禁多子自杀、贴目 7.5，与本项目引擎一致。**KataGo 对传入的 moves 很宽容**（劫、多子自杀都不报错），所以合法性只能由我们的引擎保证。
- pass：`chinese`（friendlyPassOk=true）下 KataGo 几乎从不把 pass 排第一。要让 AI 在终局正常 pass，搜索时用规则对象 `{"ko":"SIMPLE","scoring":"AREA","tax":"NONE","suicide":false,"hasButton":false,"whiteHandicapBonus":"0","friendlyPassOk":false}` 并加 `overrideSettings: { conservativePass: false, wideRootNoise: 0 }`；这样 AI 会先提净自己地里的死子再 pass。
- `maxVisits: 1` 时 `moveInfos` 为空，只能用 `policy`（加 `includePolicy: true`）。
- 耗时（b10c128，AVX2 桌面 CPU，2×2 线程）：1 次评估约 25ms；50 次 ~0.3–0.6s；200 次 ~0.8–2.5s；800 次 ~3–10s。云服务器会更慢，用 `overrideSettings.maxTime` 封顶。
- 推荐配置见 `server/katago/analysis.cfg`（2~4 核服务器）。

### 7.5 难度分级

弱档使用 KaTrain 的 "Calibrated Rank" 策略（MIT 许可，按段位从随机抽取的若干合法点里选 policy 最高者），每步只需 1 次神经网络评估；最强档用真正的搜索。

| id | 名称 | 策略 | 参数 |
|---|---|---|---|
| `k18` | 入门 | rank | kyu 18 |
| `k12` | 初级 | rank | kyu 12 |
| `k8` | 中级 | rank | kyu 8 |
| `k4` | 中高级 | rank | kyu 4 |
| `k1` | 高级 | rank | kyu 1 |
| `d3` | 业余 3 段 | rank | kyu -2 |
| `d5` | 业余高段 | policy | 取 policy 最高点（开局 22 手内按 KaTrain 规则加随机性） |
| `max` | 最强 | search | maxVisits 300，maxTime 8 秒 |

- 描述里注明"19 路约 N 级/段"。KaTrain 的校准只针对 19 路；同样参数在小棋盘上更强，因此 13 路 kyu +5、9 路 kyu +10（上限 30）作为初始修正。
- rank/policy 档的 pass：按 KaTrain 规则（pass 在 policy 前 5 → 下 policy 第一；policy 第一是 pass → pass）。另外当 `humanJustPassed` 时，追加一次 100 次搜索的"终局检查"（上面的 friendlyPassOk=false 规则），若第一选点是 pass 则 AI 也 pass，避免人停一手后 AI 在已定的局面里继续乱下。
- 选出的着法一律用本项目引擎校验合法性；不合法时把该点置 -1 重新选（最多 5 次），再不行就下 policy 最高的合法点或 pass。
- 终局判定：人停一手后，AI 在"第一选点是 pass"**或"局面已定"**时也 pass。局面已定 = 用这次检查搜索的归属值判死子后立即数子，AI 的得分不比继续下（第一选点的 scoreLead）少 1 目以上（`SETTLED_MARGIN`）。这是因为 friendlyPassOk=false 规则下 KataGo 总想先提净死子，而我们的数子本来就会去掉死子。
- 认输：`rootInfo` 换算为 AI 视角后，胜率 < 2% 且落后超过（9 路 8 目 / 13 路 15 目 / 19 路 25 目），且总手数 > 路数² × 0.4；rank/policy 档的 1 次评估满足条件时，还要用 100 次搜索确认一次（确认失败则不认输），避免原始网络误判导致领先时认输。
- 体验：AI 落子至少间隔 `config.aiMinThinkMs`（默认 600ms，测试可设 0），避免"秒下"。
- `AI_FALLBACK=1` 且未配置 KataGo 时，使用内置弱 AI（随机合法点、不填自己的眼、优先提子），`levels()` 只返回一个 `{ id: 'basic', name: '内置练习 AI' }`，`judgeDead` 直接 reject（数子阶段走手动：人机对局里玩家点选死子，见 6.4）。

## 8. 客户端（client-infra / client-play / client-pages）

### 8.1 配置 `miniprogram/config.js`

```js
module.exports = {
  API_BASE: 'http://192.168.1.100:8080',   // 本地开发：电脑的局域网 IP；上线改为 https://你的域名
  WS_URL: 'ws://192.168.1.100:8080/ws',    // 上线改为 wss://你的域名/ws
  DEV_LOGIN: true,                         // 服务端未配置微信 AppSecret 时使用开发登录
};
```

### 8.2 网络层 `utils/net/`

- `emitter.js`：极简事件总线 `on/off/once/emit`。
- `auth.js`：
  - `ensureLogin() → Promise<User>`：内存/本地存储里有令牌直接返回；否则 `wx.login` → `POST /api/auth/login`；收到 503 `wx_not_configured` 且 `DEV_LOGIN` 为真 → 用本地存储里的 `deviceId`（首次随机生成）调 `dev-login`。并发调用只登录一次。
  - `getToken()`、`getUser()`、`setUser(user)`、`needProfile()`、`clear()`。
- `api.js`：`request({ method, path, data })` → Promise<data>；自动带令牌；401 时清令牌、重新登录、重试一次；失败 reject `{ code, msg, status }`。另有 `uploadAvatar(tempFilePath)`（`wx.uploadFile`，字段名 `file`）。
- `socket.js`：单例 `socket`：
  - `connect()`：确保登录后 `wx.connectSocket({ url: WS_URL, header: { Authorization: 'Bearer ' + token } })`（令牌不进访问日志；旧写法 `WS_URL + '?token='` 服务端仍然兼容）；
  - 断线自动重连（1s、2s、4s…最多 15s；被 `kicked` 或主动 `close()` 时不重连）；`wx.onAppShow` 时若未连接立即重连；
  - 连接建立后自动发 `hello`，把结果作为 `ready` 事件发出；
  - `request(t, params, { timeout = 10000 }) → Promise<data>`：自动分配 rid，收到 res 后 resolve/reject（reject `{ code, msg }`）；未连接时先等连接（等待超时则 reject `{ code: 'offline' }`）；
  - `on(t, fn)` / `off(t, fn)` 订阅推送；另有状态事件 `status`（`'connecting'|'open'|'closed'`）和 `ready`；
  - 心跳：每 20 秒 `ping`，10 秒无 `pong` 判断线重连。
- `utils/clock.js`：`displayClock(clock, runningElapsedMs, timeControl)` → `{ text: '09:58' | '28', sub: '读秒 3 次' | '', urgent: bool, timeout: bool }`（按 6.1 的规则推演，与服务端一致；第三个参数给出完整读秒周期，见 5.4 Clocks 的说明）。

以上模块需在 `test/client/` 下用模拟的 `wx` 对象写单测（Node 可跑）。

### 8.3 页面

- **首页 `pages/index`**：顶部头像昵称（点进"我的"）；按钮：快速匹配（先选路数 9/13/19）、好友对战（创建房间 / 输入房号）、人机对弈、本地对弈、排行榜。有进行中的对局时顶部显示"你有一局正在进行，点击返回"。
- **资料 `pages/profile`**：`<button open-type="chooseAvatar">` + `<input type="nickname">`，保存时上传头像、提交昵称。首次进行联网操作（匹配、房间、人机、排行榜）前若 `needProfile` 则先跳到这里。
- **匹配 `pages/match?size=`**：显示"正在匹配 N 路…"与已等待秒数、取消按钮；`match.found` → `redirectTo` 对局页；等待超过 60 秒提示可改为人机对弈；页面卸载时取消匹配；断线重连后重新 `match.join`。
- **好友房 `pages/room`**：`?create=1&size=&color=` 创建并等待（显示 6 位房号、"邀请微信好友"分享按钮）；`?code=` 受邀进入（显示房主信息与"加入对局"按钮）；首页也可手动输入房号。`game.start` → `redirectTo` 对局页。`onShareAppMessage` 返回 `path: '/pages/room/room?code=<房号>'`。
- **人机设置 `pages/ai`**：路数、难度（来自 `GET /api/ai/levels`）、执子 → `ai.start` → `redirectTo` 对局页。
- **对局页 `pages/play?id=`**：
  - 上方对手信息（头像、昵称、执子颜色、提子数、读秒、在线状态），下方自己；中间棋盘。
  - 触摸出预览子 + "确定"落子（沿用 v1 交互）；不是自己回合时棋盘不响应。
  - 按钮：确定、停一手、认输（二次确认）、悔棋（仅人机）。
  - 数子阶段：棋盘上死子画叉、地盘画小方块；面板显示黑/白点数与胜负、双方是否已确认；按钮"同意""继续对局"；真人对局可点棋子切换死活（使用棋盘的 `tap` 事件），人机对局在 `scoring.source === 'manual'` 时也可以；`scoring.resumesLeft[myColor] === 0` 时"继续对局"不可用；时限到未达成一致时按 6.3 第 6 步终局（提示"单方面的修改不会生效"；`scoring.atDeadline` 与当前显示不同或为作废时，提示"时限到将按 … 计分 / 将作废"）；点选时带上当前 `scoring.version`。
  - `match.found`、`game.start` 可能在匹配页/房间页之外到达（另一台设备顶替连接、好友房房主不在房间页）：应用层收到时提示并进入对局页；首页收到时刷新横幅。
  - 终局面板：结果（作废、超时、继续对局被撤销等按 `result.cause` 说明原因；排位赛没计入按 `result.uncounted` 说明；`result.pending` 时显示"结果保存中"，之后的 `game.end` 会带来最终结果）、排位赛显示连胜变化；按钮"复盘""再来一局"（排位→重新匹配；人机→同设置再开；好友→返回首页）"返回首页"。
  - `onShow` 时 `wx.setKeepScreenOn({ keepScreenOn: true })`；AI 思考时显示"AI 思考中…"。
  - 网络断开时顶部显示"连接中断，正在重连…"，重连后自动 `game.sync`。
- **排行榜 `pages/leaderboard`**：三个标签（当前连胜 / 最高连胜 / 胜率）；列表显示名次、头像、昵称、数值（胜率同时显示局数）；底部固定显示"我的名次"（未上榜时显示原因，胜率榜显示还差几局）。
- **我的 `pages/me`**：头像昵称（可修改）、排位战绩（局数、胜率、当前连胜、最高连胜）、人机战绩；对局列表（分页），点击进入复盘。页面底部有"重新登录"：`POST /api/auth/logout` 作废本机令牌后重新登录（令牌疑似泄露或想切换开发账号时用）。
- **复盘 `pages/replay?id=`**：`GET /api/games/:id`，棋盘 + 上一手/下一手/首/尾按钮与进度条，显示手数与结果。

### 8.4 棋盘组件新增接口（client-play）

在 v1 接口基础上增加（v1 本地对弈页不传这些属性，行为不变）：

- `disabled: Boolean`：为真时不响应触摸。
- `marks: Object|null`：`{ dead: number[], owner: number[] }`，数子阶段显示（死子上画叉并半透明，`owner` 为 1/2 的空点或死子点画小方块）。
- 事件 `tap`：`{ idx }`，手指抬起时若与按下时是同一交叉点则触发（数子阶段点选死子用）。

## 9. 配置（环境变量，`server/.env`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | |
| `PUBLIC_BASE_URL` | `http://localhost:8080` | 生成头像地址用，上线改为 `https://你的域名` |
| `DATA_DIR` | `./data` | 数据库与头像目录 |
| `WX_APPID` / `WX_SECRET` | 空 | 小程序 AppID 与 AppSecret（只放服务端） |
| `DEV_LOGIN` | `0` | `1` 时开放开发登录（上线必须为 0）。`NODE_ENV=production` 或 `PUBLIC_BASE_URL` 是 https 时开启会拒绝启动 |
| `DEV_LOGIN_ALLOW_PRODUCTION` | `0` | `1` 时允许在上述正式环境开启开发登录（仅临时测试服） |
| `SEC_CHECK` | `on` | 昵称/头像内容安全检测：`off` / `on`（微信接口出错时放行）/ `strict`（出错也拒绝），见第 4 节 |
| `KATAGO_PATH` / `KATAGO_MODEL` / `KATAGO_CONFIG` | 空 / 空 / `./katago/analysis.cfg` | 都配置了才启用 KataGo |
| `AI_FALLBACK` | `0` | 未配置 KataGo 时是否使用内置弱 AI（开发用） |
| `TC_9` / `TC_13` / `TC_19` | 见 6.1 | 格式 `基本秒,读秒次数,每次秒`，如 `600,3,30` |
| `MIN_MOVES_RANKED` | `10` | 数子终局的排位赛计入排行所需的最少落子数（不含 pass），见 6.6 |
| `RANKED_PAIR_DAILY_MAX` | `3` | 同一对手 24 小时内最多计入排行的排位赛局数，`0` 为不限，见 6.6 |
| `MIN_GAMES_WINRATE` | `10` | |

`config.js` 在启动时若存在 `server/.env` 则用 `process.loadEnvFile` 读取。

## 10. 测试要求

- 引擎：`npm test`（根目录，已有）。
- 服务端：`cd server && npm test`，`node --test`，全部用内存数据库（`:memory:`）与假 AI；读秒用注入的 `now()`/假定时器。必须覆盖：读秒各分支、统计与连胜、三种排行榜的排序与"我的名次"、登录与令牌、协议校验、匹配与好友房、完整对局（两个 ws 客户端走完 落子→pass→数子→点选→确认→统计）、认输、超时、掉线弃局、重连恢复、人机对局（AI 落子、悔棋、AI pass 后数子）、非法与越权请求。
- 公平性与防护（回归测试）：`server/test/game/fairness.test.js`（继续对局次数与撤销、自动确认的回退规则与顺延、到场、掉线与基本时间、人机手动点选、死子判断复用、手动数子的争议作废、点选的认可、继续对局次数与保护的持久化、终局原因）、`fairness-manager.test.js`（管理器层：手动数子作废与统计、死子判断重试与每局一个在途、重启后撤销继续对局、presence 读秒、写库失败的 pending 与补推、同一对手每日计入上限、大厅限流表清理）、`limits.test.js`（AI 请求名额、终局写库失败重试、ai.start 与猜房号限流、顶替退出匹配）、`ws-limits.test.js`（发送积压、建连限流、Authorization 头）、`server/test/core/limits.test.js`（REST 限流、真实 IP、注销）、`security.test.js`（内容安全，用假的微信接口）、`db-hygiene.test.js`（令牌清理、损坏记录、列表查询计划）。
- 真实 KataGo：设置了 `KATAGO_PATH` 等环境变量时运行 `server/test/katago.real.test.js`，否则跳过（bash 与 PowerShell 的写法见 ai.md 第 7 节）。
- 客户端：`test/client/` 下对 `utils/net/*`、`utils/clock.js` 用模拟 `wx` 单测；页面在微信开发者工具里手动验证。
- 服务端集成：`cd server && npm run test:integration`（也包含在 `npm test` 里）。`server/test/integration/` 用真实的 `startServer`（SQLite 数据库文件、真实 HTTP 与 WebSocket、假 AI；另有一组不注入 AI、由 `createAiService` 按配置创建）走完：登录/资料/头像上传 → 排位全流程与统计、排行榜、棋谱 → 认输/超时/首手作废/掉线弃局/好友房/人机 → 进程重启（同一数据库文件）后恢复对局与数子阶段，统计只计一次。
- 端到端：根目录 `npm run test:e2e`（需要 Node ≥ 22.13 且已在 `server/` 下 `npm install`，否则跳过；约 30 秒，不在根目录 `npm test` 里）。`test/e2e/` 在 Node 里加载真实的小程序代码（`utils/net/*`、`utils/clock.js`、`pages/*` 的页面脚本与 `pages/play/model.js`），每个模拟客户端一份独立的模块实例和一个由真实网络实现的 `wx`（`wx.request` → fetch、`wx.uploadFile` → multipart、`wx.connectSocket` → ws），对真实服务端验证双方协议一致。
