# MiniMax 适配层（DSH 插件）调研报告

> 调研时间：2026-11-07（数据来自 GitHub REST API `api.github.com/repos/…` 与 raw.githubusercontent.com 直读源码）。
> 说明：本会话 `github` 工具依赖的 `gh` CLI 未安装（spawn ENOENT），全部事实改用 `web_fetch` 对 GitHub 匿名只读 API 与 raw 源码核实，每条结论附来源 URL。标 ⚠ 处为"已核实但与仓库存疑或口径不一致"。

---

## 1. 仓库总览

| # | 仓库 | 存在性 | Star | 语言 | License | 最近 push (UTC) | 定位 |
|---|---|---|---|---|---|---|---|
| 1 | MiniMax-AI/cli | 公开 | 2,211 | TypeScript | MIT（badge；API 返回 license=null | 2026-10-19 | MiniMax 官方 CLI + TS SDK，主力依赖 |
| 2 | MiniMax-AI/minimax_search | 公开 | 64 | Python | 无 | 2025-11-03（已近一年无更新 ⚠） | MCP 搜索/浏览服务器 |
| 3 | welsione/dsh-mmx-bridge | 公开 | 13 | JavaScript | MIT | 2026-09-18 | **已有 DSH 桥接插件（最核心参照）** |
| 4 | MiniMax-AI/MiniMax-Coding-Plan-MCP | 公开 | 101 | Python | MIT | 2026-08-20 | Coding-Plan 订阅专用 MCP（search/VLM） |
| 5 | omdsh-dev/dsh-deep-research | 公开 | 31 | TypeScript | MIT | 2026-08-12 | DSH 深度研究插件（workflow 引擎） |
| 6 | lidangzzz/goal-driven | 公开 | 1,754 | 无代码（纯 Prompt 文档） | 无 | 2026-03-18 | 目标驱动外循环方法论 |
| 7 | squirrel20/dsh-cron | 公开 | 7 | JavaScript | MIT | 2026-10-10 | DSH 无人值守定时插件 |

来源（元数据）：repo API `repos/MiniMax-AI/cli`、`repos/MiniMax-AI/minimax_search`、`repos/welsione/dsh-mmx-bridge`、`repos/MiniMax-AI/MiniMax-Coding-Plan-MCP`、`repos/omdsh-dev/dsh-deep-research`、`repos/lidangzzz/goal-driven`、`repos/squirrel20/dsh-cron`（均 200，公开，无私有/缺失项）。

---

## 2. MiniMax-AI/cli —— 官方 CLI / SDK（适配层的主力通路）

2,211★ / 196 forks / 45 open issues / 11 subscribers；npm 包 `mmx-cli`；Node ≥18；构建用 Bun（`bun.lock`、`build.ts` 把 TS 打包为 `dist/mmx.mjs` 单文件 bundle）。requires **MiniMax Token Plan** 订阅（Global `platform.minimax.io` / CN `platform.minimaxi.com`）；也有按量 API key。
来源：https://github.com/MiniMax-AI/cli （README.md、package.json、根目录 listing）。

### 2.1 能力面（README.md 实测）
- **text**：多轮 chat / repl，流式、system prompt、JSON out；默认模型 **`MiniMax-M3.1-Flash`**（Token Plan、MiniMax Code、按量 key 均可用）。
- **image**：文生图（`--n` 批次、`--aspect-ratio`）。
- **video**：异步任务生成＋进度跟踪（`video task get --task-id`、`video download --file-id`）；两个版本：
  - **Hailuo-2.3**（V1，默认）
  - **MiniMax-H3**（V2：2K/5s/16:9 默认，支持 start image、reference-image/video/audio；预检限制：image 30MB / ref video 50MB / ref audio 15MB / POST body 64MB）
- **speech**（TTS）：30+voices、速度、流式播放；模型名如 `speech-2.8-hd`（SDK.md 示例）；`mmx speech voices` 列举。
- **ASR**（transcribe）：模型 **`asr-1.0`**；支持 wav/aiff/flac/m4a/mp3/aac/opus/ogg，**≤50MB 本地预检、≤500s API 强制**；`--response-format json|verbose_json|srt|vtt`；`--stream` 增量；`recognize` 为别名。省略 `--language` 启用混语种识别。
- **vision**：图片理解（URL / 本地文件 / file-id）。
- **search**：`/v1/coding_plan/search`，**每次最多 10 条结果、无分页参数**（README 引 issue #107）。
- **quota**：额度查询（见 2.3）。
- 双区：Global `api.minimax.io` 与 CN `api.minimaxi.com`，`--region` 全局选项。

