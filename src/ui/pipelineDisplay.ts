export type PipelineStepId =
    | 'evidence'
    | 'summary'
    | 'extract'
    | 'investigate'
    | 'analyze'
    | 'select'
    | 'rag'
    | 'draft'
    | 'verify';

/**
 * Steps that only exist in the change-conditioned chain. They are rendered only
 * when the run actually produced them, so default single-prompt generation
 * does not display permanently pending chain steps.
 */
const CHANGE_CONDITIONED_STEPS: PipelineStepId[] = ['extract', 'investigate', 'analyze', 'select'];

const PIPELINE_STEP_ORDER: PipelineStepId[] = [
    'evidence', 'summary', 'extract', 'investigate', 'analyze', 'select', 'rag', 'draft', 'verify',
];
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
    restoredFromPreviousSession?: boolean;
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
    stepExtract: string;
    stepInvestigate: string;
    stepAnalyze: string;
    stepSelect: string;
    stepRag: string;
    stepDraft: string;
    stepVerify: string;
    draftInput: string;
    extractInput: string;
    analyzeInput: string;
    tokenUsage: string;
    payloadEvidence: string;
    payloadRaw: string;
    payloadSummary: string;
    payloadRagQuery: string;
    payloadRefs: string;
    phaseInput: string;
    phaseTransform: string;
    phaseHandoff: string;
    phaseExtract: string;
    phaseInvestigate: string;
    phaseAnalyze: string;
    phaseSelect: string;
    phaseRetrieval: string;
    phaseGenerate: string;
    phaseVerify: string;
    phaseOutput: string;
    metricFiles: string;
    metricRaw: string;
    metricBudget: string;
    metricContext: string;
    metricOutput: string;
    metricTrigger: string;
    metricProgress: string;
    metricSignal: string;
    metricBreaking: string;
    metricSummary: string;
    metricInput: string;
    metricType: string;
    metricScope: string;
    metricReferences: string;
    metricSymbols: string;
    metricTargets: string;
    metricQuestions: string;
    metricSteps: string;
    metricEvidence: string;
    metricFindings: string;
    metricUnresolved: string;
    metricIntent: string;
    metricConfidence: string;
    metricTool: string;
    metricMustExpress: string;
    metricOmitted: string;
    schemaValidationRetryTitle: string;
    schemaValidationFailedTitle: string;
    structuredOutputRetryTitle: string;
    structuredOutputFailedTitle: string;
    protocolViolationRetryTitle: string;
    protocolViolationFailedTitle: string;
    evidencePreconditionRetryTitle: string;
    evidencePreconditionFailedTitle: string;
    outputExhaustedTitle: string;
    providerErrorTitle: string;
    evidenceReadyTitle: string;
    evidenceReadyDescription: string;
    summarizeStartTitle: string;
    summarizeStartDescription: string;
    summarizeProgressTitle: string;
    summarizeProgressDefault: string;
    summarizeFailedTitle: string;
    summarizeFailedDefault: string;
    evidenceRoutedTitle: string;
    evidenceRoutedSummarized: string;
    evidenceRoutedRaw: string;
    changeExtractionStartTitle: string;
    changeExtractionStartDescription: string;
    changeExtractedTitle: string;
    changeExtractedDescription: string;
    changeExtractedEmptyDescription: string;
    investigationPlanStartTitle: string;
    investigationPlanStartDescription: string;
    investigationPlannedTitle: string;
    investigationPlannedDescription: string;
    investigationStartTitle: string;
    investigationStartDescription: string;
    investigationStepTitle: string;
    investigationStepDefault: string;
    memoryStepTitle: string;
    memoryStepDefault: string;
    investigationCompleteTitle: string;
    investigationCompleteDescription: string;
    analysisFinalizingTitle: string;
    analysisFinalizingDescription: string;
    investigationResolvedTitle: string;
    investigationResolvedDescription: string;
    investigationResolvedEmptyDescription: string;
    investigationSkippedTitle: string;
    investigationSkippedDefault: string;
    semanticAnalysisCompleteTitle: string;
    semanticAnalysisDegradedTitle: string;
    semanticAnalysisCompleteDescription: string;
    semanticAnalysisNoIntentDescription: string;
    informationSelectionEmptyDescription: string;
    informationSelectedTitle: string;
    informationSelectedDescription: string;
    ragDisabledTitle: string;
    ragDisabledDescription: string;
    ragPreparedTitle: string;
    ragRetrievalStartTitle: string;
    ragRetrievalStartDescription: string;
    ragRetrievedTitle: string;
    ragRetrievedEmptyTitle: string;
    ragRetrievedDescription: string;
    ragRetrievedEmptyDescription: string;
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
    detailPrimaryIntent: string;
    detailObservableEffect: string;
    detailRecommendedType: string;
    detailSuggestedScope: string;
    detailFacts: string;
    detailUncertainties: string;
    detailInvestigationTargets: string;
    detailQuestions: string;
    detailFindings: string;
    detailOptional: string;
    detailOmitted: string;
    detailQuery: string;
    detailStyleReason: string;
    detailMatchedBy: string;
    detailCompleteCommitMessage: string;
    detailAttempt: string;
    detailTotalAttempts: string;
    detailMissingStructuredOutput: string;
    detailSchemaMismatch: string;
    detailProtocolViolation: string;
    detailEvidencePrecondition: string;
    detailOutputExhausted: string;
    detailProviderError: string;
    detailProfile: string;
    detailFieldIssues: string;
    fieldIssueTooManyItems: string;
    fieldIssueTooFewItems: string;
    fieldIssueInvalidFormat: string;
    fieldIssueInvalidType: string;
    fieldIssueMissing: string;
    fieldIssueNotAllowed: string;
    fieldIssueCustom: string;
    detailFiles: string;
    detailFile: string;
    detailStatus: string;
    detailReason: string;
    detailSummary: string;
    detailBreaking: string;
    detailProgress: string;
    detailTarget: string;
    detailDidSummarize: string;
    detailSymbols: string;
    detailConfigs: string;
    detailTypes: string;
    detailDependencies: string;
    detailMaxSteps: string;
    detailSuccess: string;
    detailEvidence: string;
    detailUnresolved: string;
    detailEpoch: string;
    detailProblems: string;
    detailSource: string;
    detailChangeSetSummary: string;
    detailRetrievalFeatures: string;
    detailReferences: string;
    detailEmptyList: string;
    detailIssueCount: string;
    detailStage: string;
    detailError: string;
    detailFailureKind: string;
    detailYes: string;
    detailNo: string;
    detailMustExpress: string;
    detailTool: string;
    detailSteps: string;
    detailHardInput: string;
    detailSafetyTokens: string;
    detailForced: string;
    sourceDraft: string;
    sourceValidation: string;
    sourceStrictFix: string;
    sourceLanguageEnforcement: string;
    sourceFinal: string;
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
    stepExtract: 'Extract',
    stepInvestigate: 'Investigate',
    stepAnalyze: 'Analyze',
    stepSelect: 'Select',
    stepRag: 'RAG',
    stepDraft: 'Draft',
    stepVerify: 'Verify',
    draftInput: 'Draft input',
    extractInput: 'Change extraction input',
    analyzeInput: 'Repository Investigation and Semantic Analysis',
    tokenUsage: 'Input token usage {0}%',
    payloadEvidence: 'Evidence',
    payloadRaw: 'raw',
    payloadSummary: 'summary',
    payloadRagQuery: 'RAG query',
    payloadRefs: 'refs',
    phaseInput: 'Input',
    phaseTransform: 'Transform',
    phaseHandoff: 'Handoff',
    phaseExtract: 'Extract',
    phaseInvestigate: 'Investigate',
    phaseAnalyze: 'Analyze',
    phaseSelect: 'Select',
    phaseRetrieval: 'Retrieval',
    phaseGenerate: 'Generate',
    phaseVerify: 'Verify',
    phaseOutput: 'Output',
    metricFiles: 'Files',
    metricRaw: 'Raw',
    metricBudget: 'Budget',
    metricContext: 'Context',
    metricOutput: 'Output',
    metricTrigger: 'Trigger',
    metricProgress: 'Progress',
    metricSignal: 'Signal',
    metricBreaking: 'Breaking',
    metricSummary: 'Summary',
    metricInput: 'Input',
    metricType: 'Type',
    metricScope: 'Scope',
    metricReferences: 'References',
    metricSymbols: 'Symbols',
    metricTargets: 'Targets',
    metricQuestions: 'Questions',
    metricSteps: 'Steps',
    metricEvidence: 'Evidence',
    metricFindings: 'Findings',
    metricUnresolved: 'Unresolved',
    metricIntent: 'Intent',
    metricConfidence: 'Confidence',
    metricTool: 'Tool',
    metricMustExpress: 'Must express',
    metricOmitted: 'Omitted',
    schemaValidationRetryTitle: 'Schema validation retry: {0}',
    schemaValidationFailedTitle: 'Schema validation failed: {0}',
    structuredOutputRetryTitle: 'Empty structured output, retrying: {0}',
    structuredOutputFailedTitle: 'Structured output failed: {0}',
    protocolViolationRetryTitle: 'Protocol violation, retrying: {0}',
    protocolViolationFailedTitle: 'Protocol violation: {0}',
    evidencePreconditionRetryTitle: 'Repository evidence still missing, retrying: {0}',
    evidencePreconditionFailedTitle: 'Repository evidence precondition unmet: {0}',
    outputExhaustedTitle: 'Output or context budget exhausted: {0}',
    providerErrorTitle: 'Provider request failed: {0}',
    evidenceReadyTitle: 'Change evidence collected',
    evidenceReadyDescription: '{0} staged files entered the pipeline as complete raw diffs.',
    summarizeStartTitle: 'Evidence compaction started',
    summarizeStartDescription: 'The target request exceeded its input budget, so the largest raw diff is being summarized.',
    summarizeProgressTitle: 'Summarized {0}',
    summarizeProgressDefault: 'Raw diff replaced with grounded, hunk-referenced evidence.',
    summarizeFailedTitle: 'Evidence compaction failed',
    summarizeFailedDefault: 'Change evidence could not be compacted for the target request.',
    evidenceRoutedTitle: 'Evidence ready for {0}',
    evidenceRoutedSummarized: 'The largest raw diffs were replaced until the complete request fit the configured budget.',
    evidenceRoutedRaw: 'The complete request fits the configured budget; raw diffs remain intact.',
    changeExtractionStartTitle: 'Extracting what changed',
    changeExtractionStartDescription: 'The diff is being reduced to changed symbols, calls, configuration keys, types, and dependencies.',
    changeExtractedTitle: 'Change surface extracted',
    changeExtractedDescription: 'Changed symbols: {0}.',
    changeExtractedEmptyDescription: 'No changed code symbol was found; the diff alone will carry the meaning of this change.',
    investigationPlanStartTitle: 'Planning the investigation',
    investigationPlanStartDescription: 'Deciding what still has to be known about the repository to explain this change.',
    investigationPlannedTitle: 'Investigation plan ready',
    investigationPlannedDescription: 'Investigating: {0}.',
    investigationStartTitle: 'Investigating the repository',
    investigationStartDescription: 'Definitions, callers, callees, types, configuration, and tests are being looked up for the changed symbols.',
    investigationStepTitle: 'Investigation step {0}: {1}',
    investigationStepDefault: 'Repository lookup completed.',
    memoryStepTitle: 'Memory step {0}: {1}',
    memoryStepDefault: 'Repository memory lookup completed.',
    investigationCompleteTitle: 'Repository evidence collection finished',
    investigationCompleteDescription: '{0} repository lookup(s) produced {1} evidence item(s).',
    analysisFinalizingTitle: 'Compiling investigation and change analysis',
    analysisFinalizingDescription: 'Tools are closed. The collected evidence is being turned into findings, semantic analysis, and message content.',
    investigationResolvedTitle: 'Investigation answers ready',
    investigationResolvedDescription: '{0}',
    investigationResolvedEmptyDescription: 'No planned question could be answered with repository evidence.',
    investigationSkippedTitle: 'Repository investigation skipped',
    investigationSkippedDefault: 'The change was analyzed from the diff alone.',
    semanticAnalysisCompleteTitle: 'Semantic analysis ready',
    semanticAnalysisDegradedTitle: 'Semantic analysis degraded',
    semanticAnalysisCompleteDescription: '{0}',
    semanticAnalysisNoIntentDescription: 'The evidence did not establish a single intent; the observable change will be described instead.',
    informationSelectionEmptyDescription: 'No claim carried enough evidence to be required in the commit message.',
    informationSelectedTitle: 'Message content selected',
    informationSelectedDescription: '{0}',
    ragDisabledTitle: 'RAG skipped',
    ragDisabledDescription: 'Historical style retrieval is disabled for this generation.',
    ragPreparedTitle: 'Retrieval query prepared',
    ragRetrievalStartTitle: 'Searching commit history',
    ragRetrievalStartDescription: 'Type-filtered Dense, BM25, and scope recall are selecting historical style candidates.',
    ragRetrievedTitle: 'Style references selected',
    ragRetrievedEmptyTitle: 'No style references selected',
    ragRetrievedDescription: '{0} historical commit messages will be used for style calibration only.',
    ragRetrievedEmptyDescription: 'Drafting will continue from current change evidence without historical examples.',
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
    detailPrimaryIntent: 'Primary intent',
    detailObservableEffect: 'Observable effect',
    detailRecommendedType: 'Recommended type',
    detailSuggestedScope: 'Suggested scope',
    detailFacts: 'Facts',
    detailUncertainties: 'Uncertainties',
    detailInvestigationTargets: 'Investigation targets',
    detailQuestions: 'Questions',
    detailFindings: 'Findings',
    detailOptional: 'Optional',
    detailOmitted: 'Omitted',
    detailQuery: 'Query',
    detailStyleReason: 'Style reason',
    detailMatchedBy: 'Matched by',
    detailCompleteCommitMessage: 'Complete commit message',
    detailAttempt: 'Attempt',
    detailTotalAttempts: 'Total attempts',
    detailMissingStructuredOutput: 'Missing structured output',
    detailSchemaMismatch: 'Schema mismatch',
    detailProtocolViolation: 'Protocol violation',
    detailEvidencePrecondition: 'Repository evidence precondition unmet',
    detailOutputExhausted: 'Output or context budget exhausted',
    detailProviderError: 'Provider error',
    detailProfile: 'Profile',
    detailFieldIssues: 'Field problems',
    fieldIssueTooManyItems: '{0} has {1} items, at most {2} allowed',
    fieldIssueTooFewItems: '{0} has {1} items, at least {2} required',
    fieldIssueInvalidFormat: '{0} is {1}, which does not match the required format {2}',
    fieldIssueInvalidType: '{0} expected {1} but received {2}',
    fieldIssueMissing: '{0} is required and was not provided',
    fieldIssueNotAllowed: '{0} is not part of the schema',
    fieldIssueCustom: '{0}: {1}',
    detailFiles: 'Files',
    detailFile: 'File',
    detailStatus: 'Status',
    detailReason: 'Reason',
    detailSummary: 'Summary',
    detailBreaking: 'Breaking change',
    detailProgress: 'Progress',
    detailTarget: 'Target',
    detailDidSummarize: 'Summarized',
    detailSymbols: 'Symbols',
    detailConfigs: 'Configs',
    detailTypes: 'Types',
    detailDependencies: 'Dependencies',
    detailMaxSteps: 'Max steps',
    detailSuccess: 'Success',
    detailEvidence: 'Evidence',
    detailUnresolved: 'Unresolved',
    detailEpoch: 'Epoch',
    detailProblems: 'Problems',
    detailSource: 'Source',
    detailChangeSetSummary: 'Change-set summary',
    detailRetrievalFeatures: 'Retrieval features',
    detailReferences: 'References',
    detailEmptyList: 'None',
    detailIssueCount: 'Diagnostics',
    detailStage: 'Stage',
    detailError: 'Error',
    detailFailureKind: 'Failure kind',
    detailYes: 'Yes',
    detailNo: 'No',
    detailMustExpress: 'Must express',
    detailTool: 'Tool',
    detailSteps: 'Steps',
    detailHardInput: 'Hard input',
    detailSafetyTokens: 'Safety tokens',
    detailForced: 'Forced compaction',
    sourceDraft: 'Draft',
    sourceValidation: 'Validation',
    sourceStrictFix: 'Strict fix',
    sourceLanguageEnforcement: 'Language enforcement',
    sourceFinal: 'Final',
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

