# 围棋小程序服务端（Java 版）

`server-java/` 是 Node.js 服务端（`server/`）的 Java 移植：Spring Boot 3.5 + MyBatis + MySQL（开发时也可用 H2），JDK 17。
REST 接口、WebSocket 协议（`/ws`）、事件顺序、错误码、快照结构与全部对局规则都与 Node 版一致，**同一个小程序（`miniprogram/`）不做任何修改**
就能连接任一版本。接口契约见 [docs/online-design.md](../docs/online-design.md)（第 4 节 REST、第 5 节 WebSocket 协议、第 6 节对局规则），
AI 模块的 Java 特有说明见 [docs/ai.md](docs/ai.md)。

## 1. 构建与运行

需要 JDK 17、Maven 3.9。

```bash
cd server-java
mvn -q -DskipTests package                 # 生成 target/gamego-server-java-0.1.0.jar（可执行 jar）
java -jar target/gamego-server-java-0.1.0.jar
```

`-DbuildDir=target-xxx` 可以换一个构建目录（多人/多任务并行构建时避免互相覆盖），如 `mvn -q -DbuildDir=target-game test`。

### 数据库

- **MySQL（正式环境）**：环境变量 `DB_URL` / `DB_USER` / `DB_PASSWORD`，默认
  `jdbc:mysql://localhost:3306/gamego?createDatabaseIfNotExist=true&...`、`root`、空密码。库不存在时自动创建，
  每次启动执行 `db/schema-mysql.sql`（全部 `CREATE TABLE IF NOT EXISTS`，可重复执行）。也可以先手动执行 `sql/gamego.sql`。
- **H2（本地开发 / 冒烟测试，不用装 MySQL）**：

  ```bash
  java -jar target/gamego-server-java-0.1.0.jar --spring.profiles.active=h2
  ```

  数据保存在 `./data/gamego-h2.mv.db`（见 `src/main/resources/application-h2.yml`）。

### 环境变量（与 Node 版 `server/.env` 同名）

工作目录下的 `.env` 文件（格式同 `server/.env.example`）也会被读取，系统环境变量优先。

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | 监听地址（HTTP 与 WebSocket 同一端口，WebSocket 路径 `/ws`） |
| `PUBLIC_BASE_URL` | `http://localhost:8080` | 生成头像地址用，上线改为 `https://你的域名` |
| `DATA_DIR` | `./data` | 头像目录（`DATA_DIR/avatars`）；H2 配置的数据库文件也在这里 |
| `DB_URL` / `DB_USER` / `DB_PASSWORD` | 见上 | 数据库（Java 版特有） |
| `WX_APPID` / `WX_SECRET` | 空 | 小程序 AppID 与 AppSecret |
| `DEV_LOGIN` | `0` | `1` 时开放开发登录（`POST /api/auth/dev-login`），上线必须为 0；`NODE_ENV=production` 或 https 对外地址时开启会拒绝启动 |
| `DEV_LOGIN_ALLOW_PRODUCTION` | `0` | `1` 时允许在上述正式环境开启开发登录（仅临时测试服） |
| `SEC_CHECK` | `on` | 昵称/头像内容安全检测：`off` / `on` / `strict` |
| `KATAGO_PATH` / `KATAGO_MODEL` / `KATAGO_CONFIG` | 空 / 空 / `./katago/analysis.cfg` | 三项都配置了才启用 KataGo（安装与调参见 [../docs/ai.md](../docs/ai.md)） |
| `AI_FALLBACK` | `0` | 未配置 KataGo 时使用内置练习 AI（开发用；它不能判断死子，数子时改为手动点选） |
| `TC_9` / `TC_13` / `TC_19` | `180,3,20` / `360,3,30` / `600,3,30` | 用时：`基本秒,读秒次数,每次秒` |
| `MIN_MOVES_RANKED` | `10` | 数子终局的排位赛计入排行所需的最少落子数 |
| `RANKED_PAIR_DAILY_MAX` | `3` | 同一对手 24 小时内最多计入排行的局数（`0` 不限） |
| `MIN_GAMES_WINRATE` | `10` | 胜率榜上榜的最少局数 |
| `LOG_LEVEL` | `info` | `com.gamego` 包的日志级别 |

对局的其他时限（首手 60 秒、掉线 90 秒、数子 180 秒、判死 15 秒、人机闲置 24 小时、好友房 30 分钟）在
`application.yml` 的 `gamego.*` 里；到场宽限、继续对局次数、AI 名额等不在 Node 版 Config 契约里的项可用 `gamego.game.*` 覆盖
（默认值与 Node 版 `game/settings.js` 相同，一般不用改）。

本地开发的典型启动方式：

