# Validation Checklist

- Header format: `<type>(optional-scope)[!]: <description>`
- User template precedence: if a non-empty user template is provided, STRICTLY follow it for body structure, sections, bullet style, tone/lexicon, and required footers. Conventional Commit header/structure rules still apply.
- Allowed `<type>`: feat, fix, docs, style, refactor, perf, test, build, ci, chore (English only)
- Header: imperative, concise, no trailing period, length <= 72 chars
- Blank lines: exactly one between header/body and between body/footers (when present)
- Language policy: narrative text (description, body, footer values) follows target language; do NOT translate `<type>` or footer tokens
- Body: optional, plain text or bullets; keep bullets concise; if a template specifies sections or bullet style, follow it
- Footers: `Token: value` format; use `-` in tokens (except `BREAKING CHANGE`)
- Breaking change: either `!` in header or `BREAKING CHANGE: <details>` footer
- Multiple footers allowed; `BREAKING-CHANGE` is synonymous with `BREAKING CHANGE`
- Required footers from template must be present; if unavailable, use a sensible placeholder (e.g., `Refs: N/A`)
- Do not translate footer tokens (e.g., BREAKING CHANGE, Refs)
- Output must be valid JSON only; no markdown fences or extra commentary
