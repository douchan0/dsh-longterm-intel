# dsh-longterm-intel

DSH（DeepSeek Harness）通用长期信息收集、持续监测、多模态研究、知识积累与定时报告插件。

> 通用基础设施，不绑定任何研究主题。任何研究目标通过独立的 **Research Project** 配置表达；
> 个人背景通过独立的 **Profile** 配置表达，默认为空，且不出现在插件代码或本仓库的真实配置里。

## 三层架构

| 层 | 内容 | 位置 |
|---|---|---|
| 插件 | 信息源接入、采集、多模态、记忆、调度、报告、额度 | 本仓库代码 |
| Research Project | 主题、目标、问题、信息源、关键词、频率、深度、预算、报告 | `<dataRoot>/config/projects/*.yaml` |
| Profile | 用户背景 / 研究对象档案 / 项目上下文 | `<dataRoot>/protected/profiles/*.yaml`（默认为 `~/.dsh/longterm-intel`，位于仓库之外） |

## 快速开始

```bash
# 初始化数据根目录（配置 + 数据库都在这里，永不进 git）
npx intel init

# 创建/编辑配置后，运行研究
npx intel run <project_id>

# 生成报告、查看状态、管理调度
npx intel report latest <project_id>
npx intel schedule list
npx intel status
```

详见 [docs/](docs/)。