### 2.2 认证（README.md「mmx auth」节）
- **OAuth**：Device Authorization Grant（RFC 8628）+ PKCE，浏览器输码，`access_token/refresh_token` 存 `~/.mmx/config.json`，5 分钟缓冲自动刷新，可手动 `mmx auth refresh`。
- **API key**：保存或 `--api-key` 每次传；自动探测 region。二者互斥（一方登录即清除另一方）；优先级 `--api-key flag > OAuth(config) > api_key(config)`。
- 环境变量：`MINIMAX_REGION`、`MINIMAX_BASE_URL`、`MINIMAX_OUTPUT`、`MINIMAX_TIMEOUT`、`MINIMAX_VERBOSE`、**`MMX_CONFIG_DIR`**（子进程/CI 场景指定 config.json 目录——**桥接插件子进程调用 mmx 时必须关注**）。

### 2.3 额度查询（SDK.md）
- `sdk.quota.info()` 返回联合类型：
  - Token Plan / OAuth 凭证 → `QuotaResponse`（字段 `model_remains`）
  - `sk-api-` 前缀按量 key → `AccountBalanceResponse`（字段 `available_amount`）
  - SDK 提供 `isQuotaResponse` / `isAccountBalanceResponse` 类型守卫。

### 2.4 原生 TypeScript SDK（对适配层最有价值）
package.json 声明 `exports["./sdk"] = { import: "./dist/sdk.mjs", types: "./dist/index.d.ts" }`，即 **可 `npm install mmx-cli` 后直接 `import { MiniMaxSDK } from 'mmx-cli/sdk'`，不必 fork 出 mmx 子进程**。模块与 mmx 子命令一一对应（`sdk.text/image/video/speech/vision/search/quota`）。SDK.md：https://github.com/MiniMax-AI/cli/blob/main/SDK.md

### 2.5 源码模块划分
`src/`：`main.ts`（入口）、`registry.ts`（命令注册，12.6KB）、`commands/{text,image,video,speech,vision,search,quota,auth,config,agent,file,help,update}`、`auth/`、`client/`、`config/`、`errors/`、`output/`、`polling/`（异步任务轮询）、`video/`、`files/`、`sdk/`、`types/`、`utils/`。另有 `skill/SKILL.md` + `skill/h3-video/`（面向 agent 的 skill 形态分发，`npx skills add MiniMax-AI/cli`）。
来源：https://api.github.com/repos/MiniMax-AI/cli/contents/src 及 `contents/src/commands`、`contents/skill`。

### 2.6 可复用要点
- 直接依赖 `mmx-cli`（CLI 或 SDK 两种接入）作为 MiniMax 全模态统一入口；SDK 是 TS 原生（与 DSH 同栈），子进程方式仅作 fallback。
- `MMX_CONFIG_DIR` + `mmx auth status` 组合即可在插件进程内做"环境自检"。
- 认证、区域、额度三态（quota vs balance）语义在官方层就处理好了——适配层不用自己实现。

---

## 3. MiniMax-AI/minimax_search —— MCP 搜索服务器（参考价值有限 ⚠）

64★ / Py / 无更新已近一年；标准 MCP stdio 服务器（`list_tools/call_tool`、`stdio_server`），两个工具：
- `search`：`queries[]` 并行搜索（线程池），底层 **Google via Serper API**（`SERPER_API_KEY`），支持 Google 高级语法（`site:`/`intitle:`/`inurl:`/引号精确）。
- `browse`：`urls[] + query`，Jina Reader 转 Markdown（`JINA_API_KEY`），MiniMax LLM 综合回答（`MINIMAX_API_KEY`）。
结构仅 4 文件：`server.py`、`minimax_search_browse.py`、`pyproject.toml`、README。
⚠ 注意：**搜索本身不走 MiniMax 官方 search API**（走 Serper 第三方），与 cli 的 `mmx search`（`/v1/coding_plan/search`）通路不同；且长期未更新。适配层做外部搜索可参照其"并行多 query + 批量浏览 + LLM 归一回答"的输入输出设计，实现路径不必照抄。
来源：https://github.com/MiniMax-AI/minimax_search （README.md、server.py 直读）。

