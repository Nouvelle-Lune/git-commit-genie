# Commands & Settings Reference

Everything Git Commit Genie can do, and every setting it exposes. All settings live under the **Git Commit Genie** section in the Settings editor (`Ctrl/Cmd + ,`), or under the `gitCommitGenie.*` keys in `settings.json`.

English · [简体中文](./reference.zh-CN.md) · [Back to README](https://github.com/Nouvelle-Lune/git-commit-genie/blob/main/README.md)

## Commands

Open the Command Palette (`Ctrl/Cmd + Shift + P`) and search for `Git Commit Genie`.

### Everyday

| Command | Description |
| --- | --- |
| `Git Commit Genie: Generate commit message` | Analyze the staged changes and write a message into the commit box. Also available as the Genie icon in the Source Control title bar. |
| `Git Commit Genie: Stop generate` | Cancel a running generation. Replaces the generate icon while a generation is in progress. |
| `Git Commit Genie: Enable/Disable thinking mode` | Toggle the multi-stage pipeline (`gitCommitGenie.chain.enabled`). |
| `Git Commit Genie: Manage Models` | Add or remove providers and models, store API keys, configure custom OpenAI-compatible endpoints, thinking compatibility, and per-model pricing. |
| `Git Commit Genie: Select/Create Template` | Select, create, rename, open, or deactivate commit templates. |
| `Git Commit Genie: Menu` | Quick picker for the thinking-mode toggle, model management, and repository memory. |
| `Git Commit Genie: Show Repository Cost` | Show the accumulated estimated usage cost for the current repository. |
| `Git Commit Genie: Reset Repository Cost` | Reset the accumulated cost for the current repository. |
| `Git Commit Genie: Manage Repository Memory` | Enable or disable memory, inspect what was learned, rebuild the search index, run or pause consolidation, and clear memory. |

### RAG style index

| Command | Description |
| --- | --- |
| `Git Commit Genie: Configure RAG Embedding API Key` | Store the embeddings API key in SecretStorage. |
| `Git Commit Genie: Clear RAG Embedding API Key` | Remove the stored embeddings API key. |
| `Git Commit Genie: Start RAG Indexing` | Index historical commit messages for the current repository. Available when RAG is enabled. |
| `Git Commit Genie: Stop RAG Indexing` | Cancel an in-progress indexing run. |
| `Git Commit Genie: Repair RAG Embeddings` | Rebuild missing embeddings. Triggered from the Genie panel for a specific repository. |

### Internal

| Command | Description |
| --- | --- |
| `Run Repository Memory Replay (Paid API Calls)` | Development benchmark that replays recorded memory episodes against the model. It performs **paid API calls** and is not needed for normal use. |

## Settings

### Generation pipeline

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `gitCommitGenie.chain.enabled` | boolean | `true` | Run the multi-stage pipeline (evidence → investigation → draft → verify) instead of a single prompt. Slower and more token-hungry, but more accurate and template-faithful. |
| `gitCommitGenie.chain.maxParallel` | number | `2` | Maximum parallel model calls across all stages. Increase carefully to avoid provider rate limits. |
| `gitCommitGenie.chain.contextWindowTokens` | integer | `128000` | Context window used by the pipeline. Built-in models are clamped to their real limit automatically; change this only for custom endpoints. |
| `gitCommitGenie.llm.maxRetries` | number | `2` | Retries for recoverable model response validation failures. |
| `gitCommitGenie.llm.temperature` | number | `1` | Sampling temperature (0–2). Some providers only accept `1`; changing it may cause request errors or less stable output. |
| `gitCommitGenie.commitLanguage` | string | `auto` | Target language for commit messages. `auto` matches your VS Code display language. Values: `auto`, `en`, `zh-CN`, `zh-TW`, `ja`, `ko`, `de`, `fr`, `es`, `pt`, `ru`, `it`. |
| `gitCommitGenie.autoStageAllForDiff` | boolean | `false` | When the staging area is empty, temporarily stage all changes to build the diff, then restore your staging state. Experimental; may include unrelated changes in the prompt. |

### Model thinking

These settings control the model's **native reasoning**, independently from the generation pipeline.

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `gitCommitGenie.defaultThinkingLevel` | string | `off` | Thinking level applied to every supported model call: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Models without configurable thinking stay off. Custom OpenAI-compatible models inherit this value; official models fail on levels they do not support instead of silently rewriting them. |
| `gitCommitGenie.modelThinkingLevels` | object | `{}` | Per-model overrides keyed by `provider/model`, for example `{ "openai/gpt-5.4": "high", "custom/Qwen3.5-9B": "low" }`. Missing keys inherit the global level. |
| `gitCommitGenie.thinkingBudgets` | object | see below | Token budgets for providers that take a numeric thinking budget (Anthropic, Google Gemini) or a custom endpoint configured with a budget field. Defaults: `minimal: 1024`, `low: 4096`, `medium: 10240`, `high: 32768`, `xhigh: 65536`, `max: 131072`. |

### Repository investigation

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `gitCommitGenie.chain.investigation.enabled` | boolean | `true` | Let the pipeline answer planned questions about the change through focused lookups (definitions, callers, callees, types, configuration, tests). When disabled, the change is analyzed from the diff alone. |
| `gitCommitGenie.chain.investigation.maxSteps` | integer | `12` | Maximum repository lookups per commit (3–40). Lower values reduce latency and cost; higher values allow deeper tracing. |
| `gitCommitGenie.chain.investigation.excludePatterns` | array | `[]` | Additional files or directories to exclude from investigation. Build outputs, dependency directories, and lockfiles are already excluded. |

### Repository memory

Repository memory is off by default and stored locally per clone in VS Code's global storage.

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `gitCommitGenie.memory.enabled` | boolean | `false` | Record what investigations learn and reuse it for similar changes later. |
| `gitCommitGenie.memory.consolidation.enabled` | boolean | `true` | Organize recorded experience with the model while the editor is idle. Message generation never waits for consolidation. |
| `gitCommitGenie.memory.consolidation.maxCallsPer24h` | integer | `2` | Paid consolidation runs per clone within a rolling 24-hour window. |
| `gitCommitGenie.memory.maxStorageMiB` | integer | `256` | Storage budget per clone (MiB). Space is reclaimed the next time memory is published. |
| `gitCommitGenie.memory.excludePatterns` | array | `[]` | Additional path patterns excluded from recording, retrieval, and consolidation. |

#### Advanced memory tuning

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `gitCommitGenie.memory.navigation.maxTokens` | integer | `1500` | Token budget for memory navigation included in the prompt. |
| `gitCommitGenie.memory.navigation.maxInputPercent` | integer | `5` | Upper bound (in percent) of model input reserved for memory navigation. |
| `gitCommitGenie.memory.search.maxCalls` | integer | `3` | Extra memory searches allowed per generation; `0` disables them. |
| `gitCommitGenie.memory.sources.maxChunks` | integer | `16` | Maximum memory sources expanded per generation. |
| `gitCommitGenie.memory.sources.timeoutMs` | integer | `1500` | Timeout for each memory source expansion, in milliseconds. |
| `gitCommitGenie.memory.sources.maxResultTokens` | integer | `4096` | Maximum tokens in one memory tool result; oversized results are rejected explicitly. |
| `gitCommitGenie.memory.consolidation.maxInputTokens` | integer | `16000` | Input token budget for consolidation, including prompt and schema. |
| `gitCommitGenie.memory.consolidation.maxOutputTokens` | integer | `4000` | Output token limit for consolidation. Higher limits may increase API cost. |
| `gitCommitGenie.memory.storage.maxEpisodes` | integer | `2000` | Maximum retained episodes per clone. |
| `gitCommitGenie.memory.storage.maxEpisodeKiB` | integer | `256` | Maximum size of a newly recorded episode (KiB). Existing larger episodes remain readable. |
| `gitCommitGenie.memory.storage.maxManifestMiB` | integer | `8` | Maximum size of a newly published memory manifest (MiB). |

### RAG style index

RAG is off by default and stores its index inside the repository's `.git/git-commit-genie/rag` directory, so it is never committed.

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `gitCommitGenie.rag.enabled` | boolean | `false` | Retrieve style references from historical commit messages so new messages match your repository's conventions. Requires enough history and a configured embeddings endpoint. |
| `gitCommitGenie.rag.embedding.baseUrl` | string | `""` | Base URL of the embeddings API, in OpenAI SDK format. |
| `gitCommitGenie.rag.embedding.model` | string | `""` | Embeddings model name. |
| `gitCommitGenie.rag.embedding.dimensions` | number | `0` | Optional embedding dimensions; `0` detects them automatically. |
| `gitCommitGenie.rag.embedding.batchSize` | number | `10` | Batch size used when generating embeddings (1–512). |

### Editor integration

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `gitCommitGenie.ui.stageNotifications.enabled` | boolean | `true` | Show pipeline progress in the VS Code status bar. |
| `gitCommitGenie.ui.rawData.enabled` | boolean | `false` | Show stage inputs, outputs, and tool results in the Genie panel for debugging. Raw data can contain repository source code and is kept only for the current session. |
| `gitCommitGenie.typingAnimationSpeed` | number | `15` | Typing animation speed in milliseconds per character. Set to `-1` to disable the animation. |
| `gitCommitGenie.showUsageCost` | boolean | `true` | Show a brief notification with the estimated cost of each generation. |

## Custom and local endpoints

`Git Commit Genie: Manage Models` supports any endpoint that implements OpenAI Chat Completions:

- Set the base URL (HTTP or HTTPS), model id, and API key.
- Standard endpoints need no extra configuration — the model inherits the global thinking level.
- Only endpoints with non-standard thinking fields need a compatibility profile (for example `qwen`, `deepseek`, or `chat-template`), configured under advanced thinking compatibility while editing the model.
- Pricing can be entered manually so custom models participate in cost tracking; without pricing, usage is reported as free.

## Related guides

- [User template guide](./user-template-guide.md)
- [用户模板编写指南](./user-template-guide.zh-CN.md)
