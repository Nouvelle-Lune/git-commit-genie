export type PipelineStepId = 'evidence' | 'summary' | 'rag' | 'draft' | 'verify';
export type PipelineStepState = 'pending' | 'active' | 'complete' | 'skipped' | 'warning';
export type PipelineRunState = 'running' | 'ready' | 'degraded';

export interface PipelineLogLike {
    id: string;
    timestamp: number;
    type: string;
    title: string;
    content?: string;
    repoPath?: string;
    generationMode?: 'default' | 'thinking';
}

export interface PipelineTextCatalog {
    flowTitle: string;
    currentRepository: string;
    generationStarted: string;
    modeThinking: string;
    modeDefault: string;
    stateReady: string;
    stateDegraded: string;
    stateRunning: string;
    stateRetrying: string;
    stateFailed: string;
    stagesLabel: string;
    stepEvidence: string;
    stepSummary: string;
    stepRag: string;
    stepDraft: string;
    stepVerify: string;
    draftInput: string;
    ragInput: string;
    tokenUsage: string;
    payloadEvidence: string;
    payloadRaw: string;
    payloadSummary: string;
    payloadRagQuery: string;
    payloadRefs: string;
    phaseInput: string;
    phaseTransform: string;
    phaseHandoff: string;
    phaseRetrieval: string;
    phaseGenerate: string;
    phaseVerify: string;
    phaseOutput: string;
    metricFiles: string;
    metricRaw: string;
    metricBudget: string;
    metricProgress: string;
    metricSignal: string;
    metricBreaking: string;
    metricSummary: string;
    metricInput: string;
    metricType: string;
    metricScope: string;
    metricReferences: string;
    schemaValidationRetryTitle: string;
    schemaValidationFailedTitle: string;
    structuredOutputRetryTitle: string;
    structuredOutputFailedTitle: string;
    evidenceReadyTitle: string;
    evidenceReadyDescription: string;
    summarizeStartTitle: string;
    summarizeStartDescription: string;
    summarizeProgressTitle: string;
    summarizeProgressDefault: string;
    evidenceRoutedTitle: string;
    evidenceRoutedSummarized: string;
    evidenceRoutedRaw: string;
    ragDisabledTitle: string;
    ragDisabledDescription: string;
    ragPreparationStartTitle: string;
    ragPreparationStartDescription: string;
    ragPreparedTitle: string;
    ragRetrievalStartTitle: string;
    ragRetrievalStartDescription: string;
    ragRetrievedTitle: string;
    ragRetrievedEmptyTitle: string;
    ragRetrievedDescription: string;
    ragRetrievedEmptyDescription: string;
    ragPreparationFailedTitle: string;
    ragPreparationFailedDefault: string;
    ragRetrievalFailedTitle: string;
    ragRetrievalFailedDefault: string;
    draftStartTitle: string;
    draftStartDescription: string;
    draftCreatedTitle: string;
    validationStartTitle: string;
    validationStartDescription: string;
    validateFixTitle: string;
    strictFixStartTitle: string;
    strictFixStartDescription: string;
    strictFixTitle: string;
    enforceLanguageStartTitle: string;
    enforceLanguageStartDescription: string;
    enforceLanguageStartDefault: string;
    enforceLanguageTitle: string;
    doneTitle: string;
}