export interface EvidenceFileEntry {
    file: string;
    status: string;
}

export interface RagReferenceEntry {
    message: string;
    styleReason: string;
    matchedBy: string[];
    subject?: string;
    commitHash?: string;
}

export type CommitMessageSource = 'draft' | 'validation' | 'strictFix' | 'languageEnforcement' | 'final';

/**
 * Why a structured request was rejected. Kept distinct so a truncated
 * response, a broken tool protocol, and a genuine schema mismatch are not all
 * reported to the user as "schema retry".
 */
export type StructuredFailureKind =
    | 'protocolViolation'
    | 'missingOutput'
    | 'schemaMismatch'
    | 'evidencePrecondition'
    | 'outputExhausted'
    | 'providerError';

export type StructuredFieldIssueKind =
    | 'tooManyItems'
    | 'tooFewItems'
    | 'invalidFormat'
    | 'invalidType'
    | 'missing'
    | 'notAllowed'
    | 'custom';

/**
 * One localizable field-level rejection. Producers emit structured numbers and
 * type names instead of a pre-rendered English sentence so the Webview can
 * render "intentAnalysis.supportedBy has 9 items, at most 8 allowed" in the
 * user's language.
 */
export interface StructuredFieldIssue {
    /** Dotted JSON path such as `investigation.findings[0].evidenceRefs`. */
    path: string;
    kind: StructuredFieldIssueKind;
    /** Allowed bound for the item-count kinds. */
    limit?: number;
    /** Observed item count for the item-count kinds. */
    count?: number;
    /** Required pattern, type, or enum list. */
    expected?: string;
    /** Observed type or value. */
    actual?: string;
    /** Provider text, used only by the custom kind. */
    message?: string;
}

