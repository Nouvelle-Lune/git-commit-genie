# Changelog

## [Unreleased]

### Model access and providers
- breaking: Removed the dedicated Qwen, Local, DeepSeek, GLM, Kimi and OpenRouter provider entries. Every endpoint is now configured as a model instance on OpenAI, Anthropic, Google Gemini or a custom OpenAI-compatible entry, so region-specific Qwen keys and self-hosted base URLs are set up as custom models instead of through provider-only dialogs. Existing provider and model configuration is migrated to the new model registry on activation.
- feat: Replaced the per-provider LLM services with a provider-neutral model and session layer. Conversation history, tool results and continuation are owned by the provider session, and investigation uses native function calling instead of prompt-driven tool loops.
- feat: Added unified thinking configuration: `gitCommitGenie.defaultThinkingLevel` for every supported call, `gitCommitGenie.modelThinkingLevels` for per-model overrides and `gitCommitGenie.thinkingBudgets` for numeric budgets. Thinking is resolved once per run and reused by every stage and background call, and Manage Models gained "Set thinking level override" and "Advanced thinking compatibility" for custom endpoints.
- fix: Unsupported thinking levels on official models now fail with a descriptive error that lists the supported levels instead of being silently rewritten, while custom endpoints keep passing native values verbatim.
- feat: The pipeline token budget is derived from `gitCommitGenie.chain.contextWindowTokens` and allocates input, output and safety margins per model. Forced compaction, a single retry and provider stop-reason classification keep a run from blindly retrying when the context window or the reasoning budget is exhausted.
- fix: Structured output handling moved into one orchestrator with field-level diagnostics. Providers that return no final content are retried with an explicit schema prompt, blank responses are treated as empty instead of as structured output, and exhausted retries report the failing field paths. Built-in prompts no longer embed the full schema; the schema is injected into the system message only when the endpoint cannot take `response_format`.
- fix: Tool calls stay available while structured output is relaxed during tool turns, and custom-provider history keeps tool-result order.
- fix: Manage Models now keeps models whose endpoint has no usable `/models` catalog, validates custom base URLs on input, deletes the API key together with a removed model, and reports failures instead of dropping them. The model picker marks the currently configured model, and management submenus offer a Back entry.

### Change analysis and pipeline
- breaking: Consolidated change analysis into a single ledger-aware agent runtime. Staged hunks are pre-allocated as `D*` ids and repository observations are recorded as `E*` ids, and the previous investigation, semantic-analysis and information-selection stages are replaced by one compound terminal with per-field citations.
- feat: Agent runs are split into an investigation phase that holds repository tools and no output schema, and a finalization phase that closes tools and enforces the terminal contract in a shared repair loop.
- feat: Investigation planning was reworked around a repository map and one lookup verb per target, with coverage keyed by `D*` id. Plans that fail deterministic grounding are replanned, unmet evidence preconditions degrade the run to diff-only instead of failing it, and `gitCommitGenie.chain.investigation.maxSteps` now requires at least 3 steps (default 12).
- feat: Tool grant violations and over-budget tool calls are soft-rejected with an error tool result the model can recover from, instead of aborting the run.
- fix: Hunk headers keep their full context, so function and declaration context survives into evidence and body-only changes are identified reliably.
- fix: A shape-valid Conventional Commits header is no longer rejected for exceeding 72 characters; the limit is prompt guidance only. Generated messages are now the smallest message the change entails: the body is omitted unless a distinct fact or the template justifies it, and fixers restore only facts the message does not already contain.
- fix: The pipeline continues after a failed fixer stage and distinguishes evidence-compaction failures from RAG preparation failures, so a compaction problem no longer reports as a RAG error.
- feat: `gitCommitGenie.generationMode` (`auto`, `fast`, `deep`) replaces `gitCommitGenie.chain.enabled` and is chosen with "Select generation mode". `auto` inspects the staged diff locally and routes each change; the pre-rename values `onePrompt` and `chain` are still accepted and rewritten.
- feat: In `auto` mode the generation flow opens with a routing card that names the selected route (`Fast` or `Deep`), and reports the failure reason when the router declines to score the change and falls back to `Deep`.
- refactor: RAG style references moved into a dedicated prompt block, and the commit message panel now renders like the semantic analysis card. Pipeline badges use VS Code theme variables, "Issues" was renamed to "Diagnostics", and a degraded analysis reports its own title.
- feat: `gitCommitGenie.ui.rawData.enabled` shows stage inputs, outputs and tool results in the Genie panel for debugging; raw data can contain repository source code and is kept for the current session only.