export const DEFAULT_PIPELINE_TEXT: PipelineTextCatalog = {
    flowTitle: 'Generation flow',
    currentRepository: 'Current repository',
    generationStarted: 'Generation started: {0} — {1}',
    modeThinking: 'Thinking',
    modeDefault: 'Default',
    stateReady: 'Ready',
    stateDegraded: 'Degraded',
    stateRunning: 'Running',
    stateRetrying: 'Retrying',
    stateFailed: 'Failed',
    stagesLabel: 'Commit generation stages',
    stepEvidence: 'Evidence',
    stepSummary: 'Summary',
    stepRag: 'RAG',
    stepDraft: 'Draft',
    stepVerify: 'Verify',
    draftInput: 'Draft input',
    ragInput: 'RAG input',
    tokenUsage: 'Input token usage {0}%',
    payloadEvidence: 'Evidence',
    payloadRaw: 'raw',
    payloadSummary: 'summary',
    payloadRagQuery: 'RAG query',
    payloadRefs: 'refs',
    phaseInput: 'Input',
    phaseTransform: 'Transform',
    phaseHandoff: 'Handoff',
    phaseRetrieval: 'Retrieval',
    phaseGenerate: 'Generate',
    phaseVerify: 'Verify',
    phaseOutput: 'Output',
    metricFiles: 'Files',
    metricRaw: 'Raw',
    metricBudget: 'Budget',
    metricProgress: 'Progress',
    metricSignal: 'Signal',
    metricBreaking: 'Breaking',
    metricSummary: 'Summary',
    metricInput: 'Input',
    metricType: 'Type',
    metricScope: 'Scope',
    metricReferences: 'References',
    schemaValidationRetryTitle: 'Schema validation retry: {0}',
    schemaValidationFailedTitle: 'Schema validation failed: {0}',
    structuredOutputRetryTitle: 'Empty structured output, retrying: {0}',
    structuredOutputFailedTitle: 'Structured output failed: {0}',
    evidenceReadyTitle: 'Change evidence collected',
    evidenceReadyDescription: '{0} staged files entered the pipeline as complete raw diffs.',
    summarizeStartTitle: 'Evidence compaction started',
    summarizeStartDescription: 'The target request exceeded its input budget, so the largest raw diff is being summarized.',
    summarizeProgressTitle: 'Summarized {0}',
    summarizeProgressDefault: 'Raw diff replaced with grounded, hunk-referenced evidence.',
    evidenceRoutedTitle: 'Evidence ready for {0}',
    evidenceRoutedSummarized: 'The largest raw diffs were replaced until the complete request fit the configured budget.',
    evidenceRoutedRaw: 'The complete request fits the configured budget; raw diffs remain intact.',
    ragDisabledTitle: 'RAG skipped',
    ragDisabledDescription: 'Historical style retrieval is disabled for this generation.',
    ragPreparationStartTitle: 'Building retrieval query',
    ragPreparationStartDescription: 'The model is converting current change evidence into a semantic summary and retrieval features.',
    ragPreparedTitle: 'Retrieval query prepared',
    ragRetrievalStartTitle: 'Searching commit history',
    ragRetrievalStartDescription: 'Hybrid and type/scope recall are selecting historical style candidates.',
    ragRetrievedTitle: 'Style references selected',
    ragRetrievedEmptyTitle: 'No style references selected',
    ragRetrievedDescription: '{0} historical commit messages will be used for style calibration only.',
    ragRetrievedEmptyDescription: 'Drafting will continue from current change evidence without historical examples.',
    ragPreparationFailedTitle: 'RAG preparation failed',
    ragPreparationFailedDefault: 'Retrieval context could not be prepared.',
    ragRetrievalFailedTitle: 'Historical retrieval failed',
    ragRetrievalFailedDefault: 'Historical style references could not be retrieved.',
    draftStartTitle: 'Drafting commit message',
    draftStartDescription: 'Evidence, repository context, template, language, and style references are now being combined.',
    draftCreatedTitle: 'Draft created',
    validationStartTitle: 'Checking commit rules',
    validationStartDescription: 'The draft is being checked against the active Conventional Commit rules and template.',
    validateFixTitle: 'Commit rules checked',
    strictFixStartTitle: 'Repairing header format',
    strictFixStartDescription: 'The local strict check found a Conventional Commit header problem.',
    strictFixTitle: 'Header format repaired',
    enforceLanguageStartTitle: 'Checking target language',
    enforceLanguageStartDescription: 'Narrative text is being checked for {0}.',
    enforceLanguageStartDefault: 'Narrative text is being checked against the target language.',
    enforceLanguageTitle: 'Target language checked',
    doneTitle: 'Commit message ready',
};

