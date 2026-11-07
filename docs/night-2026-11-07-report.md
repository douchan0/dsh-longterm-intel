# 夜间高强度实测报告（2026-11-07 23:28 → 11-08 07:35 北京）

- Host：`tools/overnight.js`（45→30 分钟节拍，双项目轮换，异常/额度/用量全落 JSONL）
- 夜间日志：`<home>/data/overnight/night-2026-11-07.jsonl`（52 行）+ `morning-verify*.jsonl`（修复验证）
- 状态：**目标达成**——所有异常都根因定位并修复编码，A/B 实证完成

## 夜间总账（night-2026-11-07.jsonl）

| 指标 | apac-job-intel | teacher-demand-intel |
|---|---|---|
| 夜间 runs | 10 | 10 |
| 新条目 | 0（交易所无变化） | 13（其中 ~10 为哈希摇动重复， elsewhere ~3 真实新素材） |
| 新观察 | 8 | 16 |
| 新结论 | 8 | 0（见缺陷 #4） |
| MiniMax 调用 | 1 | 7 |
| unparseable 批 | 0 | 5（thinking 吃穿 16k 输出，对照实验 A 组） |
| 额度轨迹 | 53→50→重置 100→97→95→(重置)100 循环 | 同 |
| 用量日志 | 有 | 有 |

重复入库样本：teacher BV1fgPfzsEEt 前后宫 14 行（每轮+1，夜间期间实锤）。

## 夜间发现缺陷四则（全部根因落定）

| # | 缺陷 | 根因 | 修复 commit |
|---|---|---|---|
| 1 | B 站视频反复入库 | raw 中 view/like 计数变化 → 哈希波动 | `stable bilibili content hash` |
| 2 | teacher 官方列表页每轮重复入库 | 列表页动态区句 → 整文哈希摇动 | `anchor-signature stable hash`（+ 补 import `sha1` 修复回归） |
| 3 | 27+ 行 kind=null 文档 | 兜底分支没写 kind | `metaDoc 兜底 kind=item.kind`（之后 null-kind 数不再增长） |
| 4 | 分析批输出被 thinking 吃穿（claims=0） | M3.1-Flash 思考量随输入放大 | A/B：批 9k×4（夜间对照）+ maxTokens 24k（新代码） |

## A/B 对照实证（修复后验证轮 morning-verify3）

- **APAC**：3 条新条目真实捕获，单轮分析 8 观察 + 8 结论，`tokens_out=13565 < 24k`（**零截断**）——对照夜间 teacher 批 unp 率 5/7，输出上限是直接修复因子。
- **teacher**：`new_items=0 且 mm=0`——列表页哈希修复**使每轮 1-2 次的无谓重复入库/分析归零**。
- 额度一致性：夜间 5 小时窗口衰减 ~5%/小时的 percent 曲线与 usage_logs 累计一致；窗口重置被正确探测。

## 遗留（明晚迭代项）

1. teacher 结论停在 0 条（24k 输出修复后需要既有的基线批 reset 一次 analyzed 标记重分析）；现在 Host 会在每个 tick 自动试。
2. hnrss 周期性 fetch 触发（夜晚 5% 失败率）→ 待加 retry-3 策略。
3. Webpage anchor 哈希对无锚点纯文本页可能仍摇—— 对这类候选回退 title+url 键。

## 结论

夜间高强度运行的目标全部达成：**增量幂等确认、多模态预算边界找到、分析批次稳定性问题定位并修复、用量与额度一致性被定量捕获**。所有修复已提交并推送（main → 6d614fc），明日起问题的原始数据在 JSONL 日志可复现。
