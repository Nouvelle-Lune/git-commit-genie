# 命令与设置参考

Git Commit Genie 的全部命令与设置项。所有设置位于设置编辑器（`Ctrl/Cmd + ,`）的 **Git Commit Genie** 分类下，对应 `settings.json` 中的 `gitCommitGenie.*` 键。

[English](./reference.md) · 简体中文 · [返回 README](./README.zh-CN.md)

## 命令

打开命令面板（`Ctrl/Cmd + Shift + P`），搜索 `Git Commit Genie` 即可找到全部命令。

### 日常使用

| 命令 | 说明 |
| --- | --- |
| `Git Commit Genie: 生成提交信息` | 分析已暂存的改动并写入提交框。源代码管理标题栏上的 Genie 图标同样可用。 |
| `Git Commit Genie: 停止生成` | 取消正在进行的生成。生成过程中会替换标题栏上的生成图标。 |
| `Git Commit Genie: 启用/关闭链式思考模式` | 开关多阶段流水线（`gitCommitGenie.chain.enabled`）。 |
| `Git Commit Genie: 管理模型` | 添加或移除服务商与模型、保存 API Key、配置自定义 OpenAI 兼容端点、Thinking 兼容性以及单模型价格。 |
| `Git Commit Genie: 选择/新建模板` | 选择、新建、重命名、打开或停用提交模板。 |
| `Git Commit Genie: Menu`（菜单） | 快捷入口：思考模式开关、模型管理、仓库记忆。 |
| `Git Commit Genie: 查看仓库费用` | 查看当前仓库累计的预估使用费用。 |
| `Git Commit Genie: 重置仓库费用` | 将当前仓库的累计费用清零。 |
| `Git Commit Genie: 管理仓库记忆` | 启用或停用记忆、查看已学到的内容、重建检索索引、执行或暂停整理，以及清空记忆。 |

### RAG 风格索引

| 命令 | 说明 |
| --- | --- |
| `Git Commit Genie: 配置 RAG Embedding API Key` | 将 Embedding API Key 保存到 SecretStorage。 |
| `Git Commit Genie: 清除 RAG Embedding API Key` | 删除已保存的 Embedding API Key。 |
| `Git Commit Genie: 开始 RAG 索引` | 为当前仓库的历史提交信息建立索引。仅在启用 RAG 后可用。 |
| `Git Commit Genie: 停止 RAG 索引` | 取消正在进行的索引任务。 |
| `Git Commit Genie: 修复 RAG 缺失向量` | 重建缺失的向量。入口位于 Genie 面板中对应仓库的操作区。 |

### 内部命令

| 命令 | 说明 |
| --- | --- |
| `Run Repository Memory Replay (Paid API Calls)` | 开发用基准测试：用模型回放已记录的仓库记忆。会产生**付费 API 调用**，日常使用无需执行。 |

## 设置

### 生成流水线

| 设置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `gitCommitGenie.chain.enabled` | boolean | `true` | 使用多阶段流水线（证据 → 调查 → 起草 → 校验）替代单轮提示。更慢、更耗 Token，但结果更准确、更贴合模板。 |
| `gitCommitGenie.chain.maxParallel` | number | `2` | 各阶段允许的最大并行模型调用数。谨慎调高，避免触发服务商限流。 |
| `gitCommitGenie.chain.contextWindowTokens` | integer | `128000` | 流水线使用的上下文窗口。内置模型会自动按其真实上限收紧；仅为自定义端点手动调整。 |
| `gitCommitGenie.llm.maxRetries` | number | `2` | 模型输出校验失败时的重试次数。 |
| `gitCommitGenie.llm.temperature` | number | `1` | 采样温度（0–2）。部分服务商只接受 `1`，修改后可能报错或导致输出不稳定。 |
| `gitCommitGenie.commitLanguage` | string | `auto` | 提交信息目标语言。`auto` 跟随 VS Code 显示语言。可选值：`auto`、`en`、`zh-CN`、`zh-TW`、`ja`、`ko`、`de`、`fr`、`es`、`pt`、`ru`、`it`。 |
| `gitCommitGenie.autoStageAllForDiff` | boolean | `false` | 暂存区为空时，临时暂存全部改动以构建 diff，随后还原原暂存状态。实验性功能；可能把无关改动带入提示。 |

### 模型思考等级

以下设置控制模型**原生推理**，与生成流水线相互独立。

| 设置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `gitCommitGenie.defaultThinkingLevel` | string | `off` | 应用于所有受支持模型调用的思考等级：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。不支持思考控制的模型始终关闭。自定义 OpenAI 兼容模型会自动继承该值；官方模型遇到不支持的等级会直接报错，而不会被静默改写。 |
| `gitCommitGenie.modelThinkingLevels` | object | `{}` | 按模型覆盖，键为 `provider/model`，例如 `{ "openai/gpt-5.4": "high", "custom/Qwen3.5-9B": "low" }`。未列出的模型继承全局等级。 |
| `gitCommitGenie.thinkingBudgets` | object | 见说明 | 适用于使用数字思考预算的服务商（Anthropic、Google Gemini），以及配置了预算字段的自定义端点。默认值：`minimal: 1024`、`low: 4096`、`medium: 10240`、`high: 32768`、`xhigh: 65536`、`max: 131072`。 |

### 仓库调查

