# Git Commit Genie User Template Authoring Guide

This guide explains how to write a User Template that strongly shapes the final commit message structure and wording (especially in Chain Prompting mode). The template is read and distilled into a Template Policy only when the file exists, is non‑empty, and yields an extractable policy. Otherwise the generator falls back to default rules.

## Prerequisites & Notes

- Chain mode strongly enforces the extracted policy (command: `Git Commit Genie: Toggle Chain Prompting`; status bar shows `· Chain` when enabled).
- Configure the absolute path in VS Code settings: `gitCommitGenie.templatesPath`.
- File must exist, be non‑empty, and contain clear structured preferences.
- You can use any format for the template file if you prefer (e.g. .txt .md .json .yaml).
- Write the template content in English for best extraction (the internal prompts are English).
- The header always follows Conventional Commits: `<type>(<scope>)[!]: <description>` and ≤ 72 chars. The template mainly influences Body / Footers / wording.

## How the Template Is Used

Chain flow has three phases:
1. Parallel per‑file summaries.
2. Serial classify & draft (applies template policy here).
3. Strict validation & minimal fix + local regex fallback.

When policy extraction succeeds, the engine applies:
- Body paragraph ordering / mandatory body enforcement.
- Required footers (e.g. always include `Refs`) and defaults.
- Lexicon preferences (prefer / avoid words) and tone (imperative / neutral / friendly).
- Header scope guidance or `!` preference (never breaking the core spec rules though).

## Recommended Style A: Natural Language (Lightweight)

Good for quick preferences. Example (save this as your template file):

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

## Recommended Style B: JSON Policy (High Reliability)

 The model more reliably extracts rules. Example:

```json
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
```

You may surround the JSON with additional natural language notes—both styles can coexist and will be merged.

## Minimal Template (Example)

Minimal Template
- Always include a body with Summary and Changes.
- Use imperative, no trailing period.
- Always include a `Refs` footer (use `Refs: N/A` when missing).
- Prefer: add, fix, refactor; Avoid: update.

## Example Output (Structure Illustration)

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

> Note: This is a structural illustration. Real content depends on your actual changes.

## FAQ

- Template not applied?
  - Is the path absolute and correct? Is the file non-empty?
  - Is it sufficiently clear & structured? Try adding a JSON Policy block.
  - Is chain mode enabled?
- Why didn't the header format change per template desire?
  - Header must always comply with Conventional Commits. Template only influences selection (type / scope / `!`) and wording, not the core format.
- Output too long?
  - Keep sections concise, limit bullet counts, state explicit limits in the template.

## Summary

A clear, structured template (preferably with a JSON Policy) dramatically improves consistency and reliability. Within a standards-compliant header, your template unifies body & footer structure, tone, and vocabulary.

---

[Chinese Version / 中文版本](./user-template-guide.zh-CN.md)
