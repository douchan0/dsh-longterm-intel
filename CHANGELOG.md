# Changelog

## 0.1.0 (2026-11-07)

首个最小可用版本（MVP + 真实测试）。三层架构（插件 / 研究项目 / Profile），未写死任何研究主题。

### Added
- 研究项目系统：YAML/JSON 配置（主题/目标/问题/信息源/关键词/频率/多模态策略/模型策略/预算/报告模板/保留策略/关联档案），项目间数据默认隔离。
- Profile 系统：user / research_subject / project_context 三类档案，默认全空、绝不推断填充；保存在数据根目录 `config/protected/profiles/`（仓库之外）；支持创建/更新/暂停/删除/授权门控（can_be_used_by + associated_projects）。
- Source Adapter：web / RSS（自研解析）、YouTube（yt-dlp：频道/单视频，cookies 透传）、GitHub（REST：repo/releases/commits/issues/PR，since 增量）。统一 `poll()` + 入库去重。
- MiniMax Adapter（mmx CLI，官方订阅池）：search / text（M3.1-Flash，含 thinking 分块与 usage）/ vision / speech transcribe（asr-1.0，>500s 自动 ffmpeg 分段）/ quota / capability。
- 多模态视频工作流（无原生视频理解时的可验证回退）：元数据 → 字幕（manual 优先）→ 音频分段 ASR → 关键帧 → VLM → 综合入库；同 URL 防重复处理。
- SQLite 长期记忆（node:sqlite，15 张表：projects/profiles/sources/source_items/documents/observations/entities/claims/evidence/relationships/events/research_runs/reports/schedules/usage_logs），JSON 文件后端兜底；发布时间与抓取时间分离；断点续跑（遗留 new 条目与未分析文档自动接续）。
- 研究 Agent 闭环：增量采集 → 压缩分析（观测/实体/事件/结论/矛盾/未知量化）→ 历史结论链式替代 → 有界子问题补充搜索 → 停止；输出截断可抢救（balanced-prefix / salvageArrays）+ 部分结果不标记、下轮重试。
- 调度：每项目独立 hourly/daily/weekly/monthly/一次性/事件触发；暂停/恢复/删除/立即运行/历史/下次运行；DSH 内用官方 timer 面运行，CLI 亦可驱动。
- 报告：默认 12 小节（摘要→…→成本）+ 自定义模板小节（如 APAC 的 jobs_table），Markdown/JSON/CSV，引用上一期报告与溯源链接。
- 额度：双池建模（MiniMax 观测真值 = remaining percent；OpenCode Go = 独立记账）；全局/项目日上限、20% 保留线、触线自动 skip 并记录、usage_logs 整型记账。
- DSH 工具：intel.*（17 个）+ intel_schedule_manage（1 个）+ `longterm-intel` 技能；CLI `intel` 全量命令共享同一 runtime。
- 测试 10/10 通过；APAC 远程求职示范项目（独立配置 + 最小档案）端到端真实运行（HN Jobs RSS + goal-driven 仓库 + MiniMax 新闻页，三轮研究 + 报告）。

### Verified（全部真实执行，见 docs/verifiable-report.md）
MiniMax search/text/vision/ASR/TTS/quota；多模态工作流端到端；增量与去重；断点续跑；项目隔离；Profile 门控与暂停；调度全链路；预算上限拦截；插件以 link: 方式在 DSH 真实安装激活（fiberPhase: active）。

### Not Verified（如实声明）
YouTube 平台（环境要求登录；已实现 cookies_from_browser 透传待用户提供）；OpenCode Go 会话内调用（沙箱端口冲突，配置位已留）；JSON 兜底存储；事件触发调度的长期观察；报告图片图表。