| 设置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `gitCommitGenie.chain.investigation.enabled` | boolean | `true` | 允许流水线围绕改动规划问题，并通过聚焦查询作答（定义、调用方、被调用方、类型、配置、测试）。关闭后仅依据 diff 分析改动。 |
| `gitCommitGenie.chain.investigation.maxSteps` | integer | `12` | 单次提交允许的最大仓库查询次数（3–40）。数值越低延迟与成本越低；越高则可追踪更深的调用与依赖。 |
| `gitCommitGenie.chain.investigation.excludePatterns` | array | `[]` | 调查时额外排除的文件或目录。构建产物、依赖目录与锁文件默认已排除。 |

### 仓库记忆

仓库记忆默认关闭，按克隆保存在 VS Code 本地全局存储中。

| 设置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `gitCommitGenie.memory.enabled` | boolean | `false` | 记录调查中的经验，并在之后遇到相似改动时复用。 |
| `gitCommitGenie.memory.consolidation.enabled` | boolean | `true` | 在编辑器空闲时用模型整理已记录的经验。提交信息生成永远不会等待整理完成。 |
| `gitCommitGenie.memory.consolidation.maxCallsPer24h` | integer | `2` | 每个克隆在滚动 24 小时内允许的付费整理次数。 |
| `gitCommitGenie.memory.maxStorageMiB` | integer | `256` | 每个克隆的存储预算（MiB）。空间会在下次发布记忆时回收。 |
| `gitCommitGenie.memory.excludePatterns` | array | `[]` | 记录、检索与整理时额外排除的路径。 |

#### 记忆高级调优

| 设置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `gitCommitGenie.memory.navigation.maxTokens` | integer | `1500` | 提示中用于记忆导航的 Token 预算。 |
| `gitCommitGenie.memory.navigation.maxInputPercent` | integer | `5` | 记忆导航占模型输入的上限（百分比）。 |
| `gitCommitGenie.memory.search.maxCalls` | integer | `3` | 每次生成允许的额外记忆检索次数；`0` 表示关闭。 |
| `gitCommitGenie.memory.sources.maxChunks` | integer | `16` | 每次生成最多展开的记忆来源数量。 |
| `gitCommitGenie.memory.sources.timeoutMs` | integer | `1500` | 单次记忆来源展开的超时时间（毫秒）。 |
| `gitCommitGenie.memory.sources.maxResultTokens` | integer | `4096` | 单条记忆工具结果的最大 Token 数，超出会被明确拒绝。 |
| `gitCommitGenie.memory.consolidation.maxInputTokens` | integer | `16000` | 整理阶段的输入 Token 预算（含提示与结构定义）。 |
| `gitCommitGenie.memory.consolidation.maxOutputTokens` | integer | `4000` | 整理阶段的输出 Token 上限。调高可能增加 API 费用。 |
| `gitCommitGenie.memory.storage.maxEpisodes` | integer | `2000` | 每个克隆保留的经验条数上限。 |
| `gitCommitGenie.memory.storage.maxEpisodeKiB` | integer | `256` | 新记录单条经验的大小上限（KiB）。已存在的较大条目仍可读取。 |
| `gitCommitGenie.memory.storage.maxManifestMiB` | integer | `8` | 新发布的记忆清单大小上限（MiB）。 |

### RAG 风格索引

RAG 默认关闭，索引保存在仓库的 `.git/git-commit-genie/rag` 目录中，不会被提交。

| 设置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `gitCommitGenie.rag.enabled` | boolean | `false` | 从历史提交信息中检索风格参考，使新信息贴合仓库习惯。需要足够的历史提交与已配置的 Embedding 服务。 |
| `gitCommitGenie.rag.embedding.baseUrl` | string | `""` | Embedding API 的 Base URL，需符合 OpenAI SDK 格式。 |
| `gitCommitGenie.rag.embedding.model` | string | `""` | Embedding 模型名称。 |
| `gitCommitGenie.rag.embedding.dimensions` | number | `0` | 可选的 Embedding 维度；`0` 表示自动检测。 |
| `gitCommitGenie.rag.embedding.batchSize` | number | `10` | 生成 Embedding 时的批大小（1–512）。 |

### 编辑器集成

| 设置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `gitCommitGenie.ui.stageNotifications.enabled` | boolean | `true` | 在 VS Code 状态栏显示流水线进度。 |
| `gitCommitGenie.ui.rawData.enabled` | boolean | `false` | 在 Genie 面板中显示各阶段输入、输出与工具结果，便于调试。原始数据可能包含仓库源码，且仅在当前会话内保留。 |
| `gitCommitGenie.typingAnimationSpeed` | number | `15` | 提交框打字动画速度，单位为每字符毫秒。设为 `-1` 关闭动画。 |
| `gitCommitGenie.showUsageCost` | boolean | `true` | 每次生成后以简短通知显示预估费用。 |

## 自定义与本地端点

`Git Commit Genie: 管理模型` 支持任何实现 OpenAI Chat Completions 的端点：

- 填写 Base URL（HTTP 或 HTTPS）、模型 ID 与 API Key。
- 标准端点无需额外配置，模型会自动继承全局思考等级。
- 仅当端点使用非标准 thinking 字段时才需要选择兼容格式（例如 `qwen`、`deepseek`、`chat-template`），在编辑模型时的高级 thinking 兼容中配置。
- 可手动填写价格，让自定义模型参与费用统计；未填写价格时按免费统计。

## 相关指南

- [User template guide](./user-template-guide.md)
- [用户模板编写指南](./user-template-guide.zh-CN.md)
