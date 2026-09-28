# 部署指南

本文说明如何把围棋小程序的服务端部署到你自己的 Linux 服务器，以及如何在自己电脑上做本地联调。
服务端的接口与配置项以 [online-design.md](online-design.md) 为准。

## 0. 整体结构

```
微信小程序 ──https/wss──▶ nginx（443，TLS 证书）──http──▶ Node 服务（127.0.0.1:8080）
                                                          ├─ SQLite 数据库 data/gamego.db
                                                          ├─ 头像文件   data/avatars/
                                                          └─ KataGo 子进程（katago analysis）
```

- 服务端是一个 Node.js 进程，REST 与 WebSocket（路径 `/ws`）共用一个端口。
- 数据库是单个 SQLite 文件（WAL 模式），不需要另装数据库。
- 规则引擎和小程序共用 `miniprogram/utils/engine/`，所以要把**整个仓库**放到服务器上。

上线前需要准备好：

| 项目 | 说明 |
|---|---|
| Linux 服务器 | x86_64，建议 2 核 4GB 以上（KataGo 用 CPU 计算，核越多 AI 越快）。Ubuntu 22.04/24.04、Debian 12 均可 |
| 域名 | 小程序只能访问**已 ICP 备案**的域名，不能用 IP 地址（见第 7 节） |
| HTTPS 证书 | 小程序要求 https / wss，证书必须由正规 CA 签发（不能自签名） |
| 小程序 AppID / AppSecret | 微信公众平台 → 开发管理 → 开发设置 |

## 1. 安装 Node.js 22

服务端需要 **Node.js ≥ 22.13**（使用内置的 `node:sqlite`）。

