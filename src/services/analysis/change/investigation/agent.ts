// Stages 2 and 3: Investigation Planning and Repository Investigation.
//
// The planner turns "what changed" into "what must still be known". The agent
// then answers those questions with real repository lookups and stops as soon
// as the primary behavioral change is explainable — the stop condition is what
// keeps this from drifting back into a repository summary.

import { LLMExecution } from '../../../llm/llmTypes';
import { AgentRuntime, EvidenceLedger } from '../../../../agent';
import {
    buildInvestigationPlanMessages,
} from '../prompts';
import {
    ChangeExtraction,
    DraftEvidence,
    InvestigationPlan,
    InvestigationTarget,
    RepositoryEvidence,
    RepositoryAnalysisContext,
} from '../types';
import {
    ChangeAnalysisAgentOutput,
    InvestigationStepEvent,
    runChangeAnalysisProfile,
} from './changeAnalysisProfile';
import {
    logSchemaValidationToWebview,
    wrapSessionWithWebviewLogging,
} from '../../../llm/chatWebviewLogging';

export type { ChangeAnalysisAgentOutput, InvestigationStepEvent } from './changeAnalysisProfile';

const MAX_TARGETS = 3;
const MAX_QUESTIONS_PER_TARGET = 2;

function dedupeStrings(values: unknown): string[] {
    if (!Array.isArray(values)) {
        return [];
    }
    return Array.from(new Set(
        values
            .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
            .map(value => value.trim())
    ));
}

/**
 * Names the change actually touched. Planner targets are intersected with this
 * set so the investigation cannot be redirected onto an unrelated part of the
 * repository that merely sounds relevant.
 */
function collectGroundedNames(extraction: ChangeExtraction): Set<string> {
    return new Set([
        ...extraction.changedSymbols.map(symbol => symbol.name),
        ...extraction.introducedSymbols,
        ...extraction.removedSymbols,
        ...extraction.changedCalls,
        ...extraction.changedConfigs,
        ...extraction.changedTypes,
        ...extraction.changedDependencies,
    ]);
}

/**
 * Validates planner targets against the part of the extraction appropriate for
 * their kind. File targets are deliberately checked against changedFiles rather
 * than the general name set so an unchanged repository path cannot redirect the
 * investigation.
 */
function isGroundedTarget(
    extraction: ChangeExtraction,
    groundedNames: Set<string>,
    target: string,
    kind: InvestigationTarget['kind'],
    file: string | null,
): boolean {
    if (kind === 'file') {
        return file === target && extraction.changedFiles.some(changedFile => changedFile.path === target);
    }
    return groundedNames.has(target);
}

/**
 * Returns true when the diff alone already determines the change's meaning, so
 * repository investigation would only add cost. Documentation, lockfile, and
 * pure-formatting changes have no code path to trace.
 */
export function isInvestigationWorthwhile(extraction: ChangeExtraction): boolean {
    const hasCodeTarget = extraction.changedSymbols.length > 0
        || extraction.changedConfigs.length > 0
        || extraction.changedTypes.length > 0
        || extraction.changedDependencies.length > 0
        || extraction.changedCalls.length > 0;
    return hasCodeTarget;
}

export async function planInvestigation(
    extraction: ChangeExtraction,
    execution: LLMExecution,
    repositoryTerminology?: RepositoryAnalysisContext
): Promise<InvestigationPlan> {
    const messages = buildInvestigationPlanMessages({ changeExtraction: extraction, repositoryTerminology });
    const session = execution.createSession(messages);
    const parsed = await execution.run<InvestigationPlan>(session, messages, { requestType: 'investigationPlan' });

    const grounded = collectGroundedNames(extraction);
    const targets: InvestigationTarget[] = [];
    for (const candidate of parsed.targets) {
        const name = candidate.target.trim();
        if (!name || !isGroundedTarget(extraction, grounded, name, candidate.kind, candidate.file)) {
            continue;
        }
        if (targets.some(existing => existing.target === name)) {
            continue;
        }
        const kind = candidate.kind;
        const questions = dedupeStrings(candidate.questions).slice(0, MAX_QUESTIONS_PER_TARGET);
        targets.push({
            target: name,
            kind,
            file: candidate.file,
            questions,
        });
        if (targets.length >= MAX_TARGETS) {
            break;
        }
    }

    return { targets, notes: parsed.notes };
}

export interface ChangeAnalysisAgentParams {
    extraction: ChangeExtraction;
    plan: InvestigationPlan;
    repositoryPath: string;
    excludePatterns: string[];
    execution: LLMExecution;
    maxSteps: number;
    evidence: DraftEvidence[];
    evidenceLedger: EvidenceLedger;
    repositoryTerminology?: RepositoryAnalysisContext;
    userTemplate?: string;
    onStep?: (event: InvestigationStepEvent) => void;
    onContextCompacted?: (event: { epoch: number; estimatedTokens: number; reason: string }) => void;
}

export async function runChangeAnalysisAgent(
    params: ChangeAnalysisAgentParams,
): Promise<ChangeAnalysisAgentOutput> {
    const runtime = new AgentRuntime({
        wrapSession: session => wrapSessionWithWebviewLogging(
            session,
            params.repositoryPath,
            'investigation',
        ),
        onEvent: event => {
            if (event.type === 'contextCompacted') {
                params.onContextCompacted?.(event);
            } else if (event.type === 'schemaRetry') {
                logSchemaValidationToWebview(
                    params.repositoryPath,
                    { profile: 'change-analysis', attempt: event.attempt, message: event.message },
                    'Change analysis compound terminal schema retry',
                );
            }
        },
    });
    return runChangeAnalysisProfile({
        execution: params.execution,
        ledger: params.evidenceLedger,
        runtime,
        input: {
            extraction: params.extraction,
            plan: params.plan,
            repositoryPath: params.repositoryPath,
            excludePatterns: params.excludePatterns,
            evidence: params.evidence,
            repositoryTerminology: params.repositoryTerminology,
            userTemplate: params.userTemplate,
            maxSteps: params.maxSteps,
            onStep: params.onStep,
        },
    });
}

export function emptyRepositoryEvidence(reason: string): RepositoryEvidence {
    return {
        items: [],
        findings: [],
        unresolvedQuestions: [],
        stopReason: reason,
        steps: 0,
        degraded: true,
    };
}