export interface StructuredValidationPayload {
    stage: string;
    profile?: string;
    failureKind: StructuredFailureKind;
    attempt: number;
    totalAttempts: number;
    finalFailure: boolean;
    fieldIssues?: StructuredFieldIssue[];
    error?: string;
}

export type PipelineEventDetails =
    | { kind: 'evidenceReady'; files: EvidenceFileEntry[]; fileCount: number; rawFiles: number; summarizedFiles: number; initialEstimatedInputTokens: number; maxInputTokens: number; contextWindowTokens: number; hardInputTokens: number; compressionTriggerTokens: number; maxOutputTokens: number; safetyTokens?: number }
    | { kind: 'summarizeProgress'; file: string; summary: string; breaking: boolean; current: number; total: number }
    | { kind: 'summarizeFailed'; target: string; error: string }
    | { kind: 'evidenceRouted'; target: string; rawFiles: number; summarizedFiles: number; initialEstimatedInputTokens: number; estimatedInputTokens: number; maxInputTokens: number; didSummarize: boolean; forced?: boolean }
    | { kind: 'changeExtracted'; symbols: string[]; symbolCount: number; configCount: number; typeCount: number; dependencyCount: number }
    | { kind: 'investigationPlanned'; targets: string[]; targetCount: number; questionCount: number }
    | { kind: 'investigationStart'; maxSteps: number }
    | { kind: 'investigationStep'; current: number; total: number; tool: string; reason?: string; summary?: string; ok: boolean; evidenceCount?: number }
    | { kind: 'memoryStep'; current: number; total?: number; trigger?: string; status?: string; tool: string; reason?: string; summary?: string; ok: boolean; evidenceCount?: number; sourceStatuses?: string[]; attempt?: number; totalAttempts?: number; issues?: string[] }
    | { kind: 'investigationComplete'; steps: number; evidenceCount: number }
    | { kind: 'investigationResolved'; findingCount: number; unresolvedCount: number; reason: string }
    | { kind: 'investigationSkipped'; reason: string }
    | { kind: 'analysisDegraded'; status: string; issueCount: number; reason: string }
    | { kind: 'contextCompacted'; epoch: number; reason: string; estimatedTokens?: number }
    | { kind: 'semanticAnalysisComplete'; primaryIntent?: string; observableEffect?: string; recommendedType?: string; confidence?: string; factCount: number; uncertaintyCount: number }
    | { kind: 'informationSelected'; mustExpress: string[]; optional: string[]; omitCount: number; suggestedScope?: string; recommendedType?: string }
    | { kind: 'ragPrepared'; mustExpress: string[]; type: string | null; scope: string | null; changeSetSummary: string; retrievalFeatures: string[] }
    | { kind: 'ragRetrieved'; count: number; references: RagReferenceEntry[] }
    | { kind: 'ragRetrievalSkipped'; error: string }
    | { kind: 'commitMessage'; message: string; source: CommitMessageSource }
    | { kind: 'strictFixStart'; problems: string[] }
    | {
        kind: 'structuredValidation';
        stage: string;
        profile?: string;
        failureKind: StructuredFailureKind;
        status: 'retrying' | 'failed';
        attempt: number;
        totalAttempts: number;
        fieldIssues: StructuredFieldIssue[];
        error?: string;
    };

export interface PipelineEventPresentation {
    stage: string;
    phase: string;
    title: string;
    description: string;
    metrics: PipelineMetric[];
    tone: 'neutral' | 'active' | 'success' | 'warning';
    details?: PipelineEventDetails;
    data: Record<string, unknown>;
}

