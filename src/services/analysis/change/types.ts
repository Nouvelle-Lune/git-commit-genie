// Data contracts for the change-conditioned analysis pipeline.
//
// The pipeline answers "what does this specific change mean in this
// repository?" instead of "what is this repository?". Every stage keeps
// observed facts separate from inference so a later stage can decide what is
// actually provable, and the commit generator only ever receives conclusions
// that carry repository evidence.

import { DiffData } from '../../git/gitTypes';
import type { AgentRunMetrics } from '../../../agent/runtime';
import type { RepositoryAnalysis } from '../repository/repositoryAnalysisTypes';

export type RepositoryAnalysisContext = Partial<Pick<
    RepositoryAnalysis,
    'summary' | 'projectType' | 'technologies' | 'insights'
>>;

export interface ChangeAnalysisInputs {
    repositoryPath?: string;
    repositoryAnalysis?: RepositoryAnalysisContext;
    userTemplate?: string;
}

export interface EvidenceChange {
    action: string;
    target: string;
    behavior: string;
    exactSymbols: string[];
    evidenceHunkIds: string[];
}

export interface EvidenceObservation {
    detail: string;
    evidenceHunkIds: string[];
}

export interface EvidenceSummaryResponse {
    changes: EvidenceChange[];
    tests: EvidenceObservation[];
    breakingSignals: EvidenceObservation[];
    uncertainties: EvidenceObservation[];
}

export interface RawDiffEvidence {
    kind: 'raw';
    fileName: string;
    status: DiffData['status'];
    /** Globally unique D identifiers allocated before the first model call. */
    evidenceIds: string[];
    rawDiff: string;
}

export interface FileEvidence {
    kind: 'summary';
    fileName: string;
    status: DiffData['status'];
    coveredHunkIds: string[];
    changes: EvidenceChange[];
    tests: EvidenceObservation[];
    breakingSignals: EvidenceObservation[];
    uncertainties: EvidenceObservation[];
}

export type DraftEvidence = RawDiffEvidence | FileEvidence;

export type ChangeKind =
    | 'added'
    | 'removed'
    | 'signature'
    | 'function_body'
    | 'type_shape'
    | 'value'
    | 'renamed'
    | 'moved'
    | 'unknown';

export type ChangedSymbolType =
    | 'function'
    | 'method'
    | 'class'
    | 'interface'
    | 'type'
    | 'constant'
    | 'variable'
    | 'config_key'
    | 'route'
    | 'cli_flag'
    | 'unknown';

export interface ChangedFile {
    path: string;
    changeType: DiffData['status'];
}

export interface ChangedSymbol {
    name: string;
    file: string;
    symbolType: ChangedSymbolType;
    changeKind: ChangeKind;
    /** Hunk ids or `path:line` anchors proving the symbol appears in the diff. */
    evidenceRefs: string[];
}

/**
 * Stage 1 output. Answers "what changed?" and nothing else: no intent, no
 * commit type, no user impact. Producing intent here would anchor every later
 * stage before any repository evidence exists.
 */
export interface ChangeExtraction {
    changedFiles: ChangedFile[];
    changedSymbols: ChangedSymbol[];
    introducedSymbols: string[];
    removedSymbols: string[];
    changedCalls: string[];
    changedConfigs: string[];
    changedTypes: string[];
    changedDependencies: string[];
}

export type InvestigationTargetKind =
    | 'file'
    | 'symbol'
    | 'config'
    | 'type'
    | 'dependency'
    | 'interface'
    | 'cli_or_api';

export interface InvestigationTarget {
    target: string;
    kind: InvestigationTargetKind;
    file: string | null;
    questions: string[];
}

/** Stage 2 output: what still needs to be known to explain the change. */
export interface InvestigationPlan {
    targets: InvestigationTarget[];
    /** Model-supplied reasoning for the chosen targets, for logs only. */
    notes: string | null;
}

export type RepositoryEvidenceKind =
    | 'definition'
    | 'references'
    | 'callers'
    | 'callees'
    | 'implementations'
    | 'type'
    | 'config_usage'
    | 'tests'
    | 'documentation'
    | 'listing'
    | 'search';

/**
 * A single retrieved fact. `ref` is the citation later stages must quote when
 * they make a claim, which is what makes evidence traceability enforceable
 * instead of aspirational.
 */
