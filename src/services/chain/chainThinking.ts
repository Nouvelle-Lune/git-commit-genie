import { DiffData } from "../git/gitTypes";
import { ChatFn, NormalizedLang } from "./chainTypes";
import { ChainInputs, FileSummary, ChainOutputs } from "./chainTypes";
import {
	buildPolicyExtractionMessages,
	buildSummarizeFileMessages,
	buildClassifyAndDraftMessages,
	buildValidateAndFixMessages,
	buildEnforceStrictFixMessages,
	buildEnforceLanguageMessages,
} from "./chainChatPrompts";

function isValidPolicyShape(obj: any): boolean {
	if (!obj || typeof obj !== 'object') { return false; }
	const keys = Object.keys(obj);
	if (!keys.length) { return false; }
	// Accept if any known section exists or if it has at least one key with object/array value
	if (['header', 'body', 'footers', 'lexicon'].some(k => k in obj)) { return true; }
	return keys.some(k => typeof (obj as any)[k] === 'object');
}

async function extractTemplatePolicy(userTemplate: string, chat: ChatFn): Promise<string> {
	if (!userTemplate || !userTemplate.trim()) { return ''; }
	const messages = buildPolicyExtractionMessages(userTemplate);
	const reply = await chat(messages, { temperature: 0 });
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

function extractJson<T = any>(text: string): T | null {
	if (!text) { return null; }
	const trimmed = text.trim();
	try {
		return JSON.parse(trimmed) as T;
	} catch { }
	const start = trimmed.indexOf('{');
	const end = trimmed.lastIndexOf('}');
	if (start !== -1 && end !== -1 && end > start) {
		const slice = trimmed.slice(start, end + 1);
		try {
			return JSON.parse(slice) as T;
		} catch { }
	}
	return null;
}

async function summarizeSingleFile(diff: DiffData, chat: ChatFn): Promise<FileSummary> {
	const messages = buildSummarizeFileMessages(diff);
	const reply = await chat(messages, { temperature: 0 });
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
	const templatePolicyJson = opts?.templatePolicyJson ?? '';
	const messages = buildClassifyAndDraftMessages(summaries, inputs, templatePolicyJson);
	const reply = await chat(messages, { temperature: 0 });
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
	const messages = buildValidateAndFixMessages(commitMessage, baseRulesMarkdown);
	const reply = await chat(messages, { temperature: 0 });
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
	const messages = buildEnforceStrictFixMessages(current, problems, baseRulesMarkdown);
	const reply = await chat(messages, { temperature: 0 });
	const parsed = extractJson<{ commit_message?: string }>(reply);
	return parsed?.commit_message || current;
}

function sanitizeBodyCommitTypePrefixes(message: string): string {
	const typePattern = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore)(\([^)]+\))?(!)?:\s*/i;
	const footerTokenPattern = /^(BREAKING CHANGE|[A-Za-z][A-Za-z-]+):\s/;

	const lines = message.split('\n');
	if (lines.length === 0) { return message; }

	// find body start: first blank line after header (line 0)
	let i = 1;
	while (i < lines.length && lines[i].trim() !== '') { i++; }
	if (i >= lines.length - 1) { return message; } // no body
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

async function enforceTargetLanguageForCommit(
	commitMessage: string,
	targetLanguage: string | undefined,
	chat: ChatFn
): Promise<string> {
	const lang = (targetLanguage || '').trim();
	if (!lang) { return commitMessage; }

	// 1) Quick heuristic: if the narrative text already matches target language, skip LLM
	const normalized = normalizeLanguageCode(lang);
	if (normalized !== 'other') {
		const narrative = extractNarrativeTextForLanguageCheck(commitMessage);
		const verdict = isLikelyTargetLanguage(narrative, normalized);
		if (verdict === 'yes') {
			return commitMessage;
		}
		// If verdict is 'no' or 'uncertain', fall through to model-based enforcement.
	}
	try {
		const messages = buildEnforceLanguageMessages(commitMessage, lang);
		const reply = await chat(messages, { temperature: 0 });
		const parsed = extractJson<{ commit_message?: string }>(reply);
		return parsed?.commit_message?.trim() || commitMessage;
	} catch {
		return commitMessage;
	}
}

// --- language detection ---

function normalizeLanguageCode(input: string): NormalizedLang {
	const t = (input || '').trim().toLowerCase();
	if (!t) { return 'other'; }
	// English
	if (['en', 'en-us', 'en-gb', 'english', 'eng', '英语', '英文'].includes(t)) { return 'en'; }
	// Chinese (treat simplified/traditional the same for detection)
	if ([
		'zh', 'zh-cn', 'zh-sg', 'zh-hans', 'zh-hant', 'zh-tw', 'zh-hk',
		'chinese', 'zhongwen', '中文', '简体中文', '繁體中文', '漢語', '汉语', '華語', '华语'
	].includes(t)) { return 'zh'; }
	// Japanese
	if (['ja', 'ja-jp', 'japanese', '日本語', 'にほんご', '日语', '日文'].includes(t)) { return 'ja'; }
	// Korean
	if (['ko', 'ko-kr', 'korean', '한국어', '한글', '韓國語', '韩语', '韓文', '朝鲜语'].includes(t)) { return 'ko'; }
	return 'other';
}

