# 第三方声明（Third-Party Notices）

GameGo 本身以 MIT 许可发布，见仓库根目录的 [LICENSE](LICENSE)（Copyright (c) 2026 xindong1314）。

本文件列出两类第三方内容：

- **仓库里包含**的第三方代码或改编内容。MIT 许可要求在副本中保留它们的版权与许可声明，原文附在各节里。
- 运行时需要、但**仓库里不包含**的第三方软件和数据。部署者要自己下载，并遵守它们各自的许可。列在这里只是为了说明情况。

许可信息核对于 2026-09-25，每一节都附了来源链接。标注“[未核实]”或“[判断]”的地方，是没有找到一手资料确认的内容，或者属于法律判断。

## 概览

| # | 名称 | 在本仓库中的位置 | 仓库里是否包含 | 许可 |
|---|---|---|---|---|
| 1 | KaTrain（Calibrated Rank / Policy AI） | `server/src/ai/rank.js`（移植代码）；`server/test/ai/fixtures/katrain-reference.json`（原程序的输出数据） | **包含**（JavaScript 移植） | MIT |
| 2.1 | KataGo 示例配置 `analysis_example.cfg` | `server/katago/analysis.cfg` | **包含**（精简改写） | MIT |
| 2.2 | KataGo 程序 v1.18.1 | 由 `server/src/ai/katago.js` 以独立进程调用 | 不包含，部署者自行下载 | MIT，另含若干各自许可的第三方组件 |
| 2.3 | KataGo 神经网络权重（kata1 系列） | 由部署者放在 `server/katago/`（已被 .gitignore 忽略） | 不包含，部署者自行下载 | KataGo Neural Network License（MIT 措辞） |
| 3 | ws 8.21.3（npm） | `server/package.json` 的依赖 | 不包含，由 `npm install` 安装 | MIT |
| 4 | Mulberry32 伪随机数算法 | `server/test/ai/helpers.js`（只用于测试） | **包含**（约 8 行） | CC0 / 公有领域 |
| 5 | Node.js、SQLite、微信小程序平台 | 运行环境与平台 API | 不包含 | 见第 5 节（不需要署名） |

---

## 1. KaTrain：Calibrated Rank / Policy AI 的 JavaScript 移植

- **用途**：人机对弈的弱档 AI。`server/src/ai/rank.js` 把 KaTrain 的 “Calibrated Rank” AI（`ai:p:rank`，`RankStrategy`）和 “Policy” AI（`PolicyStrategy`，含 `WeightedStrategy` 的开局随机化）移植成了 JavaScript，包括辅助函数 `policy_ranking`、`var_to_grid`、`weighted_selection_without_replacement`。
- **来源**：https://github.com/sanderland/katrain ，commit `f4981cf905cece90085ce4e3967415d0c16d525f`（即 tag `v1.20.0`，2026-08-24）。移植的是以下文件里的逻辑：`katrain/core/ai.py`、`katrain/core/utils.py`、`katrain/core/game_node.py`。具体行号写在 `rank.js` 的文件头里。
- **段位校准公式**：作者是 bale-go（https://github.com/bale-go ）。KaTrain 的 `CONTRIBUTIONS.md` 把 “calibrated rank” AI 记在他名下，相关讨论见 KaTrain issue #44 和 #74。
- **测试数据**：`server/test/ai/fixtures/katrain-reference.json` 里是 KaTrain 原版 Python 代码对 3000 组合成输入选出的着法，用来逐手比对移植结果。文件里只有数值输出，没有 KaTrain 的源代码文本；`about` 字段写明了出处。
- **许可**：MIT。KaTrain 的 `LICENSE` 开头列出了四类不适用 MIT 的内容：KataGo 二进制、flaticon 图标、DIGITAL-7 字体（仅限非商业使用）、Noto Sans 字体（SIL OFL 1.1）。**本项目没有使用其中任何一项**。移植的 Python 逻辑属于 LICENSE 里 “all other content”，适用下面的 MIT 许可。
- **保留要求**：下面的版权与许可声明已经完整写在 `server/src/ai/rank.js` 的文件头里，修改该文件时**不要删改这段声明**。文中提到的 `CONTRIBUTIONS.md` 不在本仓库中，见 https://github.com/sanderland/katrain/blob/f4981cf905cece90085ce4e3967415d0c16d525f/CONTRIBUTIONS.md 。
- **来源链接**：
  - 许可原文：https://raw.githubusercontent.com/sanderland/katrain/f4981cf905cece90085ce4e3967415d0c16d525f/LICENSE
  - tag 与 commit 的对应关系：https://api.github.com/repos/sanderland/katrain/git/refs/tags/v1.20.0
  - bale-go 的署名：https://github.com/sanderland/katrain/blob/f4981cf905cece90085ce4e3967415d0c16d525f/CONTRIBUTIONS.md
  - 讨论：https://github.com/sanderland/katrain/issues/44 、https://github.com/sanderland/katrain/issues/74

