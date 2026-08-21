import { DiffData } from "../git/gitTypes";
import { ChatFn, ChatMessage } from "../llm/llmTypes";
import { ChainInputs, ChangeSetSummary, DraftEvidence, FileEvidence, FileSummary, ChainOutputs, RagStyleReference, RetrievalFeatures } from "./chainTypes";
import {
	buildClassifyAndDraftMessages,
	buildRagPreparationMessages,
	buildValidateAndFixMessages,
	buildEnforceStrictFixMessages,
	buildEnforceLanguageMessages,
} from "./chainChatPrompts";

import { normalizeLanguageCode, isLikelyTargetLanguage } from "./langDetector";
import { isRagPreparationEnabled, prepareRagContext } from "./ragPreparation";
import { logger } from "../logger";
import { safeRun } from "../../utils/safeRun";
import { compactEvidenceToFit, createRawDraftEvidence } from "./dynamicSummary";
import { DEFAULT_CHAIN_MAX_INPUT_TOKENS, resolveChainInputTokenBudget } from "./tokenBudget";

async function classifyAndDraft(
	evidence: DraftEvidence[],
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
	const messages = buildClassifyAndDraftMessages(evidence, inputs);
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
	options?: {
		maxParallel?: number;
		maxInputTokens?: number;
		model?: string;
		onStage?: (event: import('../../ui/StageNotificationManager').StageEvent) => void;
		retrieveRagExamples?: (context: {
			changeSetSummary: ChangeSetSummary;
			retrievalFeatures: RetrievalFeatures;
		}) => Promise<RagStyleReference[]>;
	}
): Promise<ChainOutputs> {
	const { diffs } = inputs;
	const maxParallel = options?.maxParallel ?? Math.max(4, Math.min(8, diffs.length));
	const maxInputTokens = resolveChainInputTokenBudget(
		options?.model || '',
		options?.maxInputTokens ?? DEFAULT_CHAIN_MAX_INPUT_TOKENS
	);
	let evidence = createRawDraftEvidence(diffs);
	let summaryStageStarted = false;
	let summarizedCount = 0;

	safeRun('Chain.onStage.evidenceReady', () => options?.onStage?.({
		type: 'evidenceReady',
		data: {
			fileCount: diffs.length,
			rawFiles: diffs.length,
			summarizedFiles: 0,
			maxInputTokens,
			files: diffs.map(diff => ({ file: diff.fileName, status: diff.status })),
		}
	}));

	const compactFor = async (
		target: 'ragPreparation' | 'draft',
		buildTargetMessages: (current: DraftEvidence[]) => ChatMessage[]
	) => {
		try {
			const result = await compactEvidenceToFit({
				diffs,
				evidence,
				chat,
				maxInputTokens,
				maxParallel,
				buildTargetMessages,
				onSummarizeStart: () => {
					if (!summaryStageStarted) {
						summaryStageStarted = true;
						safeRun('Chain.onStage.summarizeStart', () => options?.onStage?.({ type: 'summarizeStart' }));
					}
				},
				onFileSummarized: (file) => {
					summarizedCount += 1;
					safeRun('Chain.onStage.summarizeProgress', () => options?.onStage?.({
						type: 'summarizeProgress',
						data: {
							current: summarizedCount,
							total: diffs.length,
							file: file.fileName,
							summary: summarizeEvidenceForDisplay(file),
							breaking: file.breakingSignals.length > 0,
						}
					}));
				},
			});
			evidence = result.evidence;
			safeRun('Chain.onStage.evidenceRouted', () => options?.onStage?.({
				type: 'evidenceRouted',
				data: {
					target,
					fileCount: evidence.length,
					rawFiles: evidence.filter(item => item.kind === 'raw').length,
					summarizedFiles: evidence.filter(item => item.kind === 'summary').length,
					initialEstimatedInputTokens: result.initialEstimatedInputTokens,
					estimatedInputTokens: result.estimatedInputTokens,
					maxInputTokens,
					didSummarize: result.didSummarize,
				}
			}));
		} catch (error) {
			const errorMessage = String((error as any)?.message || error || 'Unknown error');
			logger.warn(`[Genie][Chain] Evidence compaction failed for ${target}.`, error);
			safeRun('Chain.onStage.summarizeFailed', () => options?.onStage?.({
				type: 'summarizeFailed',
				data: { target, error: errorMessage }
			}));
			throw error;
		}
	};

	let changeSetSummary: ChangeSetSummary | undefined;
	let retrievalFeatures: RetrievalFeatures | undefined;
	let ragStyleReferences: RagStyleReference[] = [];

	if (isRagPreparationEnabled()) {
		let ragEvidenceReady = false;
		try {
			await compactFor('ragPreparation', current => buildRagPreparationMessages(current));
			ragEvidenceReady = true;
		} catch {
			// compactFor already reports this as a Summary-stage failure. RAG is optional,
			// so generation can continue without misclassifying the failed prerequisite.
		}

		if (ragEvidenceReady) {
			try {
				safeRun('Chain.onStage.ragPreparationStart', () => options?.onStage?.({ type: 'ragPreparationStart' }));
				const ragContext = await prepareRagContext(diffs, evidence, chat);
				changeSetSummary = ragContext.changeSetSummary;
				retrievalFeatures = ragContext.retrievalFeatures;
				safeRun('Chain.onStage.ragPrepared', () => options?.onStage?.({
					type: 'ragPrepared',
					data: {
						changeSetSummary,
						retrievalFeatures,
					}
				}));
			} catch (error) {
				const errorMessage = String((error as any)?.message || error || 'Unknown error');
				logger.warn('[Genie][Chain] RAG preparation failed; continuing without RAG context.', error);
				safeRun('Chain.onStage.ragPreparationSkipped', () => options?.onStage?.({
					type: 'ragPreparationSkipped',
					data: { error: errorMessage }
				}));
			}
		}
	} else {
		safeRun('Chain.onStage.ragDisabled', () => options?.onStage?.({
			type: 'ragDisabled',
			data: { reason: 'disabled' }
		}));
	}

	if (changeSetSummary && retrievalFeatures && options?.retrieveRagExamples) {
		try {
			safeRun('Chain.onStage.ragRetrievalStart', () => options?.onStage?.({ type: 'ragRetrievalStart' }));
			ragStyleReferences = await options.retrieveRagExamples({ changeSetSummary, retrievalFeatures });
			safeRun('Chain.onStage.ragRetrieved', () => options?.onStage?.({
				type: 'ragRetrieved',
				data: {
					count: ragStyleReferences.length,
					messages: ragStyleReferences.map(reference => reference.message),
					references: ragStyleReferences.map(reference => ({
						message: reference.message,
						matchedBy: reference.matchedBy,
						styleReason: reference.styleReason,
						type: reference.type ?? null,
						scope: reference.scope ?? null,
					})),
				}
			}));
		} catch (error) {
			const errorMessage = String((error as any)?.message || error || 'Unknown error');
			logger.warn('[Genie][Chain] RAG retrieval failed; continuing without style references.', error);
			safeRun('Chain.onStage.ragRetrievalSkipped', () => options?.onStage?.({
				type: 'ragRetrievalSkipped',
				data: { error: errorMessage }
			}));
		}
	}

	await compactFor('draft', current => buildClassifyAndDraftMessages(current, { ...inputs, ragStyleReferences }));
	safeRun('Chain.onStage.draftStart', () => options?.onStage?.({ type: 'draftStart' }));
	const { draft, notes: classificationNotes } = await classifyAndDraft(evidence, { ...inputs, ragStyleReferences }, chat);

	safeRun('Chain.onStage.classifyDraft', () => options?.onStage?.({ type: 'classifyDraft', data: { draft } }));

	safeRun('Chain.onStage.validationStart', () => options?.onStage?.({ type: 'validationStart' }));
	const { validMessage, notes: validationNotes } = await validateAndFix(draft, inputs.validationChecklist ?? '', chat, inputs.userTemplate);
	safeRun('Chain.onStage.validateFix', () => options?.onStage?.({ type: 'validateFix', data: { validMessage } }));

	// Local strict check; if still not conforming, ask LLM for a minimal strict fix
	let finalMessage = validMessage;
	const check = localStrictCheck(finalMessage);
	if (!check.ok) {
		safeRun('Chain.onStage.strictFixStart', () => options?.onStage?.({
			type: 'strictFixStart',
			data: { problems: check.problems }
		}));
		finalMessage = await enforceStrictWithLLM(finalMessage, check.problems, chat, inputs.userTemplate);
		safeRun('Chain.onStage.strictFix', () => options?.onStage?.({ type: 'strictFix', data: { message: finalMessage } }));
	}

	// Enforce target language strictly while preserving tokens/structure
	if ((inputs.targetLanguage || '').trim()) {
		try {
			safeRun('Chain.onStage.enforceLanguageStart', () => options?.onStage?.({
				type: 'enforceLanguageStart',
				data: { targetLanguage: inputs.targetLanguage }
			}));
			const out = await enforceTargetLanguageForCommit(finalMessage, inputs.targetLanguage, chat, inputs.userTemplate);
			finalMessage = out;
			safeRun('Chain.onStage.enforceLanguage', () => options?.onStage?.({ type: 'enforceLanguage', data: { message: finalMessage } }));
		} catch (error) {
			logger.warn('[Genie][Chain] Target language enforcement failed; keeping previous message.', error);
		}
	}

	safeRun('Chain.onStage.done', () => options?.onStage?.({ type: 'done', data: { finalMessage } }));

	return {
		commitMessage: finalMessage,
		fileSummaries: toFileSummaries(evidence, diffs),
		changeSetSummary,
		retrievalFeatures,
		ragStyleReferences,
		raw: {
			draft,
			classificationNotes: classificationNotes ?? '',
			validationNotes: validationNotes ?? ''
		}
	};
}

