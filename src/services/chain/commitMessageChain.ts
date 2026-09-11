import { LLMExecution } from "../llm/llmTypes";
import { AIMessage } from "../llm/providers";
import { ChainInputs, ChangeSetSummary, ChainOutputs, RagRetrievalQuery, RagStyleReference, RetrievalFeatures } from "./types";
import { DraftEvidence, SelectedSemanticInformation } from "../analysis/change/types";

import { enforceCommitLanguage } from "./validation/languageValidation";
import { buildSelectionRagContext, isRagEnabled } from "./rag/selectionQuery";
import { logger } from "../logger";
import { safeRun } from "../../utils/safeRun";
import {
	compactEvidenceToFit,
	createRawDraftEvidence,
	createSummaryTaskScheduler,
} from "./evidence/compaction";
import { ChainTokenBudget, estimateChatMessagesTokens, isContextWindowFailure } from "../llm/inputTokenBudget";
import { buildChangeConditionedDraftMessages } from "./generation/prompts";
import { InvestigationSettings } from "../analysis/change/investigation/config";
import { runChangeAnalysisPipeline } from "../analysis/change/pipeline";
import { generateDraft } from "./generation/draft";
import {
	checkConventionalCommitHeader,
	validateAndFixCommit,
} from "./validation/commitValidation";
import { buildFileSummaries, summarizeFileEvidenceForDisplay } from "./evidence/fileSummaries";
import { EvidenceLedger } from "../../agent/evidenceLedger";

type FixerStage = 'validateFix' | 'enforceLanguage';

interface FixerFailure {
	stage: FixerStage;
	error: string;
	retainedMessage: string;
	remainingViolations?: string[];
}

function fixerErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function appendValidationNote(existing: string | undefined, note: string): string {
	return [existing, note].filter(Boolean).join(' | ');
}