KaTrain 许可原文（“all other content” 部分）：

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

---

## 2. KataGo

KataGo 的作者是 David J Wu（“lightvector”）等人：https://github.com/lightvector/KataGo 。

### 2.1 `server/katago/analysis.cfg`（改编自 KataGo 示例配置）

- **用途**：KataGo 分析引擎的配置文件，服务端启动 `katago analysis` 时传入。
- **来源**：KataGo v1.18.1 自带的 `cpp/configs/analysis_example.cfg`（527 行），https://github.com/lightvector/KataGo/blob/v1.18.1/cpp/configs/analysis_example.cfg 。本项目的版本精简到 76 行，注释全部用中文重写，没有保留上游的英文注释。和上游相同的只有参数名（这是 KataGo 的配置接口）和少数几项默认值。
- **许可**：上游文件本身没有许可头，适用 KataGo 仓库对 “all OTHER content” 的 MIT 许可（原文见 2.4）。
- [判断] 保留下来的内容很少，很可能构不成 MIT 所说的 “substantial portions”。出于谨慎，这里仍然附上 KataGo 的版权与许可声明。

### 2.2 KataGo 程序（仓库里不包含）

- **用途**：人机对弈和终局死子判断。服务端（`server/src/ai/katago.js`）把 `katago analysis` 作为**独立的子进程**启动，通过标准输入输出交换 JSON。本项目不修改、不链接、不打包 KataGo。
- **获取方式**：部署者从 https://github.com/lightvector/KataGo/releases 下载 v1.18.1 的发布包，步骤见 `docs/ai.md` 第 4 节，文件放在 `server/katago/`。这个目录已被 `.gitignore` 忽略，只有 `analysis.cfg` 除外。
- **许可**：MIT，版权行 `Copyright 2025 David J Wu ("lightvector") and/or other authors of the content in this repository.`。KataGo 另外依赖若干第三方库和文件，它们有各自的许可，位于 KataGo 源码的 `cpp/external/` 下：clblast、composable_kernel_fmha、cudnn-frontend、cutlass、filesystem-1.5.8、half-2.2.0、httplib、katagocoreml（内含 Apple coremltools 和 FP16 的部分组件）、macos（Swift CMake 模块）、mozilla-cacerts、nlohmann_json、sgfmill、onnx、tclap-1.2.5。此外 `cpp/core/sha2.cpp` 自带许可，`python/katago/model_pytorch.py` 的部分内容改编自其他开源作者。
  - [未核实] sgfmill 列在 KataGo 的 LICENSE 里，但 v1.18.1 的 `cpp/external/` 下没有它，没有查到它在仓库里的位置。
  - [未核实] Eigen 版可执行文件还使用了 Eigen 库，KataGo 的 LICENSE 没有列出它，本文也没有核对它的许可。