function summarizeEvidenceForDisplay(evidence: FileEvidence): string {
	return [
		...evidence.changes.map(change => `${change.action} ${change.target}: ${change.behavior}`),
		...evidence.tests.map(test => `test: ${test.detail}`),
		...evidence.breakingSignals.map(signal => `breaking: ${signal.detail}`),
		...evidence.uncertainties.map(uncertainty => `uncertain: ${uncertainty.detail}`),
	].slice(0, 2).join('; ');
}

function toFileSummaries(evidence: DraftEvidence[], diffs: DiffData[]): FileSummary[] {
	const diffByFile = new Map(diffs.map(diff => [diff.fileName, diff]));
	return evidence.map(item => {
		if (item.kind === 'summary') {
			return {
				file: item.fileName,
				status: item.status,
				summary: summarizeEvidenceForDisplay(item),
				breaking: item.breakingSignals.length > 0,
			};
		}

		const diff = diffByFile.get(item.fileName);
		const additions = diff?.diffHunks.reduce((count, hunk) => count + hunk.additions.length, 0) ?? 0;
		const deletions = diff?.diffHunks.reduce((count, hunk) => count + hunk.deletions.length, 0) ?? 0;
		return {
			file: item.fileName,
			status: item.status,
			summary: `Raw diff retained (${additions} additions, ${deletions} deletions)`,
			breaking: false,
		};
	});
}