---

## 4. welsione/dsh-mmx-bridge —— 已有 DSH≠MiniMax 桥接插件（**第一参照，重点研究**）

13★ / JS / MIT / npm `dsh-mmx-bridge` v1.0.10；自述适配 **DSH 0.1.0-rc.7 ~ 0.1.5-rc.2 (Web GUI profile)**。

### 4.1 manifest / 注册形式（目标：如何注册成 DSH 插件）
`package.json`（https://github.com/welsione/dsh-mmx-bridge/blob/main/package.json）：
- `main: ./lib/index.js`（服务端插件）；`exports: { ".": "./lib/index.js", "./client": "./lib/client.js" }`（客户端增强独立入口）。
- **`"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web" } }`** ←—— DSH 插件 manifest 的核心字段形态：
  - `dsh.bundle.patch` 指向 bundle 补丁文件，`dsh plugin add` 后**自动**把包写进 profile 的 `dsh.profile.bundles` 并让补丁行生效；
  - `dsh.client.platform: "web"` 声明客户端增强，Web GUI 刷新即加载（服务端仍需重启 dsh，ESM 缓存不热替换）。
- `cordis.patch.yml`（https://github.com/welsione/dsh-mmx-bridge/blob/main/cordis.patch.yml）全部内容即一行：
  ```yaml
  - insert:
      - id: mmx-bridge
        name: dsh-mmx-bridge
  ```
- peerDependencies 走 `@deepseek-ai` 生态：`@deepseek-ai/dsh-settings`、`@deepseek-ai/dsh-home-paths`、`react`（^18 || ^19）；runtime 唯一非 peer 依赖 `@deepseek-ai/schemastery`（配置 schema）。**零第三方运行时依赖**。
- 安装面：`dsh plugin --profile web add dsh-mmx-bridge`（npm 源）／`add github:welsione/dsh-mmx-bridge`；手动安装 = profile 目录 `packages/` 拷贝 + `node_modules` 软链 + 手写 patch 行（AGENT.md §4）。

### 4.2 架构与代码路径
```
lib/index.js   87.5KB  服务端：mmx_bridge 工具、mmx_env 工具、/api/mmx-bridge/* 路由、/mmx-files/ 同源文件服务、图片桥、接管 web_search/read_image
lib/client.js  38.4KB  Web GUI：工具卡片内嵌播放器/预览、设置页管理卡片、图片桥界面零改动
lib/imgjson.mjs 31.3KB  识别缓存内核（vendor welsione/imgjson v0.3.0）：PNG `tEXt` / JPEG `COM` 标准块内嵌 JSON
lib/img-cache.js 7.4KB  缓存层：信封 {v,tool,ts,layers:{<prompt>:{ts,sha256,description}}}，按 prompt 分层，>100 层淘汰
lib/video-args.js 3.4KB 视频参数校验（duration/ratio 仅 H3 支持时自动补 --model MiniMax-H3）
```
调用链（README「架构」节 + AGENT.md）：`用户对话 → DSH Agent → mmx_bridge 工具 → mmx-cli 子进程 → MiniMax API`，产物落 `MMX_OUT_DIR`（默认 `/tmp/mmx-out/`），经同源 `/mmx-files/` 提供（支持 Range、防穿越）。

### 4.3 工具注册面（目标：工具怎么注册、怎么暴露给模型）
- 单工具 `mmx_bridge` 按 `action` 分发 8 能力：`describe`(VLM) / `image`(文生图) / `video`(文图生视频) / `speech`(TTS) / `music`(音乐生成) / `cover`(音频翻唱) / `search`(联网) / `quota`(额度)。
- 辅助工具 `mmx_env`（`status / install / login / set-path`）：Agent 侧自修复 mmx 环境——`mmx_bridge` 环境类错误的错误信息自带修复引导，模型先 `status` 再现场 `install/login/set-path`。
- **可选接管内置工具**：`web_search`（换成 mmx 搜索）、`read_image`（VLM 文字描述），控制文件开关。
- 设置页管理卡片：DSH rc.7+ 要求插件注册 `dsh-mmx-bridge` settings 命名空间并带 `key`（AGENT.md §9；1.0.4+）。
- 图片桥（v1.0.5）：包装 `ctx.llm.resolveModelInfo` 给纯文本模型补声明 `image` 输入能力（DSH 不允许 registerAdapter 替换已注册 provider，故走公开方法包装）；监听官方 `llm/stream` 瀑布事件把图片块落盘改为路径文本后重入，`transforming` 标志防递归（AGENT.md §1 v1.0.5 段）。
- HTTP 面：`install-mmx` / `login-mmx`（api-key 一键登录，**Key 不落盘不写日志不回显**）/ `auth-status` / `set-enabled` 等路由；产物路由 `/mmx-files/<name>`；读取 DSH 附件存储 `attachments/v1` 只读不写（体验：同源文件服务不变更 DSH 存储）。