- **本仓库的义务**：没有，因为仓库不分发 KataGo。如果将来分发 KataGo 可执行文件（例如打进 Docker 镜像或发布包），需要附上 KataGo 的 `LICENSE` 和对应构建所用 `cpp/external/` 组件的许可。
- **来源链接**：
  - https://raw.githubusercontent.com/lightvector/KataGo/v1.18.1/LICENSE （tag commit `92ee95c0a4b25fec214da00951ab69e97e207729`，与 master 上的 LICENSE 逐字节相同）
  - https://github.com/lightvector/KataGo/blob/v1.18.1/README.md#license
  - https://api.github.com/repos/lightvector/KataGo/contents/cpp/external?ref=v1.18.1

### 2.3 KataGo 神经网络权重（仓库里不包含）

- **用途**：KataGo 需要的神经网络权重文件。文档（`docs/ai.md` 第 4 节）只给出下载链接和 SHA-256，仓库里没有权重文件。推荐的两个网络是：
  - `kata1-b10c128-s1141046784-d204142634`
  - `kata1-b6c96-s175395328-d26788732`
- **获取方式**：部署者从 https://katagotraining.org/networks/ 下载（文件位于 `media.katagotraining.org/uploaded/networks/models/kata1/`）。
- **许可**：KataGo Neural Network License，版权行 `Copyright 2026 David J Wu ("lightvector").`，许可措辞和 MIT 相同，适用对象是 “the neural net files or training weight files”（原文见 2.5）。它覆盖 katagotraining.org/networks 页面上 “kata1” 训练中的全部网络，上面两个网络都在 “Networks for kata1” 列表里。
- **例外**（不适用于上面两个网络；如果换用其他网络，请查看它自己的条款）：
  - “g170” 系列网络采用 CC0，实际上属于公有领域。
  - “zhizi” 系列网络使用单独的 MIT 许可，版权行 `Copyright (c) 2026 hzyhhzy & zhizigo.com`。
  - extra_networks 页面上由外部贡献者提供、没有标为 “KataGo” 的网络，可能没有明确的许可条款。
- **本仓库的义务**：没有，因为仓库只提供链接。再分发权重文件的人需要附上下面的声明。
- **来源链接**：https://katagotraining.org/network_license/ ；https://katagotraining.org/networks/ （网站每页页脚的 “Neural Net License” 链接指向前者）

### 2.4 KataGo 许可原文（适用于 2.1 和 2.2）

```
The code in this repository currently relies on several other libraries, parts of libraries,
or external files: clblast, composable_kernel_fmha, cudnn-frontend, cutlass, filesystem-1.5.8, half-2.2.0,
httplib, katagocoreml (which itself vendors components from Apple's coremltools and the FP16
library), macos (Swift CMake modules), mozilla-cacerts, nlohmann_json, sgfmill, onnx, and
tclap-1.2.5. For the licenses for those libraries and/or files, see the individual readmes and/or
license files for each one within their respective subdirectories within cpp/external.
Additionally, cpp/core/sha2.cpp derives from another piece of external code and embeds its own
license within that file.

Some parts of python/katago/model_pytorch.py and a few other files, where noted, are modifications
of code from other open source authors.

Aside from the above, the license for all OTHER content in this repo is as follows:

----------------------------------------

Copyright 2025 David J Wu ("lightvector") and/or other authors of the content in this repository.
(See 'CONTRIBUTORS' file for a list of authors as well as other indirect contributors).

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

----------------------------------------

Additional disclaimer from David J Wu ("lightvector") regarding the above license and KataGo's
repository (https://github.com/lightvector/KataGo):
I am providing code in the repository to you under an open source license. Because this is my
personal repository, the license you receive to my code is from me, and not from any of my employers,
present or past (including Facebook, during part of 2020-2023).
```

`CONTRIBUTORS` 文件不在本仓库中，见 https://github.com/lightvector/KataGo/blob/v1.18.1/CONTRIBUTORS 。

### 2.5 KataGo 神经网络权重许可原文（适用于 2.3）