export interface StructuredValidationPresentation {
    title: string;
    tone: 'warning';
    details: Extract<PipelineEventDetails, { kind: 'structuredValidation' }>;
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
        target: 'changeExtraction' | 'semanticAnalysis' | 'draft';
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

/**
 * Every stage `presentPipelineEvent` can render. Kept as a union so the badge
 * table below is exhaustive by construction: a new stage cannot be presented
 * without also being given a badge.
 */
export type PipelineStageName =
    | 'evidenceReady'
    | 'summarizeStart'
    | 'summarizeProgress'
    | 'summarizeFailed'
    | 'evidenceRouted'
    | 'changeExtractionStart'
    | 'changeExtracted'
    | 'investigationPlanStart'
    | 'investigationPlanned'
    | 'investigationStart'
    | 'investigationStep'
    | 'memoryStep'
    | 'investigationComplete'
    | 'analysisFinalizing'
    | 'investigationResolved'
    | 'investigationSkipped'
    | 'semanticAnalysisComplete'
    | 'analysisDegraded'
    | 'contextCompacted'
    | 'informationSelected'
    | 'ragDisabled'
    | 'ragPrepared'
    | 'ragRetrievalStart'
    | 'ragRetrieved'
    | 'ragRetrievalSkipped'
    | 'draftStart'
    | 'classifyDraft'
    | 'validationStart'
    | 'validateFix'
    | 'strictFixStart'
    | 'strictFix'
    | 'enforceLanguageStart'
    | 'enforceLanguage'
    | 'done';

export interface PipelineStageBadge {
    label: string;
    className: string;
}

/**
 * Short badge shown beside each commit-stage log row.
 *
 * Keyed by exact stage name rather than matched by substring: stage names
 * overlap (`investigationPlanStart` contains both "investigation" and "plan"),
 * so substring matching silently mislabels rows and, worse, leaves newly added
 * stages unmatched.
 */
export const PIPELINE_STAGE_BADGES: Record<PipelineStageName, PipelineStageBadge> = {
    evidenceReady: { label: 'EVD', className: 'stage-badge-data' },
    evidenceRouted: { label: 'EVD', className: 'stage-badge-data' },
    summarizeStart: { label: 'SUM', className: 'stage-badge-summarize' },
    summarizeProgress: { label: 'SUM', className: 'stage-badge-summarize' },
    summarizeFailed: { label: 'SUM', className: 'stage-badge-summarize' },
    changeExtractionStart: { label: 'EXTR', className: 'stage-badge-extract' },
    changeExtracted: { label: 'EXTR', className: 'stage-badge-extract' },
    investigationPlanStart: { label: 'PLAN', className: 'stage-badge-plan' },
    investigationPlanned: { label: 'PLAN', className: 'stage-badge-plan' },
    investigationStart: { label: 'INVG', className: 'stage-badge-investigate' },
    investigationStep: { label: 'INVG', className: 'stage-badge-investigate' },
    memoryStep: { label: 'MEM', className: 'stage-badge-memory' },
    investigationComplete: { label: 'INVG', className: 'stage-badge-investigate' },
    analysisFinalizing: { label: 'FINL', className: 'stage-badge-semantic' },
    investigationResolved: { label: 'INVG', className: 'stage-badge-investigate' },
    investigationSkipped: { label: 'SKIP', className: 'stage-badge-skipped' },
    semanticAnalysisComplete: { label: 'SEM', className: 'stage-badge-semantic' },
    analysisDegraded: { label: 'WARN', className: 'stage-badge-warning' },
    contextCompacted: { label: 'CTX', className: 'stage-badge-summarize' },
    informationSelected: { label: 'SEL', className: 'stage-badge-select' },
    ragDisabled: { label: 'RAG', className: 'stage-badge-rag' },
    ragPrepared: { label: 'RAG', className: 'stage-badge-rag' },
    ragRetrievalStart: { label: 'RAG', className: 'stage-badge-rag' },
    ragRetrieved: { label: 'RAG', className: 'stage-badge-rag' },
    ragRetrievalSkipped: { label: 'RAG', className: 'stage-badge-rag' },
    draftStart: { label: 'DRFT', className: 'stage-badge-classify' },
    classifyDraft: { label: 'DRFT', className: 'stage-badge-classify' },
    validationStart: { label: 'CHK', className: 'stage-badge-verify' },
    validateFix: { label: 'CHK', className: 'stage-badge-verify' },
    strictFixStart: { label: 'CHK', className: 'stage-badge-verify' },
    strictFix: { label: 'CHK', className: 'stage-badge-verify' },
    enforceLanguageStart: { label: 'CHK', className: 'stage-badge-verify' },
    enforceLanguage: { label: 'CHK', className: 'stage-badge-verify' },
    done: { label: 'DONE', className: 'stage-badge-done' },
};

/**
 * Badge for a stage read off a log payload. Returns a generic badge for stages
 * this build does not know: the badge is decorative, and a persisted log from a
 * newer build must not be able to break the log list.
 */
export function pipelineStageBadge(stage: string): PipelineStageBadge {
    return PIPELINE_STAGE_BADGES[stage as PipelineStageName]
        ?? { label: 'STG', className: 'stage-badge-tool' };
}

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

function handoffTargetLabel(target: unknown, text: PipelineTextCatalog): string {
    switch (target) {
        case 'changeExtraction':
            return text.extractInput;
        case 'semanticAnalysis':
            return text.analyzeInput;
        default:
            return text.draftInput;
    }
}

function asStringList(value: unknown, limit: number): string[] {
    return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).slice(0, limit)
        : [];
}

function asFullStringList(value: unknown, stage: string, field: string): string[] {
    if (!Array.isArray(value)) {
        throw new Error(`Commit pipeline stage '${stage}' is missing required field '${field}'.`);
    }
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function requireNumberField(data: Record<string, unknown>, stage: string, field: string): number {
    const value = asNumber(data[field]);
    if (value === undefined) {
        throw new Error(`Commit pipeline stage '${stage}' is missing required field '${field}'.`);
    }
    return value;
}

function requireStringField(data: Record<string, unknown>, stage: string, field: string): string {
    const value = asString(data[field]);
    if (!value) {
        throw new Error(`Commit pipeline stage '${stage}' is missing required field '${field}'.`);
    }
    return value;
}

function requireBooleanField(data: Record<string, unknown>, stage: string, field: string): boolean {
    if (typeof data[field] !== 'boolean') {
        throw new Error(`Commit pipeline stage '${stage}' is missing required field '${field}'.`);
    }
    return data[field];
}

function requireMessageField(data: Record<string, unknown>, stage: string, field: string): string {
    if (typeof data[field] !== 'string') {
        throw new Error(`Commit pipeline stage '${stage}' is missing required field '${field}'.`);
    }
    return data[field];
}

function optionalMessageField(data: Record<string, unknown>, field: string): string {
    return typeof data[field] === 'string' ? data[field] : '';
}

function parseEvidenceFiles(value: unknown, stage: string): EvidenceFileEntry[] {
    if (!Array.isArray(value)) {
        throw new Error(`Commit pipeline stage '${stage}' is missing required field 'files'.`);
    }
    return value.map((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            throw new Error(`Commit pipeline stage '${stage}' has invalid files[${index}].`);
        }
        const record = entry as Record<string, unknown>;
        return {
            file: requireStringField(record, stage, 'file'),
            status: requireStringField(record, stage, 'status'),
        };
    });
}

function formatRetrievalFeatures(features: Record<string, unknown>): string[] {
    const lines: string[] = [];
    const predictedType = asString(features.predictedType);
    const predictedScope = asString(features.predictedScope);
    const fileCount = asNumber(features.fileCount);
    if (predictedType) {
        lines.push(`type: ${predictedType}`);
    }
    if (predictedScope) {
        lines.push(`scope: ${predictedScope}`);
    }
    if (fileCount !== undefined) {
        lines.push(`fileCount: ${fileCount}`);
    }
    for (const key of ['areas', 'fileKinds', 'changeActions', 'entities', 'touchedPaths', 'fileExtensions', 'statusMix'] as const) {
        if (!Array.isArray(features[key])) {
            continue;
        }
        const list = features[key].filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
        if (list.length) {
            lines.push(`${key}: ${list.join(', ')}`);
        }
    }
    for (const flag of ['hasDocs', 'hasTests', 'hasConfig', 'hasRenames', 'isCrossLayer', 'breakingLike'] as const) {
        if (typeof features[flag] === 'boolean') {
            lines.push(`${flag}: ${features[flag]}`);
        }
    }
    return lines;
}