### 4.4 配置结构
- 控制文件（默认 `/tmp/dsh-vision-control.json`）：`enabled / count / webSearchEnabled / readImageEnabled / imageBridgeEnabled / imageCacheEnabled / mmxBin`（缺省=默认值，显式 false 才关）。
- 环境变量：`MMX_BIN / MMX_OUT_DIR / MMX_CONTROL_FILE / MMX_STATUS_FILE / MMX_DEBUG_LOG / MMX_INSTALL_PATH / MMX_LOGIN_PATH / MMX_AUTH_STATUS_PATH`。
- mmx 二进制解析优先级：控制文件 `mmxBin` > `MMX_BIN` > 自动扫描（`command -v mmx` / `where mmx`、`/usr/local/bin/mmx`、`/opt/homebrew/bin/mmx`、npm 全局目录等）。

### 4.5 MiniMax 侧事实（经此插件核实）
- 视频模型可选：`MiniMax-Hailuo-2.3`（默认）/ `MiniMax-Hailuo-2.3-Fast`(仅图生视频) / `MiniMax-H3` / `MiniMax-H3-Max`；**duration/ratio 仅 H3 支持**，传入自动换 H3。
- ⚠ 重要兼容性事实：**MiniMax Credits / Token Plan 账号不支持 H3 系列**，H3 请求报服务器 2013 错误；插件把该错误翻译成操作指引（对这类账号省略 duration/ratio）。Hailuo-2.3 默认约 6 秒、16:9、无音轨。
- 认证依赖 mmx-cli 自身（OAuth 或 api-key），插件不碰 MiniMax HTTP——只做 mmx 二进制的发现/安装/登录闭环。
来源：README.md、AGENT.md（https://github.com/welsione/dsh-mmx-bridge/blob/main/AGENT.md）、CHANGELOG 文件清单。

### 4.6 可直接复用的设计点
1. **manifest 三件套**（package.json `dsh` 块 + cordis.patch.yml 单行 insert + exports `./client`）—— Cook 书级样板。
2. 单工具 action 分发降低工具数压力；错误信息内置自修复引导（mmx_env）的 Agent-自愈闭环。
3. 产物统一 outDir + 同源静态路由（Range/防穿越）+ URL 带时间戳保证历史链接不失效。
4. 包一层"接管内置工具"的能力进阶路径。
5. 识别缓存（imgjson 内嵌，同图同问零 VLM 调用）——本项目未采用可直接复用 `lib/imgjson.mjs`（零依赖 vendor 包）。
6. 运维文档 AGENT.md 面向 Agent 的安装/排障话术（含"不要重启 dsh，杀自己进程"的约束）。

---

## 5. MiniMax-AI/MiniMax-Coding-Plan-MCP —— 订阅用户专用 MCP（HTTP API 事实源）

101★ / Py / MIT / MIT；uvx `minimax-coding-plan-mcp`；stdio 与 SSE 双传输。专为 **coding-plan 订阅** 用户设计，只有 2 个工具：
- `web_search`：POST **`/v1/coding_plan/search`**，body `{"q": query}`，返回 `{organic:[{title,link,snippet,date}], related_searches, base_resp}`。
- `understand_image`：POST **`/v1/coding_plan/vlm`**，body `{"prompt","image_url"}`（本地文件/URL 统一 base64 化 `process_image_url`），返回 `{"content": "..."}`；仅 JPEG/PNG/WebP。
认证（client.py 实读）：
- HTTP header：`Authorization: Bearer <key>` + **`MM-API-Source: Minimax-MCP`**。
- **key 与 host 必须区域配对**：Global `https://api.minimax.io` ↔ minimax.io 后台 key；大陆 `https://api.minimaxi.com` ↔ minimaxi.com key；错配报 `invalid api key`。
- 错误码映射（base_resp.status_code）：**1004 = 认证错（查 key/host）**、**2038 = 需实名认证（platform.minimaxi.com）**。
结构：`minimax_mcp/{server.py 6KB, client.py 3.7KB, const.py, exceptions.py, utils.py}` + `pyproject.toml`。
来源：https://github.com/MiniMax-AI/MiniMax-Coding-Plan-MCP （README.md、minimax_mcp/server.py、minimax_mcp/client.py 直读）。