```
KataGo Neural Network License

Copyright 2026 David J Wu ("lightvector").

Permission is hereby granted, free of charge, to any person obtaining a copy of the neural net files or training weight files (the "Software"), to deal in the Software without restriction,
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

---

## 3. npm 依赖：ws 8.21.3（仓库里不包含）

- **用途**：服务端的 WebSocket 实现，是服务端唯一的运行时依赖。`server/package.json` 里写的是 `"ws": "^8.21.3"`，`server/package-lock.json` 锁定 8.21.3。根目录的端到端测试（`test/e2e/`）也从 `server/node_modules` 加载它。ws 没有传递依赖；可选的 peer 依赖 `bufferutil` 和 `utf-8-validate` 没有安装。
- **获取方式**：`npm install` 安装到 `server/node_modules/`，这个目录已被 `.gitignore` 忽略。npm 会把 ws 自带的 `LICENSE` 一起装进 `node_modules/ws/LICENSE`。
- **许可**：MIT。
- **本仓库的义务**：没有，因为仓库不分发 ws。如果将来把 `node_modules` 一起打包分发，请保留 `node_modules/ws/LICENSE`。
- **其他 npm 包**：没有。根目录的 `package.json` 没有任何依赖，小程序也没有 `miniprogram_npm`。
- **来源链接**：https://github.com/websockets/ws ；https://raw.githubusercontent.com/websockets/ws/8.21.3/LICENSE （与本地安装的 `server/node_modules/ws/LICENSE` 相同）；https://registry.npmjs.org/ws/8.21.3

ws 许可原文：

```
Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>
Copyright (c) 2013 Arnout Kazemier and contributors
Copyright (c) 2016 Luigi Pinca and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

---

## 4. Mulberry32 伪随机数算法（`server/test/ai/helpers.js`，只用于测试）

- **用途**：测试里的确定性伪随机数，为 KaTrain 比对测试生成合成输入，约 8 行。
- **来源**：算法作者是 Tommy Ettinger（2017 年，C 语言版）。本项目的 JavaScript 写法与 bryc 整理的 JS 版本一致。
- **许可**：Tommy Ettinger 以 CC0 把算法贡献到公有领域。bryc 的页面写明 “License: Public domain”，其仓库的 LICENSE.md 在公有领域之外另给 MIT 作为后备（Copyright (c) 2024 bryc）。
- **本仓库的义务**：没有。列在这里只是致谢。
- **来源链接**：https://gist.github.com/tommyettinger/46a874533244883189143505d203312c ；https://github.com/bryc/code/blob/master/jshash/PRNGs.md#mulberry32 ；https://github.com/bryc/code/blob/master/LICENSE.md

---

## 5. 运行环境与平台（仓库里不包含，不需要署名）

- **Node.js**（>= 22.13）：服务端和测试只使用 `node:*` 内置模块，Node.js 由部署者自行安装。Node.js 采用 MIT 许可（“Copyright Node.js contributors”）。`node:sqlite` 内嵌的 SQLite 属于公有领域。本项目不分发 Node.js，所以不需要署名。
  来源：https://github.com/nodejs/node/blob/v22.17.0/LICENSE ；https://sqlite.org/copyright.html
- **微信小程序平台**：小程序调用 `wx.*` 接口，服务端调用 `api.weixin.qq.com` 的接口（`jscode2session`、`stable_token`、`msg_sec_check`、`img_sec_check`）。仓库里没有腾讯的代码，也没有照抄官方文档的内容，代码注释里只引用了文档链接。使用平台须遵守《微信小程序平台服务条款》。“微信”“WeChat”是腾讯公司的商标，本项目与腾讯公司没有关联。
  来源：https://developers.weixin.qq.com/miniprogram/product/service/ ；https://developers.weixin.qq.com/miniprogram/dev/framework/security.html

---

## 6. 如果将来分发二进制或镜像

本仓库目前只分发源代码。如果将来发布 Docker 镜像、安装包或其他包含第三方文件的产物，需要随产物附上：

- KataGo 的 `LICENSE`，以及该构建所用 `cpp/external/` 组件的许可（见 2.2、2.4）；
- 所附权重文件的许可（kata1 网络见 2.5；其他网络以它自己的条款为准）；
- `node_modules/ws/LICENSE`（见第 3 节）；
- 如果打包了 Node.js 运行时，还要附上 Node.js 的 `LICENSE`（它还包含所内嵌依赖的许可）。
