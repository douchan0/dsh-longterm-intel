# 能力实测报告（VERIFIED / NOT VERIFIED 矩阵）

测试时间：2026-11-07 · 环境：macOS（arm64），Node v25.6.1（系统）/ v24.21（DSH 运行时），mmx CLI 1.0.28，yt-dlp + ffmpeg（Homebrew/pyenv）

本报告只记录**真实执行过**的验证；未实测的能力明确标注 NOT VERIFIED。

## 一、MiniMax 引擎（官方订阅，额度独立池）

| 能力 | 状态 | 实测证据 |
|---|---|---|
| `mmx search query` 网页搜索 | VERIFIED | "MiniMax M2" 真实返回 organic 结果（含 minimax.io/news、新华网）；每 query ≤10 条、无分页（官方 issue #107 一致） |
| `mmx text chat`（M3.1-Flash） | VERIFIED | 单条/多轮、`--output json` 含 thinking+text 内容分块与 usage（input/output tokens）；单消息走 `--message` 最稳 |
| `mmx vision describe` 图像理解 | VERIFIED | PIL 生成含 "INTEL-VISION-TEST 7391" 文本的图 → VLM 精确转录 + 描述形状；无效画面时如实回答"无信息量" |
| `mmx speech transcribe`（ASR asr-1.0） | VERIFIED | TTS 合成语音 → ASR 往返文本一致（"今天是十一月七日的语音转写测试…七三九一"），verbose_json 含 segments/时间戳 |
| TTS `speech synthesize` | VERIFIED | female-shaonv 输出 138KB mp3（供 ASR 往返与音频分段测试） |
| 视频原生理解 | NOT AVAILABLE（明确无此能力） | 官方 CLI 只有视频**生成**。按任务书设计回退工作流：字幕→音频分段 ASR→关键帧→VLM（下节验证） |
| `mmx quota show` 额度观测 | VERIFIED | interval/weekly remaining_percent 可观测；总计数器返回 0 → 额度管理以百分比真值为准 |

## 二、多模态研究工作流（端到端，真实执行）

本地合成 12s 测试视频（testsrc 渐变画面 + 真实语音）经 HTTP 服务，全部走同一 `processVideoItem` 工作流：

- 元数据（yt-dlp `--dump-single-json`）→ 入库 `video_meta`：VERIFIED
- 字幕：本地样例无字幕轨 → 正确跳过并记录 note（真实 YouTube 字幕要求 cookies，见下）
- 音频：yt-dlp 提取音频 → ffmpeg 需按 ≤500s 分段 → `mmx speech transcribe` → 文本正确入库，与原 TTS 台词一致：VERIFIED
- 关键帧：ffmpeg fps 均匀抽帧 → `mmx vision` 分析 3 帧 → `video_frame_analysis` 文档入库（画面无信息量时模型如实作答）：VERIFIED
- 防重复处理：同 URL 已有文档时工作流跳过并记录（"skipped: N document(s) already captured"）：VERIFIED

## 三、长期记忆与研究闭环

- SQLite（node:sqlite，Node ≥22.13）建库 15 张表、WAL、项目索引与唯一去重索引：VERIFIED（JSON-文件降级后端存在但仅为兜底，未做性能/一致性正式验证 → 降级路径 NOT VERIFIED，仅代码路径存在）
- 增量采集 + `(source_id, content_hash)` 去重：VERIFIED（同内容重复 ingest 返回 null）
- 断点续跑：上轮崩溃遗留的 `status=new` 条目与未分析文档在下一轮被自动接续处理：VERIFIED（真实崩溃后恢复验证）
- 历史观点追踪：claims 带 first_seen/last_seen/status/superseded_by 链式替代：结构 VERIFIED（DB 记录），长周期真实观点演变案例未观察（需要长期运行）
- 证据链：每条 claim 携带 quote/URL/时间/可信度，报告可点回原文：VERIFIED（APAC + smoke 报告）
- 事实/观点/推断/未知 区分（epistemic 字段）：VERIFIED（模型输出含"即使材料未证实""资格未核实"的真实标注）
- 子问题自主研究 + 预算内后续搜索：VERIFIED（smoke 项目自动提出 3 个子问题并真实执行 1 次 MiniMax 搜索把结果落库）

## 四、三层架构（插件 / 研究项目 / Profile）

- 多项目隔离：intel-smoke / intel-mm / apac-job-intel 三个项目并行运行，source_items/claims 均带 project_id 且查询全部按项目过滤（测试覆盖 + status 按项目查询通过）：VERIFIED
- Profile：创建/更新/暂停/授权门控（can_be_used_by + associated_profiles）；未授权显示 NOT GRANTED；未创建显示 NOT FOUND（不臆造）：VERIFIED（单元测试 isolate cases）
- Profile 默认空、无推断：VERIFIED（resolveProfilesForProject 空档案输出显式"未知"声明）
- Profile 存储：`<dataRoot>/config/protected/profiles/`（默认 ~/.dsh/longterm-intel，在仓库之外，.gitignore 兜底）：VERIFIED

## 五、调度与运行控制

- hourly/daily/weekly/monthly/一次性 的 next_run 计算（IANA 时区，DST 安全）：VERIFIED（单测 + 真实 schedule create）
- schedule create/pause/resume/run/next/history/list：VERIFIED（端到端）
- 事件触发调度（event_trigger 无新内容 → idle）：结构实现，实际触发场景 NOT VERIFIED（需要长期运行观察）
- 重试与退避、并发上限：代码路径实现（单测覆盖 pause/resume 持久化；重试路径未触发真实失败场景 → 重试分支 NOT VERIFIED）
- DSH 内运行：插件经 `plugin_manager` 以 `link:` 方式真实安装并激活（`fiberPhase: active`，模块名 dsh-longterm-intel）：VERIFIED
- 停机/重启状态恢复：跨进程状态在 SQLite，重复运行由 DB 状态防止叠加：VERIFIED（重启 CLI 多次运行的数据一致性）