复用价值：若适配层想绕过 mmx 子进程、代码内直连 coding-plan HTTP API（搜索 + VLM 两端点），此仓库是**最简可抄实现**（3.7KB 通用 client：URL 拼接、Content-Type 处理、错误码→异常类型）。TTS/视频/额度不在其中。

---

## 6. omdsh-dev/dsh-deep-research —— DSH 深度研究插件（研究循环结构参照）

31★ / TS / MIT；零构建（原生 erasable-only TS；package.json `main: ./lib/types/index.js`，README 自述源码即运行时指向 src/index.ts——⚠ 两者口径不一致：仓库同时存在 `src/index.ts` 与 `lib/` 产物目录；实际包入口以 package.json 的 `lib/types/index.js` 为准，README 主张 src-as-runtime 的加载路径经 tsx hook）。Node ^22.19 || ≥24。

### 6.1 插件注册形态（与 mmx-bridge 同构、再精简）
- package.json：`dsh.bundle.patch` + peerDeps `@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-workflow`、`cordis ^4.0.0-rc.7`。
- cordis.patch.yml：
  ```yaml
  - insert:
      - id: dsh-deep-research
        name: '@dsh-external/dsh-deep-research'
  ```
- src/index.ts（28.8KB 单文件）导出：
  - `name = 'dsh-deep-research'`、**`inject = ['tools', 'workflows']`**（cordis 注入，缺 services 则 loader pending 不mount）
  - `Config` interface（`subagentProvider / plannerModel / researcherModel / synthesizerModel / reviewerModel / maxTotalAgents / maxParallel`）
  - `apply(ctx, config)`：**`ctx.tools.register(defineTool({ name:'deep_research', description, parameters, output:{schema,render}, async execute(args, exec) {...} }))`**，execute 内 **`ctx.workflows.start({ script: SCRIPT, meta: WorkflowMeta, args, subagentProvider?, maxTotalAgents?, parent: exec.agent, signal: exec.signal })`**，等待 `run.result` 后 `run.dispose()`。
- 工具触发纯靠工具描述（深度研究/调研/多源信息综合分析…触发词），**不注册 skill、不注入 system prompt、不碰 TUI**。取消传播走 `exec.signal`。

### 6.2 研究循环结构（信息增益停止——重点）
五阶段（脚本 `SCRIPT` 为静态文本常量注入 workflow 引擎 worker 线程；schema 以 JSON 常量拼接进脚本头部，动态输入全部走 `args`，避免模板注入）：
1. **规划**（`agent(..., schema: PLANNER_SCHEMA)`）：输出 `scope`（答案空间）、`dimensions[]`（信息维度）、`questions[{question, dimension, keywords, acceptance}]`（验收标准）、`coverage_gaps[]`（盲区假设——盲区转为"盲区侦察"问题入研究队列）。
2. **研究闭环**（自适应，非固定流水线）：
   - `while (pending.length > 0 && round < depth + 1)`：每轮取队首 `maxParallel` 个子问题并行研究；**队列语义**：超出的子问题留队首，本轮发现的 **high-priority 缺口**（seen 去重、上限 maxParallel）作为 followUp 追加队尾。
   - 每个子代理内部：预测（选 EIG 最高的高熵点）→ 行动（web_search/web_fetch）→ 更新三态证据 → 边际增益验证；**停止准则：上一轮零增益 / 高优先级缺口清空 / 内部轮上限（depth>=3→4 轮，depth=1→2，否则 3）**。
   - 三态证据 `confirmed[{claim, source, confidence high/med/low}] / uncertain[{point, reason}] / gaps[{aspect, priority}]`（RESEARCHER_SCHEMA）——"条件熵的工程表达"，报告保留置信度与矛盾。
