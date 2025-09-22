import { DiffData } from "../git/gitTypes";
import { ChatFn } from "./chainTypes";
import { ChainInputs, FileSummary, ChainOutputs } from "./chainTypes";
import {
	buildPolicyExtractionMessages,
	buildSummarizeFileMessages,
	buildClassifyAndDraftMessages,
	buildValidateAndFixMessages,
	buildEnforceStrictFixMessages,
	buildEnforceLanguageMessages,
} from "./chainChatPrompts";

import { normalizeLanguageCode, extractNarrativeTextForLanguageCheck, isLikelyTargetLanguage } from "./langDetector";

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
	chat: ChatFn,
	opts?: { templatePolicyJson?: string }
): Promise<{ validMessage: string; notes?: string; violations?: string[] }> {
	const messages = buildValidateAndFixMessages(commitMessage, baseRulesMarkdown, opts?.templatePolicyJson);
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
	const { validMessage, notes: validationNotes } = await validateAndFix(draft, baseRulesMarkdown, chat, { templatePolicyJson });

	// Local strict check; if still not conforming, ask LLM for a minimal strict fix
	let finalMessage = validMessage;
	const check = localStrictCheck(finalMessage);
	if (!check.ok) {
		finalMessage = await enforceStrictWithLLM(finalMessage, check.problems, baseRulesMarkdown, chat);
	}

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