const LOCALIZED_PIPELINE_LANGUAGES = new Set(['zh-cn', 'zh-tw']);

/**
 * Returns whether the pipeline UI has an exact translation for a VS Code locale.
 * Exact matching prevents unsupported regional variants from inheriting a
 * translation that the extension does not explicitly maintain.
 */
export function isLocalizedPipelineLanguage(language: string): boolean {
    return LOCALIZED_PIPELINE_LANGUAGES.has(language.toLowerCase());
}

export interface PipelineMetric {
    label: string;
    value: string;
    tone?: 'raw' | 'summary' | 'budget' | 'rag';
}

export interface PipelineEventPresentation {
    stage: string;
    phase: string;
    title: string;
    description: string;
    metrics: PipelineMetric[];
    tone: 'neutral' | 'active' | 'success' | 'warning';
    data: Record<string, unknown>;
}

export interface PipelineSnapshot {
    repoPath?: string;
    startedAt: number;
    state: PipelineRunState;
    steps: Array<{
        id: PipelineStepId;
        label: string;
        state: PipelineStepState;
    }>;
    latest: PipelineEventPresentation;
    queryText?: string;
    predictedType?: string;
    predictedScope?: string;
    referenceCount?: number;
    latestHandoff?: {
        target: 'ragPreparation' | 'draft';
        rawFiles: number;
        summarizedFiles: number;
        estimatedInputTokens: number;
        maxInputTokens: number;
    };
}

type CommitStagePayload = {
    stage: string;
    data: Record<string, unknown>;
};

function asNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function formatInteger(value: number): string {
    return Math.round(value).toLocaleString('en-US');
}

function firstLine(value: unknown): string {
    return String(value || '').split(/\r?\n/, 1)[0].trim();
}

export function formatPipelineText(template: string, ...values: Array<string | number>): string {
    return template.replace(/\{(\d+)\}/g, (_match, rawIndex: string) => {
        const index = Number(rawIndex);
        if (index >= values.length) {
            throw new Error(`Pipeline text is missing replacement value {${index}}.`);
        }
        return String(values[index]);
    });
}

export function parseCommitStageLog(log: PipelineLogLike): CommitStagePayload | null {
    if (log.type !== 'toolCall' || !log.title.startsWith('Commit stage:') || !log.content) {
        return null;
    }

    const parsed = JSON.parse(log.content) as { stage?: unknown; data?: unknown };
    const stage = asString(parsed.stage);
    if (!stage) {
        throw new Error(`Commit stage log '${log.id}' is missing a stage.`);
    }
    if (parsed.data !== undefined && (typeof parsed.data !== 'object' || parsed.data === null || Array.isArray(parsed.data))) {
        throw new Error(`Commit stage log '${log.id}' contains invalid stage data.`);
    }

    return {
        stage,
        data: (parsed.data || {}) as Record<string, unknown>,
    };
}