### Repository Memory
- breaking: The always-on repository analysis feature, its settings and its model wiring are removed and replaced by opt-in Repository Memory under `gitCommitGenie.memory.enabled`.
- breaking: Memory storage moved to episode version 3 and manifest version 4 with no migration path. Clear repository memory once from "Manage Repository Memory" before using it again.
- feat: Completed runs publish against the captured before/after Git snapshot, and diffs plus investigation tools read immutable trees, so a stale snapshot opens the draft as an untitled document instead of overwriting the Source Control input.
- feat: The handbook is experience-based. Entries describe a situation, optional steps and lessons with limitations, must cite observation-level provenance from at least two independent snapshots, and can be retired when later counterevidence still applies to the current snapshot. Steps are constrained to eligible routes that already succeeded with matching evidence.
- feat: Every memory navigation result is gated on the current snapshot and reports whether its target is available, needs revalidation, unavailable or historical only. Changed symbols no longer participate in episodes or retrieval ranking, which now ranks by paths, targets and BM25 terms.
- feat: Consolidation groups one seed investigation with related episodes and runs one group per call, validates groups independently, publishes valid groups while reporting partial results, and never re-bills a group whose evidence fingerprint is unchanged.
- feat: "Recheck organized evidence" lets you inspect a group's stored evidence and long-term memory in a read-only report before paying for a rerun, and a replay benchmark command measures retrieval against recorded runs.
- feat: Repository memory is inspected in a read-only webview with metric cards and a newest-first record timeline, one reusable panel per repository.
- feat: Memory budgets, quotas and exclusions are configurable under `gitCommitGenie.memory.*`, and memory operations report localized outcomes such as not ready, budget exhausted or cancelled.
- fix: The memory log lane keeps consolidation spinners, retries and terminal outcomes in sync with the live run, shows model memory tool calls, and no longer reopens rows restored from a previous session.

### Cost and packaging
- breaking: Cost accounting is structured. Legacy numeric `cost` log entries are rejected by persistence validation in favour of `costDisplay` entries that report cache hit rates.
- feat: Pricing resolves per model with an optional per-model flat override, and provider usage is normalized into one quote type before it is recorded.
- docs: Rewrote the READMEs and added `docs/reference.md` and its zh-CN counterpart, documenting every command and every `gitCommitGenie.*` setting.
- chore: Packaging ships only the webpack bundles, their license notices and the codicon files, cleans `dist` first, localizes command titles through NLS, and removes the redundant title prefix.

## [3.2.2]
- fix: Prevented duplicate `Repository Analysis Summary` headings when generated or synchronized analysis content already contains the file title.

## [3.2.1]
- feat: Added the latest supported OpenAI GPT-5.6/5.5, Claude 5/4.8, Gemini 3.6/3.5/3.1, Qwen 3.7/3.6, GLM 5.2/5.1, and Kimi K3/K2.7/K2.6 models.
- fix: Removed retired or scheduled-for-retirement Claude Opus 4.1, Gemini preview, Qwen 3 Max/Coder Plus, GLM 4.5, and Kimi K2/K2.5 model entries.
- fix: Updated provider context limits, OpenRouter aliases, and official token pricing, including long-context price tiers.
- fix: Omitted unsupported sampling parameters for current Claude and Kimi models.