function buildDetailsForStage(stage: PipelineStageName, data: Record<string, unknown>): PipelineEventDetails | undefined {
    switch (stage) {
        case 'evidenceReady':
            return {
                kind: 'evidenceReady',
                files: parseEvidenceFiles(data.files, stage),
                fileCount: requireNumberField(data, stage, 'fileCount'),
                rawFiles: requireNumberField(data, stage, 'rawFiles'),
                summarizedFiles: requireNumberField(data, stage, 'summarizedFiles'),
                initialEstimatedInputTokens: requireNumberField(data, stage, 'initialEstimatedInputTokens'),
                maxInputTokens: requireNumberField(data, stage, 'maxInputTokens'),
                contextWindowTokens: requireNumberField(data, stage, 'contextWindowTokens'),
                hardInputTokens: requireNumberField(data, stage, 'hardInputTokens'),
                compressionTriggerTokens: requireNumberField(data, stage, 'compressionTriggerTokens'),
                maxOutputTokens: requireNumberField(data, stage, 'maxOutputTokens'),
                ...(asNumber(data.safetyTokens) !== undefined ? { safetyTokens: asNumber(data.safetyTokens) } : {}),
            };
        case 'summarizeProgress':
            return {
                kind: 'summarizeProgress',
                file: requireStringField(data, stage, 'file'),
                summary: requireStringField(data, stage, 'summary'),
                breaking: requireBooleanField(data, stage, 'breaking'),
                current: requireNumberField(data, stage, 'current'),
                total: requireNumberField(data, stage, 'total'),
            };
        case 'summarizeFailed':
            return {
                kind: 'summarizeFailed',
                target: requireStringField(data, stage, 'target'),
                error: requireStringField(data, stage, 'error'),
            };
        case 'evidenceRouted':
            return {
                kind: 'evidenceRouted',
                target: requireStringField(data, stage, 'target'),
                rawFiles: requireNumberField(data, stage, 'rawFiles'),
                summarizedFiles: requireNumberField(data, stage, 'summarizedFiles'),
                initialEstimatedInputTokens: requireNumberField(data, stage, 'initialEstimatedInputTokens'),
                estimatedInputTokens: requireNumberField(data, stage, 'estimatedInputTokens'),
                maxInputTokens: requireNumberField(data, stage, 'maxInputTokens'),
                didSummarize: requireBooleanField(data, stage, 'didSummarize'),
                ...(typeof data.forced === 'boolean' ? { forced: data.forced } : {}),
            };
        case 'changeExtracted':
            return {
                kind: 'changeExtracted',
                symbols: asFullStringList(data.symbols, stage, 'symbols'),
                symbolCount: requireNumberField(data, stage, 'symbolCount'),
                configCount: requireNumberField(data, stage, 'configCount'),
                typeCount: requireNumberField(data, stage, 'typeCount'),
                dependencyCount: requireNumberField(data, stage, 'dependencyCount'),
            };
        case 'investigationPlanned':
            return {
                kind: 'investigationPlanned',
                targets: asFullStringList(data.targets, stage, 'targets'),
                targetCount: requireNumberField(data, stage, 'targetCount'),
                questionCount: requireNumberField(data, stage, 'questionCount'),
            };
        case 'investigationStart':
            return {
                kind: 'investigationStart',
                maxSteps: requireNumberField(data, stage, 'maxSteps'),
            };
        case 'investigationStep':
            return {
                kind: stage,
                current: requireNumberField(data, stage, 'current'),
                total: requireNumberField(data, stage, 'total'),
                tool: requireStringField(data, stage, 'tool'),
                ok: requireBooleanField(data, stage, 'ok'),
                ...(asString(data.reason) ? { reason: asString(data.reason) } : {}),
                ...(asString(data.summary) ? { summary: asString(data.summary) } : {}),
                ...(asNumber(data.evidenceCount) !== undefined ? { evidenceCount: asNumber(data.evidenceCount) } : {}),
            };
        case 'memoryStep': {
            const hasAttemptDetails = data.attempt !== undefined || data.totalAttempts !== undefined || data.issues !== undefined;
            return {
                kind: stage,
                current: requireNumberField(data, stage, 'current'),
                // Maintenance events are operations, not steps in the generation's tool budget.
                ...(data.trigger ? { trigger: requireStringField(data, stage, 'trigger'), status: requireStringField(data, stage, 'status') }
                    : { total: requireNumberField(data, stage, 'total') }),
                tool: requireStringField(data, stage, 'tool'),
                ok: requireBooleanField(data, stage, 'ok'),
                ...(asString(data.reason) ? { reason: asString(data.reason) } : {}),
                ...(asString(data.summary) ? { summary: asString(data.summary) } : {}),
                ...(asNumber(data.evidenceCount) !== undefined ? { evidenceCount: asNumber(data.evidenceCount) } : {}),
                ...(Array.isArray(data.sourceStatuses) ? { sourceStatuses: asFullStringList(data.sourceStatuses, stage, 'sourceStatuses') } : {}),
                ...(hasAttemptDetails ? {
                    attempt: requireNumberField(data, stage, 'attempt'),
                    totalAttempts: requireNumberField(data, stage, 'totalAttempts'),
                    issues: asFullStringList(data.issues, stage, 'issues'),
                } : {}),
            };
        }
        case 'investigationComplete':
            return {
                kind: 'investigationComplete',
                steps: requireNumberField(data, stage, 'steps'),
                evidenceCount: requireNumberField(data, stage, 'evidenceCount'),
            };
        case 'investigationResolved':
            return {
                kind: 'investigationResolved',
                findingCount: requireNumberField(data, stage, 'findingCount'),
                unresolvedCount: requireNumberField(data, stage, 'unresolvedCount'),
                reason: requireStringField(data, stage, 'reason'),
            };
        case 'investigationSkipped':
            return {
                kind: 'investigationSkipped',
                reason: requireStringField(data, stage, 'reason'),
            };
        case 'analysisDegraded':
            return {
                kind: 'analysisDegraded',
                status: requireStringField(data, stage, 'status'),
                issueCount: requireNumberField(data, stage, 'issueCount'),
                reason: requireStringField(data, stage, 'reason'),
            };
        case 'contextCompacted':
            return {
                kind: 'contextCompacted',
                epoch: requireNumberField(data, stage, 'epoch'),
                reason: requireStringField(data, stage, 'reason'),
                ...(asNumber(data.estimatedTokens) !== undefined ? { estimatedTokens: asNumber(data.estimatedTokens) } : {}),
            };
        case 'semanticAnalysisComplete':
            return {
                kind: 'semanticAnalysisComplete',
                factCount: requireNumberField(data, stage, 'factCount'),
                uncertaintyCount: requireNumberField(data, stage, 'uncertaintyCount'),
                ...(asString(data.primaryIntent) ? { primaryIntent: asString(data.primaryIntent) } : {}),
                ...(asString(data.observableEffect) ? { observableEffect: asString(data.observableEffect) } : {}),
                ...(asString(data.recommendedType) ? { recommendedType: asString(data.recommendedType) } : {}),
                ...(asString(data.confidence) ? { confidence: asString(data.confidence) } : {}),
            };
        case 'informationSelected':
            return {
                kind: 'informationSelected',
                mustExpress: asFullStringList(data.mustExpress, stage, 'mustExpress'),
                optional: asFullStringList(data.optional, stage, 'optional'),
                omitCount: requireNumberField(data, stage, 'omitCount'),
                ...(asString(data.suggestedScope) ? { suggestedScope: asString(data.suggestedScope) } : {}),
                ...(asString(data.recommendedType) ? { recommendedType: asString(data.recommendedType) } : {}),
            };
        case 'ragPrepared': {
            const query = (data.query || {}) as Record<string, unknown>;
            const changeSetSummary = (data.changeSetSummary || {}) as Record<string, unknown>;
            const retrievalFeatures = (data.retrievalFeatures || {}) as Record<string, unknown>;
            return {
                kind: 'ragPrepared',
                mustExpress: asFullStringList(query.mustExpress, stage, 'query.mustExpress'),
                type: typeof query.type === 'string' || query.type === null ? query.type : null,
                scope: typeof query.scope === 'string' || query.scope === null ? query.scope : null,
                changeSetSummary: optionalMessageField(changeSetSummary, 'text'),
                retrievalFeatures: formatRetrievalFeatures(retrievalFeatures),
            };
        }
        case 'ragRetrieved': {
            const references = Array.isArray(data.references) ? data.references : [];
            return {
                kind: 'ragRetrieved',
                count: requireNumberField(data, stage, 'count'),
                references: references.map((entry, index) => {
                    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                        throw new Error(`Commit pipeline stage '${stage}' has invalid references[${index}].`);
                    }
                    const record = entry as Record<string, unknown>;
                    return {
                        message: requireMessageField(record, stage, 'message'),
                        styleReason: requireStringField(record, stage, 'styleReason'),
                        matchedBy: asFullStringList(record.matchedBy, stage, 'matchedBy'),
                        ...(asString(record.subject) ? { subject: asString(record.subject) } : {}),
                        ...(asString(record.commitHash) ? { commitHash: asString(record.commitHash) } : {}),
                    };
                }),
            };
        }
        case 'ragRetrievalSkipped':
            return {
                kind: 'ragRetrievalSkipped',
                error: requireStringField(data, stage, 'error'),
            };
        case 'classifyDraft':
            return {
                kind: 'commitMessage',
                message: requireMessageField(data, stage, 'draft'),
                source: 'draft',
            };
        case 'validateFix':
            return {
                kind: 'commitMessage',
                message: requireMessageField(data, stage, 'validMessage'),
                source: 'validation',
            };
        case 'strictFixStart':
            return {
                kind: 'strictFixStart',
                problems: asFullStringList(data.problems, stage, 'problems'),
            };
        case 'strictFix':
            return {
                kind: 'commitMessage',
                message: requireMessageField(data, stage, 'message'),
                source: 'strictFix',
            };
        case 'enforceLanguage':
            return {
                kind: 'commitMessage',
                message: requireMessageField(data, stage, 'message'),
                source: 'languageEnforcement',
            };
        case 'done':
            return {
                kind: 'commitMessage',
                message: requireMessageField(data, stage, 'finalMessage'),
                source: 'final',
            };
        default:
            return undefined;
    }
}