3. **综合**（rate–distortion）：把证据有损压缩为最终报告：摘要/背景/核心发现（按维度组织+行内引用）/不确定性与矛盾/缺口与已验证盲区/结论与建议/参考资料。
4. **对抗性审查**（可选 `review:true`，"信道纠错"）：引用 URL 可达性抽查、覆盖度审计（对照声明维度）、矛盾、过度自信标注。
5. 返回 `{report, review?, rounds, subquestions, completed, failed}`。
来源：https://github.com/omdsh-dev/dsh-deep-research/blob/main/src/index.ts

### 6.3 可直接复用到 MiniMax 适配层
- **"单工具 + workflow 脚本注入官方引擎"** 的编排骨架（无需自研子代理管线）；`defineTool` 的 parameters/output(含 render) 描述格式可直接抄。
- 研究循环的收敛三条停止准则（零增益/缺口清空/硬上限）与三态证据 schema——若想把 MiniMax 的 `search`/`browse` 搜索接替内置 `web_search/web_fetch`，此结构直接兼容。
- **模型分层配置**（planner/researcher/synthesizer/reviewer 各自可指定模型）——正好可以映射到 MiniMax 侧不同价位模型。

---

## 7. lidangzzz/goal-driven —— 目标驱动外循环（方法论文档，非插件）

1,754★ / 127 forks / 无代码（纯 Markdown，仓库体量 ~17KB）/ 2026-03-18 后无更新。
内容：1 master + N subagent 的 prompt 模板（英文版 README.md / 中文 readme_cn.md）：
- 四元概念：**Goal / Criteria（可判定成功条件）/ Subagent / Master Agent**。
- 核心伪代码：`while (criteria not met) { subagent 持续工作 }`；master 每 5 分钟巡检，子代理失活→校验 criteria→不达标则以 **同名** 新子代理接替；criteria 达成才停；显式禁止作为 skill/plugin 注入（避免污染上下文），主 agent 只做：创建/重启子代理、按 criteria 评估、绝不自行停。
- 自述成果：C++ 版 TypeScript 编译器（~100h）、Rust 版 SQLite（~30h）、Lean4→TS（在途）。场景为**可验证的编程/数学/编译器类硬问题**，不是研究类任务。
复用价值：为长时预算（跨续轮）的 MiniMax 调研/生成任务提供**外层收敛骨架**的 prompt 文本（goal+criteria 填空模板）；在 DSH 中可由 dsh-cron 类 host 级调度来扮演"巡检 master"角色（见下），或直接引用其 prompt 作为 DSH goal 提示语的一部分。
来源：https://github.com/lidangzzz/goal-driven （README.md）。

---

## 8. squirrel20/dsh-cron —— DSH 定时插件（调度注册参照）

7★ / JS / MIT / v0.14.5。

### 8.1 manifest（又一种 registry 型插件形态）
- `package.json`：`main: lib/index.js`；`exports: {":", "./client", "./cordis.patch.yml"}`；`dsh.bundle.patch` + **`dsh.client: { inject: ["@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-ui-sidebar","@deepseek-ai/dsh-client-ui-primitives"], platform: "web" }`** —— 客户端注入依赖列表的写法。
- peerDependencies 全套 `@deepseek-ai`：`cordis ^4.0.1`、`dsh-agent/llm/session/storage/storage-domain/tools`、`schemastery`（0.1.1/0.1.5/0.1.7/0.2.0-rc.2 多版本区间）；唯一 dep `zod`（实际 `index.js` 里 `import z from "@deepseek-ai/schemastery"`）。
- cordis.patch.yml：`- insert: { id: dsh-cron, name: 'dsh-cron', config: { jobs: [] } }` —— **patch 行可带默认 config**，profile 层可覆写。

### 8.2 架构（lib/ 模块实测清单）
`index.js`(6KB, cordis 装配) / `service.js`(41KB, 调度核心) / `cron.js`(调度数学) / `registry.js`(插件作业注册表) / `executor.js` / `agent-task.js`(ctx.agents.create 一次性 agent) / `domain.js`(storage domain=cron) / `gc.js` / `security.js` / `tools.js`(18.8KB, 7 个会话工具) / `skill.js`(cron-create skill 注入) / `web.js`(HTTP 路由+Bearer) / `client.js`(103KB 侧边栏 overlay)。