## [3.2.0]
- feat: Added comprehensive RAG embedding and indexing system with embedding repair, BM25 caching, and commit file loading for enhanced commit message generation.
- feat: Added support for new Anthropic models — `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6` — and removed retired/deprecated model variants.
- feat: Switched to `DeepSeek-V4 Flash` and `DeepSeek-V4 Pro` models.
- fix: Prompt caching now uses the top-level `cache_control` field for Anthropic requests.
- feat: Added full provider support for `GLM`, `Kimi`, and `OpenRouter` across model management, status bar integration, commit generation, and repository analysis model selection, with curated model sets.
- feat: Added OpenRouter model mapping registry for request-model to canonical-pricing alias normalization, integrated into usage logging and cost tracking.
- feat: Added local provider support with configurable base URL for connecting to self-hosted LLM endpoints.
- feat: Repository analysis now skips likely-binary files, supports configurable default exclude patterns, and exposes tool-result truncation thresholds.
- refactor: Introduced CJK-aware token estimation and text splitting for more accurate token counting in mixed-language content.
- refactor: Introduced a shared OpenAI-compatible chat-completions provider base and migrated `DeepSeek`/`Qwen` onto the unified implementation path.
- refactor: Unified provider config types (replaced `any`), extracted shared retry loop and `safeRun` error handling, centralised CNY→USD pricing conversion.
- refactor: Simplified repository analysis control flow, removed deprecated analysis modules and placeholder LLM service dependencies.
- refactor: Webview UI updated with CSS design tokens and icon component extraction.
- fix: Resolved `cancelCurrentAnalysis` race condition with per-repository cancel sources and fixed `EventManager` repository listener leak.
- fix: Preserved `ProviderError.statusCode` when retries are exhausted in Gemini and Anthropic providers.
- fix: Preserved cancellation signals instead of silently converting to HTTP 500 errors.
- fix: Added 68 missing i18n translation keys for `zh-cn` and `zh-tw` locales.
- fix: Fixed `toggleThinking` typo and added missing `repairRagEmbeddings` dashboard i18n key.

## [3.0.4]
- feat: Added support for new OpenAI frontier models:
  - `gpt-5.4`
  - `gpt-5.4-mini`
  - `gpt-5.4-nano`
- fix: Removed `gpt-5.2-pro` from selectable OpenAI models to avoid structured-output incompatibility.
- feat: Updated OpenAI model fallback priority, context window mapping, and pricing table for GPT-5.4 series.

## [3.0.1]
- feat: Added support for new Claude 4.5 series models:
  - `claude-haiku-4-5-20251001`
  - `claude-sonnet-4-5-20250929`
  - `claude-opus-4-5-20251101`
- feat: Added support for new Gemini models:
  - `gemini-3-pro-preview`
- fix: Fixed SCM title buttons not displaying in newer VS Code versions.

## [3.0.0]
- feat: Add a webview-based dashboard for genie.
- feat: The new repository analysis system will be agentic and function-calling-driven.
- fix: Removed support for Gemini 2.5 flash-lite and flash-lite-preview-09-2025; the performance of these models is not satisfactory.

## [2.3.1]
- fix: Fixed some text display issues.

## [2.3.0]
- feat: Added support for Qwen models from Qwen LLM provider.

## [2.2.0]
- feat: Added support for multiple repository.
- feat: Added support for Gemini 2.5 flash-lite, flash-lite-preview-09-2025, flash-preview-09-2025 models.

## [2.1.7]
- fix: Update English UI text for better clarity.

## [2.1.6]
- fix: Added spport for .ipynb files commit message generation.
- fix: Simplified binary file content reading to generate commit messages, saving unnecessary tokens.
- feat: Added a repository analysis cache cleanup command. The current repository analysis cache primarily includes summaries of the technology stack and characteristics of the repository.

## [2.1.3]
- fix: Enhanced retry logic with schema validation and improved error handling in Anthropic and DeepSeek provider.

## [2.1.0]
- feat: Now genie will show stage notifications when using thinking mode.

## [2.0.0]
- feat: Now can use different modle for repository analysis and commit message generation.
- feat: Add LLM cost tracking for this plugin, and display cost details in the VS Code output channel.
- feat: Ensuring generated commit messages better adhere to the user templates.
- feat: Added intelligent repository analysis context for enhanced commit message generation
- fix: Improved the commit message generation for renamed files

## [1.5.0]
- feat: Improved commit message generation in chain-of-thought mode by refining prompt structure and reducing token usage.
- feat: add typing animation when generating commit messages.
- feat: Replaced all console logging with a dedicated logger service that uses VS Code's output channel for better log management and user experience.
- feat: Improved user template system, now can use different templates for different repositories.

## [1.1.0]

- feat: Optimized the language detection logic for commit messages generated during chain-of-thought reasoning, reducing token consumption.
- feat: Enhanced the accuracy of commit messages generated using user templates.

## [1.0.0]

Never suffer through writing commit messages again.

🎉 The first release brings smart commit generation powered by multiple LLM providers, with multilingual support built in.
A simple start, focused on making your workflow smoother and faster.