export function isStructuredValidationLog(log: PipelineLogLike): boolean {
    const title = (log.title || '').toLowerCase();
    const reason = ((log as { reason?: string }).reason || '').toLowerCase();
    return log.type === 'toolCall' && (
        title.includes('schema validation')
        || title.includes('structured output')
        || reason.includes('schema validation')
        || reason.includes('structured output')
    );
}

const STRUCTURED_FAILURE_KINDS = new Set<string>([
    'protocolViolation',
    'missingOutput',
    'schemaMismatch',
    'evidencePrecondition',
    'outputExhausted',
    'providerError',
]);

const STRUCTURED_FIELD_ISSUE_KINDS = new Set<string>([
    'tooManyItems',
    'tooFewItems',
    'invalidFormat',
    'invalidType',
    'missing',
    'notAllowed',
    'custom',
]);

/** Names a failure category for the user without exposing internal wording. */
export function structuredFailureKindLabel(
    kind: StructuredFailureKind,
    text: PipelineTextCatalog = DEFAULT_PIPELINE_TEXT,
): string {
    switch (kind) {
        case 'protocolViolation':
            return text.detailProtocolViolation;
        case 'missingOutput':
            return text.detailMissingStructuredOutput;
        case 'schemaMismatch':
            return text.detailSchemaMismatch;
        case 'evidencePrecondition':
            return text.detailEvidencePrecondition;
        case 'outputExhausted':
            return text.detailOutputExhausted;
        case 'providerError':
            return text.detailProviderError;
    }
}

/**
 * Title for a structured-request rejection. Shared by the Webview row and the
 * Extension-side log title so both name the same failure category.
 */
export function structuredValidationTitle(
    payload: Pick<StructuredValidationPayload, 'stage' | 'profile' | 'failureKind' | 'finalFailure'>,
    text: PipelineTextCatalog = DEFAULT_PIPELINE_TEXT,
): string {
    const label = payload.profile ? `${payload.profile} ${payload.stage}` : payload.stage;
    switch (payload.failureKind) {
        case 'protocolViolation':
            return formatPipelineText(
                payload.finalFailure ? text.protocolViolationFailedTitle : text.protocolViolationRetryTitle,
                label,
            );
        case 'missingOutput':
            return formatPipelineText(
                payload.finalFailure ? text.structuredOutputFailedTitle : text.structuredOutputRetryTitle,
                label,
            );
        case 'schemaMismatch':
            return formatPipelineText(
                payload.finalFailure ? text.schemaValidationFailedTitle : text.schemaValidationRetryTitle,
                label,
            );
        case 'evidencePrecondition':
            return formatPipelineText(
                payload.finalFailure ? text.evidencePreconditionFailedTitle : text.evidencePreconditionRetryTitle,
                label,
            );
        case 'outputExhausted':
            return formatPipelineText(text.outputExhaustedTitle, label);
        case 'providerError':
            return formatPipelineText(text.providerErrorTitle, label);
    }
}

/** Renders one field-level rejection, e.g. `intentAnalysis.supportedBy has 9 items, at most 8 allowed`. */
export function formatStructuredFieldIssue(
    issue: StructuredFieldIssue,
    text: PipelineTextCatalog = DEFAULT_PIPELINE_TEXT,
): string {
    switch (issue.kind) {
        case 'tooManyItems':
            return formatPipelineText(text.fieldIssueTooManyItems, issue.path, issue.count ?? 0, issue.limit ?? 0);
        case 'tooFewItems':
            return formatPipelineText(text.fieldIssueTooFewItems, issue.path, issue.count ?? 0, issue.limit ?? 0);
        case 'invalidFormat':
            return formatPipelineText(text.fieldIssueInvalidFormat, issue.path, issue.actual ?? '', issue.expected ?? '');
        case 'invalidType':
            return formatPipelineText(text.fieldIssueInvalidType, issue.path, issue.expected ?? '', issue.actual ?? '');
        case 'missing':
            return formatPipelineText(text.fieldIssueMissing, issue.path);
        case 'notAllowed':
            return formatPipelineText(text.fieldIssueNotAllowed, issue.path);
        case 'custom':
            return formatPipelineText(text.fieldIssueCustom, issue.path, issue.message ?? '');
    }
}

function parseStructuredFieldIssues(value: unknown, logId: string): StructuredFieldIssue[] {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value)) {
        throw new Error(`Structured validation log '${logId}' has invalid fieldIssues.`);
    }
    return value.map((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            throw new Error(`Structured validation log '${logId}' has invalid fieldIssues[${index}].`);
        }
        const record = entry as Record<string, unknown>;
        const kind = asString(record.kind);
        if (!kind || !STRUCTURED_FIELD_ISSUE_KINDS.has(kind)) {
            throw new Error(`Structured validation log '${logId}' has an unknown fieldIssues[${index}].kind.`);
        }
        // Read `path` directly: the requireStringField helpers use their field
        // argument as the lookup key, so an indexed label cannot be passed there.
        const path = asString(record.path);
        if (!path) {
            throw new Error(`Structured validation log '${logId}' is missing fieldIssues[${index}].path.`);
        }
        return {
            path,
            kind: kind as StructuredFieldIssueKind,
            ...(asNumber(record.limit) !== undefined ? { limit: asNumber(record.limit) } : {}),
            ...(asNumber(record.count) !== undefined ? { count: asNumber(record.count) } : {}),
            ...(asString(record.expected) ? { expected: asString(record.expected) } : {}),
            ...(asString(record.actual) ? { actual: asString(record.actual) } : {}),
            ...(asString(record.message) ? { message: asString(record.message) } : {}),
        };
    });
}

