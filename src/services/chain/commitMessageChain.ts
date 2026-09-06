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
import { EvidenceRouteTarget, runChangeAnalysisPipeline } from "../analysis/change/pipeline";
import { generateDraft } from "./generation/draft";
import {
	checkConventionalCommitHeader,
	enforceStrictCommitFormat,
	validateAndFixCommit,
} from "./validation/commitValidation";
import { buildFileSummaries, summarizeFileEvidenceForDisplay } from "./evidence/fileSummaries";
import { EvidenceLedger } from "../../agent/evidenceLedger";


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
		}
	}));

	const createCompactFor = (branch: { current: DraftEvidence[] }) => async (
		target: EvidenceRouteTarget,
		buildTargetMessages: (current: DraftEvidence[]) => AIMessage[],
		force = false,
	): Promise<void> => {
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
						safeRun('Chain.onStage.summarizeStart', () => options?.onStage?.({ type: 'summarizeStart' }));
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
						}
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
	const compactFor = createCompactFor(analysisEvidence);

	// Stages 1-5 of the change-conditioned chain. Their only product is the
	// compact selected-information payload; the investigation trajectory itself
	// never reaches the generator.
	const trace = await runChangeAnalysisPipeline({
		diffs,
		inputs,
		execution,
		getEvidence: () => analysisEvidence.current,
		compactFor,
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
	safeRun('Chain.onStage.draftStart', () => options?.onStage?.({ type: 'draftStart' }));
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

	safeRun('Chain.onStage.classifyDraft', () => options?.onStage?.({ type: 'classifyDraft', data: { draft } }));

	safeRun('Chain.onStage.validationStart', () => options?.onStage?.({ type: 'validationStart' }));
	const { validMessage, notes: validationNotes } = await validateAndFixCommit(draft, inputs.validationChecklist ?? '', execution, inputs.userTemplate);
	safeRun('Chain.onStage.validateFix', () => options?.onStage?.({ type: 'validateFix', data: { validMessage } }));

	// Local strict check; if still not conforming, ask LLM for a minimal strict fix
	let finalMessage = validMessage;
	const check = checkConventionalCommitHeader(finalMessage);
	if (!check.ok) {
		safeRun('Chain.onStage.strictFixStart', () => options?.onStage?.({
			type: 'strictFixStart',
			data: { problems: check.problems }
		}));
		finalMessage = await enforceStrictCommitFormat(finalMessage, check.problems, execution, inputs.userTemplate);
		safeRun('Chain.onStage.strictFix', () => options?.onStage?.({ type: 'strictFix', data: { message: finalMessage } }));
	}

	// Enforce target language strictly while preserving tokens/structure
	if ((inputs.targetLanguage || '').trim()) {
		safeRun('Chain.onStage.enforceLanguageStart', () => options?.onStage?.({
			type: 'enforceLanguageStart',
			data: { targetLanguage: inputs.targetLanguage }
		}));
		finalMessage = await enforceCommitLanguage(finalMessage, inputs.targetLanguage, execution, inputs.userTemplate);
		safeRun('Chain.onStage.enforceLanguage', () => options?.onStage?.({ type: 'enforceLanguage', data: { message: finalMessage } }));
	}

	safeRun('Chain.onStage.done', () => options?.onStage?.({ type: 'done', data: { finalMessage } }));

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
		}));

		let references: RagStyleReference[] = [];
		try {
			if (options?.retrieveRagExamples) {
				safeRun('Chain.onStage.ragRetrievalStart', () => options.onStage?.({ type: 'ragRetrievalStart' }));
				references = await options.retrieveRagExamples(context.query);
			}
			safeRun('Chain.onStage.ragRetrieved', () => options?.onStage?.({
				type: 'ragRetrieved',
				data: {
					count: references.length,
					messages: references.map(reference => reference.message),
					references,
				},
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
