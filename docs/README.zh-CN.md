<div align="center">

<img src="../media/Genie.png" width="112" alt="Git Commit Genie" />

# Git Commit Genie

根据已暂存的 Git 改动生成提交信息，并写入源代码管理输入框。

[![Marketplace version](https://vsmarketplacebadges.dev/version/Lune-99.git-commit-genie.svg?label=marketplace&color=007ec6)](https://marketplace.visualstudio.com/items?itemName=Lune-99.git-commit-genie)
[![Marketplace installs](https://vsmarketplacebadges.dev/installs/Lune-99.git-commit-genie.svg?label=installs&color=4c1)](https://marketplace.visualstudio.com/items?itemName=Lune-99.git-commit-genie)
[![Marketplace rating](https://vsmarketplacebadges.dev/rating-star/Lune-99.git-commit-genie.svg?label=rating&color=dfb317)](https://marketplace.visualstudio.com/items?itemName=Lune-99.git-commit-genie)
[![Open VSX version](https://img.shields.io/open-vsx/v/Lune-99/git-commit-genie?label=open-vsx&color=007ec6)](https://open-vsx.org/extension/Lune-99/git-commit-genie)
[![Open VSX downloads](https://img.shields.io/open-vsx/dt/Lune-99/git-commit-genie?label=downloads&color=4c1)](https://open-vsx.org/extension/Lune-99/git-commit-genie)
[![Open VSX rating](https://img.shields.io/open-vsx/rating/Lune-99/git-commit-genie?label=rating&color=dfb317)](https://open-vsx.org/extension/Lune-99/git-commit-genie)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/Nouvelle-Lune/git-commit-genie/blob/main/LICENSE)

[English](https://github.com/Nouvelle-Lune/git-commit-genie/blob/main/README.md) | 简体中文

<img src="../media/demo1.gif" width="820" alt="根据暂存改动生成提交信息" />

</div>

## 功能说明

Git Commit Genie 根据已暂存的改动生成提交信息，支持 OpenAI、Anthropic Claude、Google Gemini，以及任何兼容 OpenAI 接口的端点。默认遵循 [Conventional Commits 1.0.0](https://www.conventionalcommits.org/zh-hans/v1.0.0/)，也可以跟随仓库中保存的模板。

生成流程分为多个阶段：

| 阶段 | 说明 |
| --- | --- |
| 证据 | 并行摘要每个暂存文件，并补充仓库上下文。 |
| 调查 | 针对本次改动规划问题，通过查询定义、调用方、被调用方、类型、配置与测试作答。 |
| 起草 | 结合证据、模板、仓库记忆与 RAG 风格参考，起草一条提交信息。 |
| 校验 | 按 Conventional Commits 与模板检查草稿，做最小修复，并强制使用目标语言。 |

流水线由 `gitCommitGenie.chain.enabled` 控制，默认开启。关闭后改用单轮提示生成，对少量改动更快、更省 Token。

流水线与模型自身的思考等级是两件事：流水线决定跑几个阶段，`gitCommitGenie.defaultThinkingLevel` 决定每次调用中模型推理的深度。

## 安装

从 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Lune-99.git-commit-genie) 或 [Open VSX](https://open-vsx.org/extension/Lune-99/git-commit-genie) 安装，或执行：

```bash
code --install-extension Lune-99.git-commit-genie
```

使用 Open VSX 而非微软市场的编辑器（如 VSCodium、Cursor、Windsurf、Trae）可以直接在扩展视图中安装 Open VSX 版本。

环境要求：VS Code 1.103 或更高版本、内置 Git 扩展，以及所选服务商或端点的 API Key。

## 使用

1. 运行 `Git Commit Genie: 管理模型`，添加服务商并填入 API Key。密钥保存在 VS Code SecretStorage 中，不写入 `settings.json`。
2. 暂存改动。
3. 点击源代码管理标题栏的 Genie 图标，或运行 `Git Commit Genie: 生成提交信息`。
4. 检查提交框中的信息，按需修改后提交。

`Git Commit Genie: Menu`（菜单）提供流水线开关、模型管理与仓库记忆入口。

## 特性

- 生成符合 Conventional Commits 的提交信息，并在写入提交框前完成校验。
- 服务商：OpenAI、Anthropic Claude、Google Gemini，以及 DeepSeek、Qwen、GLM、Kimi、OpenRouter、本地 vLLM / SGLang / llama.cpp 等兼容端点。
- 思考等级从 `off` 到 `max`，可全局设置或按模型设置。
- 提交信息语言：`auto`、`en`、`zh-CN`、`zh-TW`、`ja`、`ko`、`de`、`fr`、`es`、`pt`、`ru`、`it`。
- 插件界面支持英文、简体中文与繁体中文。
- 在源代码管理标题栏生成与取消，进度显示在状态栏。
- 可选的仓库调查、仓库记忆与 RAG 风格索引，见[进阶功能](#进阶功能)。
- 按仓库统计费用，见[面板与费用](#面板与费用)。
- 模板控制正文结构、footer 与用词，见[模板](#模板)。

### 生成示例

```
feat(scm): add per-repository cost tracking to the Genie panel

- Record token usage and estimated cost for every generation
- Show accumulated spend next to each repository in the panel
- Keep the pipeline log available for the current session

Refs: #142
```

具体结构由模板决定；未配置模板时遵循 Conventional Commits 1.0.0。

## 面板与费用

源代码管理侧边栏中的 Genie 面板会列出工作区内的仓库及其累计费用，以及流水线各阶段与模型调用的日志。

<img src="../media/dashboard-view.png" width="430" alt="Genie 面板：仓库列表、费用与流水线日志" />

生成过程中，状态栏会显示当前使用的模型与所处阶段。

<img src="../media/status-bar.png" width="430" alt="状态栏：当前模型与生成阶段" />

## 模板

模板是 Markdown 文件，存放在工作区的 `.gitgenie/templates` 或用户模板目录中。Genie 会从模板中提取正文结构、必备 footer 与用词偏好，并在起草与校验阶段应用。

<img src="../media/demo2.gif" width="600" alt="创建并选择提交模板" />

编写指南：[English](./user-template-guide.md) 与 [中文](./user-template-guide.zh-CN.md)。

## 进阶功能

**仓库调查**默认开启。当 diff 信息不足时，流水线会围绕本次改动规划问题，并从仓库中作答：定义、调用方、配置与测试。查询次数上限由 `gitCommitGenie.chain.investigation.maxSteps` 控制，可用 `gitCommitGenie.chain.investigation.excludePatterns` 排除路径。

**仓库记忆**默认关闭。开启 `gitCommitGenie.memory.enabled` 后，Genie 会把调查过程中获得的信息记录到本仓库的本地存储，并在之后遇到相似改动时召回；整理在编辑器空闲时进行。可通过 `Git Commit Genie: 管理仓库记忆` 查看、重建或清除。

**RAG 风格索引**默认关闭。开启 `gitCommitGenie.rag.enabled` 后，Genie 会在本地索引历史提交信息，并为新信息检索风格参考。需要兼容 OpenAI 接口的 Embedding 服务，可通过 `Git Commit Genie: 配置 RAG Embedding API Key` 完成配置。

## 配置

常用设置：

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `gitCommitGenie.chain.enabled` | `true` | 多阶段流水线；关闭后使用单轮提示生成 |
| `gitCommitGenie.commitLanguage` | `auto` | 提交信息目标语言 |
| `gitCommitGenie.defaultThinkingLevel` | `off` | 受支持模型的思考等级 |
| `gitCommitGenie.memory.enabled` | `false` | 仓库记忆 |
| `gitCommitGenie.rag.enabled` | `false` | RAG 风格索引 |
| `gitCommitGenie.autoStageAllForDiff` | `false` | 暂存区为空时暂存全部改动 |

全部命令与设置项见[命令与设置参考](./reference.zh-CN.md)。

## 隐私

- API Key 保存在 VS Code SecretStorage 中，不写入 `settings.json`，也不记录到日志。
- 只有已暂存的改动会被分析。`gitCommitGenie.autoStageAllForDiff` 是例外，它会在生成后还原暂存状态。
- 开启仓库调查后，Genie 会读取仓库内的文件，并把筛选后的结论发送给所配置的模型服务。构建产物、依赖目录与锁文件默认已排除，也可以自行追加排除规则。
- RAG 会把历史提交信息发送到所配置的 Embedding 服务。
- 仓库记忆保存在 VS Code 本地全局存储中，不会上传。
- 插件不收集统计分析，也没有遥测。

## 参与贡献

问题与 Pull Request：https://github.com/Nouvelle-Lune/git-commit-genie。

## 许可证

[MIT](https://github.com/Nouvelle-Lune/git-commit-genie/blob/main/LICENSE)

## 致谢

- [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)
- OpenAI、Anthropic、Google Gemini，以及兼容 OpenAI 接口的模型生态。