```bash
DEV_LOGIN=1 AI_FALLBACK=1 java -jar target/gamego-server-java-0.1.0.jar --spring.profiles.active=h2
```

PowerShell：

```powershell
$env:DEV_LOGIN='1'; $env:AI_FALLBACK='1'; java -jar target/gamego-server-java-0.1.0.jar --spring.profiles.active=h2
```

## 2. 让小程序连接 Java 版

小程序不需要改代码，只要把 `miniprogram/config.js` 里的地址指向 Java 服务端（与指向 Node 版完全相同）：

```js
API_BASE: 'http://192.168.x.x:8080',   // 电脑的局域网 IP + Java 服务端端口
WS_URL: 'ws://192.168.x.x:8080/ws',
DEV_LOGIN: true,                        // 服务端 DEV_LOGIN=1、未配置微信 AppSecret 时
```

本地调试时在微信开发者工具"详情 → 本地设置"里勾选"不校验合法域名"。上线时改为 `https://` / `wss://你的域名/ws`
（nginx 反向代理的写法与 Node 版相同，见 [docs/deploy.md](../docs/deploy.md) 与下面第 3 节；WebSocket 需要 `Upgrade` / `Connection` 头透传）。
Node 版与 Java 版共用同一套表结构，但不要让两个版本同时连同一个库运行（对局状态在各自进程的内存里）。

## 3. 部署到服务器（Java 版）

[docs/deploy.md](../docs/deploy.md) 是按 Node.js 版写的完整部署文档；其中安装 KataGo（第 3 节）、nginx 与 HTTPS（第 6 节）、
微信公众平台设置（第 7 节）两版完全相同。Java 版只有“运行服务端”这一步不同：不装 Node.js，改为 JDK 17 + MySQL 8，
由 systemd 守护可执行 jar。下面以 Ubuntu 22.04/24.04 为例（Debian 12 的软件源里没有 MySQL，需要先添加 MySQL 官方 APT 源）。

### 3.1 安装 JDK 17 与 MySQL 8，建库建用户

```bash
sudo apt update
sudo apt install -y openjdk-17-jre-headless mysql-server
sudo mysql -e "CREATE DATABASE IF NOT EXISTS gamego DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  CREATE USER IF NOT EXISTS 'gamego'@'localhost' IDENTIFIED BY 'CHANGE_ME';
  GRANT ALL PRIVILEGES ON gamego.* TO 'gamego'@'localhost';"
```

表不用手动建：服务启动时自动执行 `db/schema-mysql.sql`（全部 `CREATE TABLE IF NOT EXISTS`）；也可以先执行 `mysql -u root -p < sql/gamego.sql`。
MySQL 保持默认的只监听本机（127.0.0.1:3306）。

### 3.2 上传 jar 与 KataGo 配置

在开发机上执行 `mvn -q -DskipTests package`，把 `target/gamego-server-java-0.1.0.jar` 与 `katago/analysis.cfg` 传到服务器：

```bash
sudo useradd --system --home /srv/gamego --shell /usr/sbin/nologin gamego
sudo mkdir -p /srv/gamego/server-java/katago /srv/gamego/server-java/data
sudo cp gamego-server-java-0.1.0.jar /srv/gamego/server-java/
sudo cp analysis.cfg /srv/gamego/server-java/katago/
sudo chown -R gamego:gamego /srv/gamego
```

KataGo 程序（v1.18.1 Linux CPU 版）与权重按 docs/deploy.md 第 3 节下载，放进 `/srv/gamego/server-java/katago/`。

### 3.3 配置 `.env`

新建 `/srv/gamego/server-java/.env`（服务从工作目录读取它，格式为 `名称=值`；系统环境变量优先）：

```ini
HOST=127.0.0.1
PORT=8080
PUBLIC_BASE_URL=https://go.example.com
DATA_DIR=/srv/gamego/server-java/data
DB_URL=jdbc:mysql://127.0.0.1:3306/gamego?useUnicode=true&characterEncoding=UTF-8&serverTimezone=Asia/Shanghai&useSSL=false&allowPublicKeyRetrieval=true
DB_USER=gamego
DB_PASSWORD=CHANGE_ME
WX_APPID=wx0123456789abcdef
WX_SECRET=CHANGE_ME
DEV_LOGIN=0
KATAGO_PATH=/srv/gamego/server-java/katago/katago
KATAGO_MODEL=/srv/gamego/server-java/katago/kata1-b10c128-s1141046784-d204142634.txt.gz
KATAGO_CONFIG=/srv/gamego/server-java/katago/analysis.cfg
```

`HOST=127.0.0.1` 让 8080 端口只接受本机（nginx）的连接；`PUBLIC_BASE_URL` 为 https 地址时开启开发登录会拒绝启动。
`.env` 里有密钥，权限设为 `sudo chmod 600 /srv/gamego/server-java/.env`（属主 gamego）。

