import { DiffData } from "../git/gitTypes";
import { ChatFn } from "../llm/llmTypes";
import { ChainInputs, FileSummary, ChainOutputs } from "./chainTypes";
import {
	buildSummarizeFileMessages,
	buildClassifyAndDraftMessages,
	buildValidateAndFixMessages,
	buildEnforceStrictFixMessages,
	buildEnforceLanguageMessages,
} from "./chainChatPrompts";

import { normalizeLanguageCode, extractNarrativeTextForLanguageCheck, isLikelyTargetLanguage } from "./langDetector";


async function summarizeSingleFile(diff: DiffData, chat: ChatFn): Promise<FileSummary> {
	const messages = buildSummarizeFileMessages(diff);
    const parsed = await chat(messages, { requestType: 'summary' });

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
	chat: ChatFn
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
	const messages = buildClassifyAndDraftMessages(summaries, inputs);
    const parsed = await chat(messages, { requestType: 'draft' });

	let draft = parsed?.commitMessage || '';
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
    checklistText: string,
    chat: ChatFn,
    userTemplate?: string
): Promise<{ validMessage: string; notes?: string; violations?: string[] }> {
	const messages = buildValidateAndFixMessages(commitMessage, checklistText, userTemplate);
    const parsed = await chat(messages, { requestType: 'fix' });

	if (parsed?.status === 'fixed') {
		return { validMessage: parsed.commitMessage, notes: parsed.notes, violations: parsed.violations };
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
    chat: ChatFn,
    userTemplate?: string
): Promise<string> {
    const messages = buildEnforceStrictFixMessages(current, problems, userTemplate);
    const parsed = await chat(messages, { requestType: 'strictFix' });
    return parsed?.commitMessage || current;
}


async function enforceTargetLanguageForCommit(
	commitMessage: string,
	targetLanguage: string | undefined,
	chat: ChatFn,
	userTemplate?: string
): Promise<string> {
	const lang = (targetLanguage || '').trim();
	if (!lang) { return commitMessage; }

	// 1) Quick heuristic: check if the commit message matches target language
	const normalized = normalizeLanguageCode(lang);
	if (normalized !== 'other') {
		// Extract header description and body separately for more precise language checking
		const lines = commitMessage.split('\n');
		const header = lines[0] || '';
		const colonIdx = header.indexOf(':');
		const headerDescription = colonIdx !== -1 ? header.slice(colonIdx + 1).trim() : header.trim();

		// Find body content (skip empty lines after header)
		let bodyStartIdx = 1;
		while (bodyStartIdx < lines.length && lines[bodyStartIdx].trim() === '') {
			bodyStartIdx++;
		}
		const bodyLines = lines.slice(bodyStartIdx);
		const bodyContent = bodyLines.join(' ').trim();

		// Priority check: header description must match target language
		const headerVerdict = isLikelyTargetLanguage(headerDescription, normalized);
		if (headerVerdict === 'no') {
			// Header doesn't match target language, force conversion
		} else if (headerVerdict === 'yes') {
			// Header matches, check body if exists
			if (!bodyContent) {
				// No body, header is good
				return commitMessage;
			}
			const bodyVerdict = isLikelyTargetLanguage(bodyContent, normalized);
			if (bodyVerdict === 'yes') {
				// Both header and body match target language
				return commitMessage;
			}
			// Body doesn't match, fall through to LLM enforcement
		}
		// If header is 'uncertain' or body check failed, fall through to model-based enforcement
	}

	try {
		const messages = buildEnforceLanguageMessages(commitMessage, lang, userTemplate);
        const parsed = await chat(messages, { requestType: 'enforceLanguage' });
		return parsed?.commitMessage?.trim() || commitMessage;
	} catch (error) {
		return commitMessage;
	}
}


export async function generateCommitMessageChain(
    inputs: ChainInputs,
    chat: ChatFn,
    options?: { maxParallel?: number; onStage?: (event: { type: string; data?: any }) => void }
): Promise<ChainOutputs> {
    const { diffs } = inputs;
	const maxParallel = options?.maxParallel ?? Math.max(4, Math.min(8, diffs.length));

	const queue = [...diffs];
	const results: FileSummary[] = [];

    // Notify: summarizing has started
    try { options?.onStage?.({ type: 'summarizeStart' }); } catch { /* ignore */ }

	async function worker() {
		while (queue.length) {
			const item = queue.shift();
			if (!item) { break; };
			const summary = await summarizeSingleFile(item, chat);
			results.push(summary);
            // progress update
            try { options?.onStage?.({ type: 'summarizeProgress', data: { current: results.length, total: diffs.length } }); } catch { /* ignore */ }
		}
	}

	const workers = Array.from({ length: Math.min(maxParallel, diffs.length || 1) }, () => worker());

	// Waiting for all workers to complete
	await Promise.all(workers);

	const { draft, notes: classificationNotes } = await classifyAndDraft(results, inputs, chat);
    try { options?.onStage?.({ type: 'classifyDraft' }); } catch { /* ignore */ }
	const { validMessage, notes: validationNotes } = await validateAndFix(draft, inputs.validationChecklist ?? '', chat, inputs.userTemplate);
    try { options?.onStage?.({ type: 'validateFix' }); } catch { /* ignore */ }

	// Local strict check; if still not conforming, ask LLM for a minimal strict fix
	let finalMessage = validMessage;
	const check = localStrictCheck(finalMessage);
    if (!check.ok) {
        try { options?.onStage?.({ type: 'strictFix' }); } catch { /* ignore */ }
        finalMessage = await enforceStrictWithLLM(finalMessage, check.problems, chat, inputs.userTemplate);
    }

	// Enforce target language strictly while preserving tokens/structure
    try {
        if ((inputs.targetLanguage || '').trim()) {
            try { options?.onStage?.({ type: 'enforceLanguage' }); } catch { /* ignore */ }
        }
		finalMessage = await enforceTargetLanguageForCommit(finalMessage, inputs.targetLanguage, chat, inputs.userTemplate);
	} catch (error) {
		// ignore
	}

	try { options?.onStage?.({ type: 'done' }); } catch { /* ignore */ }

	return {
		commitMessage: finalMessage,
		fileSummaries: results,
		raw: {
			draft,
			classificationNotes: classificationNotes ?? '',
			validationNotes: validationNotes ?? ''
		}
	};
}
