---
description: 用 dsh-longterm-intel 做长期信息收集、多模态研究和定时报告时，如何创建/运行/调度研究项目与管理档案。
---

# Long-term Intelligence（长期信息收集与多模态研究）

本插件提供通用能力：信息源接入、内容采集、MiniMax 多模态处理、搜索分析、
长期记忆（SQLite）、证据管理、定时调度、报告生成、额度控制。
它不绑定任何研究主题；具体研究语义全部在项目和档案配置中。

## 数据在哪

数据根目录默认 `~/.dsh/longterm-intel`（可用环境变量 `INTEL_HOME` 改）：

```
config/global.yaml providers.yaml budgets.yaml
config/projects/*.yaml            ← 每个研究项目一个配置文件
config/protected/profiles/*.yaml  ← 个人档案（受保护目录，不上传）
data/intel.db                     ← SQLite 长期记忆
reports/<project_id>/*.md         ← 生成的研究报告
```

## 典型操作

```bash
# 1) 初始化
intel init

# 2) 建项目（编辑 yaml 后）
intel project create <file> --overwrite
intel project list

# 3) 建档案（个人背景默认为空，由用户维护）
intel profile create <file>
intel profile list

# 4) 跑一轮研究（可同时出报告）
intel run <project_id> --report

# 5) 定时：每个项目独立频率
intel schedule create <project_id> --spec '{"cadence":"daily","at":"09:00"}'
# 事件触发：--spec '{"event_trigger":{"sources":["demo-github-project"]}}'
intel schedule list / pause / resume / next / history

# 6) 报告与状态
intel report latest <project_id> --path
intel status [project_id]
intel quota
```

## 版本注意

- `mmx search query` 一次最多 10 条且无分页参数。
- `mmx vision describe` 是图像理解；没有原生视频输入能力——YouTube 走
  字幕 →（无字幕时）音频 ffmpeg 分段 ASR（asr-1.0，单次 ≤500s）→ 关键帧 VLM 的
  工作流，全部产物以文档+证据形式入库。
- 音频转写优先字幕，绝不重复处理同一内容（content_hash 去重）。
- 额度：`mmx quota show` 的百分比是观测真值；每次调用都记 usage_logs；
  保留 20% 余量策略默认开启，触线即停新任务并记录。