export interface RepositoryEvidenceItem {
    id: string;
    kind: RepositoryEvidenceKind;
    target: string;
    /** Human-readable citation, e.g. `src/auth/token.ts:42-78`. */
    ref: string;
    excerpt: string;
}

export interface InvestigationFinding {
    target: string;
    question: string;
    answer: string;
    evidenceRefs: string[];
}

export interface RepositoryEvidence {
    items: RepositoryEvidenceItem[];
    findings: InvestigationFinding[];
    unresolvedQuestions: string[];
    stopReason: string;
    steps: number;
    /** True when the agent could not run at all (no repo path, disabled, error). */
    degraded: boolean;
}

export interface EvidenceBackedClaim {
    claim: string;
    evidenceRefs: string[];
}

export interface AgentClaim extends EvidenceBackedClaim {
    category: 'observed_change' | 'repository_fact' | 'supported_inference' | 'uncertain_inference';
    disposition: 'must_express' | 'optional' | 'omit';
}

/** Locally assigned identifier used only by trace and benchmark output. */
export interface TracedAgentClaim extends AgentClaim {
    id: string;
}

export type ChangeAnalysisStatus = 'complete' | 'degraded' | 'unavailable';

export interface ChangeTargetRole {
    symbol: string;
    file: string;
    role: string;
    evidenceRefs: string[];
}

export interface DependencyContext {
    callers: string[];
    callees: string[];
    stateDependencies: string[];
    relatedConfigs: string[];
    relatedTypes: string[];
}

export interface BehaviorAnalysis {
    before: string | null;
    after: string | null;
    observableEffect: string | null;
}

export interface CapabilityContext {
    technicalCapability: string | null;
    productCapability: string | null;
}

export interface IntentAnalysis {
    primaryIntent: string | null;
    supportedBy: string[];
    confidence: 'low' | 'medium' | 'high';
}

export interface ChangeClassification {
    existingBehaviorCorrected: boolean;
    newCapabilityAdded: boolean;
    externalBehaviorChanged: boolean;
    structuralOnly: boolean;
    recommendedType: string | null;
    reason: string | null;
}

/**
 * Stage 4 output, frozen schema. Anything that cannot be proven from the diff
 * plus repository evidence stays `null`/`[]` and is recorded in
 * `uncertainties` rather than filled in from model priors.
 */
export interface SemanticChangeAnalysis {
    changeTargets: ChangeTargetRole[];
    dependencyContext: DependencyContext;
    observedChanges: EvidenceBackedClaim[];
    repositoryFacts: EvidenceBackedClaim[];
    behaviorAnalysis: BehaviorAnalysis;
    capabilityContext: CapabilityContext;
    supportedInferences: EvidenceBackedClaim[];
    uncertainInferences: EvidenceBackedClaim[];
    intentAnalysis: IntentAnalysis;
    changeClassification: ChangeClassification;
    uncertainties: string[];
}

/** Stage 5 output: the only semantic content the generator is allowed to see. */
export interface InformationSelection {
    mustExpress: string[];
    optional: string[];
    omit: string[];
    /** Scope hint derived from the investigated code paths, not from file names alone. */
    suggestedScope: string | null;
    notes: string | null;
}

/** Compact payload handed to the commit generator. */
export interface SelectedSemanticInformation {
    analysisStatus: 'complete' | 'degraded' | 'unavailable';
    analysisIssues: string[];
    primaryIntent: string | null;
    mustExpress: string[];
    optional: string[];
    omit: string[];
    suggestedScope: string | null;
    recommendedType: string | null;
    behaviorBefore: string | null;
    behaviorAfter: string | null;
    observableEffect: string | null;
    technicalCapability: string | null;
    breakingSignals: string[];
    uncertainties: string[];
}

export interface ChangeAnalysisTrace {
    analysisStatus: ChangeAnalysisStatus;
    analysisIssues: string[];
    /** Runtime counters and per-request provider usage for benchmark collection. */
    agentMetrics?: AgentRunMetrics;
    agentClaims: TracedAgentClaim[];
    changeExtraction: ChangeExtraction;
    investigationPlan?: InvestigationPlan;
    repositoryEvidence: RepositoryEvidence;
    semanticAnalysis: SemanticChangeAnalysis;
    informationSelection: InformationSelection;
    selectedInformation: SelectedSemanticInformation;
}