Ubuntu / Debian（NodeSource 源）：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v        # 应显示 v22.13.0 或更高
```

CentOS / Rocky / AlmaLinux：

```bash
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo dnf install -y nodejs
```

国内服务器下载慢时，推荐直接用国内镜像的官方二进制包装到 `/usr/local`（所有用户都能用，systemd 里写 `/usr/local/bin/node`）：

```bash
cd /tmp
curl -fLO https://npmmirror.com/mirrors/node/v22.17.0/node-v22.17.0-linux-x64.tar.xz
sudo tar -xJf node-v22.17.0-linux-x64.tar.xz -C /usr/local --strip-components=1
node -v
npm config set registry https://registry.npmmirror.com
```

> **不要用 root 或自己账号下的 nvm 给服务用。** nvm 把 node 装在安装者的家目录（`/root/.nvm`、`/home/<你>/.nvm`），而第 5 节的 systemd 服务设了 `ProtectHome=true`（`/home`、`/root` 对服务不可见），服务用户 `gamego` 通常也进不去这些目录，结果是 `status=203/EXEC`、服务起不来。
> 一定要用 nvm 的话，以服务用户 `gamego` 的身份安装（`NVM_DIR=/srv/gamego/.nvm`，即第 2 节建的服务用户的家目录，不受 `ProtectHome` 影响；国内设 `NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node`），`ExecStart` 写 `sudo -u gamego bash -lc 'which node'` 显示的完整路径。

## 2. 上传代码并安装依赖

建议建一个专用用户运行服务：

```bash
sudo useradd --system --create-home --home-dir /srv/gamego --shell /usr/sbin/nologin gamego
sudo -u gamego git clone <你的仓库地址> /srv/gamego/GameGo
cd /srv/gamego/GameGo/server
sudo -u gamego npm ci --omit=dev      # 只有 ws 一个依赖
```

没有 git 的话，把整个仓库打包上传后解压到同一位置即可（`server/node_modules`、`server/data`、`server/.env` 不需要上传）。

## 3. 安装 KataGo（人机对弈与数子）

KataGo 负责人机对弈，以及终局时判断死子。不装 KataGo 服务也能运行：人机对弈不可用，数子阶段改为双方手动点选死子（手动数子时没有中立的死子建议：双方对死子有争议、又没有继续对局下清楚，时限到后这局作废、不计入排行，见设计文档 6.3）。

KataGo 的完整说明——各平台的下载地址与 SHA-256、Windows 开发机的安装、线程与强度调参、排查、真实 KataGo 的测试——见 [ai.md](ai.md) 第 4~7 节；本节只讲 Linux 服务器上的最短步骤。

### 3.1 下载程序

到 KataGo 的发布页下载 **v1.18.1** 的 Linux CPU 版（<https://github.com/lightvector/KataGo/releases/tag/v1.18.1>）。
注意不要下"最新版"：v1.18.2 只有 CUDA（显卡）版，v1.18.1 是最后一个带纯 CPU（Eigen）版的版本。

- `katago-v1.18.1-eigenavx2-linux-x64.zip`：CPU 支持 AVX2 时用这个（大部分云服务器都支持）；
- `katago-v1.18.1-eigen-linux-x64.zip`：老 CPU 不支持 AVX2 时用这个，速度较慢。

检查 CPU 是否支持 AVX2：

```bash
grep -o -m1 avx2 /proc/cpuinfo     # 有输出就是支持
```

解压到 `server/katago/`（这个目录里除 `analysis.cfg` 外都已被 `.gitignore` 忽略）：

```bash
cd /srv/gamego/GameGo/server/katago
wget https://github.com/lightvector/KataGo/releases/download/v1.18.1/katago-v1.18.1-eigenavx2-linux-x64.zip
unzip katago-v1.18.1-eigenavx2-linux-x64.zip
chmod +x katago
APPIMAGE_EXTRACT_AND_RUN=1 ./katago version
```

**Linux 版的 `katago` 是 AppImage**，直接运行需要 FUSE（`libfuse2`，Ubuntu 22.04/24.04 默认没装），否则报 `AppImages require FUSE to run`（这个错误用 `ldd` 看不出来）。有两种办法：

- **推荐**：设置环境变量 `APPIMAGE_EXTRACT_AND_RUN=1`，每次启动时解压到临时目录再运行，不需要 FUSE。上面的手动测试、第 3.3 节的测试命令都要带上它，第 5 节的 systemd 服务里已经写了 `Environment=APPIMAGE_EXTRACT_AND_RUN=1`（服务端启动 KataGo 时继承这个环境变量）。
- 安装 FUSE：`sudo apt install libfuse2`（Ubuntu 24.04 上包名是 `libfuse2t64`）。**但在 systemd 服务里仍然不行**：服务设了 `NoNewPrivileges=true`，挂载 FUSE 用的 setuid 程序 `fusermount` 拿不到权限。所以服务里还是要用 `APPIMAGE_EXTRACT_AND_RUN=1`。

如果提示缺少共享库（`error while loading shared libraries: libxxx.so`），用 `ldd ./katago` 查看缺哪些，再用系统包管理器安装对应的库（例如 Ubuntu 上缺 `libzip.so.X` 就 `sudo apt install libzipX`，缺 `libgomp.so.1` 就安装 `libgomp1`）。

> GitHub 在国内下载慢的话，可以先在自己电脑上下载，再用 `scp` 传到服务器。

### 3.2 下载神经网络权重

权重文件（`.txt.gz` / `.bin.gz`，不用解压）的下载地址与 SHA-256 见 [ai.md 第 4 节](ai.md#4-安装-katago)：

- **推荐** `kata1-b10c128-s1141046784-d204142634.txt.gz`（14MB）：本项目的全部难度、终局死子判断与测试都是用它校准和验证的，CPU 上够快，最强档已远超业余顶尖；
- CPU 很弱（1~2 核）时可以改用更小的 `kata1-b6c96-s175395328-d26788732.txt.gz`（5MB），更快、略弱；
- **不建议**用 katagotraining.org 上更大的 b18c384 等网络：在 CPU 上每次评估慢好几倍，没有测试过；死子判断会被 8 秒的搜索上限截断（判断质量下降），服务器忙时还可能超过 15 秒的判断时限、改成双方手动数子。

```bash
cd /srv/gamego/GameGo/server/katago
wget https://media.katagotraining.org/uploaded/networks/models/kata1/kata1-b10c128-s1141046784-d204142634.txt.gz
sha256sum kata1-b10c128-s1141046784-d204142634.txt.gz   # 与 ai.md 第 4 节的值一致
```

### 3.3 配置与测试

仓库自带分析引擎配置模板 `server/katago/analysis.cfg`（其中的线程数等参数按注释根据 CPU 核数调整）。
先手动测一下 KataGo 能否正常分析（第一次启动会做一些初始化，稍等几秒）：

```bash
cd /srv/gamego/GameGo/server/katago
echo '{"id":"t","moves":[],"rules":"chinese","komi":7.5,"boardXSize":9,"boardYSize":9,"maxVisits":10}' \
  | APPIMAGE_EXTRACT_AND_RUN=1 ./katago analysis -config analysis.cfg -model kata1-b10c128-s1141046784-d204142634.txt.gz
