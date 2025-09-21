import { DiffData } from "../../git/git_types";

export type ChatRole = 'system' | 'user';

export interface ChatMessage {
	role: ChatRole;
	content: string;
}

export type ChatFn = (
  messages: ChatMessage[],
  options?: { model?: string; temperature?: number }
) => Promise<string>;

// Extracted constraints from a user template (template-first policy)
export interface TemplatePolicy {
  header?: {
    requireScope?: boolean;
    scopeDerivation?: 'directory' | 'repo' | 'none';
    preferBangForBreaking?: boolean;
    alsoRequireBreakingFooter?: boolean;
  };
  body?: {
    alwaysInclude?: boolean;
    orderedSections?: string[]; // e.g., ["Summary", "Changes", "Impact", "Risk", "Notes"]
    bulletRules?: Array<{ section: string; maxBullets?: number; style?: 'dash' | 'asterisk' }>;
  };
  footers?: {
    required?: string[]; // e.g., ["Refs"]
    defaults?: Array<{ token: string; value: string }>;
  };
  lexicon?: {
    prefer?: string[];
    avoid?: string[];
    tone?: 'imperative' | 'neutral' | 'friendly';
  };
}

function isValidPolicyShape(obj: any): boolean {
  if (!obj || typeof obj !== 'object') { return false; }
  const keys = Object.keys(obj);
  if (!keys.length) {return false;}
  // Accept if any known section exists or if it has at least one key with object/array value
  if (['header', 'body', 'footers', 'lexicon'].some(k => k in obj)) {return true;}
  return keys.some(k => typeof (obj as any)[k] === 'object');
}

async function extractTemplatePolicy(userTemplate: string, chat: ChatFn): Promise<string> {
  if (!userTemplate || !userTemplate.trim()) {return '';}
  const system: ChatMessage = {
    role: 'system',
    content: 'You are a configuration extractor. Return STRICT JSON only; no markdown.'
  };
  const user: ChatMessage = {
    role: 'user',
    content: [
      'Extract a concise policy from the following commit template. Output only JSON with this schema:',
      '{',
      '  "header": {"requireScope": boolean, "scopeDerivation": "directory|repo|none", "preferBangForBreaking": boolean, "alsoRequireBreakingFooter": boolean},',
      '  "body": {"alwaysInclude": boolean, "orderedSections": string[], "bulletRules": Array<{"section": string, "maxBullets"?: number, "style"?: "dash"|"asterisk"}>},',
      '  "footers": {"required": string[], "defaults": Array<{"token": string, "value": string}>},',
      '  "lexicon": {"prefer": string[], "avoid": string[], "tone": "imperative|neutral|friendly"}',
      '}',
      'Template:',
      userTemplate
    ].join('\n')
  };
  const reply = await chat([system, user], { temperature: 0 });
  const text = reply?.trim() || '';
  try {
    const parsed = JSON.parse(text);
    if (isValidPolicyShape(parsed)) {
      // Return a canonical minified JSON string as policy
      return JSON.stringify(parsed);
    }
  } catch {
    // ignore parse error
  }
  return '';
}

export interface ChainInputs {
  diffs: DiffData[];
  baseRulesMarkdown: string;
  currentTime?: string;
  workspaceFilesTree?: string;
  userTemplate?: string;
  targetLanguage?: string;
}

export interface FileSummary {
	file: string;
	status: DiffData['status'];
	summary: string;
	breaking: boolean;
}

export interface ChainOutputs {
  commitMessage: string;
  fileSummaries: FileSummary[];
  raw?: {
    draft?: string;
    classificationNotes?: string;
    validationNotes?: string;
    templatePolicy?: string;
  };
}

function extractJson<T = any>(text: string): T | null {
	if (!text) { return null; }
	const trimmed = text.trim();
	try {
		return JSON.parse(trimmed) as T;
	} catch {}
	const start = trimmed.indexOf('{');
	const end = trimmed.lastIndexOf('}');
	if (start !== -1 && end !== -1 && end > start) {
		const slice = trimmed.slice(start, end + 1);
		try {
			return JSON.parse(slice) as T;
		} catch {}
	}
	return null;
}