export function presentStructuredValidationLog(
    log: PipelineLogLike,
    text: PipelineTextCatalog = DEFAULT_PIPELINE_TEXT
): StructuredValidationPresentation | null {
    if (!isStructuredValidationLog(log)) {
        return null;
    }
    if (!log.content) {
        throw new Error(`Structured validation log '${log.id}' is missing its payload.`);
    }
    const payload = JSON.parse(log.content) as Record<string, unknown>;
    const stage = requireStringField(payload, 'structuredValidation', 'stage');
    const failureKind = requireStringField(payload, 'structuredValidation', 'failureKind');
    if (!STRUCTURED_FAILURE_KINDS.has(failureKind)) {
        throw new Error(`Structured validation log '${log.id}' has unknown failureKind '${failureKind}'.`);
    }
    const finalFailure = requireBooleanField(payload, 'structuredValidation', 'finalFailure');
    const profile = asString(payload.profile);
    return {
        title: structuredValidationTitle(
            { stage, failureKind: failureKind as StructuredFailureKind, finalFailure, ...(profile ? { profile } : {}) },
            text,
        ),
        tone: 'warning',
        details: {
            kind: 'structuredValidation',
            stage,
            ...(profile ? { profile } : {}),
            failureKind: failureKind as StructuredFailureKind,
            status: finalFailure ? 'failed' : 'retrying',
            attempt: requireNumberField(payload, 'structuredValidation', 'attempt'),
            totalAttempts: requireNumberField(payload, 'structuredValidation', 'totalAttempts'),
            fieldIssues: parseStructuredFieldIssues(payload.fieldIssues, log.id),
            ...(asString(payload.error) ? { error: asString(payload.error) } : {}),
        },
        data: payload,
    };
}

export function presentPipelineEvent(
    payload: CommitStagePayload,
    text: PipelineTextCatalog = DEFAULT_PIPELINE_TEXT
): PipelineEventPresentation {
    const presentation = presentPipelineEventCore(payload, text);
    const details = buildDetailsForStage(payload.stage as PipelineStageName, payload.data);
    return details ? { ...presentation, details } : presentation;
}