export function presentPipelineEvent(
    payload: CommitStagePayload,
    text: PipelineTextCatalog = DEFAULT_PIPELINE_TEXT
): PipelineEventPresentation {
    const { stage, data } = payload;
    const fileCount = asNumber(data.fileCount);
    const rawFiles = asNumber(data.rawFiles);
    const summarizedFiles = asNumber(data.summarizedFiles);
    const estimatedTokens = asNumber(data.estimatedInputTokens);
    const maxInputTokens = asNumber(data.maxInputTokens);
    const target = data.target === 'ragPreparation' ? text.ragInput : text.draftInput;

    switch (stage) {
        case 'evidenceReady':
            return {
                stage,
                phase: text.phaseInput,
                title: text.evidenceReadyTitle,
                description: formatPipelineText(text.evidenceReadyDescription, fileCount ?? 0),
                metrics: [
                    { label: text.metricFiles, value: String(fileCount ?? 0) },
                    { label: text.metricRaw, value: String(rawFiles ?? fileCount ?? 0), tone: 'raw' },
                    ...(maxInputTokens !== undefined ? [{ label: text.metricBudget, value: formatInteger(maxInputTokens), tone: 'budget' as const }] : []),
                ],
                tone: 'success',
                data,
            };
        case 'summarizeStart':
            return {
                stage,
                phase: text.phaseTransform,
                title: text.summarizeStartTitle,
                description: text.summarizeStartDescription,
                metrics: [],
                tone: 'active',
                data,
            };
        case 'summarizeProgress': {
            const file = asString(data.file) || 'Changed file';
            const current = asNumber(data.current) ?? 0;
            const total = asNumber(data.total) ?? 0;
            return {
                stage,
                phase: text.phaseTransform,
                title: formatPipelineText(text.summarizeProgressTitle, file),
                description: asString(data.summary) || text.summarizeProgressDefault,
                metrics: [
                    { label: text.metricProgress, value: `${current}/${total}`, tone: 'summary' },
                    ...(data.breaking === true ? [{ label: text.metricSignal, value: text.metricBreaking, tone: 'summary' as const }] : []),
                ],
                tone: 'success',
                data,
            };
        }
        case 'evidenceRouted': {
            const didSummarize = data.didSummarize === true;
            return {
                stage,
                phase: text.phaseHandoff,
                title: formatPipelineText(text.evidenceRoutedTitle, target),
                description: didSummarize
                    ? text.evidenceRoutedSummarized
                    : text.evidenceRoutedRaw,
                metrics: [
                    { label: text.metricRaw, value: String(rawFiles ?? 0), tone: 'raw' },
                    { label: text.metricSummary, value: String(summarizedFiles ?? 0), tone: 'summary' },
                    ...(estimatedTokens !== undefined && maxInputTokens !== undefined
                        ? [{ label: text.metricInput, value: `${formatInteger(estimatedTokens)} / ${formatInteger(maxInputTokens)}`, tone: 'budget' as const }]
                        : []),
                ],
                tone: 'success',
                data,
            };
        }
        case 'ragDisabled':
            return {
                stage,
                phase: text.phaseRetrieval,
                title: text.ragDisabledTitle,
                description: text.ragDisabledDescription,
                metrics: [],
                tone: 'neutral',
                data,
            };
        case 'ragPreparationStart':
            return {
                stage,
                phase: text.phaseRetrieval,
                title: text.ragPreparationStartTitle,
                description: text.ragPreparationStartDescription,
                metrics: [],
                tone: 'active',
                data,
            };
        case 'ragPrepared': {
            const changeSetSummary = (data.changeSetSummary || {}) as Record<string, unknown>;
            const retrievalFeatures = (data.retrievalFeatures || {}) as Record<string, unknown>;
            const query = asString(changeSetSummary.text) || '';
            const type = asString(retrievalFeatures.predictedType);
            const scope = asString(retrievalFeatures.predictedScope);
            return {
                stage,
                phase: text.phaseRetrieval,
                title: text.ragPreparedTitle,
                description: query,
                metrics: [
                    ...(type ? [{ label: text.metricType, value: type, tone: 'rag' as const }] : []),
                    ...(scope ? [{ label: text.metricScope, value: scope, tone: 'rag' as const }] : []),
                    ...(asNumber(retrievalFeatures.fileCount) !== undefined
                        ? [{ label: text.metricFiles, value: String(asNumber(retrievalFeatures.fileCount)) }]
                        : []),
                ],
                tone: 'success',
                data,
            };
        }
        case 'ragRetrievalStart':
            return {
                stage,
                phase: text.phaseRetrieval,
                title: text.ragRetrievalStartTitle,
                description: text.ragRetrievalStartDescription,
                metrics: [],
                tone: 'active',
                data,
            };
        case 'ragRetrieved': {
            const count = asNumber(data.count) ?? 0;
            return {
                stage,
                phase: text.phaseRetrieval,
                title: count > 0 ? text.ragRetrievedTitle : text.ragRetrievedEmptyTitle,
                description: count > 0
                    ? formatPipelineText(text.ragRetrievedDescription, count)
                    : text.ragRetrievedEmptyDescription,
                metrics: [{ label: text.metricReferences, value: String(count), tone: 'rag' }],
                tone: 'success',
                data,
            };
        }
        case 'ragPreparationSkipped':
            return {
                stage,
                phase: text.phaseRetrieval,
                title: text.ragPreparationFailedTitle,
                description: asString(data.error) || text.ragPreparationFailedDefault,
                metrics: [],
                tone: 'warning',
                data,
            };
        case 'ragRetrievalSkipped':
            return {
                stage,
                phase: text.phaseRetrieval,
                title: text.ragRetrievalFailedTitle,
                description: asString(data.error) || text.ragRetrievalFailedDefault,
                metrics: [],
                tone: 'warning',
                data,
            };
        case 'draftStart':
            return {
                stage,
                phase: text.phaseGenerate,
                title: text.draftStartTitle,
                description: text.draftStartDescription,
                metrics: [],
                tone: 'active',
                data,
            };
        case 'classifyDraft':
            return {
                stage,
                phase: text.phaseGenerate,
                title: text.draftCreatedTitle,
                description: firstLine(data.draft),
                metrics: [],
                tone: 'success',
                data,
            };
        case 'validationStart':
            return {
                stage,
                phase: text.phaseVerify,
                title: text.validationStartTitle,
                description: text.validationStartDescription,
                metrics: [],
                tone: 'active',
                data,
            };
        case 'validateFix':
            return {
                stage,
                phase: text.phaseVerify,
                title: text.validateFixTitle,
                description: firstLine(data.validMessage),
                metrics: [],
                tone: 'success',
                data,
            };
        case 'strictFixStart':
            return {
                stage,
                phase: text.phaseVerify,
                title: text.strictFixStartTitle,
                description: text.strictFixStartDescription,
                metrics: [],
                tone: 'active',
                data,
            };
        case 'strictFix':
            return {
                stage,
                phase: text.phaseVerify,
                title: text.strictFixTitle,
                description: firstLine(data.message),
                metrics: [],
                tone: 'success',
                data,
            };
        case 'enforceLanguageStart':
            return {
                stage,
                phase: text.phaseVerify,
                title: text.enforceLanguageStartTitle,
                description: asString(data.targetLanguage)
                    ? formatPipelineText(text.enforceLanguageStartDescription, asString(data.targetLanguage)!)
                    : text.enforceLanguageStartDefault,
                metrics: [],
                tone: 'active',
                data,
            };
        case 'enforceLanguage':
            return {
                stage,
                phase: text.phaseVerify,
                title: text.enforceLanguageTitle,
                description: firstLine(data.message),
                metrics: [],
                tone: 'success',
                data,
            };
        case 'done':
            return {
                stage,
                phase: text.phaseOutput,
                title: text.doneTitle,
                description: firstLine(data.finalMessage),
                metrics: [],
                tone: 'success',
                data,
            };
        default:
            throw new Error(`Unknown commit pipeline stage '${stage}'.`);
    }
}