async function summarizeSingleFile(diff: DiffData, chat: ChatFn): Promise<FileSummary> {
	const system: ChatMessage = {
		role: 'system',
		content:
			'You are a senior software engineer helping generate high-quality Conventional Commit messages. Analyze a single unified git diff and return a strict JSON summary. No commentary.'
	};

	const user: ChatMessage = {
		role: 'user',
		content: [
			'Summarize the following file change. Requirements:',
			'- Identify a concise change summary (<= 18 words).',
			'- Detect if this change might be a breaking change (boolean).',
			'- Respond ONLY with JSON using this schema:',
			'{"file": string, "status": "added|modified|deleted|renamed|untracked|ignored", "summary": string, "breaking": boolean}',
			'---',
			`file: ${diff.fileName}`,
			`status: ${diff.status}`,
			'diff:',
			diff.rawDiff
		].join('\n')
	};

	const reply = await chat([system, user], { temperature: 0 });
	const parsed = extractJson<FileSummary>(reply);
	if (!parsed || !parsed.file || !parsed.summary) {
		return {
			file: diff.fileName,
			status: diff.status,
			summary: 'Summarize file change (fallback): minor update',
			breaking: false
		};
	}
	return parsed;
}

async function classifyAndDraft(
  summaries: FileSummary[],
  inputs: ChainInputs,
  chat: ChatFn,
  opts?: { templatePolicyJson?: string }
): Promise<{
  draft: string;
  notes?: string;
  structured?: {
    type?: string;
		scope?: string | null;
		breaking?: boolean;
		description?: string;
		body?: string | null;
		footers?: { token: string; value: string }[];
	}
}> {
  const { baseRulesMarkdown, userTemplate, workspaceFilesTree, currentTime, targetLanguage } = inputs;
  const templatePolicyJson = opts?.templatePolicyJson ?? '';

	const system: ChatMessage = {
		role: 'system',
		content: [
			'You are an expert on Conventional Commits. Return STRICT JSON only.',
			'Follow the provided rules and examples EXACTLY. No markdown in values.',
			'Allowed types (use exactly one): feat, fix, docs, style, refactor, perf, test, build, ci, chore.'
		].join('\n')
	};

  const payload = {
    now: currentTime ?? new Date().toISOString(),
    file_summaries: summaries,
    workspace_files: workspaceFilesTree ?? '',
    template: userTemplate ?? '',
    template_policy: templatePolicyJson || '',
    target_language: targetLanguage || ''
  };

  const lines: string[] = [
    'Inputs (JSON):',
    JSON.stringify(payload, null, 2),
    '--- Rules and examples (Markdown):',
    baseRulesMarkdown,
    '--- Output JSON schema (STRICT):',
    '{',
    '  "type": "feat|fix|docs|style|refactor|perf|test|build|ci|chore",',
    '  "scope": "string|null",',
    '  "breaking": "boolean",',
    '  "description": "string",',
    '  "body": "string|null",',
    '  "footers": "Array<{token:string,value:string}>",',
    '  "commit_message": "string",',
    '  "notes": "string"',
    '}',
  ];
  if (templatePolicyJson) {
    lines.push(
      'Precedence and assembly rules (MUST follow):',
      '- If a template and template_policy are provided, FOLLOW THEM STRICTLY for body/footers structure, wording preferences, and required sections.',
      '- Conventional Commit HEADER MUST remain valid at all times.',
    );
  }
  const allowedTypes = 'feat, fix, docs, style, refactor, perf, test, build, ci, chore';
  lines.push(
    'Body bullets MUST NOT include commit types (feat, fix, docs, style, refactor, perf, test, build, ci, chore) or "!" markers; use file/scope labels only.',
    'First line: <type>[optional scope][!]: <description>',
    'If breaking=true and you use "!", do not require BREAKING CHANGE footer.',
    'If breaking=true and no "!" is used, include a footer: BREAKING CHANGE: <details>.',
    'Body must start after one blank line' + (templatePolicyJson ? '; format body according to template_policy if present.' : '.'),
    'Footers must start after one blank line (after body if present)' + (templatePolicyJson ? '; include any required footers per template_policy.' : '.'),
    'First line length must be <= 72 characters.',
    'No markdown, code fences, or extra commentary in any field.',
    `Type constraint: The Conventional Commit <type> MUST be exactly one of: ${allowedTypes}.`,
    `Language requirement: Use the target language for narrative text (description, body, footer values). Do NOT translate the <type> token; keep it in English. Do NOT translate footer tokens like BREAKING CHANGE or Refs.`,
    (targetLanguage && targetLanguage.trim() ? `Target language hint: ${targetLanguage}` : 'Target language hint: en'),
    'Return strictly valid JSON.'
  );

  const user: ChatMessage = { role: 'user', content: lines.join('\n') };

	const reply = await chat([system, user], { temperature: 0 });
	const parsed = extractJson<{
		type?: string;
		scope?: string | null;
		breaking?: boolean;
		description?: string;
		body?: string | null;
		footers?: { token: string; value: string }[];
		commit_message?: string;
		notes?: string;
	}>(reply);

	let draft = parsed?.commit_message || '';
	// Fallback: assemble from structured fields if provided
	if (!draft && parsed?.type && parsed?.description) {
		const type = parsed.type.trim();
		const scope = (parsed.scope || '').trim();
		const bang = parsed.breaking ? '!' : '';
		const header = `${type}${scope ? `(${scope})` : ''}${bang}: ${parsed.description.trim()}`;
		const parts: string[] = [header];
		if (parsed.body && parsed.body.trim()) {
			parts.push('', parsed.body.trim());
		}
		const footers: string[] = [];
		if (parsed.footers?.length) {
			for (const f of parsed.footers) {
				if (f?.token && typeof f?.value === 'string') {
					footers.push(`${f.token}: ${f.value}`);
				}
			}
		}
		if (parsed.breaking && !/!:\s/.test(header)) {
			footers.push('BREAKING CHANGE: Please see description for details.');
		}
		if (footers.length) {
			parts.push('', ...footers);
		}
		draft = parts.join('\n');
	}

	return {
		draft,
		notes: parsed?.notes,
		structured: parsed
			? {
					type: parsed.type,
					scope: parsed.scope ?? null,
					breaking: !!parsed.breaking,
					description: parsed.description,
					body: parsed.body ?? null,
					footers: parsed.footers ?? []
				}
			: undefined
	};
}

