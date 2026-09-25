# GameGo 服务端

围棋小程序的服务端：微信登录、资料与头像、排行榜、棋谱（REST），快速匹配、好友房、联网对局与人机对弈（WebSocket），KataGo AI。

- 运行环境：Node.js ≥ 22.13（使用内置的 `node:sqlite`），唯一依赖是 `ws`。
- 规则引擎与小程序共用：`../miniprogram/utils/engine/`，所以部署时要上传**整个仓库**，不能只传 `server/`。
- 接口契约见 [docs/online-design.md](../docs/online-design.md)，部署见 [docs/deploy.md](../docs/deploy.md)，KataGo（下载、安装、调参、排查、真实 KataGo 测试）见 [docs/ai.md](../docs/ai.md)。

## 本地开发快速开始

```bash
cd server
npm install
cp .env.example .env        # Windows：copy .env.example .env
```

编辑 `.env`，本地开发至少设置：

```ini
DEV_LOGIN=1                                  # 开放开发登录（不需要 AppSecret）
PUBLIC_BASE_URL=http://192.168.1.100:8080    # 换成电脑的局域网 IP
AI_FALLBACK=1                                # 没有 KataGo 时用内置弱 AI
```

启动并检查：

```bash
npm start
curl http://127.0.0.1:8080/healthz           # → {"ok":true}
```

然后把 `miniprogram/config.js` 里的 `API_BASE`、`WS_URL` 改成同一个局域网 IP，在微信开发者工具里勾选"不校验合法域名"即可联调。
详细步骤（防火墙、真机调试、配置 KataGo）见 [docs/deploy.md 第 9 节](../docs/deploy.md#9-本地开发)；KataGo 的 Windows 安装步骤（v1.18.1 的下载地址、SHA-256、推荐的 b10c128 权重）见 [docs/ai.md 第 4 节](../docs/ai.md#4-安装-katago)。

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm start` | 启动服务（读取 `server/.env`） |
| `npm run dev` | 开发模式：修改代码后自动重启 |
| `npm test` | 运行全部服务端测试（内存数据库 + 假 AI，不需要 KataGo；含集成测试） |
| `npm run test:core` | 只运行 server-core 的测试（配置、数据库、登录、REST、限流、内容安全） |
| `npm run test:integration` | 只运行集成测试（真实 `startServer`、SQLite 文件、HTTP 与 WebSocket） |

真实 KataGo 的测试要先设 `KATAGO_PATH`/`KATAGO_MODEL`/`KATAGO_CONFIG` 三个环境变量（bash 与 PowerShell 的写法见 [docs/ai.md 第 7 节](../docs/ai.md#7-测试)），没设时自动跳过。

## 目录

```
src/
  index.js        入口：读取配置、启动、优雅退出
  app.js          startServer：组装数据库、AI、HTTP、WebSocket
  config.js       环境变量 → Config
  logger.js       日志
  engine.js       转出共用规则引擎
  db/             SQLite 迁移与仓储（users / sessions / games / stats）
  auth/           微信 code2Session、开发登录、令牌鉴权
  http/           REST 路由、请求体解析、头像上传与静态文件
  ws/ game/       WebSocket 协议、匹配、好友房、对局（server-game）
  ai/             KataGo 适配与分级 AI（server-ai）
  util/           公共小工具（对外用户信息等）
test/             node:test 测试
katago/           KataGo 配置模板（可执行文件与权重也放这里，已被 .gitignore 忽略）
data/             运行时数据（数据库、头像），已被 .gitignore 忽略
```

## REST 错误码

所有错误都是 `HTTP 4xx/5xx` + `{ "error": { "code", "msg" } }`，`msg` 为可直接展示的中文。

| HTTP | code | 场景 |
|---|---|---|
| 400 | `bad_request` | 参数不合法（昵称、deviceId、图片格式 / 结构 / 尺寸、JSON 格式等） |
| 400 | `content_risky` | 昵称或头像未通过微信内容安全检测 |
| 400 | `sec_check_retry` | 昵称检测要求该用户近两小时打开过小程序（微信 61010）：重新打开小程序后再改 |
| 401 | `unauthorized` | 缺少令牌或令牌失效 |
| 404 | `not_found` | 路径不存在、对局不存在或无权查看、开发登录未开启 |
| 405 | `method_not_allowed` | 请求方法不对 |
| 413 | `too_large` | 请求体超过 16KB / 头像超过 2MB |
| 415 | `unsupported_media_type` | JSON 接口收到非 JSON，或头像不是 multipart |
| 429 | `rate_limited` | 请求太频繁（带 `Retry-After`），见设计文档第 4 节的限额 |
| 500 | `internal` | 服务器内部错误 |
| 502 | `wx_login_failed` | 微信 code2Session 失败 |
| 503 | `wx_not_configured` | 服务器没有配置 WX_APPID / WX_SECRET |
| 503 | `sec_check_unavailable` | `SEC_CHECK=strict` 且微信内容安全接口出错（日志里有微信的 errcode） |

`POST /api/auth/logout`（需要令牌）注销当前令牌。WebSocket 握手推荐把令牌放在 `Authorization: Bearer` 头里（`?token=` 仍兼容）。