function presentPipelineEventCore(
    payload: CommitStagePayload,
    text: PipelineTextCatalog = DEFAULT_PIPELINE_TEXT
): PipelineEventPresentation {
    const { stage, data } = payload;
    const fileCount = asNumber(data.fileCount);
    const rawFiles = asNumber(data.rawFiles);
    const summarizedFiles = asNumber(data.summarizedFiles);
    const estimatedTokens = asNumber(data.estimatedInputTokens);
    const maxInputTokens = asNumber(data.maxInputTokens);
    const contextWindowTokens = asNumber(data.contextWindowTokens);
    const maxOutputTokens = asNumber(data.maxOutputTokens);
    const compressionTriggerTokens = asNumber(data.compressionTriggerTokens);
    const target = handoffTargetLabel(data.target, text);

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
                    ...(contextWindowTokens !== undefined ? [{ label: text.metricContext, value: formatInteger(contextWindowTokens), tone: 'budget' as const }] : []),
                    ...(maxOutputTokens !== undefined ? [{ label: text.metricOutput, value: formatInteger(maxOutputTokens), tone: 'budget' as const }] : []),
                    ...(compressionTriggerTokens !== undefined ? [{ label: text.metricTrigger, value: formatInteger(compressionTriggerTokens), tone: 'budget' as const }] : []),
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
        case 'summarizeFailed':
            return {
                stage,
                phase: text.phaseTransform,
                title: text.summarizeFailedTitle,
                description: asString(data.error) || text.summarizeFailedDefault,
                metrics: [{ label: text.metricInput, value: target, tone: 'summary' }],
                tone: 'warning',
                data,
            };
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
        case 'changeExtractionStart':
            return {
                stage,
                phase: text.phaseExtract,
                title: text.changeExtractionStartTitle,
                description: text.changeExtractionStartDescription,
                metrics: [],
                tone: 'active',
                data,
            };
        case 'changeExtracted': {
            const symbols = asStringList(data.symbols, 4);
            const symbolCount = asNumber(data.symbolCount) ?? symbols.length;
            return {
                stage,
                phase: text.phaseExtract,
                title: text.changeExtractedTitle,
                description: symbols.length
                    ? formatPipelineText(text.changeExtractedDescription, symbols.join(', '))
                    : text.changeExtractedEmptyDescription,
                metrics: [
                    { label: text.metricSymbols, value: String(symbolCount) },
                    ...(asNumber(data.configCount) ? [{ label: text.metricScope, value: String(asNumber(data.configCount)) }] : []),
                ],
                tone: 'success',
                data,
            };
        }
        case 'investigationPlanStart':
            return {
                stage,
                phase: text.phaseInvestigate,
                title: text.investigationPlanStartTitle,
                description: text.investigationPlanStartDescription,
                metrics: [],
                tone: 'active',
                data,
            };
        case 'investigationPlanned': {
            const targets = asStringList(data.targets, 4);
            return {
                stage,
                phase: text.phaseInvestigate,
                title: text.investigationPlannedTitle,
                description: formatPipelineText(text.investigationPlannedDescription, targets.join(', ')),
                metrics: [
                    { label: text.metricTargets, value: String(asNumber(data.targetCount) ?? targets.length) },
                    ...(asNumber(data.questionCount) !== undefined
                        ? [{ label: text.metricQuestions, value: String(asNumber(data.questionCount)) }]
                        : []),
                ],
                tone: 'success',
                data,
            };
        }
        case 'investigationStart':
            return {
                stage,
                phase: text.phaseInvestigate,
                title: text.investigationStartTitle,
                description: text.investigationStartDescription,
                metrics: asNumber(data.maxSteps) !== undefined
                    ? [{ label: text.metricBudget, value: String(asNumber(data.maxSteps)), tone: 'budget' }]
                    : [],
                tone: 'active',
                data,
            };
        case 'investigationStep': {
            const current = asNumber(data.current) ?? 0;
            const tool = asString(data.tool) || 'search';
            return {
                stage,
                phase: text.phaseInvestigate,
                title: formatPipelineText(text.investigationStepTitle, current, tool),
                description: asString(data.summary) || asString(data.reason) || text.investigationStepDefault,
                metrics: [
                    { label: text.metricProgress, value: `${current}/${asNumber(data.total) ?? 0}` },
                    ...(asNumber(data.evidenceCount)
                        ? [{ label: text.metricEvidence, value: String(asNumber(data.evidenceCount)), tone: 'summary' as const }]
                        : []),
                ],
                tone: data.ok === false ? 'warning' : 'success',
                data,
            };
        }
        case 'memoryStep': {
            const current = asNumber(data.current) ?? 0;
            const tool = asString(data.tool) || 'memory';
            return {
                stage,
                phase: text.phaseInvestigate,
                title: asString(data.label) || formatPipelineText(text.memoryStepTitle, current, tool),
                description: asString(data.summary) || asString(data.reason) || text.memoryStepDefault,
                metrics: [
                    ...(data.trigger ? [] : [{ label: text.metricProgress, value: `${current}/${asNumber(data.total) ?? 0}` }]),
                    ...(asNumber(data.evidenceCount)
                        ? [{ label: text.metricEvidence, value: String(asNumber(data.evidenceCount)), tone: 'summary' as const }]
                        : []),
                ],
                tone: data.ok === false ? 'warning' : data.status === 'running' ? 'active'
                    : data.trigger && !['completed', 'published'].includes(asString(data.status) ?? '') ? 'neutral' : 'success',
                data,
            };
        }
        case 'investigationComplete': {
            const steps = asNumber(data.steps) ?? 0;
            const evidenceCount = asNumber(data.evidenceCount) ?? 0;
            return {
                stage,
                phase: text.phaseInvestigate,
                title: text.investigationCompleteTitle,
                description: formatPipelineText(text.investigationCompleteDescription, steps, evidenceCount),
                metrics: [
                    { label: text.metricSteps, value: String(steps) },
                    { label: text.metricEvidence, value: String(evidenceCount), tone: 'summary' },
                ],
                tone: 'success',
                data,
            };
        }
        case 'analysisFinalizing':
            return {
                stage,
                phase: text.phaseAnalyze,
                title: text.analysisFinalizingTitle,
                description: text.analysisFinalizingDescription,
                metrics: [],
                tone: 'active',
                data,
            };
        case 'investigationResolved': {
            const findingCount = asNumber(data.findingCount) ?? 0;
            return {
                stage,
                phase: text.phaseInvestigate,
                title: text.investigationResolvedTitle,
                description: findingCount
                    ? formatPipelineText(text.investigationResolvedDescription, asString(data.reason) || text.investigationStepDefault)
                    : text.investigationResolvedEmptyDescription,
                metrics: [
                    { label: text.metricFindings, value: String(findingCount) },
                    ...(asNumber(data.unresolvedCount)
                        ? [{ label: text.metricUnresolved, value: String(asNumber(data.unresolvedCount)) }]
                        : []),
                ],
                tone: 'success',
                data,
            };
        }
        case 'investigationSkipped':
            return {
                stage,
                phase: text.phaseInvestigate,
                title: text.investigationSkippedTitle,
                description: asString(data.reason) || text.investigationSkippedDefault,
                metrics: [],
                tone: 'neutral',
                data,
            };
        case 'semanticAnalysisComplete': {
            const intent = asString(data.primaryIntent);
            const effect = asString(data.observableEffect);
            return {
                stage,
                phase: text.phaseAnalyze,
                title: text.semanticAnalysisCompleteTitle,
                description: intent || effect
                    ? formatPipelineText(text.semanticAnalysisCompleteDescription, intent || effect!)
                    : text.semanticAnalysisNoIntentDescription,
                metrics: [
                    ...(asString(data.recommendedType)
                        ? [{ label: text.metricType, value: asString(data.recommendedType)!, tone: 'rag' as const }]
                        : []),
                    ...(asString(data.confidence)
                        ? [{ label: text.metricConfidence, value: asString(data.confidence)! }]
                        : []),
                    { label: text.metricEvidence, value: String(asNumber(data.factCount) ?? 0), tone: 'summary' },
                ],
                tone: 'success',
                data,
            };
        }
        case 'analysisDegraded':
            return {
                stage,
                phase: text.phaseAnalyze,
                title: text.semanticAnalysisDegradedTitle,
                description: asString(data.reason) || text.semanticAnalysisNoIntentDescription,
                metrics: [],
                tone: 'warning',
                data,
            };
        case 'contextCompacted':
            return {
                stage,
                phase: text.phaseTransform,
                title: text.summarizeStartTitle,
                description: asString(data.reason) || text.summarizeStartDescription,
                metrics: asNumber(data.epoch) !== undefined
                    ? [{ label: text.metricProgress, value: String(asNumber(data.epoch)), tone: 'budget' }]
                    : [],
                tone: 'success',
                data,
            };
        case 'informationSelected': {
            const mustExpress = asStringList(data.mustExpress, 3);
            return {
                stage,
                phase: text.phaseSelect,
                title: text.informationSelectedTitle,
                description: mustExpress.length
                    ? formatPipelineText(text.informationSelectedDescription, mustExpress.join(' / '))
                    : text.informationSelectionEmptyDescription,
                metrics: [
                    { label: text.metricMustExpress, value: String(mustExpress.length) },
                    ...(asNumber(data.omitCount)
                        ? [{ label: text.metricOmitted, value: String(asNumber(data.omitCount)) }]
                        : []),
                    ...(asString(data.suggestedScope)
                        ? [{ label: text.metricScope, value: asString(data.suggestedScope)!, tone: 'rag' as const }]
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
        .filter((payload): payload is CommitStagePayload => payload !== null)
        // Maintenance remains visible in the log list, but belongs to no commit generation.
        .filter(payload => payload.stage !== 'memoryStep' || !['manual', 'automatic'].includes(asString(payload.data.trigger) ?? ''));
    if (!events.length) {
        return null;
    }

    const stepStates: Record<PipelineStepId, PipelineStepState> = {
        evidence: 'pending',
        summary: 'pending',
        extract: 'pending',
        investigate: 'pending',
        analyze: 'pending',
        select: 'pending',
        rag: 'pending',
        draft: 'pending',
        verify: 'pending',
    };
    let changeConditioned = false;
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
            case 'summarizeFailed':
                stepStates.summary = 'warning';
                degraded = true;
                break;
            case 'evidenceRouted':
                if (data.didSummarize === true) {
                    stepStates.summary = 'complete';
                } else if (stepStates.summary === 'pending') {
                    stepStates.summary = 'skipped';
                }
                if (
                    (data.target === 'draft' || data.target === 'changeExtraction' || data.target === 'semanticAnalysis')
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
            case 'changeExtractionStart':
                changeConditioned = true;
                stepStates.extract = 'active';
                break;
            case 'changeExtracted':
                changeConditioned = true;
                stepStates.extract = 'complete';
                break;
            case 'investigationPlanStart':
            case 'investigationPlanned':
            case 'investigationStart':
            case 'investigationStep':
            case 'memoryStep':
                changeConditioned = true;
                stepStates.investigate = 'active';
                break;
            case 'investigationComplete':
            case 'investigationResolved':
                changeConditioned = true;
                stepStates.investigate = 'complete';
                break;
            case 'investigationSkipped':
                changeConditioned = true;
                stepStates.investigate = 'skipped';
                break;
            case 'analysisFinalizing':
                changeConditioned = true;
                stepStates.analyze = degraded ? 'warning' : 'active';
                stepStates.select = degraded ? 'warning' : 'active';
                break;
            case 'semanticAnalysisComplete':
                changeConditioned = true;
                stepStates.analyze = degraded ? 'warning' : 'complete';
                break;
            case 'analysisDegraded':
                changeConditioned = true;
                stepStates.analyze = 'warning';
                stepStates.select = 'warning';
                degraded = true;
                break;
            case 'contextCompacted':
                break;
            case 'informationSelected':
                changeConditioned = true;
                stepStates.select = degraded ? 'warning' : 'complete';
                break;
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
        steps: PIPELINE_STEP_ORDER
            .filter(id => changeConditioned || !CHANGE_CONDITIONED_STEPS.includes(id))
            .map(id => ({
                id,
                label: {
                    evidence: text.stepEvidence,
                    summary: text.stepSummary,
                    extract: text.stepExtract,
                    investigate: text.stepInvestigate,
                    analyze: text.stepAnalyze,
                    select: text.stepSelect,
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