async function validateAndFix(
	commitMessage: string,
	baseRulesMarkdown: string,
	chat: ChatFn
): Promise<{ validMessage: string; notes?: string; violations?: string[] }> {
	const system: ChatMessage = {
		role: 'system',
		content: [
			'You are a strict Conventional Commits validator and fixer. Output ONLY JSON.',
			'Do not include markdown. Apply minimal edits when fixing.'
		].join('\n')
	};

  const user: ChatMessage = {
    role: 'user',
    content: [
      'Check the following commit message against the rules. If valid, return:',
      '{"status":"valid","commit_message": string,"violations":[]}',
      'If invalid, minimally edit to fix and return:',
      '{"status":"fixed","commit_message": string, "violations": string[], "notes": string}',
      'Additionally enforce: header <type> MUST be one of [feat, fix, docs, style, refactor, perf, test, build, ci, chore] and MUST NOT be translated.',
      'Additional requirement: Body bullets MUST NOT contain commit types (feat, fix, docs, style, refactor, perf, test, build, ci, chore) or "!" markers. If present, remove those prefixes and keep concise descriptions.',
      '--- Commit message:',
      commitMessage,
      '--- Rules (Markdown):',
      baseRulesMarkdown
    ].join('\n')
  };

	const reply = await chat([system, user], { temperature: 0 });
	const parsed = extractJson<{ status?: string; commit_message?: string; notes?: string; violations?: string[] }>(reply);
	if (parsed?.commit_message) {
		return { validMessage: parsed.commit_message, notes: parsed.notes, violations: parsed.violations };
	}
	return { validMessage: commitMessage };
}

function headerRegex(): RegExp {
	// <type>[optional scope][!]: <description>
	return /^([a-z]+)(\([A-Za-z0-9_.-]+\))?(!)?:\s[^\n\r]+$/;
}

function firstLine(text: string): string {
  const idx = text.indexOf('\n');
  return idx === -1 ? text : text.slice(0, idx);
}

function localStrictCheck(msg: string): { ok: boolean; problems: string[] } {
	const problems: string[] = [];
	const header = firstLine(msg).trim();
	if (!headerRegex().test(header)) {
		problems.push('Header must match <type>[optional scope][!]: <description>.');
	}
	if (header.length > 72) {
		problems.push('Header length must be <= 72 characters.');
	}
	return { ok: problems.length === 0, problems };
}

