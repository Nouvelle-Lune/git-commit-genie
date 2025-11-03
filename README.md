<div align="center">

# Git Commit Genie

Chinese version: [中文说明](./docs/README.zh-CN.md)

</div>

## Overview

Git Commit Genie analyzes your staged Git diff and generates high‑quality Conventional Commits style messages using mainstream LLM providers (OpenAI / DeepSeek / Anthropic / Gemini / Qwen). Features intelligent repository analysis that understands your project structure and tech stack to provide better context for commit generation. Supports optional multi‑step Thinking mode and user template strategy to improve structural consistency and style alignment.

<table style="width: 100%; border-spacing: 10px;">
  <tr>
    <td width="50%" align="center" style="vertical-align: top;">
      <strong>Commit message generate</strong><br/><br/>
      <img src="./media/demo1.gif" width="100%" alt="Usage Demo" style="display: block;"/>
    </td>
    <td width="50%" rowspan="2" align="center" style="vertical-align: top;">
      <strong>Log dashboard</strong><br/><br/>
      <img src="./media/dashboard-view.png" width="100%" alt="Dashboard view" style="display: block;"/>
    </td>
  </tr>
  <tr>
    <td align="center" style="vertical-align: top;">
      <strong>Status Bar Display</strong><br/><br/>
      <img src="./media/status-bar.png" width="100%" alt="Status Bar" style="display: block;"/>
    </td>
  </tr>
</table>

## Format

By default, generated commit messages follow the Conventional Commits 1.0.0 specification. See the spec: https://www.conventionalcommits.org/en/v1.0.0/

Basic format:
```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

## Tips

- Small or trivial commits: prefer a lightweight, fast model to speed up generation and reduce token usage.
- Large, multi‑file commits: consider switching to a stronger model for better analysis and structure.
- You can switch models anytime via "Git Commit Genie: Manage Models".
- Toggle Thinking quickly via "Git Commit Genie: Enable / Disable thinking mode".

## Core Features

| Feature                         | Description                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi‑provider LLM support      | Supports OpenAI, DeepSeek, Anthropic, Gemini, Qwen.                                                                                                                                                                                                                                                                    |
| Repository Intelligence         | AI-powered repository analysis agent that autonomously explores your codebase using intelligent tools; automatically understands project structure, tech stack, and architecture to provide contextual insights for better commit messages; supports manual refresh, real-time updates, and editable analysis reports. |
| Thinking Mode                   | Optional multi‑step pipeline: per‑file summaries → structured synthesis → validation & minimal fix‑ups (improves accuracy & template adherence).                                                                                                                                                                       |
| User Template Strategy          | Built-in template selection and creation, supports workspace and user data directory storage, extracts strategy affecting structure, required footers, and vocabulary preferences.                                                                                                                                     |
| Conventional Commit Enforcement | Header validation (type, optional scope, optional `!`, ≤ 72 chars, imperative, no trailing period).                                                                                                                                                                                                                    |
| Diff Awareness                  | Only staged changes are analyzed; intelligently classifies type (`feat`, `fix`, `docs`, `refactor`, etc.).                                                                                                                                                                                                             |
| Status Bar Integration          | Shows current model and analysis status, click to access feature menu.                                                                                                                                                                                                                                                 |
| Cancellation                    | Cancel in‑progress generation directly from the SCM title bar button.                                                                                                                                                                                                                                                  |
| Secure Secret Storage           | API keys stored in VS Code secret storage (not in settings JSON).                                                                                                                                                                                                                                                      |
| Internationalization            | Built‑in English, Simplified Chinese, Traditional Chinese, and more.                                                                                                                                                                                                                                                   |
| Stage Notifications             | Bottom‑right, progress notifications that show thinking stages.                                                                                                                                                                                                                                                        |

## How It Works

1. You stage your changes.
2. Run command: `Git Commit Genie: Generate commit message` (SCM toolbar button or Command Palette).
3. Result is injected into the repository input box—review / tweak / commit.


## Configuration

All settings are under: `Git Commit Genie`.

| Setting                                             | Type    | Default   | Description                                                                                                                                                                                                                                                         |
| --------------------------------------------------- | ------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gitCommitGenie.autoStageAllForDiff`                | boolean | false     | Only when the staging area is empty: temporarily stage all changes to build the diff, then restore your staging state. Use with caution—this may include unrelated changes in the prompt.                                                                           |
| `gitCommitGenie.chain.enabled`                      | boolean | false     | Enable multi-step Thinking mode for commit generation (more detailed and accurate, better template adherence, but higher latency and token usage).                                                                                                                  |
| `gitCommitGenie.chain.maxParallel`                  | number  | 2         | Maximum parallel LLM calls used by Thinking mode across all providers. Increase carefully to avoid provider rate limits.                                                                                                                                            |
| `gitCommitGenie.llm.maxRetries`                     | number  | 2         | Max retry attempts for API request failures.                                                                                                                                                                                                                        |
| `gitCommitGenie.llm.temperature`                    | number  | 0.2       | Temperature (0–2). Default 0.2.                                                                                                                                                                                                                                     |
| `gitCommitGenie.repositoryAnalysis.enabled`         | boolean | true      | Enable repository analysis to provide better context for commit message generation.                                                                                                                                                                                 |
| `gitCommitGenie.repositoryAnalysis.excludePatterns` | array   | []        | File patterns to exclude from repository analysis scanning (gitignore-style).                                                                                                                                                                                       |
| `gitCommitGenie.repositoryAnalysis.updateThreshold` | number  | 10        | Number of commits after which to update the repository analysis.                                                                                                                                                                                                    |
| `gitCommitGenie.repositoryAnalysis.MaxCount`        | number  | unlimited | Maximum number of analysis steps allowed during repository exploration. Set to -1 for unlimited steps (default).                                                                                                                                                    |
| `gitCommitGenie.repositoryAnalysis.model`           | enum    | general   | Model used for repository analysis. Pick any supported model across providers; the provider automatically switches to match your selection. Choose "Use default model" to reuse your main commit message model. You can configure this via "Manage Models" command. |
| `gitCommitGenie.commitLanguage`                     | string  | `auto`    | Target language for generated commit messages. Options: `auto`, `en`, `zh-CN`, `zh-TW`, `ja`, `ko`, `de`, `fr`, `es`, `pt`, `ru`, `it`.                                                                                                                             |
| `gitCommitGenie.typingAnimationSpeed`               | number  | 15        | Speed of the commit message box typing animation in milliseconds per character. Set to -1 to disable the animation.                                                                                                                                                 |
| `gitCommitGenie.showUsageCost`                      | boolean | true      | When enabled, a brief notification displays the estimated total cost for the current generation.                                                                                                                                                                    |
| `gitCommitGenie.ui.stageNotifications.enabled`      | boolean | true      | Show bottom‑right stage notifications during Thinking. Title‑less minimal bubble.                                                                                                                                                                                   |