## 六、额度管理

- 双池建模（MiniMax 订阅=观测真值；DeepSeek/glm OpenCode Go=独立记账）：MiniMax VERIFIED；OpenCode Go 在会话内受沙箱端口冲突限制 → **NOT VERIFIED in-session**（providers.yaml 已留 config；服务器进程内不受限）
- 全局日上限拦截：VERIFIED（上限=1 时第 2 次新分析被拦且 skip_budget 记账）
- 20% 保留线：实现并单测（percent<=reserve 拒绝新任务）
- 用量记账：usage_logs quantity 整型、按项目/工具聚合：VERIFIED
- 项目预算不得互相耗尽：VERIFIED（计数按 project_id 过滤）

## 七、DSH 工具面

- 17 个 `intel.*` 工具 + 1 个 `intel_schedule_manage`（注：schedule 管理聚合为一个工具以避免接口膨胀）注册成功：安装激活 VERIFIED
- 会话内直接调用工具的行为（model→tool→execute 链路）：待新会话验证 → 标注 NOT VERIFIED（本会话工具清单在安装前已固定）

## 八、已知限制（诚实清单）

1. YouTube：环境要求登录校验（"Sign in to confirm you're not a bot"）。已实现 `spec.cookies_from_browser`/`spec.cookies`/`spec.extra_args` 透传，但**本机无可用 cookie → YouTube 平台流水线 NOT VERIFIED（权限限制如实上报）**；工作流本体已用等效视频链路完整验证。
2. Twitter/X、播客 RSS、Greenhouse/Lever/Ashby/Workday 深度 Connector：架构就位（source/kind 注册机制），专用 connector NOT IMPLEMENTED（第四阶段）。
3. JSON 降级存储后端：未做正式验证。
4. 报告图表（图片渲染）：MVP 输出 Markdown 表/列表，无图片图表（报告模板支持自定义小节）。
5. web 页面正文抽取：内置轻量 HTML→text，复杂站点需要更完整的可读性抽取（第四阶段）。

---

# 第二轮验收补充（2026-11-07 晚，首个真实项目 apac-job-intel）

| 项 | 结论 | 证据 |
|---|---|---|
| 调度真实触发（一次性任务） | VERIFIED | spec.at=now+90s，Host 进程 14:27:25Z 真实启动 research run（ периода DB run 9d7e79d8131fbb started_at），随后外部 pkill 打断 |
| 一次性任务自我禁用 | VERIFIED（修复后） | 触发成功后 enabled=0 / next_run_at=null（否则复触发 bug，已修，commit "scheduler: one-shot disables itself"） |
| 暂停阻断 Host 执行 | VERIFIED | pause 后 5s tick 内 last_status 不变，无新 run |
| 重启识别 | VERIFIED | 跨进程 SQLite schedule rows 保留（daily next=北京 08:00、weekly next=周五 12:00 UTC）并由新 Host 加载 |
| 中断恢复（--resume） | VERIFIED | 被外部杀掉的悬垂 running run → `intel run --resume` 标 interrupted → 新轮完成；遗留未分析文档被自动接续（11-47 个 docs 两轮 recovery） |
| stale overlap 保护 | VERIFIED | 依"真实 in-flight run（6h 窗口）"判断，schedule cell 卡死不再永久阻塞 |
| RSS 瞬时失败不毁轮 | VERIFIED | 单源 fetch failed → 新状态 `completed_with_errors`（24 obs/18 claims 已入库） |
| 视频不重复转写 | VERIFIED | 第二轮+恢复轮 processed 0-1 条、零新增 mmx speech/vision 调用（usage_logs） |
| 岗位重复计数修复 | VERIFIED | claim 身份语义（同 subject 更新 last_seen；update 走 superseded 链）；渲染层每 subject 取最新 |
| 分析批次预算修复 | VERIFIED | 单大批次 thinking 吃满输出 → 每批 ≤16k 字符、单轮 ≤3 批；47 文档分 3 批成功（24 obs/20 claims/16 events） |
| 板 JSON 压缩 | VERIFIED | greenhouse/ashby/lever JSON → "公司::岗位│地区│链接" 行，分析信噪比提升后关键岗位全部成 claim |
| 官方岗位核验 | VERIFIED 5/6 | 6 候选官方链接 fetch：5 存活（含 Databento APAC ×2 官方确认 "Remote/HK/Shanghai/…"），1 已下线 404（Fathom，真实证明"搜索命中≠在招"） |
| B 站源与多模态全链路 | VERIFIED | bilibili_video adapter（BV 规范 URL/去重、多 P 记录）；30 分钟视频 4 段 ASR + 6 帧 VLM；产物 claim JSON 含 platform/bvid/uploader/analysis_method/key_points |
| 大批量 stdin EAGAIN | VERIFIED（修复） | 大 payload 改临时文件传 --messages-file |
| DSH 内调度服务自启 | CODE VERIFIED / RUNTIME PARTIAL | apply() 现在启动 scheduler（stub-ctx 单测调通 18 tools+1 skill 注册）；live DSH 进程重启后的自动执行需下一次 App 重启观察 → PARTIAL |
| 无人值守每日/每周 | NOT VERIFIED（计划配置并暂停） | daily 10:00（北京）与 weekly 报告已就绪但 enabled=0：正式长期 Host 机器未满足（见报告 §13 阻碍），不得宣称自动运行 |