### 8.3 `index.js` 实读出的插件代码契约（**给新 DSH 插件抄的标准形**）
```js
export const name = "cron"
export const provide = "cron"        // 对外提供的服务名（供其他插件 ctx.cron.registerJob）
export const inject = ["storage","storageDomain","agents","agentDefaultModel","sessions","tools"]
export const Config = z.object({...})   // @deepseek-ai/schemastery
export function apply(ctx, config) {
  ctx.provide("cron", registry.api)     // 先供后建：registry 先收注册、队列排队
  ctx.effect(() => { /* service.start(); 重载时 registry.flush(); 返回 dispose */ }, "标签")
  ctx.on("agent/created", ({agent}) => { /* 每会话注册 agent-scoped 工具 */ })
}
```
来源：https://github.com/squirrel20/dsh-cron/blob/main/lib/index.js

### 8.4 三种作业声明 + 三种任务类型
- 触发：`cron`（5 字段+显式 IANA timeZone）/ `everySeconds`（锚对齐，≥60s）/ `at`（RFC3339 一次性）。
- 任务：`agent`（ctx.agents.create → submit → 等静默 → 取最后助手消息 → dispose，即 dsh-headless 配方）/ `command`（spawn 进程，记 exit code+输出尾巴）/ `callback`（**仅插件可注册**：传入自己进程内的 handler，表单与 cron_create 拒绝该类型；handler 收 `{job,target,seq,signal}`，可返回 `{ok,summary,error}`）。
- 目录：可从 CLI/stream 之外的插件代码调 **`ctx.cron.registerJobs([{name, schedule, task, policy}], {owner})`**，owner 必填、同名冲突 throw、批量注册失败整批回滚、dsh-cron 自身重启会重放注册。
- 安装四路：插件市场（dsh-market）/ release tgz（npm 包名被无关项目占用 ⚠）/ profile package.json+`dsh.profile.bundles`/ UI 运行时 overlay / 其他插件经 cron service。
- 安全模型（README"Security"节）：无人值守属 host 管理，会话工具化需要 danger-full-access 等；manually 创建的作业有授权 digest 与隔离（quarantine）；web 写需 ≥32 字符 `webControlToken`；命令环境变量白名单。
来源：https://github.com/squirrel20/dsh-cron （README.md、lib/index.js、lib/ 内容 API）。

### 8.5 可复用到 MiniMax 适配层
- 若适配层要"定时产出（每日心跳/每日生成日报/晚间巡检）"，可直接作为 dsh-cron 的**消费者插件**：`inject: ["cron"]` + `ctx.effect(() => ctx.cron.registerJob({...kind:"callback" 或 "agent"}, {owner:"<包名>"}))`，随包安装即挂、卸载即撤（orphan 语义见 README）。
- `callback` 型任务是在**进程内**调用 MiniMax SDK 的零 shell 开销路径。

---

## 9. MiniMax 能力面矩阵（供适配层决策）

| 能力 | 官方通路 | 认证 | 模型/端点 | 备注 |
|---|---|---|---|---|
| 聊天文本 | mmx text / sdk.text.chat | OAuth 或 api-key | `MiniMax-M3.1-Flash` 默认 | Token Plan、MiniMax Code、按量 key 均可用；SDK 支持流式与 thinking(max effort) |
| 文本（HTTP 直连） | — | Bearer key | `/v1/coding_plan/*` 仅 search/vlm；chat 不在其中 | coding-plan MCP 只暴露 2 工具；chat 直连端点未在本次抓取中落地（未核实勿假设 ⚠） |
| 文生图 | mmx image / sdk.image.generate | 同上 | `image-01` | n/aspectRatio |
| 视频 | mmx video / sdk.video.generate | 同上 | `MiniMax-Hailuo-2.3`(-Fast, 图生视频) / `MiniMax-H3`(-Max) | H3 需 key 支持；**Token Plan/Credits 账号 H3 报 2013**（dsh-mmx-bridge 核实）；异步任务+getTask+download |
| TTS | mmx speech synthesize | 同上 | `speech-2.8-hd`（SDK 示例）, 30+voice | 流式、速度、voices() |
| ASR | mmx speech transcribe | 同上 | `asr-1.0` | ≤50MB 本地预检；≤500s API 限；json/verbose_json/srt/vtt；混语种省略 --language |
| 图片理解(VLM) | mmx vision / sdk.vision.describe | 同上 | URL/本地/file-id | coding-plan 账号另有 `/v1/coding_plan/vlm` |
| 搜索 | mmx search / sdk.search.query | 同上 | `/v1/coding_plan/search` | **最多 10 条/次，无分页**（issue #107） |
| 额度 | mmx quota / sdk.quota.info | 同上 | — | Token Plan/OAuth→`model_remains`；`sk-api-` 按量→`available_amount` |
| 音乐 | mmx_bridge(music)（经 mmx 子命令） | 同上 | — | dsh-mmx-bridge 覆盖 |
| 翻唱 | mmx_bridge(cover)（参考音频 prompt+audio） | 同上 | — | 同上 |
| OAuth | mmx auth login（interactive） | Device Flow RFC8628+PKCE | `~/.mmx/config.json` | OAuth 与 api-key 互斥 |
| 双区 | `--region`/`MINIMAX_REGION` | — | `api.minimax.io` / `api.minimaxi.com` | key 必须 host 配对（coding-plan MCP 核实） |

