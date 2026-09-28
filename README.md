# GameGo：围棋微信小程序

原生微信小程序 + 自建 Node.js 服务端的围棋对弈项目：

- **联网对弈**：快速匹配（排位赛，9/13/19 路）、好友房（6 位房号，可分享给微信好友）；服务端权威判定，基本时间 + 读秒；断线重连、服务端重启后恢复对局。
- **人机对弈**：服务端运行 KataGo 分析引擎，8 档难度（入门 18 级 ~ 最强），可悔棋；没有 KataGo 时可以开内置练习 AI（开发用）。
- **本地对弈**：同一台手机两人轮流下（不联网）。
- **排行榜**：当前连胜、最高连胜、胜率（≥ 10 局上榜），**只统计排位赛**；好友房、人机对局不计入。
- **我的 / 复盘**：战绩、对局列表、逐手复盘、复制 SGF 棋谱。

规则：中国规则**数子法**、黑贴 **7.5** 目、简单劫、禁止自杀。终局双方连续 pass 后进入数子阶段：KataGo 给出死子建议，双方可以点选修改、确认，有异议可以"继续对局"下清楚。

## 目录

```
miniprogram/            小程序（miniprogramRoot）
  utils/engine/         纯 JS 规则引擎（棋盘、提子、劫、数子、SGF），小程序与服务端共用
  utils/net/            登录、REST、WebSocket（断线重连、心跳）
  pages/                首页、匹配、好友房、人机设置、对局、排行榜、我的、复盘、本地对弈
  components/           棋盘、头像
server/                 服务端：node:http + ws + SQLite（node:sqlite），KataGo 子进程，见 server/README.md
test/                   规则引擎测试（test/*.test.js）、小程序纯逻辑测试（test/client/）、端到端测试（test/e2e/）
docs/                   设计与部署文档（见下）
project.config.json     微信开发者工具的项目配置（导入的是仓库根目录）
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/online-design.md](docs/online-design.md) | **接口契约**：数据库、REST、WebSocket 协议、对局规则细节（读秒、弃局、数子、计入排行的条件）、配置项、测试要求 |
| [docs/deploy.md](docs/deploy.md) | 部署到 Linux 服务器（Node、KataGo、systemd、nginx、微信公众平台设置、备份）与本地开发联调 |
| [docs/ai.md](docs/ai.md) | 人机 AI：难度分级、KataGo 的下载与安装（含 Windows）、调参、排查、真实 KataGo 测试 |
| [server/README.md](server/README.md) | 服务端的命令、目录、REST 错误码 |


## 快速开始（本机联调，约 5 分钟）

需要 **Node.js ≥ 22.13**（服务端用内置的 `node:sqlite`；根目录的测试脚本也需要）和[微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)。

1. 启动服务端：

   ```bash
   cd server
   npm install
   cp .env.example .env        # Windows：copy .env.example .env
   ```

   编辑 `server/.env`（`192.168.1.100` 换成电脑的局域网 IP）：

   ```ini
   DEV_LOGIN=1                                  # 开发登录，不需要微信 AppSecret
   AI_FALLBACK=1                                # 没装 KataGo 时用内置练习 AI
   PUBLIC_BASE_URL=http://192.168.1.100:8080
   ```

   ```bash
   npm start
   curl http://127.0.0.1:8080/healthz          # → {"ok":true}
   ```

   要用真正的 KataGo（人机的全部难度、终局死子判断），按 [docs/ai.md 第 4 节](docs/ai.md#4-安装-katago) 安装 v1.18.1 与 b10c128 权重，在 `.env` 里填 `KATAGO_PATH/KATAGO_MODEL/KATAGO_CONFIG`。没有 KataGo 时数子阶段是双方手动点选死子。

2. 生成本地小程序配置（自动选择当前局域网 IPv4 地址，文件不会提交 Git）：

   ```bash
   npm run config:local
   ```

   Windows PowerShell 如果禁止执行 `npm.ps1`，使用 `npm.cmd run config:local`。

   如果自动选择的地址不正确，可以手动指定地址和端口：

   ```bash
   npm run config:local -- 192.168.1.100 8080
   ```

   生成结果位于 `miniprogram/config.local.js`。手机与电脑应连接同一个 Wi-Fi，`DEV_LOGIN` 在本地开发时保持为 `true`。

3. 微信开发者工具 → 导入项目，目录选**仓库根目录**（不是 `miniprogram/`），AppID 用默认的游客 `touristappid` 即可；"详情 → 本地设置"里勾选**不校验合法域名**。

4. 两个人对局需要两个不同的用户（同一用户的第二条连接会顶掉第一条）：
   - 开发者工具的 **多账号调试**（工具栏 → 多账号调试，添加一个测试账号），每个账号有独立的本地存储，就是不同的用户；
   - 或者用手机预览 / 真机调试：游客 AppID 不能预览，先到 <https://mp.weixin.qq.com/wxamp/sandbox> 申请**测试号**，把它的 AppID 写进 `project.private.config.json`（`{ "appid": "wx…" }`，只在本机生效——不要提交这个文件）。

完整步骤（Windows 防火墙、真机调试等）见 [docs/deploy.md 第 9 节](docs/deploy.md#9-本地开发)；上线部署见 deploy.md 第 1~8 节。

## 测试

| 命令（目录） | 内容 |
|---|---|
| `npm test`（根目录） | 规则引擎 + 小程序纯逻辑（用模拟的 `wx`），不需要服务端 |
| `npm run test:e2e`（根目录） | 端到端：真实服务端 + 真实小程序页面代码（每个模拟客户端一份模块实例，`wx` 由真实网络实现）。需要先在 `server/` 下 `npm install`，约 30 秒 |
| `npm test`（`server/`） | 服务端全部测试：配置、数据库、登录、REST、限流、内容安全、协议、读秒、对局、公平性、集成测试（内存/临时数据库 + 假 AI） |
| 真实 KataGo（`server/`） | 设置 `KATAGO_PATH/KATAGO_MODEL/KATAGO_CONFIG` 后运行 `node --disable-warning=ExperimentalWarning --test test/ai/ test/katago.real.test.js`；PowerShell 的写法见 [docs/ai.md 第 7 节](docs/ai.md#7-测试) |

小程序页面本身只能在微信开发者工具里手动验证（页面逻辑已在 `test/client/` 与 `test/e2e/` 中用 Node 覆盖）。

## 许可证

本项目以 [MIT 许可证](LICENSE)发布，Copyright (c) 2026 xindong1314。

- `server/src/ai/rank.js` 移植自 [KaTrain](https://github.com/sanderland/katrain)（MIT），文件头保留了 KaTrain 的版权与许可声明，修改该文件时请不要删除这段声明。段位校准公式的作者是 [bale-go](https://github.com/bale-go)。
- `server/katago/analysis.cfg` 由 KataGo 自带的示例配置精简改写而来（MIT）。
- 所有第三方组件及其许可原文见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

**KataGo 不包含在本仓库中。** KataGo 程序（[MIT，另含若干各自许可的第三方组件](https://github.com/lightvector/KataGo/blob/v1.18.1/LICENSE)）和神经网络权重（[KataGo Neural Network License](https://katagotraining.org/network_license/)）都需要按 [docs/ai.md 第 4 节](docs/ai.md#4-安装-katago)另行下载，使用时遵守它们各自的许可条款。如果要再分发这些文件（例如打进 Docker 镜像），请一并附上对应的许可声明。

**本仓库不包含任何 AppID 或 AppSecret。** `project.config.json` 里用的是微信开发者工具的游客 AppID `touristappid`。你自己的 AppID 写在 `project.private.config.json` 里，AppSecret 写在 `server/.env` 里（格式参考 `server/.env.example`）。这两个文件都已被 `.gitignore` 忽略，请不要提交。

“微信”是腾讯公司的商标，本项目与腾讯公司没有关联。