## Commands

Search these in the Command Palette:

- Git Commit Genie: Generate commit message
- Git Commit Genie: Stop generate (visible during generation)
- Git Commit Genie: Manage Models
- Git Commit Genie: Enable / Disable thinking mode
- Git Commit Genie: Select/Create Template
- Git Commit Genie: View Repository Analysis (opens analysis as editable Markdown)
- Git Commit Genie: Refresh Repository Analysis (triggers new analysis)
- Git Commit Genie: Clear Repository Analysis Cache (clears analysis cache)
- Git Commit Genie: Cancel Repository Analysis (cancels analysis process)
- Git Commit Genie: Menu
- Git Commit Genie: Show Repository Cost
- Git Commit Genie: Reset Repository Cost

SCM Title Bar shows “Generate commit message” or “Stop generate” depending on state.

## Template Authoring
Using command `Git Commit Genie: Select/Create Template`to select or create a template file.

<img src="./media/demo2.gif" width="600"/>

When present & non‑empty, Genie attempts to extract a "Template Policy".

Full guides: [English](./docs/user-template-guide.md) | [中文](./docs/user-template-guide.zh-CN.md)

Minimum example:
```
Minimal Template
- Always include a body with Summary and Changes.
- Use imperative, no trailing period.
- Always include a `Refs` footer (use `Refs: N/A` when missing).
- Prefer: add, fix, refactor; Avoid: update.
```

## Security & Privacy

- API keys stored via VS Code SecretStorage (not written to disk config in plain text).
- Only staged diffs (file names & hunks) are sent; no untracked or unstaged changes.
- No analytics/telemetry are collected by this extension.

## License

MIT

## Acknowledgements

- [Conventional Commits](https://conventionalcommits.org/) - https://github.com/conventional-commits/conventionalcommits.org
- OpenAI / DeepSeek / Anthropic / Gemini / Qwen model ecosystems.

---

Never suffer through writing commit messages again.