来源：cli README/SDK.md、coding-plan server.py/client.py、dsh-mmx-bridge README+AGENT.md。

---

## 10. 结论与建议（面向"DSH 插件中的 MiniMax 适配层"设计）

1. **通路选型**（按优先级）：
   a. **`mmx-cli/sdk` 原生 TypeScript SDK 直装依赖**（`package.json` dep 即用，同栈零 shell），失败时降级 mmx 子进程（`MMX_CONFIG_DIR` 保留本次会话凭证；二进制扫描优先级抄 dsh-mmx-bridge）。
   b. 少量想直连的端点（coding-plan search/VLM）可抄 MiniMax-Coding-Plan-MCP 的 3.7KB `MinimaxAPIClient`（Bearer + `MM-API-Source` + 1004/2038 错误映射）。
   c. 全站订阅（Token Plan）场景优先走 CLI/SDK——它们对 OAuth token 自动刷新与配额类型分流有官方实现。
2. **manifest 模板**：照抄两种已验证形态之一——
   - 工具插件（mmx-bridge/ deep-research 式）：package.json `dsh.bundle.patch`→cordis.patch.yml 单行 `insert`→exports `./client` 可选客户端增强。
   - 服务提供插件（dsh-cron 式）：`export name/provide/inject/Config(=z.object) /apply(ctx,config)`，`ctx.provide("xxx", api)` + `ctx.effect(dispose)`。
3. **工具面**：单工具+action 分发（8 能力）+错误内嵌自愈引导（mmx_env）是低成本高覆盖方案；若要更细粒度的模型选择（`describe`/`image`/`video`/`speech` 参数差异大），可考虑单一工具+子命名参数或两工具拆分。
4. **研究/生成闭环**：把 dsh-deep-research 的 PLANNER/RESEARCHER 双 schema、EIG 停止三准则、三态证据、分层模型（正好映射 MiniMax 价位分层）+ workflow 静态脚本注入方式偷过来，搜索通路换成 MiniMax `search`（10 条上限需在 planner 构造 query 时考虑切片/改写）。
5. **定时能力**：以 consumer 插件身份对接 dsh-cron `registerJob`（callback 或 agent 型），避免自研调度。
6. **长时预算外层**：goal-driven 模板适合作为"目标+criteria"的 prompt 骨架（不编码为 skill/plugin，注意其自述告诫；可由 host 级调度器承担 master 巡检角色）。
7. **风险**：cross-region key/host 错配（1004）、实名认证（2038）、H3 对 Credits/Token Plan 账号的 2013、search 10 条上限无分页——这四个已知坑应写进适配层错误翻译表。

### ⚠ 未核实 / 口径存疑项清单
- mmx-cli 内 `sdk/` 源码未直读（依据 SDK.md 与 package.json exports；实现细节未验）。
- minimax_search `minimax_search_browse.py` 未直读（其 browse 用的具体 MiniMax 模型名未知）。
- dsh-deep-research 的 README（"源码即运行时 src/index.ts"）与 package.json（`main: ./lib/types/index.js`）不完全一致；以 package.json 为运行时入口更可信（`lib/` 目录存在）。
- dsh-mmx-bridge `lib/index.js`(87KB) 未整篇直读，工具注册/路由结构结论来自 AGENT.md + CHANGELOG 的自述，未逐行核对。
- goal-driven 是方法论不是插件，也没有任何代码，不可当 DSH 插件样板使用。