function extractNarrativeTextForLanguageCheck(message: string): string {
	if (!message) { return ''; }
	const lines = message.split('\n');
	if (lines.length === 0) { return ''; }

	const header = lines[0] || '';
	const colonIdx = header.indexOf(':');
	const desc = colonIdx !== -1 ? header.slice(colonIdx + 1).trim() : header.trim();

	// Find body start: first blank line after header
	let i = 1;
	while (i < lines.length && lines[i].trim() !== '') { i++; }
	const bodyStart = i + 1;

	// Find footers start: first token-like footer (BREAKING CHANGE or Token: value)
	const footerTokenPattern = /^(BREAKING CHANGE|[A-Za-z][A-Za-z-]+):\s/;
	let footersStart = lines.length;
	for (let j = bodyStart; j < lines.length; j++) {
		if (footerTokenPattern.test(lines[j])) { footersStart = j; break; }
	}

	const bodyLines: string[] = [];
	for (let j = bodyStart; j < footersStart; j++) {
		const l = lines[j];
		// strip common bullet prefixes
		const m = l.match(/^\s*([-*])\s+(.*)$/);
		bodyLines.push(m ? m[2] : l);
	}

	return [desc, ...bodyLines].join(' ').trim();
}

function isLikelyTargetLanguage(text: string, target: NormalizedLang): 'yes' | 'no' | 'uncertain' {
	const scores = countScripts(text);

	// Total letters seen (approximate narrative signal)
	const totalSignal = scores.asciiLetters + scores.cjk + scores.hiragana + scores.katakana + scores.hangul;
	if (totalSignal === 0) { return 'uncertain'; }

	switch (target) {
		case 'en': {
			const nonLatin = scores.cjk + scores.hiragana + scores.katakana + scores.hangul;
			if (nonLatin === 0) { return 'yes'; }
			if (nonLatin > 0 && scores.asciiLetters === 0) { return 'no'; }
			return 'uncertain';
		}
		case 'zh': {
			// Favor CJK without kana/hangul; allow some ASCII for code/tokens
			const kanaHangul = scores.hiragana + scores.katakana + scores.hangul;
			if (scores.cjk >= 4 && kanaHangul === 0) { return 'yes'; }
			if (scores.cjk >= 2 && scores.cjk >= scores.asciiLetters) { return 'yes'; }
			if (scores.cjk === 0 && (scores.hiragana + scores.katakana + scores.hangul) > 0) { return 'no'; }
			if (scores.cjk === 0 && scores.asciiLetters > 0) { return 'uncertain'; }
			return 'uncertain';
		}
		case 'ja': {
			// Presence of kana is a strong indicator
			if ((scores.hiragana + scores.katakana) >= 2) { return 'yes'; }
			if (scores.cjk >= 2 && (scores.hiragana + scores.katakana) >= 1) { return 'yes'; }
			if ((scores.hiragana + scores.katakana + scores.hangul) === 0 && scores.asciiLetters > 0) { return 'no'; }
			return 'uncertain';
		}
		case 'ko': {
			if (scores.hangul >= 2) { return 'yes'; }
			if (scores.hangul === 0 && (scores.hiragana + scores.katakana + scores.cjk) > 0) { return 'no'; }
			return 'uncertain';
		}
		default:
			return 'uncertain';
	}
}

function countScripts(text: string): {
	asciiLetters: number;
	cjk: number;
	hiragana: number;
	katakana: number;
	hangul: number;
} {
	let asciiLetters = 0;
	let cjk = 0;
	let hiragana = 0;
	let katakana = 0;
	let hangul = 0;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const code = ch.charCodeAt(0);
		// ASCII letters
		if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) { asciiLetters++; continue; }
		// CJK Unified Ideographs + Ext A + Compatibility Ideographs (BMP ranges)
		if (
			(code >= 0x3400 && code <= 0x4DBF) ||
			(code >= 0x4E00 && code <= 0x9FFF) ||
			(code >= 0xF900 && code <= 0xFAFF)
		) { cjk++; continue; }
		// Hiragana
		if (code >= 0x3040 && code <= 0x309F) { hiragana++; continue; }
		// Katakana (including Phonetic Extensions)
		if ((code >= 0x30A0 && code <= 0x30FF) || (code >= 0x31F0 && code <= 0x31FF)) { katakana++; continue; }
		// Hangul (Jamo + Syllables + Compatibility Jamo)
		if ((code >= 0x1100 && code <= 0x11FF) || (code >= 0x3130 && code <= 0x318F) || (code >= 0xAC00 && code <= 0xD7AF)) { hangul++; continue; }
	}
	return { asciiLetters, cjk, hiragana, katakana, hangul };
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
			if (!item) { break; };
			const summary = await summarizeSingleFile(item, chat);
			results.push(summary);
		}
	}

	const workers = Array.from({ length: Math.min(maxParallel, diffs.length || 1) }, () => worker());

	// Waiting for all workers to complete
	await Promise.all(workers);

	// If user provided a template, extract a template policy first (template-first precedence)
	// TODO: Support different template in different repo (monorepo)
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

	// Enforce target language strictly while preserving tokens/structure
	try {
		finalMessage = await enforceTargetLanguageForCommit(finalMessage, inputs.targetLanguage, chat);
	} catch {
		// ignore
	}

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
