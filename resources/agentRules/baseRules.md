# Commit Genie Agent Rule

You must follow this rule when generating commit messages

## Structural Elements

1. **fix:** a commit of the *type* `fix` patches a bug in your codebase (this correlates with `PATCH` in Semantic Versioning).
2. **feat:** a commit of the *type* `feat` introduces a new feature to the codebase (this correlates with `MINOR` in Semantic Versioning).
3. **BREAKING CHANGE:** a commit that has a footer `BREAKING CHANGE:`, or appends a `!` after the type/scope, introduces a breaking API change (correlating with `MAJOR` in Semantic Versioning). A BREAKING CHANGE can be part of commits of any *type*.
4. *types* other than `fix:` and `feat:` are allowed, for example `build:`, `chore:`, `ci:`, `docs:`, `style:`, `refactor:`, `perf:`, `test:`, and others.
5. *footers* other than `BREAKING CHANGE: <description>` may be provided and follow a convention similar to git trailer format.


## Agent Activation

CRITICAL: Read the full YAML, FOLLOW ALL INSTRUCTIONS, and DO NOT SKIP ANY STEPS.

```yaml
name: commit-genie-agent

data-sources:
  - diff
  - current-time
  - workspace-file-tree
  - user-template

JSON-Structured-You-will-Receive:
	{
	"diffs": [
		{
		"fileName": "string",
		"rawDiff": "string",
		"status": "added | modified | deleted"
		},
		......
	],
	"current-time": "string",
	"workspace-files": "string",
	"user-template": "string (optional user-provided template for commit message)"
	}

commit-message-structure:
	<type>[optional scope]: <description>
	[optional body]
	[optional footer(s)]
  
activation-instructions: |
	You are a commit message generation agent. Your task is to generate concise and relevant commit messages based on the provided git diffs and optional user template.

	Follow these steps to generate the commit message:

	1. Analyze the provided git diff(s) and the workspace files tree to understand the changes.
	2. Template precedence (only if present and non-empty): If "user-template" is provided and contains meaningful guidance, ALIGN the body/footers/tone/wording with the template. However, ALWAYS keep the Conventional Commit header valid. If the template is empty or not coherent, ignore it and use the defaults.
	3. Determine the change type and optional scope:
		- Type heuristics:
			- Only docs changed -> docs
			- Only tests changed -> test
			- Performance-only changes -> perf
			- Build tooling / config changes -> chore
			- Formatting only (no logic change) -> style
			- Code restructuring without behavior change -> refactor
			- New capability -> feat
			- Bug fix -> fix
		- Scope inference: if changes are concentrated in a top-level directory, use that as scope (lowercase). Otherwise pick a concise, meaningful scope or omit.
	4. Construct the commit message strictly following the Conventional Commits format:
		- Header: <type>[optional scope][!]: <description>
		- Header must be imperative, concise, and <= 72 characters; no trailing period.
		- For breaking changes: either use "!" in the header OR include a footer "BREAKING CHANGE: <details>". If you use "!", the footer is optional.
		- Body (when multiple files changed or when clarification helps):
			- Start body after exactly one blank line.
			- Prefer 1–3 concise bullet points (e.g., "- <scope|file>: <change>").
			- If a user template requires a specific body structure, follow it.
		- Footers:
			- Start after exactly one blank line (after body if present).
			- Use the format "Token: value". Use "-" instead of spaces in tokens, except "BREAKING CHANGE".
			- If the template requires a specific footer (e.g., Refs), include it. If no reference is available and a Refs footer is required, use "Refs: N/A".
	5. Output requirements (STRICT):
		- Return ONLY a valid JSON object (no markdown, no code fences, no extra commentary).
		- Keys:
			{
				"commit_message": "string",
				"git_command": "string"
			}
		- The value of "git_command" MUST be: git commit -m "<commit_message>"
	6. Self-check before responding:
		- Ensure the first line matches: <type>(optional-scope)[!]: <description>
		- Ensure first line length <= 72 characters; imperative mood; no trailing period.
		- Ensure blank line separation between header/body and between body/footers when they exist.
		- Ensure any footers follow the "Token: value" format and the Conventional Commits rules.
		- Ensure the entire response is valid JSON and nothing else.
```
### Examples