export async function generateCommitMessageChain(
	inputs: ChainInputs,
	execution: LLMExecution,
	options?: {
		maxParallel?: number;
		maxRetries?: number;
		tokenBudget?: ChainTokenBudget;
		/** Overrides the configured investigation limits; used by tests and benchmarks. */
		investigation?: Partial<InvestigationSettings>;
		onStage?: (event: import('../../ui/StageNotificationManager').StageEvent) => void;
		retrieveRagExamples?: (query: RagRetrievalQuery) => Promise<RagStyleReference[]>;
	}
): Promise<ChainOutputs> {
	const { diffs } = inputs;
	const timings: Partial<ChainOutputs['timings']> & { chainStart: number } = {
		chainStart: Date.now(),
	};
	const maxParallel = options?.maxParallel ?? Math.max(4, Math.min(8, diffs.length));
	const maxRetries = options?.maxRetries ?? 2;
	const tokenBudget = options?.tokenBudget ?? execution.tokenBudget;
	const maxInputTokens = tokenBudget.compressionTargetTokens;
	const evidenceLedger = EvidenceLedger.fromDiffs(diffs);
	const analysisEvidence = { current: createRawDraftEvidence(diffs, evidenceLedger) };
	const initialRawEvidenceTokens = estimateChatMessagesTokens([{
		role: 'user',
		content: JSON.stringify(analysisEvidence.current),
	}]);
	let summaryStageStarted = false;
	let summarizedCount = 0;
	const summarizedFiles = new Set<string>();
	const summaryStore = new Map<string, Promise<Extract<DraftEvidence, { kind: 'summary' }>>>();
	const summaryScheduler = createSummaryTaskScheduler(maxParallel);

	safeRun('Chain.onStage.evidenceReady', () => options?.onStage?.({
		type: 'evidenceReady',
		data: {
			fileCount: diffs.length,
			rawFiles: diffs.length,
			summarizedFiles: 0,
			maxInputTokens,
			initialEstimatedInputTokens: initialRawEvidenceTokens,
			contextWindowTokens: tokenBudget.effectiveContextTokens,
			hardInputTokens: tokenBudget.hardInputTokens,
			compressionTriggerTokens: tokenBudget.compressionTriggerTokens,
			maxOutputTokens: tokenBudget.maxOutputTokens,
			safetyTokens: tokenBudget.safetyTokens,
			files: diffs.map(diff => ({ file: diff.fileName, status: diff.status })),
		},
		rawData: {
			output: {
				evidence: analysisEvidence.current,
				tokenBudget,
			},
		},
	}));

	const createCompactFor = (branch: { current: DraftEvidence[] }) => async (
		target: 'draft',
		buildTargetMessages: (current: DraftEvidence[]) => AIMessage[],
		force = false,
	): Promise<void> => {
		const evidenceBefore = branch.current;
		try {
			const currentTokens = estimateChatMessagesTokens(buildTargetMessages(branch.current));
			const forcedTarget = Math.max(1, Math.floor(currentTokens * 0.8));
			const triggerInputTokens = force
				? Math.min(tokenBudget.compressionTargetTokens, forcedTarget)
				: tokenBudget.compressionTriggerTokens;
			const targetInputTokens = force
				? Math.max(1, Math.floor(triggerInputTokens * 0.9))
				: tokenBudget.compressionTargetTokens;
			const result = await compactEvidenceToFit({
				diffs,
				evidence: branch.current,
				ledger: evidenceLedger,
				summaryStore,
				summaryScheduler,
				execution,
				triggerInputTokens,
				targetInputTokens,
				hardInputTokens: tokenBudget.hardInputTokens,
				maxParallel,
				maxRetries,
				buildTargetMessages,
				onSummarizeStart: () => {
					if (!summaryStageStarted) {
						summaryStageStarted = true;
						safeRun('Chain.onStage.summarizeStart', () => options?.onStage?.({
							type: 'summarizeStart',
							rawData: { input: { target, evidence: evidenceBefore } },
						}));
					}
				},
				onFileSummarized: (file) => {
					if (summarizedFiles.has(file.fileName)) {
						return;
					}
					summarizedFiles.add(file.fileName);
					summarizedCount = summarizedFiles.size;
					safeRun('Chain.onStage.summarizeProgress', () => options?.onStage?.({
						type: 'summarizeProgress',
						data: {
							current: summarizedCount,
							total: diffs.length,
							file: file.fileName,
							summary: summarizeFileEvidenceForDisplay(file),
							breaking: file.breakingSignals.length > 0,
						},
						rawData: {
							input: { diff: diffs.find(diff => diff.fileName === file.fileName) },
							output: file,
						},
					}));
				},
			});
			branch.current = result.evidence;
			safeRun('Chain.onStage.evidenceRouted', () => options?.onStage?.({
				type: 'evidenceRouted',
				data: {
					target,
					fileCount: branch.current.length,
					rawFiles: branch.current.filter(item => item.kind === 'raw').length,
					summarizedFiles: branch.current.filter(item => item.kind === 'summary').length,
					initialEstimatedInputTokens: result.initialEstimatedInputTokens,
					estimatedInputTokens: result.estimatedInputTokens,
					maxInputTokens,
					hardInputTokens: tokenBudget.hardInputTokens,
					contextWindowTokens: tokenBudget.effectiveContextTokens,
					didSummarize: result.didSummarize,
					forced: force,
				},
				rawData: {
					input: { target, evidence: evidenceBefore, force },
					output: {
						evidence: branch.current,
						initialEstimatedInputTokens: result.initialEstimatedInputTokens,
						estimatedInputTokens: result.estimatedInputTokens,
						didSummarize: result.didSummarize,
					},
				},
			}));
		} catch (error) {
			const errorMessage = String((error as any)?.message || error || 'Unknown error');
			logger.warn(`[Genie][Chain] Evidence compaction failed for ${target}.`, error);
			safeRun('Chain.onStage.summarizeFailed', () => options?.onStage?.({
				type: 'summarizeFailed',
				data: { target, error: errorMessage },
				rawData: {
					input: { target, evidence: evidenceBefore, force },
					output: { error: errorMessage },
				},
			}));
			throw error;
		}
	};
	const compactFor = createCompactFor(analysisEvidence);

	// Stages 1-5 of the change-conditioned chain. Their only product is the
	// compact selected-information payload; the investigation trajectory itself
	// never reaches the generator.
	const trace = await runChangeAnalysisPipeline({
		diffs,
		inputs,
		execution,
		getEvidence: () => analysisEvidence.current,
		investigationOverrides: options?.investigation,
		evidenceLedger,
		onStage: options?.onStage,
		onAgentMilestone: (milestone, timestamp) => {
			if (milestone === 'start') {
				timings.agentStart = timestamp;
			} else {
				timings.agentTerminal = timestamp;
			}
		},
	});

	const { changeSetSummary, retrievalFeatures, ragStyleReferences } = await runRagBranch(
		trace.selectedInformation,
	);

	const buildDraftMessages = (current: DraftEvidence[]): AIMessage[] =>
		buildChangeConditionedDraftMessages({
			selected: trace.selectedInformation,
			evidencePayload: current,
			inputs,
			ragStyleReferences,
		});

	await compactFor('draft', buildDraftMessages);
	timings.draftStart = Date.now();
	safeRun('Chain.onStage.draftStart', () => options?.onStage?.({
		type: 'draftStart',
		rawData: {
			input: {
				selectedInformation: trace.selectedInformation,
				evidence: analysisEvidence.current,
				ragStyleReferences,
				currentTime: inputs.currentTime,
				targetLanguage: inputs.targetLanguage,
				userTemplate: inputs.userTemplate,
			},
		},
	}));
	let generatedDraft: Awaited<ReturnType<typeof generateDraft>>;
	try {
		generatedDraft = await generateDraft(buildDraftMessages(analysisEvidence.current), execution);
	} catch (error) {
		if (!isContextWindowFailure(error)) {
			throw error;
		}
		await compactFor('draft', buildDraftMessages, true);
		generatedDraft = await generateDraft(buildDraftMessages(analysisEvidence.current), execution);
	}
	const { draft, notes: classificationNotes } = generatedDraft;
	timings.draftReady = Date.now();

	safeRun('Chain.onStage.classifyDraft', () => options?.onStage?.({
		type: 'classifyDraft',
		data: { draft },
		rawData: { output: generatedDraft },
	}));

	const factContext = {
		requiredFacts: trace.agentClaims
			.filter(claim => claim.disposition === 'must_express' && trace.selectedInformation.mustExpress.includes(claim.claim))
			.map(claim => ({ id: claim.id, text: claim.claim })),
		optionalFacts: trace.agentClaims
			.filter(claim => claim.disposition === 'optional' && trace.selectedInformation.optional.includes(claim.claim))
			.map(claim => ({ id: claim.id, text: claim.claim })),
	};
	safeRun('Chain.onStage.validationStart', () => options?.onStage?.({
		type: 'validationStart',
		rawData: {
			input: {
				draft,
				validationChecklist: inputs.validationChecklist ?? '',
				userTemplate: inputs.userTemplate,
				factContext,
			},
		},
	}));
	let finalMessage = draft;
	let validationNotes: string | undefined;
	let preservedFactIds: string[] | undefined;
	let retainedInputByFixer = false;
	const fixerFailures: FixerFailure[] = [];

	// Fixers are quality improvements, not chain prerequisites. Keep the complete
	// message that entered a failed fixer so a provider/protocol/fact-binding
	// failure cannot discard the only real output or block later stages.
	const validationInput = finalMessage;
	let validationError: string | undefined;
	try {
		const validationResult = await validateAndFixCommit(
			validationInput,
			inputs.validationChecklist ?? '',
			execution,
			inputs.userTemplate,
			factContext,
		);
		finalMessage = validationResult.validMessage;
		validationNotes = validationResult.notes;
		preservedFactIds = validationResult.preservedFactIds;
	} catch (error) {
		if (execution.signal?.aborted) {
			throw error;
		}
		validationError = fixerErrorMessage(error);
		finalMessage = validationInput;
		retainedInputByFixer = true;
		validationNotes = appendValidationNote(validationNotes, `validateFix failed; retained input: ${validationError}`);
		fixerFailures.push({ stage: 'validateFix', error: validationError, retainedMessage: validationInput });
		logger.warn(`[Genie][Chain] validateFix failed after retries; retaining input and continuing. error=${validationError}`);
	}

	let formatCheck = checkConventionalCommitHeader(finalMessage);
	safeRun('Chain.onStage.validateFix', () => options?.onStage?.({
		type: 'validateFix',
		data: {
			validMessage: finalMessage,
			retainedInput: Boolean(validationError),
			...(validationError ? { error: validationError } : {}),
			remainingViolations: formatCheck.problems,
		},
		rawData: {
			input: { message: validationInput, validationChecklist: inputs.validationChecklist ?? '', userTemplate: inputs.userTemplate, factContext },
			output: {
				validMessage: finalMessage,
				validationNotes,
				preservedFactIds,
				retainedInput: Boolean(validationError),
				...(validationError ? { error: validationError } : {}),
				remainingViolations: formatCheck.problems,
			},
		},
	}));

	// Reuse the fact-aware validator for any remaining format violation. A second
	// request is bounded by the same execution retry policy and receives the full
	// semantic contract, so no blind whole-message fixer can erase the body. Its
	// failure has the same non-blocking retention semantics as the first fixer.
	if (!formatCheck.ok) {
		const formatFixInput = finalMessage;
		const formatViolationsBeforeFix = formatCheck.problems;
		let formatFixError: string | undefined;
		try {
			const repaired = await validateAndFixCommit(
				formatFixInput,
				[inputs.validationChecklist ?? '', ...formatCheck.problems].filter(Boolean).join('\n'),
				execution,
				inputs.userTemplate,
				factContext,
			);
			finalMessage = repaired.validMessage;
			preservedFactIds = repaired.preservedFactIds;
			validationNotes = appendValidationNote(validationNotes, repaired.notes ?? '');
		} catch (error) {
			if (execution.signal?.aborted) {
				throw error;
			}
			formatFixError = fixerErrorMessage(error);
			finalMessage = formatFixInput;
			retainedInputByFixer = true;
			validationNotes = appendValidationNote(validationNotes, `validateFix format repair failed; retained input: ${formatFixError}`);
			fixerFailures.push({
				stage: 'validateFix',
				error: formatFixError,
				retainedMessage: formatFixInput,
				remainingViolations: formatViolationsBeforeFix,
			});
			logger.warn(`[Genie][Chain] validateFix format repair failed after retries; retaining input and continuing. error=${formatFixError}`);
		}
		formatCheck = checkConventionalCommitHeader(finalMessage);
		safeRun('Chain.onStage.validateFix.formatRepair', () => options?.onStage?.({
			type: 'validateFix',
			data: {
				validMessage: finalMessage,
				retainedInput: Boolean(formatFixError),
				...(formatFixError ? { error: formatFixError } : {}),
				remainingViolations: formatCheck.problems,
			},
			rawData: {
				input: { message: formatFixInput, validationChecklist: inputs.validationChecklist ?? '', userTemplate: inputs.userTemplate, factContext, remainingViolations: formatViolationsBeforeFix },
				output: {
					validMessage: finalMessage,
					validationNotes,
					preservedFactIds,
					retainedInput: Boolean(formatFixError),
					...(formatFixError ? { error: formatFixError } : {}),
					remainingViolations: formatCheck.problems,
				},
			},
		}));
	}

	// Enforce target language strictly while preserving tokens/structure. This is
	// also a fixer: a failed request retains its input, except cancellation must
	// still abort the operation instead of being reported as a successful chain.
	if ((inputs.targetLanguage || '').trim()) {
		safeRun('Chain.onStage.enforceLanguageStart', () => options?.onStage?.({
			type: 'enforceLanguageStart',
			data: { targetLanguage: inputs.targetLanguage },
			rawData: {
				input: {
					message: finalMessage,
					targetLanguage: inputs.targetLanguage,
					userTemplate: inputs.userTemplate,
				},
			},
		}));
		const languageInput = finalMessage;
		let languageError: string | undefined;
		try {
			finalMessage = await enforceCommitLanguage(languageInput, inputs.targetLanguage, execution, inputs.userTemplate, factContext);
		} catch (error) {
			if (execution.signal?.aborted) {
				throw error;
			}
			languageError = fixerErrorMessage(error);
			finalMessage = languageInput;
			retainedInputByFixer = true;
			validationNotes = appendValidationNote(validationNotes, `enforceLanguage failed; retained input: ${languageError}`);
			fixerFailures.push({ stage: 'enforceLanguage', error: languageError, retainedMessage: languageInput });
			logger.warn(`[Genie][Chain] enforceLanguage failed after retries; retaining input and continuing. error=${languageError}`);
		}
		formatCheck = checkConventionalCommitHeader(finalMessage);
		safeRun('Chain.onStage.enforceLanguage', () => options?.onStage?.({
			type: 'enforceLanguage',
			data: {
				message: finalMessage,
				retainedInput: Boolean(languageError),
				...(languageError ? { error: languageError } : {}),
				remainingViolations: formatCheck.problems,
			},
			rawData: {
				input: { message: languageInput, targetLanguage: inputs.targetLanguage, userTemplate: inputs.userTemplate, factContext },
				output: {
					message: finalMessage,
					retainedInput: Boolean(languageError),
					...(languageError ? { error: languageError } : {}),
					remainingViolations: formatCheck.problems,
				},
			},
		}));
	}

	// The final deterministic check is diagnostic only. Never rewrite, truncate,
	// synthesize, or throw here: the last real message is the chain's output even
	// when a fixer could not satisfy Conventional Commit formatting.
	const finalCheck = checkConventionalCommitHeader(finalMessage);
	if (!finalCheck.ok) {
		validationNotes = appendValidationNote(validationNotes, `Final format check found remaining violations: ${finalCheck.problems.join(' | ')}`);
		logger.warn(`[Genie][Chain] Final Conventional Commit check found remaining violations; returning the last real message. violations=${finalCheck.problems.join(' | ')}`);
	}

	safeRun('Chain.onStage.done', () => options?.onStage?.({
		type: 'done',
		data: {
			finalMessage,
			retainedInput: retainedInputByFixer,
			remainingViolations: finalCheck.problems,
			...(validationNotes ? { validationNotes } : {}),
		},
		rawData: {
			output: {
				finalMessage,
				retainedInput: retainedInputByFixer,
				remainingViolations: finalCheck.problems,
				validationNotes,
				fixerFailures,
			},
		},
	}));

	return {
		commitMessage: finalMessage,
		fileSummaries: buildFileSummaries(analysisEvidence.current, diffs),
		changeSetSummary,
		retrievalFeatures,
		ragStyleReferences,
		changeAnalysis: trace,
		timings: {
			chainStart: timings.chainStart,
			agentStart: timings.agentStart,
			agentTerminal: timings.agentTerminal,
			ragReady: timings.ragReady,
			draftStart: timings.draftStart!,
			draftReady: timings.draftReady!,
			ttdMs: timings.draftReady! - timings.chainStart,
		},
		raw: {
			draft,
			classificationNotes: classificationNotes ?? '',
			validationNotes: validationNotes ?? ''
		}
	};

	async function runRagBranch(
		selected: SelectedSemanticInformation,
	): Promise<{
		changeSetSummary?: ChangeSetSummary;
		retrievalFeatures?: RetrievalFeatures;
		ragStyleReferences: RagStyleReference[];
	}> {
		if (!isRagEnabled()) {
			safeRun('Chain.onStage.ragDisabled', () => options?.onStage?.({
				type: 'ragDisabled',
				data: { reason: 'disabled' },
				rawData: { input: { selectedInformation: selected } },
			}));
			timings.ragReady = Date.now();
			return { ragStyleReferences: [] };
		}

		const context = buildSelectionRagContext(selected, diffs);
		safeRun('Chain.onStage.ragPrepared', () => options?.onStage?.({
			type: 'ragPrepared',
			data: {
				query: context.query,
				changeSetSummary: context.changeSetSummary,
				retrievalFeatures: context.retrievalFeatures,
			},
			rawData: {
				input: { selectedInformation: selected },
				output: context,
			},
		}));

		let references: RagStyleReference[] = [];
		try {
			if (options?.retrieveRagExamples) {
				safeRun('Chain.onStage.ragRetrievalStart', () => options.onStage?.({
					type: 'ragRetrievalStart',
					rawData: { input: { query: context.query } },
				}));
				references = await options.retrieveRagExamples(context.query);
			}
			safeRun('Chain.onStage.ragRetrieved', () => options?.onStage?.({
				type: 'ragRetrieved',
				data: {
					count: references.length,
					messages: references.map(reference => reference.message),
					references,
				},
				rawData: { output: { references } },
			}));
		} catch (error) {
			if (execution.signal?.aborted) {
				throw error;
			}
			const errorMessage = String((error as { message?: unknown })?.message ?? error ?? 'Unknown error');
			logger.warn('[Genie][Chain] RAG retrieval failed; continuing without style references.', error);
			safeRun('Chain.onStage.ragRetrievalSkipped', () => options?.onStage?.({
				type: 'ragRetrievalSkipped',
				data: { error: errorMessage },
				rawData: {
					input: { query: context.query },
					output: { error: errorMessage },
				},
			}));
		}

		timings.ragReady = Date.now();
		return {
			changeSetSummary: context.changeSetSummary,
			retrievalFeatures: context.retrievalFeatures,
			ragStyleReferences: references,
		};
	}
}