```

看到一行以 `{"id":"t",` 开头的 JSON 输出就说明正常（按 Ctrl+C 退出）。

然后在 `.env` 里填上三个路径（见下一节）：

```ini
KATAGO_PATH=./katago/katago
KATAGO_MODEL=./katago/kata1-b10c128-s1141046784-d204142634.txt.gz
KATAGO_CONFIG=./katago/analysis.cfg
```

三项都有值才会启用 KataGo；相对路径是相对 `server/` 目录的。启动日志里出现 `KataGo 已就绪` 即成功；不成功时按 [ai.md 第 6 节](ai.md#6-排查) 排查。

## 4. 配置 `.env`

```bash
cd /srv/gamego/GameGo/server
sudo -u gamego cp .env.example .env
sudo chmod 600 .env        # 里面有 AppSecret，只允许服务用户读取
sudo -u gamego nano .env
```

正式环境的关键配置：

```ini
HOST=127.0.0.1                          # 只允许本机 nginx 访问
PORT=8080
PUBLIC_BASE_URL=https://go.example.com  # 你的域名，用于生成头像地址，结尾不要 /
WX_APPID=wx0123456789abcdef             # 小程序 AppID
WX_SECRET=0123456789abcdef0123456789abcdef   # 小程序 AppSecret
DEV_LOGIN=0                             # 上线必须为 0！（NODE_ENV=production 或 https 地址时开着会拒绝启动）
SEC_CHECK=on                            # 昵称/头像内容安全检测（strict 要先用正式 AppID 实测，见下）
KATAGO_PATH=./katago/katago
KATAGO_MODEL=./katago/kata1-b10c128-s1141046784-d204142634.txt.gz
AI_FALLBACK=0
```

- **内容安全**：昵称和头像会显示在排行榜和对手的对局页上，属于用户产生内容，平台运营规范要求有内容安全措施。配置了 `WX_APPID/WX_SECRET` 后，服务端会用微信的 msgSecCheck 2.0（昵称）、imgSecCheck（头像）再检测一次（客户端的检测可以被绕过），判定违规的拒绝保存。
  - 用户自己能造成的情况在任何模式下都拒绝，不能用来绕过检测：头像超出 imgSecCheck 的送检限制（1MB、750×1334）→ 400「头像图片太大」，不保存（小程序上传前应先压缩）；昵称检测返回 61010（该用户近两小时没有打开过小程序——只有绕过小程序直接调接口才会这样）→ 400 `sec_check_retry`「请重新打开小程序后再修改昵称」。
  - 微信那边出错（接口异常、超时、调用次数用完等）时：`SEC_CHECK=on`（默认）放行，`strict` 拒绝（503 `sec_check_unavailable`）。两种模式都会在日志里记下微信返回的 errcode，例如 40164（服务器出口 IP 不在公众平台"开发管理 → 开发设置 → IP 白名单"里）、45009（当天调用次数用完）。
  - **头像检测只能算尽力而为**：imgSecCheck 是 1.0 版同步接口，微信已停止更新并下线了它的文档（2.0 只有异步的 mediaCheckAsync，需要在公众平台配置消息推送才能收结果）。它目前仍可调用，但不保证一直可用。因此**建议保持 `SEC_CHECK=on`**；想用 `strict`，先用正式 AppID 实测改昵称、换头像都能通过，否则微信接口一出错所有人都改不了资料。
  - **未发布的小程序**调用 msgSecCheck 每天只有 100 次（微信文档：未上架小程序调用上限 100 次/天），测试、审核期间用 `strict` 很容易因为配额用完而拒绝所有昵称修改。
- **开发登录**：`DEV_LOGIN=1` 时任何人凭一个设备号就能登录、无限注册账号。服务在 `NODE_ENV=production`（第 5 节的 systemd 服务已设置）或 `PUBLIC_BASE_URL` 是 https 时发现它开着会拒绝启动；临时测试服确实需要时再加 `DEV_LOGIN_ALLOW_PRODUCTION=1`。

所有配置项及默认值见 `server/.env.example` 中的注释（读秒 `TC_9/TC_13/TC_19`、排行榜 `MIN_MOVES_RANKED/MIN_GAMES_WINRATE/RANKED_PAIR_DAILY_MAX`、日志 `LOG_LEVEL` 等）。
配置有误时服务会拒绝启动并打印原因（如 `配置错误：PORT 必须是整数`）。

AppSecret 获取：微信公众平台 → 开发管理 → 开发设置 → 开发者 ID → AppSecret（生成/重置后只显示一次，请妥善保存；泄露后立即重置）。

先手动试运行一次：

```bash
sudo -u gamego npm start
# 另开一个终端：
curl http://127.0.0.1:8080/healthz          # → {"ok":true}
curl http://127.0.0.1:8080/api/ai/levels    # KataGo 正常时 available 为 true
```

没问题后 Ctrl+C 停止，改用 systemd 托管。

## 5. systemd 服务

新建 `/etc/systemd/system/gamego.service`：

```ini
[Unit]
Description=GameGo 围棋小程序服务端
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=gamego
Group=gamego
WorkingDirectory=/srv/gamego/GameGo/server
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/index.js
Environment=NODE_ENV=production
# KataGo 的 Linux 版是 AppImage：解压后运行，不需要 FUSE（NoNewPrivileges 下 FUSE 也挂载不了）
Environment=APPIMAGE_EXTRACT_AND_RUN=1
Restart=on-failure
RestartSec=3
# 收到 SIGTERM 后服务会保存对局、关闭连接与 KataGo（最多 15 秒）
KillSignal=SIGTERM
TimeoutStopSec=20
LimitNOFILE=65535
# 安全加固
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

启用并启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now gamego
sudo systemctl status gamego
journalctl -u gamego -f          # 查看日志
```

`ProtectHome=true` 会让服务看不到 `/home`、`/root`，所以代码要放在 `/srv` 这类目录（本文的做法），node 也不能装在这些目录里（见第 1 节）。
`ExecStart` 里的 node 路径按第 1 节的安装方式填：NodeSource 是 `/usr/bin/node`，二进制包是 `/usr/local/bin/node`。

## 6. nginx：HTTPS 与 WebSocket 反向代理

安装 nginx 并申请证书（可以用云服务商的免费证书，或 Let's Encrypt：`sudo apt install certbot python3-certbot-nginx && sudo certbot --nginx -d go.example.com`）。

新建 `/etc/nginx/conf.d/gamego.conf`（把 `go.example.com` 和证书路径换成你的）：

```nginx
# WebSocket：有 Upgrade 头时转发 Connection: upgrade
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

# 限流（按客户端 IP）。nginx 这层只挡洪水，按用户的公平限流由服务端自己做（见设计文档第 4、5 节）。
# 数值给得宽，是因为很多真实用户共用一个出口 IP：手机网络（运营商 CGNAT）、校园网、公司网。
# 普通接口 20 次/秒（突发 100）、头像图片 100 次/秒（排行榜一次会加载几十个头像）、登录 60 次/分钟、
# 头像上传 10 次/分钟；每个 IP 最多 100 条 WebSocket 连接（小程序拿不到 429 状态码，被挡时只会一直显示"连接中"）。
limit_req_zone  $binary_remote_addr zone=gamego_api:10m    rate=20r/s;
limit_req_zone  $binary_remote_addr zone=gamego_static:10m rate=100r/s;
limit_req_zone  $binary_remote_addr zone=gamego_login:10m  rate=60r/m;
limit_req_zone  $binary_remote_addr zone=gamego_upload:10m rate=10r/m;
limit_conn_zone $binary_remote_addr zone=gamego_conn:10m;

# nginx 前面还有云负载均衡（CLB/SLB）或 CDN 时，$remote_addr 是负载均衡的地址，所有用户会挤在同一个限流桶里。
# 这时在 http 块里加上（CIDR 换成负载均衡的回源网段），让 nginx 从 X-Forwarded-For 取真实 IP：
#   set_real_ip_from 100.64.0.0/10;
#   real_ip_header   X-Forwarded-For;
#   real_ip_recursive on;
# nginx 直接暴露在公网（本文的结构）时不要加，否则客户端可以伪造 X-Forwarded-For 绕过限流。

# 访问日志只记路径不记查询参数：旧版客户端把令牌放在 /ws?token=… 里，默认的日志格式会把它写进日志
log_format gamego_noargs '$remote_addr - $remote_user [$time_local] "$request_method $uri $server_protocol" '
                         '$status $body_bytes_sent "$http_referer" "$http_user_agent"';

server {
    listen 80;
    server_name go.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    # 可选的 HTTP/2：http2 指令从 nginx 1.25.1 才有，Ubuntu 22.04/24.04、Debian 12 自带的 nginx（1.18/1.24/1.22）
    # 不认识它，直接打开会让 nginx -t 报 unknown directive "http2"。新版本 nginx 去掉下一行的 #；
    # 旧版本想开 HTTP/2，就把上面一行改成 listen 443 ssl http2;
    # http2 on;
    server_name go.example.com;

    ssl_certificate     /etc/nginx/ssl/go.example.com.pem;
    ssl_certificate_key /etc/nginx/ssl/go.example.com.key;
    ssl_protocols       TLSv1.2 TLSv1.3;   # 小程序要求 TLS 1.2 及以上

    client_max_body_size 3m;         # 头像上限 2MB，加上 multipart 的开销
    access_log /var/log/nginx/gamego.access.log gamego_noargs;
    limit_req_status  429;
    limit_conn_status 429;

    # WebSocket（对局连接）
    location = /ws {
        limit_conn gamego_conn 100;
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        # 对局连接会保持很久：服务端每 25 秒 ping 一次，这里设长一些避免被 nginx 断开
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }

    # 登录（每次都要请求微信接口）
    location ~ ^/api/auth/(login|dev-login)$ {
        limit_req zone=gamego_login burst=30 nodelay;
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # 头像上传
    location = /api/me/avatar {
        limit_req zone=gamego_upload burst=5 nodelay;
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # 头像图片：排行榜页一次加载几十个头像（懒加载会预取上下三屏），不能和接口共用限流桶，
    # 否则一半头像会被 429 挡掉、显示成昵称首字。文件名随机、永不复用，服务端回的是一年的强缓存头。
    location /avatars/ {
        limit_req zone=gamego_static burst=200 nodelay;
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # REST 接口、健康检查
    location / {
        limit_req zone=gamego_api burst=100 nodelay;
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
```

检查并生效：

```bash
sudo nginx -t && sudo systemctl reload nginx
curl https://go.example.com/healthz          # → {"ok":true}
```

WebSocket 可以用 `npx wscat -c "wss://go.example.com/ws" -H "Authorization: Bearer xxx"` 测试（没有有效令牌时应被拒绝，返回 401，这说明请求已经到达服务端）。

关于限流与日志：

- 服务端自己也有一层限流（登录按 IP、其他接口按用户、WebSocket 建连与消息按用户），超出返回 429 `rate_limited`；nginx 这层按 IP、只挡洪水请求，数值要给得宽（同一出口 IP 后面可能有很多真实用户）。调小之前先想想排行榜页：一次打开就会请求几十个头像。服务端只在请求来自本机（nginx）时才相信 `X-Real-IP`，所以上面每个 `location` 都要转发这个头。
- 客户端把令牌放在 WebSocket 握手的 `Authorization` 头里，不会进访问日志；`gamego_noargs` 日志格式是给还在用 `?token=` 的旧客户端兜底的。已经写进旧日志里的令牌，可以让用户在小程序里重新登录（`POST /api/auth/logout` 注销当前令牌），或者直接清空 `sessions` 表让所有人重新登录。

服务器防火墙 / 云安全组只需要放行 80 和 443；8080 只监听 127.0.0.1，不要对外开放。

## 7. 微信公众平台设置

### 7.1 服务器域名

微信公众平台 → 开发管理 → 开发设置 → 服务器域名，填写（都是同一个域名）：

| 类型 | 填写 |
|---|---|
| request 合法域名 | `https://go.example.com` |
| socket 合法域名 | `wss://go.example.com` |
| uploadFile 合法域名 | `https://go.example.com` |
| downloadFile 合法域名 | `https://go.example.com` |

注意：

- 域名必须已经 **ICP 备案**，不能是 IP 地址或 localhost，必须是 https / wss；
- 如果用了非 443 端口（如 `https://go.example.com:8443`），这里也要带上端口，且只能访问这个端口；
- 服务器域名每月修改次数有限，填之前确认无误。

填好后创建小程序本地覆盖文件 `miniprogram/config.local.js`（该文件不会提交 Git），写入正式地址：

```js
module.exports = {
  API_BASE: 'https://go.example.com',
  WS_URL: 'wss://go.example.com/ws',
  DEV_LOGIN: false,
};
```

### 7.2 AppID 与 AppSecret

- `project.config.json` 里的 `appid` 改成你的小程序 AppID（仓库里是体验用的 `touristappid`）；
- 服务端 `.env` 的 `WX_APPID` / `WX_SECRET` 填同一个小程序的 AppID 和 AppSecret。两边 AppID 不一致时登录会报 `wx_login_failed`。

### 7.3 用户隐私保护指引

在 微信公众平台 → 设置 → 服务内容声明 → **用户隐私保护指引** 中声明下面两项，否则对应的组件和接口在正式版里会被直接禁用（报 `api scope is not declared in the privacy agreement`），审核也会被拒：

| 声明项 | 用到的地方 |
|---|---|
| 收集你的昵称、头像 | 资料页的 `<button open-type="chooseAvatar">` 与 `<input type="nickname">` |
| 读取你的剪切板 | 好友房"复制房号"、复盘页"复制 SGF 棋谱"（`wx.setClipboardData`） |

### 7.4 ICP 备案与小程序备案

- **域名 ICP 备案**：服务器域名必须备案。服务器在中国大陆时，通过云服务商（阿里云、腾讯云等）的备案系统办理，一般需要 1~3 周；备案期间服务器可以先用本地联调（第 9 节）开发。
- **小程序备案**：小程序本身也需要在微信公众平台完成备案后才能上线（公众平台首页会有提示）。
- **服务类目**：提交审核前请查阅微信官方《小程序开放的服务类目》，棋类对弈属于游戏相关内容，部分类目需要额外资质，个人主体可选的类目有限，建议先确认再提交。

## 8. 运维

### 8.1 备份

需要备份的只有两样：数据库文件 `data/gamego.db` 和头像目录 `data/avatars/`。

数据库是 WAL 模式，**不要在服务运行时直接 `cp` 数据库文件**（最近写入的数据可能还在 `-wal` 文件里，复制出来的文件可能不完整）。用 SQLite 的在线备份：

```bash
cd /srv/gamego/GameGo/server
mkdir -p /srv/gamego/backup
node -e "new (require('node:sqlite').DatabaseSync)('data/gamego.db').exec(\"VACUUM INTO '/srv/gamego/backup/gamego-$(date +%F).db'\")"
tar czf /srv/gamego/backup/avatars-$(date +%F).tar.gz -C data avatars
```

（装了 sqlite3 命令行工具的话，也可以用 `sqlite3 data/gamego.db ".backup '/srv/gamego/backup/gamego.db'"`。）

每天凌晨自动备份并保留 14 天，`sudo crontab -u gamego -e` 加入：

```cron
30 4 * * * cd /srv/gamego/GameGo/server && node -e "new (require('node:sqlite').DatabaseSync)('data/gamego.db').exec(\"VACUUM INTO '/srv/gamego/backup/gamego-$(date +\%F).db'\")" && tar czf /srv/gamego/backup/avatars-$(date +\%F).tar.gz -C data avatars && find /srv/gamego/backup -mtime +14 -delete
```

建议再把备份目录同步到另一台机器或对象存储。

恢复：

```bash
sudo systemctl stop gamego
cd /srv/gamego/GameGo/server/data
rm -f gamego.db-wal gamego.db-shm
cp /srv/gamego/backup/gamego-2026-09-25.db gamego.db
tar xzf /srv/gamego/backup/avatars-2026-09-25.tar.gz -C .
sudo chown -R gamego:gamego .
sudo systemctl start gamego
```

### 8.2 升级

```bash
cd /srv/gamego/GameGo
sudo -u gamego git pull
cd server && sudo -u gamego npm ci --omit=dev
sudo systemctl restart gamego
```

重启时服务会先保存进行中的对局，启动后自动恢复（读秒从保存的剩余时间继续，停机时间不计）。数据库结构的升级（迁移）在启动时自动执行。

### 8.3 常见问题

| 现象 | 排查 |
|---|---|
| 小程序报"不在以下 request 合法域名列表中" | 第 7.1 节的域名没填或填错；开发阶段可在开发者工具里勾选"不校验合法域名" |
| 登录返回 503 `wx_not_configured` | `.env` 中 `WX_APPID` / `WX_SECRET` 为空 |
| 登录返回 502 `wx_login_failed` | AppSecret 错误、AppID 与小程序不一致，或服务器无法访问 `api.weixin.qq.com`；看 `journalctl -u gamego` 的具体原因 |
| WebSocket 连不上 / 立刻断开（1006） | nginx 的 `/ws` 没有转发 `Upgrade` / `Connection` 头；socket 合法域名没填 wss |
| 对局中隔一段时间断线 | nginx `proxy_read_timeout` 太短 |
| 上传头像返回 413 | nginx `client_max_body_size` 太小 |
| 头像不显示 | `PUBLIC_BASE_URL` 不是外部能访问的地址 |
| `/api/ai/levels` 的 `available` 为 false | KataGo 三个路径没配全或不可执行；看启动日志 |
| 启动报 `node:sqlite` 不存在 | Node 版本低于 22.13 |
| `systemctl status gamego` 显示 `status=203/EXEC` | `ExecStart` 的 node 路径不对，或 node 装在 `/root`、`/home` 下被 `ProtectHome` 挡住（见第 1 节） |
| 日志里 KataGo 反复启动失败、`AppImages require FUSE to run` | systemd 服务里缺 `Environment=APPIMAGE_EXTRACT_AND_RUN=1`（见第 3.1 节） |
| 启动报 `DEV_LOGIN=1 不能用于正式环境` | 正式环境把 `.env` 的 `DEV_LOGIN` 改回 0 |
| 请求返回 429 `rate_limited`、排行榜头像显示成昵称首字、一直"连接中" | 触发了限流。nginx 按 IP 限流：很多用户共用一个出口 IP（手机网络、校园网、公司网）或 nginx 前面有负载均衡 / CDN（见第 6 节 `set_real_ip_from`）时调大第 6 节的数值；服务端按用户限流，持续大量出现时排查是否有脚本在刷接口 |
| 设置昵称/头像返回 `content_risky` | 微信内容安全检测判定违规 |
| 设置昵称/头像返回 `sec_check_unavailable` | `SEC_CHECK=strict` 且微信接口出错：日志里有微信的 errcode（40164 服务器 IP 不在 IP 白名单、45009 当天次数用完——未发布的小程序每天只有 100 次）；不确定时改回 `SEC_CHECK=on`（见第 4 节） |
| 修改昵称返回 `sec_check_retry` | 微信要求被检测的用户近两小时打开过小程序；在小程序里重新打开后再改即可 |
| 上传头像返回"头像图片太大" | 开启内容安全检测时头像必须在 750×1334 像素、1MB 以内（imgSecCheck 的送检限制），换一张或裁小一点 |

## 9. 本地开发

不需要服务器、域名和备案，在自己电脑上就能跑通联网对局（用开发登录代替微信登录）。

### 9.1 在电脑上启动服务端

```bash
cd server
npm install
cp .env.example .env         # Windows：copy .env.example .env
```

查电脑的局域网 IP：Windows 运行 `ipconfig` 看"IPv4 地址"；macOS 运行 `ipconfig getifaddr en0`；Linux 运行 `ip addr`。假设是 `192.168.1.100`，编辑 `.env`：

```ini
HOST=0.0.0.0
PORT=8080
PUBLIC_BASE_URL=http://192.168.1.100:8080
DEV_LOGIN=1          # 开放开发登录，不需要 AppSecret
AI_FALLBACK=1        # 没装 KataGo 时用内置弱 AI
```

启动：

```bash
npm start            # 或 npm run dev（改代码自动重启）
```

浏览器打开 `http://192.168.1.100:8080/healthz` 能看到 `{"ok":true}` 即可。

Windows 上如果手机访问不到，需要在防火墙放行 8080 端口（管理员 PowerShell）：

```powershell
netsh advfirewall firewall add rule name="GameGo 8080" dir=in action=allow protocol=TCP localport=8080
```

### 9.2 小程序指向本机

在微信开发者工具里选"导入项目"，目录选**仓库根目录**（`project.config.json` 所在的目录，它把 `miniprogramRoot` 指向 `miniprogram/`），不要选 `miniprogram/` 子目录。

在仓库根目录生成 `miniprogram/config.local.js`：

```bash
npm run config:local
# 自动检测不正确时手动指定：
npm run config:local -- 192.168.1.100 8080
```

生成内容如下：

```js
module.exports = {
  API_BASE: 'http://192.168.1.100:8080',
  WS_URL: 'ws://192.168.1.100:8080/ws',
  DEV_LOGIN: true,
};
```

微信开发者工具：右上角"详情" → "本地设置" → 勾选 **"不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书"**（仓库的 `project.config.json` 已默认关闭域名校验）。

- 客户端先尝试微信登录；服务端没有配置 AppSecret 时返回 `wx_not_configured`，客户端在 `DEV_LOGIN: true` 时自动改用开发登录（每台设备随机生成一个设备号，存在本地存储里，所以同一份本地存储就是同一个用户）。
- **一个模拟器不能和自己对局**（同一个用户的第二条连接会把第一条顶掉）。两人对局测试需要两份独立的本地存储：
  - **只有一台电脑**：用开发者工具的"多账号调试"（工具栏 → 多账号调试，添加一个测试账号）。每个账号的模拟器有自己的本地存储，也就是不同的设备号、不同的用户。开两个项目窗口不行：它们共用本地存储，是同一个用户。
  - **加一部手机**：用"预览"或"真机调试"在手机上打开（手机和电脑连同一个 Wi-Fi，在小程序右上角菜单里打开"开发调试"，否则会校验域名）。**仓库里的 `touristappid`（游客模式）不能预览和真机调试**，要先到 <https://mp.weixin.qq.com/wxamp/sandbox> 申请一个**测试号**，把它的 AppID 写进 `project.private.config.json`（`{ "appid": "wx…" }`，只在本机生效，不要提交——确认 `.gitignore` 里有这个文件名）或 `project.config.json` 的 `appid`。

### 9.3 本地使用 KataGo（可选）

Windows 开发机按 [ai.md 第 4.1 节](ai.md#41-windows开发机) 安装：下载 **v1.18.1** 的 `katago-v1.18.1-eigenavx2-windows-x64.zip`（<https://github.com/lightvector/KataGo/releases/download/v1.18.1/katago-v1.18.1-eigenavx2-windows-x64.zip>，CPU 不支持 AVX2 时换成 `eigen` 版；不要下最新版，v1.18.2 没有 CPU 版），**整个解压**到 `server/katago/`（`katago.exe` 旁边的 dll 都要保留），权重用第 3.2 节推荐的 b10c128，放在同一目录。先在 PowerShell 里确认能运行：

```powershell
cd server\katago
.\katago.exe version
```

然后在 `.env` 中设置（相对路径按 `server/` 目录解析）：

```ini
KATAGO_PATH=./katago/katago.exe
KATAGO_MODEL=./katago/kata1-b10c128-s1141046784-d204142634.txt.gz
KATAGO_CONFIG=./katago/analysis.cfg
AI_FALLBACK=0
```

`npm start` 的日志里出现 `KataGo 已就绪`、`/api/ai/levels` 返回 `available: true` 即可。

### 9.4 运行测试

```bash
npm test                       # 仓库根目录：规则引擎 + 小程序纯逻辑（test/*.test.js 与 test/client/*.test.js）
npm run test:client            # 只跑小程序纯逻辑
npm run test:e2e               # 端到端：真实服务端 + 真实小程序代码（需要先在 server/ 下 npm install，约 30 秒）
cd server && npm test          # 服务端全部测试（含集成测试；内存/临时数据库 + 假 AI，不需要 KataGo）
npm run test:integration       # （在 server/ 下）只跑集成测试
```

不要写成 `node --test test/client/`：Node 22 会把目录当成一个模块去加载，直接报错。
设置了 `KATAGO_PATH` 等环境变量时，服务端测试还会运行真实 KataGo 的测试。只跑真实 KataGo 的测试（在 `server/` 下，路径换成你的）：

```bash
# bash / Git Bash
KATAGO_PATH=./katago/katago.exe KATAGO_MODEL=./katago/kata1-b10c128-s1141046784-d204142634.txt.gz KATAGO_CONFIG=./katago/analysis.cfg \
  node --disable-warning=ExperimentalWarning --test test/ai/ test/katago.real.test.js
```

```powershell
# Windows PowerShell（环境变量只在当前窗口有效）
$env:KATAGO_PATH = './katago/katago.exe'
$env:KATAGO_MODEL = './katago/kata1-b10c128-s1141046784-d204142634.txt.gz'
$env:KATAGO_CONFIG = './katago/analysis.cfg'
node --disable-warning=ExperimentalWarning --test test/ai/ test/katago.real.test.js
```

根目录的 `npm test` / `npm run test:e2e` 与服务端一样需要 **Node.js ≥ 22.13**（`node --test` 的通配符参数从 Node 21 才支持，端到端测试还要 `node:sqlite`）。

### 9.5 上线前检查清单

- [ ] `.env`：`DEV_LOGIN=0`、`AI_FALLBACK=0`、`HOST=127.0.0.1`、`PUBLIC_BASE_URL=https://你的域名`、`WX_APPID/WX_SECRET` 已填、`SEC_CHECK` 不是 `off`
- [ ] `miniprogram/config.local.js`：https / wss 正式地址，`DEV_LOGIN: false`
- [ ] `project.config.json`：`appid` 为正式 AppID
- [ ] 微信公众平台：四类服务器域名、用户隐私保护指引（昵称头像 + 剪切板两项）、小程序备案
- [ ] nginx：`nginx -t` 通过（旧版本 nginx 不要打开 `http2 on`）、证书有效、`/ws` 转发 Upgrade、`client_max_body_size 3m`、`limit_req`/`limit_conn` 限流（`/avatars/` 用单独的宽限流）、`gamego_noargs` 访问日志格式
- [ ] systemd：`Environment=APPIMAGE_EXTRACT_AND_RUN=1`、node 路径不在 `/root`、`/home` 下；`/api/ai/levels` 返回 `available: true`
- [ ] 备份定时任务已配置并验证过一次恢复