export function deriveLatestPipelineSnapshot(
    logs: PipelineLogLike[],
    text: PipelineTextCatalog = DEFAULT_PIPELINE_TEXT
): PipelineSnapshot | null {
    let generationStartIndex = -1;
    for (let index = logs.length - 1; index >= 0; index -= 1) {
        if (logs[index].type === 'generationStart') {
            generationStartIndex = index;
            break;
        }
    }
    if (generationStartIndex < 0) {
        return null;
    }

    const generationStart = logs[generationStartIndex];
    if (generationStart.generationMode !== 'thinking') {
        return null;
    }
    const runLogs = logs
        .slice(generationStartIndex + 1)
        .filter(log => !generationStart.repoPath || log.repoPath === generationStart.repoPath);
    const events = runLogs
        .map(parseCommitStageLog)
        .filter((payload): payload is CommitStagePayload => payload !== null);
    if (!events.length) {
        return null;
    }

    const stepStates: Record<PipelineStepId, PipelineStepState> = {
        evidence: 'pending',
        summary: 'pending',
        rag: 'pending',
        draft: 'pending',
        verify: 'pending',
    };
    let degraded = false;
    let queryText: string | undefined;
    let predictedType: string | undefined;
    let predictedScope: string | undefined;
    let referenceCount: number | undefined;
    let latestHandoff: PipelineSnapshot['latestHandoff'];

    for (const event of events) {
        const { stage, data } = event;
        switch (stage) {
            case 'evidenceReady':
                stepStates.evidence = 'complete';
                break;
            case 'summarizeStart':
            case 'summarizeProgress':
                stepStates.summary = stage === 'summarizeStart' ? 'active' : 'complete';
                break;
            case 'evidenceRouted':
                if (data.didSummarize === true) {
                    stepStates.summary = 'complete';
                } else if (stepStates.summary === 'pending') {
                    stepStates.summary = 'skipped';
                }
                if (
                    (data.target === 'ragPreparation' || data.target === 'draft')
                    && asNumber(data.rawFiles) !== undefined
                    && asNumber(data.summarizedFiles) !== undefined
                    && asNumber(data.estimatedInputTokens) !== undefined
                    && asNumber(data.maxInputTokens) !== undefined
                ) {
                    latestHandoff = {
                        target: data.target,
                        rawFiles: asNumber(data.rawFiles)!,
                        summarizedFiles: asNumber(data.summarizedFiles)!,
                        estimatedInputTokens: asNumber(data.estimatedInputTokens)!,
                        maxInputTokens: asNumber(data.maxInputTokens)!,
                    };
                }
                break;
            case 'ragPreparationStart':
            case 'ragRetrievalStart':
                stepStates.rag = 'active';
                break;
            case 'ragPrepared': {
                stepStates.rag = 'complete';
                const summary = (data.changeSetSummary || {}) as Record<string, unknown>;
                const features = (data.retrievalFeatures || {}) as Record<string, unknown>;
                queryText = asString(summary.text);
                predictedType = asString(features.predictedType);
                predictedScope = asString(features.predictedScope);
                break;
            }
            case 'ragRetrieved':
                stepStates.rag = 'complete';
                referenceCount = asNumber(data.count);
                break;
            case 'ragDisabled':
                stepStates.rag = 'skipped';
                break;
            case 'ragPreparationSkipped':
            case 'ragRetrievalSkipped':
                stepStates.rag = 'warning';
                degraded = true;
                break;
            case 'draftStart':
                stepStates.draft = 'active';
                break;
            case 'classifyDraft':
                stepStates.draft = 'complete';
                break;
            case 'validationStart':
            case 'strictFixStart':
            case 'enforceLanguageStart':
                stepStates.verify = 'active';
                break;
            case 'validateFix':
            case 'strictFix':
            case 'enforceLanguage':
                stepStates.verify = 'complete';
                break;
            case 'done':
                stepStates.draft = 'complete';
                stepStates.verify = 'complete';
                break;
        }
    }

    const latestPayload = events[events.length - 1];
    const completed = latestPayload.stage === 'done';
    return {
        repoPath: generationStart.repoPath,
        startedAt: generationStart.timestamp,
        state: completed ? (degraded ? 'degraded' : 'ready') : (degraded ? 'degraded' : 'running'),
        steps: (['evidence', 'summary', 'rag', 'draft', 'verify'] as PipelineStepId[]).map(id => ({
            id,
            label: {
                evidence: text.stepEvidence,
                summary: text.stepSummary,
                rag: text.stepRag,
                draft: text.stepDraft,
                verify: text.stepVerify,
            }[id],
            state: stepStates[id],
        })),
        latest: presentPipelineEvent(latestPayload, text),
        queryText,
        predictedType,
        predictedScope,
        referenceCount,
        latestHandoff,
    };
}
