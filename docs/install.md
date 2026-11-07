# 安装与配置

## 安装（DSH 插件）

本项目按 DSH 插件规范打包（cordis 插件入口 `dsh/index.js` + `cordis.patch.yml`）。

**本地目录安装**（推荐开发期，DSH 原生支持 `link:` 安装源）：

```
 本地路径：/Users/<you>/code/dsh-longterm-intel
```

在 DSH 插件管理里用 `link:<路径>` 作为安装源即可（也可复制到 profile 后安装）。
安装后 DSH 会注册 `intel.*` 工具与 `longterm-intel` 技能。

## 数据根目录

所有真实配置/数据都在数据根目录（默认 `~/.dsh/longterm-intel`，可用环境变量 `INTEL_HOME` 覆盖），
**不在任何 git 仓库里**；本仓库只有模板与示例。

```bash
intel init   # 生成 global/providers/budgets 配置与目录骨架
```

## 建立第一个研究项目

```bash
cp config/templates/user-profile.yaml <数据根>/config/protected/profiles/my-profile.yaml
cp config/examples/apac-job-intel.example.yaml <数据根>/config/projects/my-project.yaml
# 编辑两份配置（研究主题/信息源/频率/预算/关联档案）后：
intel project create <数据根>/config/projects/my-project.yaml
intel profile create <数据根>/config/protected/profiles/my-profile.yaml
intel run <project_id> --report
intel schedule create <project_id> --spec '{"cadence":"daily","at":"09:00"}'
intel schedule create <project_id> --kind report --spec '{"cadence":"weekly","weekday":5,"at":"20:00"}'
```

## 环境依赖（用户本机工具）

| 工具 | 用途 | 必须? |
|---|---|---|
| mmx ≥1.0.28 | MiniMax 全引擎（search/text/vision/ASR/TTS/quota） | 是 |
| yt-dlp | YouTube/视频源 | 用到时 |
| ffmpeg | 音频分段 / 关键帧 | 用到时 |
| GitHub token（可选） | providers.github.token_env 提名环境变量 | 否（匿名 60 请求/小时） |

## 平台权限注意（不得假装无限制抓取）

- YouTube：多数环境要求登录校验。源配置支持
  `spec.cookies_from_browser: chrome|edge|firefox…` 或 `spec.cookies: <netscape cookie 文件路径>`，
  由用户自行提供登录凭据；插件绝不内置凭据。
- 评论抓取等涉权限的数据：未启用（合规保守）。
- 需要账号的平台（X 等）：仅接入可匿名访问的公开内容；被拒时如实记录权限错误到 run.errors。