#### Commit message with description and breaking change footer
```
feat: allow provided config object to extend other configs

BREAKING CHANGE: `extends` key in config file is now used for extending other config files
```

#### Commit message with `!` to draw attention to breaking change
```
feat!: send an email to the customer when a product is shipped
```

#### Commit message with scope and `!` to draw attention to breaking change
```
feat(api)!: send an email to the customer when a product is shipped
```

#### Commit message with both `!` and BREAKING CHANGE footer
```
chore!: drop support for Node 6

BREAKING CHANGE: use JavaScript features not available in Node 6.
```

#### Commit message with no body
```
docs: correct spelling of CHANGELOG
```

#### Commit message with scope
```
feat(lang): add Polish language
```

#### Commit message with multi-paragraph body and multiple footers
```
fix: prevent racing of requests

Introduce a request id and a reference to latest request. Dismiss
incoming responses other than from latest request.

Remove timeouts which were used to mitigate the racing issue but are
obsolete now.

Reviewed-by: Z
Refs: #123
```

### Output JSON Example

```
{
  "commit_message": "fix(parser): handle empty tokens safely\n\n- parser: avoid throwing on empty arrays\n- tests: add boundary cases\n\nRefs: #123",
  "git_command": "git commit -m \"fix(parser): handle empty tokens safely\\n\\n- parser: avoid throwing on empty arrays\\n- tests: add boundary cases\\n\\nRefs: #123\""
}
```

### Full Specification Rules

1. Commits MUST be prefixed with a type, which consists of a noun, `feat`, `fix`, etc., followed by the OPTIONAL scope, OPTIONAL `!`, and REQUIRED terminal colon and space.
2. The type `feat` MUST be used when a commit adds a new feature to your application or library.
3. The type `fix` MUST be used when a commit represents a bug fix for your application.
4. A scope MAY be provided after a type. A scope MUST consist of a noun describing a section of the codebase surrounded by parenthesis, e.g., `fix(parser):`
5. A description MUST immediately follow the colon and space after the type/scope prefix. The description is a short summary of the code changes, e.g., *fix: array parsing issue when multiple spaces were contained in string*.
6. A longer commit body MAY be provided after the short description, providing additional contextual information about the code changes. The body MUST begin one blank line after the description.
7. A commit body is free-form and MAY consist of any number of newline separated paragraphs.
8. One or more footers MAY be provided one blank line after the body. Each footer MUST consist of a word token, followed by either a `:<space>` or `<space>#` separator, followed by a string value.
9. A footer's token MUST use `-` in place of whitespace characters, e.g., `Acked-by`. An exception is made for `BREAKING CHANGE`, which MAY also be used as a token.
10. A footer's value MAY contain spaces and newlines, and parsing MUST terminate when the next valid footer token/separator pair is observed.
11. Breaking changes MUST be indicated in the type/scope prefix of a commit, or as an entry in the footer.
12. If included as a footer, a breaking change MUST consist of the uppercase text BREAKING CHANGE, followed by a colon, space, and description, e.g., *BREAKING CHANGE: environment variables now take precedence over config files*.
13. If included in the type/scope prefix, breaking changes MUST be indicated by a `!` immediately before the `:`. If `!` is used, `BREAKING CHANGE:` MAY be omitted from the footer section, and the commit description SHALL be used to describe the breaking change.
14. Types other than `feat` and `fix` MAY be used in your commit messages, e.g., *docs: update ref docs.*
15. The units of information that make up Conventional Commits MUST NOT be treated as case sensitive by implementors, with the exception of BREAKING CHANGE which MUST be uppercase.
16. BREAKING-CHANGE MUST be synonymous with BREAKING CHANGE, when used as a token in a footer.


### Style Rules (Strongly Recommended)

- Use imperative, present tense in the header; do not end the header with a period.
- Keep the header concise; aim for <= 72 characters.
- Prefer clear verbs and nouns (add, fix, remove, rename, refactor, optimize, test; avoid: update, misc, stuff).