### 3.4 systemd 服务

新建 `/etc/systemd/system/gamego-java.service`：

```ini
[Unit]
Description=GameGo 围棋小程序服务端（Java 版）
After=network-online.target mysql.service
Wants=network-online.target

[Service]
Type=simple
User=gamego
Group=gamego
WorkingDirectory=/srv/gamego/server-java
ExecStart=/usr/bin/java -jar /srv/gamego/server-java/gamego-server-java-0.1.0.jar
# KataGo 的 Linux 版是 AppImage：解压后运行，不需要 FUSE（见 docs/deploy.md 第 3.1 节）
Environment=APPIMAGE_EXTRACT_AND_RUN=1
# 收到 SIGTERM 后先以 1001 关闭 WebSocket、补写终局结果，再退出；JVM 因 SIGTERM 退出时返回 143
KillSignal=SIGTERM
SuccessExitStatus=143
TimeoutStopSec=30
Restart=on-failure
RestartSec=3
LimitNOFILE=65535
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now gamego-java
journalctl -u gamego-java -f                 # 查看日志
curl http://127.0.0.1:8080/healthz           # → {"ok":true}
```

### 3.5 nginx 反向代理

按 docs/deploy.md 第 6 节配置（`proxy_pass http://127.0.0.1:8080`，证书、限流、日志格式与 Node 版相同）。要点：
`/ws` 必须透传 `Upgrade` 与 `Connection` 头并放宽超时；每个 `location` 都转发 `X-Real-IP`（服务端只在请求来自本机时才相信它，用于按 IP 限流）。

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name go.example.com;
    # ssl_certificate / ssl_certificate_key / 限流等见 docs/deploy.md 第 6 节

    location = /ws {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 3.6 运维

- 备份：`mysqldump --single-transaction gamego > gamego-$(date +%F).sql`，外加 `DATA_DIR/avatars` 头像目录。
- 升级：替换 jar 后 `sudo systemctl restart gamego-java`；未结束的对局在启动时自动恢复（停机时间不计入读秒）。
- 防火墙 / 云安全组只放行 80 和 443；不要让 Node 版与 Java 版同时连同一个库运行。

## 4. 测试

```bash
cd server-java
mvn -q -DbuildDir=target-game test      # 全部测试（H2 内存库、假 AI，不需要 MySQL / KataGo）
```

- `com.gamego.game`：读秒各分支（`GameClockTest`）、对局会话与公平性规则（`GameSessionTest`，对应 Node 的 session / fairness 测试）、
  对局管理器（`GameManagerTest`：可控的假时间与手动定时器、内存仓储、可挂起的假 AI；超时、弃局、到场、数子与自动确认、继续对局保护、
  重启恢复、AI 名额与重试、终局写库失败的 pending 与补推、同一对手每日上限等）、大厅（`LobbyTest`：匹配、好友房、限流）。
- `com.gamego.ws`：协议校验（`ProtocolTest`）、连接层（`HubTest`：慢读断开、心跳、顶替、batch 顺序、消息限流）、
  端到端（`WsEndToEndTest`：`@SpringBootTest` 随机端口 + 真实 WebSocket 客户端 + `@Primary FakeAiService`，走完排位全流程与统计、
  好友房、人机、断线重连、顶替、越权、畸形消息与 16KB 上限、限流 4008 / 429、Authorization 头、极短用时超时、首手作废、掉线弃局、
  重启恢复（关闭以 1001）、启动时恢复与损坏记录作废、`GET /api/me` 的 activeGameIds）。
- 真实 KataGo：设置了 `KATAGO_PATH` 等环境变量时运行 `KataGoRealTest`，否则跳过。

## 5. 实时对局的实现要点

- **单线程游戏循环**：Node 版是单线程的；为了忠实移植、避免竞态，所有对局 / 大厅状态只在一个单线程
  `ScheduledExecutorService`（线程名 `game-loop`，`com.gamego.game.GameLoop`）上读写。WebSocket 处理线程只做限流与 JSON 解析 / 协议校验，
  然后把业务提交给循环；定时器（读秒、首手、弃局、数子自动确认、人机闲置、房间过期、终局写库重试）在循环上触发；
  AI 的 `CompletableFuture` 回调也经 `GameLoop.execute` 回到循环上执行。时间取自注入的 `java.time.Clock`，测试里换成手动推进的假时间。
- **WebSocket**（`com.gamego.ws`）：握手拦截器校验令牌（`Authorization: Bearer` 优先，其次 `?token=`），失败回 401 JSON；
  每用户建连限流（突发 10、每 6 秒 1 次，429）；一个用户一条连接（旧连接收到 `kicked` 后以 4001 关闭）；每 25 秒 ping、两次无 pong 断开；
  单条消息 ≤ 16KB（1009）；每用户每秒 ≤ 20 条（重连不清零，4008）；发送走每连接的队列 + 发送线程池（不阻塞游戏循环），
  积压超过 1MB 断开；请求的 `res` 一定先于它引起的推送（`Hub.batch`）。JSON 输出与 Node 的 `JSON.stringify` 一致
  （整数值的浮点数写成整数，`idx` 为 -1 表示 pass，颜色做键的对象键为 `"1"` / `"2"`）。
- **持久化与统计**：每一手后 `saveProgress`（着手、读秒、`state` = 继续对局次数与保护）；终局 `games.finish` 与 `stats.applyRanked`
  在同一个 `DbTransactions` 事务里（`counted` 防重，统计只计一次）；写库失败时推送 `pending: true`、按 1/5/15/60 秒重试补写，
  成功后再推送一次 `game.end`，关机前再写一次。同一对手每日上限经 `StatsRepository.pairLimitReached`。
- **启动恢复**：`ApplicationReadyEvent` 时从 `listUnfinished()` 恢复（读秒按保存值、停机时间不计；玩家按"到场"处理，5 分钟没回来作废；
  数子阶段重新请求死子建议；无法重放的记录作废为 `Void`、`cause: 'broken'`），完成之前握手回 503。
  `Realtime.restart(settings, limits)` 可在同一个库上重启实时服务（测试用，相当于进程重启）。
- `Realtime` 同时实现 `com.gamego.api.ActiveGamesProvider`（`GET /api/me` 的 `activeGameIds`）。

## 6. Node 文件 → Java 包对照

| Node（`server/src/`） | Java（`com.gamego.*`） |
|---|---|
| `engine.js`、`miniprogram/utils/engine/*` | `engine`（`Board`、`Rules`、`Game`、`GameState`、`Score`、`Record`、`Coords`） |
| `config.js`、`logger.js` | `config`（`GameGoProperties`、`TimeControl`、`Clock` Bean）、SLF4J |
| `db/*`（repos、migrations） | `db`（`UserRepository`、`SessionRepository`、`GameRepository`、`StatsRepository`、`DbTransactions`、MyBatis mapper）、`resources/db/schema-*.sql` |
| `auth/*` | `auth`（`AuthService`、`WechatClient`、`WxSecurityService`） |
| `http/*`、`util/rate-limit.js`、`util/public-user.js` | `web`（Controller、拦截器、`RateLimiter`）、`api`（`PublicUsers`、`ActiveGamesProvider`、`AiLevelsProvider`） |
| `ai/*` | `ai`（见 [docs/ai.md](docs/ai.md)） |
| `realtime.js` | `ws.Realtime`（组装、恢复、关闭）、`ws.WebSocketConfig` |
| `ws/hub.js` | `ws.Hub`、`ws.Connection`、`ws.SessionTransport`、`ws.WsHandshakeInterceptor`、`ws.GameWebSocketHandler` |
| `ws/protocol.js` | `ws.Protocol` |
| `ws/router.js` | `ws.Router` |
| `game/clock.js` | `game.GameClock` |
| `game/session.js` | `game.GameSession` |
| `game/manager.js` | `game.GameManager`（持久化经 `game.GameStore` / `game.DbGameStore`） |
| `game/matchmaker.js` | `game.Matchmaker` |
| `game/rooms.js` | `game.RoomRegistry` |
| `game/lobby.js` | `game.Lobby` |
| `game/settings.js` | `game.GameSettings` |
| `game/players.js` | `game.Players` |
| `game/errors.js` | `game.GameError` |
| `game/engine-ref.js` | 直接使用 `com.gamego.engine` |
| （Node 的单线程事件循环 / `timers` 注入） | `game.GameLoop` / `game.ExecutorGameLoop` |

## 7. 与 Node 版的细微差别

- 强制断开（发送积压超过 1MB、两次没有 pong）：Node 直接销毁 socket（客户端看到 1006）；Java 由 Tomcat 发出 1001 关闭帧后立即关闭 socket
  （对方已不读 / 无响应时效果相同）。小程序只对 4001 特殊处理，其余关闭一律重连。
- 单条消息上限 16KB：Node 按字节计，Tomcat 的文本缓冲按字符计（含大量中文的 16~48KB 消息 Java 版可能放行；协议里的消息都远小于此）。
- 启动恢复完成之前（或 `Realtime.restart` 期间）握手回 503；Node 版此时还没挂 upgrade 处理（连接被直接关闭）。两者客户端都会退避重连。