async function enforceStrictWithLLM(
  current: string,
  problems: string[],
  baseRulesMarkdown: string,
  chat: ChatFn
): Promise<string> {
	const system: ChatMessage = {
		role: 'system',
		content: 'Return STRICT JSON only. Fix commit message to satisfy Conventional Commits exactly.'
	};
	const user: ChatMessage = {
		role: 'user',
		content: [
			'Fix the commit message to satisfy all constraints. Output only:',
			'{"commit_message": string}',
			'Current message:',
			current,
			'Detected problems:',
			JSON.stringify(problems),
			'Rules (Markdown):',
			baseRulesMarkdown
		].join('\n')
	};
	const reply = await chat([system, user], { temperature: 0 });
	const parsed = extractJson<{ commit_message?: string }>(reply);
  return parsed?.commit_message || current;
}

function sanitizeBodyCommitTypePrefixes(message: string): string {
  const typePattern = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore)(\([^)]+\))?(!)?:\s*/i;
  const footerTokenPattern = /^(BREAKING CHANGE|[A-Za-z][A-Za-z-]+):\s/;

  const lines = message.split('\n');
  if (lines.length === 0) return message;

  // find body start: first blank line after header (line 0)
  let i = 1;
  while (i < lines.length && lines[i].trim() !== '') i++;
  if (i >= lines.length - 1) return message; // no body
  const bodyStart = i + 1;

  // find footers start: first line matching token pattern after body start
  let footersStart = lines.length;
  for (let j = bodyStart; j < lines.length; j++) {
    const l = lines[j];
    if (footerTokenPattern.test(l)) { footersStart = j; break; }
  }

  for (let j = bodyStart; j < footersStart; j++) {
    const l = lines[j];
    const m = l.match(/^\s*([-*])\s+(.*)$/);
    if (m) {
      const bullet = m[1];
      let content = m[2];
      const stripped = content.replace(typePattern, '').trim();
      if (stripped !== content) {
        lines[j] = `${bullet} ${stripped}`;
      }
    }
  }
  return lines.join('\n');
}

export async function generateCommitMessageChain(
  inputs: ChainInputs,
  chat: ChatFn,
  options?: { maxParallel?: number }
): Promise<ChainOutputs> {
  const { diffs, baseRulesMarkdown } = inputs;
  const maxParallel = options?.maxParallel ?? Math.max(4, Math.min(8, diffs.length));

	const queue = [...diffs];
	const results: FileSummary[] = [];

	async function worker() {
		while (queue.length) {
			const item = queue.shift();
			if (!item) {break;};
			const summary = await summarizeSingleFile(item, chat);
			results.push(summary);
		}
	}

  const workers = Array.from({ length: Math.min(maxParallel, diffs.length || 1) }, () => worker());
  await Promise.all(workers);

  // If user provided a template, extract a template policy first (template-first precedence)
  let templatePolicyJson = '';
  if (inputs.userTemplate && inputs.userTemplate.trim()) {
    try {
      templatePolicyJson = await extractTemplatePolicy(inputs.userTemplate, chat);
    } catch {
      templatePolicyJson = '';
    }
  }

  const { draft, notes: classificationNotes } = await classifyAndDraft(results, inputs, chat, { templatePolicyJson });
  const { validMessage, notes: validationNotes } = await validateAndFix(draft, baseRulesMarkdown, chat);

  // Local strict check; if still not conforming, ask LLM for a minimal strict fix
  let finalMessage = validMessage;
  const check = localStrictCheck(finalMessage);
  if (!check.ok) {
    finalMessage = await enforceStrictWithLLM(finalMessage, check.problems, baseRulesMarkdown, chat);
  }

  // Sanitize body: remove commit-type-like prefixes in bullets to avoid header leakage
  finalMessage = sanitizeBodyCommitTypePrefixes(finalMessage);

  return {
    commitMessage: finalMessage,
    fileSummaries: results,
    raw: {
      draft,
      classificationNotes: classificationNotes ?? '',
      validationNotes: validationNotes ?? '',
      templatePolicy: templatePolicyJson
    }
  };
}
