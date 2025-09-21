# Git Commit Genie 用户模板编写指南

本指南介绍如何编写“用户模板”（User Template），以在链式提示模式下强力影响最终提交信息的结构与用词。模板会被模型读取与“归纳”为策略（Template Policy），当且仅当模板文件存在、非空且可被抽取为有效策略时，才会启用“模板优先”；否则回退为默认规则优先。

## 前置与注意

- 链式模式会强力遵循模板策略（命令：Git Commit Genie: Toggle Chain Prompting；状态栏显示“· Chain”即开启）。
- 在 VS Code 设置里配置 `gitCommitGenie.templatesPath` 为模板文件的绝对路径。
- 文件必须真实存在、非空，且内容有明确、结构化的偏好描述。
- 为获得最佳效果，请用英文撰写模板内容（插件的提示词为英文）。
- 头行始终严格遵循 Conventional Commits：`<type>(<scope>)[!]: <description>`，长度 ≤ 72 字符；模板主要影响 Body/Footers/用词。

## 模板如何被使用

链式流程分三步：
1) 并行生成逐文件摘要
2) 串行“分类与草拟”提交信息（此处应用模板策略）
3) 严格校验与最小修复 + 本地正则兜底

当模板有效时，插件会先“抽取模板策略（Template Policy）”，并在第 2 步严格应用：

- Body 的段落顺序、是否强制包含 Body
- Footers 必选项（例如总是包含 `Refs`）与默认值
- 词汇偏好（prefer/avoid）与语气（imperative/neutral/friendly）
- Header 的 scope 是否强制、是否偏好 `!` 标注等（但不会破坏规范）

## 推荐写法 A：自然语言模板（轻量）

适合快速指定偏好，示例如下（请保存为你的模板文件）：

Strongly Opinionated Conventional Commit Template
- Header:
  - Use a type from: feat, fix, docs, style, refactor, perf, test, build, ci, chore.
  - Always include a lowercase scope. Derive from the top-level directory; if unclear, use repo.
  - Imperative, present tense; no trailing period; <= 72 chars.
  - For breaking changes, prefer "!" and also add a BREAKING CHANGE footer.
- Body (always include):
  - Summary: one concise sentence for overall intent.
  - Changes: up to 3 bullets, each is "<file-or-scope>: <concise change>".
  - Impact: one of [none, developer, user-facing, performance, security, breaking].
  - Risk: one of [low, medium, high].
  - Notes: up to 2 lines if needed.
- Footers:
  - Always include `Refs`; if no ticket, use `Refs: N/A`.
  - Keep one blank line between header and body, and between body and footers.
- Lexicon:
  - Prefer: add, fix, remove, rename, refactor, optimize, document, configure, test.
  - Avoid: update, various, stuff, misc.

## 推荐写法 B：JSON Policy（高可靠）

为提升“可抽取性”，你可以在模板中加入一个 JSON Policy 区块（无需代码块标记），模型会更可靠地抽取到策略。示例：

{
  "header": {
    "requireScope": true,
    "scopeDerivation": "directory",
    "preferBangForBreaking": true,
    "alsoRequireBreakingFooter": true
  },
  "body": {
    "alwaysInclude": true,
    "orderedSections": ["Summary", "Changes", "Impact", "Risk", "Notes"],
    "bulletRules": [
      { "section": "Changes", "maxBullets": 3, "style": "dash" }
    ]
  },
  "footers": {
    "required": ["Refs"],
    "defaults": [{ "token": "Refs", "value": "N/A" }]
  },
  "lexicon": {
    "prefer": ["add", "fix", "remove", "refactor", "optimize", "test"],
    "avoid": ["update", "misc", "stuff"],
    "tone": "imperative"
  }
}

可在 JSON 之前/之后继续写自然语言说明，两者可并存。抽取器会尽力综合。

## 最小模板（示例）

Minimal Template
- Always include a body with Summary and Changes.
- Use imperative, no trailing period.
- Always include a `Refs` footer (use `Refs: N/A` when missing).
- Prefer: add, fix, refactor; Avoid: update.

## 示例输出（结构示意）

fix(parser)!: handle empty tokens safely

Summary: guard against null/empty token arrays
Changes:
- parser: avoid throwing on empty tokens
- tests: add boundary cases
Impact: developer
Risk: low
Notes: none

BREAKING CHANGE: parsing behavior changed for empty inputs
Refs: N/A

> 注意：这是一个结构示意，真实内容需由你的变更决定。

## 常见问题（FAQ）

- 模板不生效？
  - 路径是否正确且为绝对路径？文件是否非空？
  - 模板是否足够明确、结构化？尝试加入“JSON Policy”区块以增强抽取稳定性。
  - 是否开启了链式模式？
- 为什么头行格式没有按模板改？
  - 头行必须严格遵循 Conventional Commits，模板不会改变头行的规范格式，只能影响其选择（type/scope/!）与描述用词。
- 生成内容过长？
  - 保持段落与要点简洁，限制 bullet 数量与句长；模板中明确这些限制。

## 小结

编写清晰、结构化的模板（更推荐附带 JSON Policy），可显著提升生成提交信息的稳定性与一致性；在保证头行合规的前提下，模板能有效统一 Body/Footers 的结构与风格。

---

[English Version / 英文版本](./user-template-guide.md)

