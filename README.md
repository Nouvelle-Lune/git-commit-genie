<div align="center">

<img src="./media/Genie.png" width="112" alt="Git Commit Genie" />

# Git Commit Genie

Generates a commit message from your staged Git changes and writes it into the Source Control input box.

[![Marketplace version](https://vsmarketplacebadges.dev/version/Lune-99.git-commit-genie.svg?label=marketplace&color=007ec6)](https://marketplace.visualstudio.com/items?itemName=Lune-99.git-commit-genie)
[![Marketplace installs](https://vsmarketplacebadges.dev/installs/Lune-99.git-commit-genie.svg?label=installs&color=4c1)](https://marketplace.visualstudio.com/items?itemName=Lune-99.git-commit-genie)
[![Marketplace rating](https://vsmarketplacebadges.dev/rating-star/Lune-99.git-commit-genie.svg?label=rating&color=dfb317)](https://marketplace.visualstudio.com/items?itemName=Lune-99.git-commit-genie)
[![Open VSX version](https://img.shields.io/open-vsx/v/Lune-99/git-commit-genie?label=open-vsx&color=007ec6)](https://open-vsx.org/extension/Lune-99/git-commit-genie)
[![Open VSX downloads](https://img.shields.io/open-vsx/dt/Lune-99/git-commit-genie?label=downloads&color=4c1)](https://open-vsx.org/extension/Lune-99/git-commit-genie)
[![Open VSX rating](https://img.shields.io/open-vsx/rating/Lune-99/git-commit-genie?label=rating&color=dfb317)](https://open-vsx.org/extension/Lune-99/git-commit-genie)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

English | [简体中文](https://github.com/Nouvelle-Lune/git-commit-genie/blob/main/docs/README.zh-CN.md)

<img src="./media/demo1.gif" width="820" alt="Generating a commit message from staged changes" />

</div>

## What it does

Git Commit Genie generates a commit message from the changes you have staged, using OpenAI, Anthropic Claude, Google Gemini or any OpenAI-compatible endpoint. Messages follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) by default, and can follow a template kept in your repository.

Generation runs as a pipeline:

| Stage | Description |
| --- | --- |
| Evidence | Summarizes each staged file in parallel, together with repository context. |
| Investigation | Plans questions about the change and answers them with lookups for definitions, callers, callees, types, configuration and tests. |
| Draft | Writes one message from the evidence, your template, repository memory and RAG style references. |
| Verify | Checks the draft against Conventional Commits and your template, applies minimal fixes and enforces the target language. |

The pipeline is controlled by `gitCommitGenie.chain.enabled` and is enabled by default. Disabling it generates the message from a single prompt, which is faster and cheaper for small commits.

The pipeline is independent from the model's own reasoning level: the pipeline decides how many stages run, while `gitCommitGenie.defaultThinkingLevel` decides how much the model reasons inside each call.

## Installation

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Lune-99.git-commit-genie) or [Open VSX](https://open-vsx.org/extension/Lune-99/git-commit-genie), or run:

```bash
code --install-extension Lune-99.git-commit-genie
```

Editors that use Open VSX instead of the Microsoft Marketplace, such as VSCodium, Cursor, Windsurf and Trae, can install the Open VSX build from their Extensions view.

Requirements: VS Code 1.103 or newer, the built-in Git extension, and an API key for the provider or endpoint you choose.

## Usage

1. Run `Git Commit Genie: Manage Models`, add a provider and paste its API key. Keys are stored in VS Code SecretStorage, not in `settings.json`.
2. Stage your changes.
3. Click the Genie icon in the Source Control title bar, or run `Git Commit Genie: Generate commit message`.
4. Review the message in the commit box, edit it if needed, and commit.

`Git Commit Genie: Menu` opens the pipeline toggle, model management and repository memory.

## Features

- Conventional Commits output, validated before it is written to the commit box.
- Providers: OpenAI, Anthropic Claude and Google Gemini, plus custom OpenAI-compatible endpoints such as DeepSeek, Qwen, GLM, Kimi, OpenRouter and local vLLM, SGLang or llama.cpp servers.
- Thinking levels from `off` to `max`, set globally or per model.
- Commit message languages: `auto`, `en`, `zh-CN`, `zh-TW`, `ja`, `ko`, `de`, `fr`, `es`, `pt`, `ru`, `it`.
- Extension UI in English, Simplified Chinese and Traditional Chinese.
- Generate and cancel from the Source Control title bar; progress is shown in the status bar.
- Optional repository investigation, repository memory and RAG style index (see [Advanced features](#advanced-features)).
- Per-repository cost tracking (see [Panel and cost](#panel-and-cost)).
- Templates for body structure, footers and vocabulary (see [Templates](#templates)).

### Example output

```
feat(scm): add per-repository cost tracking to the Genie panel

- Record token usage and estimated cost for every generation
- Show accumulated spend next to each repository in the panel
- Keep the pipeline log available for the current session

Refs: #142
```

The structure depends on your template. Without a template, Genie follows Conventional Commits 1.0.0.

## Panel and cost

The Genie panel in the Source Control sidebar lists the repositories in your workspace with their accumulated cost, and a log of pipeline stages and model calls.

<img src="./media/dashboard-view.png" width="430" alt="Genie panel with repository list, costs and pipeline log" />

While a message is generating, the status bar shows the current model and stage.

<img src="./media/status-bar.png" width="430" alt="Status bar showing the current model and generation stage" />

## Templates

Templates are Markdown files stored in `.gitgenie/templates` in the workspace, or in your user template folder. Genie extracts the body layout, required footers and vocabulary preferences from the template and applies them while drafting and validating the message.

<img src="./media/demo2.gif" width="600" alt="Creating and selecting a commit template" />

Guides: [English](https://github.com/Nouvelle-Lune/git-commit-genie/blob/main/docs/user-template-guide.md) and [中文](https://github.com/Nouvelle-Lune/git-commit-genie/blob/main/docs/user-template-guide.zh-CN.md).

## Advanced features

**Repository investigation** is enabled by default. When the diff alone is ambiguous, the pipeline plans questions about the change and answers them from the repository: definitions, callers, configuration and tests. The number of lookups is bounded by `gitCommitGenie.chain.investigation.maxSteps`, and paths can be excluded with `gitCommitGenie.chain.investigation.excludePatterns`.

**Repository memory** is off by default. With `gitCommitGenie.memory.enabled`, Genie records what its investigations learned into local, per-repository storage and recalls it for similar changes later. Consolidation runs while the editor is idle. Use `Git Commit Genie: Manage Repository Memory` to inspect, rebuild or clear it.

**RAG style index** is off by default. With `gitCommitGenie.rag.enabled`, Genie indexes your historical commit messages locally and retrieves style references for new messages. It requires an OpenAI-compatible embeddings endpoint; configure it with `Git Commit Genie: Configure RAG Embedding API Key`.

## Configuration

Commonly changed settings:

| Setting | Default | Description |
| --- | --- | --- |
| `gitCommitGenie.chain.enabled` | `true` | Multi-stage pipeline; disable for single-prompt generation |
| `gitCommitGenie.commitLanguage` | `auto` | Target language for commit messages |
| `gitCommitGenie.defaultThinkingLevel` | `off` | Thinking level for supported models |
| `gitCommitGenie.memory.enabled` | `false` | Repository memory |
| `gitCommitGenie.rag.enabled` | `false` | RAG style index |
| `gitCommitGenie.autoStageAllForDiff` | `false` | Stage all changes when the staging area is empty |

All commands and every setting are documented in the [Commands & Settings reference](https://github.com/Nouvelle-Lune/git-commit-genie/blob/main/docs/reference.md).

## Privacy

- API keys are stored in VS Code SecretStorage and are not written to `settings.json` or the logs.
- Only staged changes are analyzed. `gitCommitGenie.autoStageAllForDiff` is the exception; it restores your staging state afterwards.
- With investigation enabled, Genie reads files inside the repository and sends the findings it selects to the model provider you configured. Build outputs, dependency directories and lockfiles are excluded by default, and you can add exclusions.
- RAG sends historical commit messages to the embeddings endpoint you configure.
- Repository memory is stored in VS Code's local global storage and is not uploaded.
- The extension collects no analytics or telemetry.

## Contributing

Issues and pull requests: https://github.com/Nouvelle-Lune/git-commit-genie.

## License

[MIT](./LICENSE)

## Acknowledgements

- [Conventional Commits](https://www.conventionalcommits.org/)
- OpenAI, Anthropic and Google Gemini, and the OpenAI-compatible model ecosystem.
