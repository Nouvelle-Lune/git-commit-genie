import { ChatFn, ChatMessage } from "../llm/llmTypes";
import { IRepositoryAnalysisService } from "../analysis/repository/repositoryAnalysisTypes";
import { ChainInputs, ChangeSetSummary, ChainOutputs, RagStyleReference, RetrievalFeatures } from "./types";
import { DraftEvidence } from "../analysis/change/types";
import { buildRagPreparationMessages } from "./rag/prompts";

import { enforceCommitLanguage } from "./validation/languageValidation";
import { isRagPreparationEnabled, prepareRagContext } from "./rag/preparation";
import { logger } from "../logger";
import { safeRun } from "../../utils/safeRun";
import { compactEvidenceToFit, createRawDraftEvidence } from "./evidence/compaction";
import { DEFAULT_CHAIN_MAX_INPUT_TOKENS, resolveChainInputTokenBudget } from "../llm/inputTokenBudget";
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


export async function generateCommitMessageChain(
	inputs: ChainInputs,
	chat: ChatFn,
	options?: {
		maxParallel?: number;
		maxRetries?: number;
		maxInputTokens?: number;
		model?: string;
		/** Overrides the configured investigation limits; used by tests and benchmarks. */
		investigation?: Partial<InvestigationSettings>;
		repositoryAnalysisService?: Pick<IRepositoryAnalysisService, 'runChangeAnalysis'>;
		onStage?: (event: import('../../ui/StageNotificationManager').StageEvent) => void;
		retrieveRagExamples?: (context: {
			changeSetSummary: ChangeSetSummary;
			retrievalFeatures: RetrievalFeatures;
		}) => Promise<RagStyleReference[]>;
	}
): Promise<ChainOutputs> {
	const { diffs } = inputs;
	const maxParallel = options?.maxParallel ?? Math.max(4, Math.min(8, diffs.length));
	const maxRetries = options?.maxRetries ?? 2;
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
		target: EvidenceRouteTarget,
		buildTargetMessages: (current: DraftEvidence[]) => ChatMessage[]
	) => {
		try {
			const result = await compactEvidenceToFit({
				diffs,
				evidence,
				chat,
				maxInputTokens,
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
					summarizedCount += 1;
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

	// Stages 1-5 of the change-conditioned chain. Their only product is the
	// compact selected-information payload; the investigation trajectory itself
	// never reaches the generator.
	const trace = await runChangeAnalysisPipeline({
		diffs,
		inputs,
		chat,
		getEvidence: () => evidence,
		compactFor,
		investigationOverrides: options?.investigation,
		repositoryAnalysisService: options?.repositoryAnalysisService,
		maxInputTokens,
		onStage: options?.onStage,
	});

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

	const buildDraftMessages = (current: DraftEvidence[]): ChatMessage[] =>
		buildChangeConditionedDraftMessages({
			selected: trace.selectedInformation,
			evidencePayload: current,
			inputs,
			ragStyleReferences,
		});

	await compactFor('draft', buildDraftMessages);
	safeRun('Chain.onStage.draftStart', () => options?.onStage?.({ type: 'draftStart' }));
	const { draft, notes: classificationNotes } = await generateDraft(buildDraftMessages(evidence), chat);

	safeRun('Chain.onStage.classifyDraft', () => options?.onStage?.({ type: 'classifyDraft', data: { draft } }));

	safeRun('Chain.onStage.validationStart', () => options?.onStage?.({ type: 'validationStart' }));
	const { validMessage, notes: validationNotes } = await validateAndFixCommit(draft, inputs.validationChecklist ?? '', chat, inputs.userTemplate);
	safeRun('Chain.onStage.validateFix', () => options?.onStage?.({ type: 'validateFix', data: { validMessage } }));

	// Local strict check; if still not conforming, ask LLM for a minimal strict fix
	let finalMessage = validMessage;
	const check = checkConventionalCommitHeader(finalMessage);
	if (!check.ok) {
		safeRun('Chain.onStage.strictFixStart', () => options?.onStage?.({
			type: 'strictFixStart',
			data: { problems: check.problems }
		}));
		finalMessage = await enforceStrictCommitFormat(finalMessage, check.problems, chat, inputs.userTemplate);
		safeRun('Chain.onStage.strictFix', () => options?.onStage?.({ type: 'strictFix', data: { message: finalMessage } }));
	}

	// Enforce target language strictly while preserving tokens/structure
	if ((inputs.targetLanguage || '').trim()) {
		safeRun('Chain.onStage.enforceLanguageStart', () => options?.onStage?.({
			type: 'enforceLanguageStart',
			data: { targetLanguage: inputs.targetLanguage }
		}));
		finalMessage = await enforceCommitLanguage(finalMessage, inputs.targetLanguage, chat, inputs.userTemplate);
		safeRun('Chain.onStage.enforceLanguage', () => options?.onStage?.({ type: 'enforceLanguage', data: { message: finalMessage } }));
	}

	safeRun('Chain.onStage.done', () => options?.onStage?.({ type: 'done', data: { finalMessage } }));

	return {
		commitMessage: finalMessage,
		fileSummaries: buildFileSummaries(evidence, diffs),
		changeSetSummary,
		retrievalFeatures,
		ragStyleReferences,
		changeAnalysis: trace,
		raw: {
			draft,
			classificationNotes: classificationNotes ?? '',
			validationNotes: validationNotes ?? ''
		}
	};
}
