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
} from '../types';
import {
    ChangeAnalysisAgentOutput,
    InvestigationStepEvent,
    runChangeAnalysisProfile,
} from './changeAnalysisProfile';
import {
    logSchemaValidationToWebview,
    wrapExecutionSessionForWebview,
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
    navigation?: import('../../../memory/types').MemoryNavigation[],
): Promise<InvestigationPlan> {
    const messages = buildInvestigationPlanMessages({ changeExtraction: extraction, navigation });
    const session = execution.createSession(messages);
    let requestMessages = messages;

    for (let attempt = 0; attempt <= execution.maxRetries; attempt += 1) {
        const parsed = await execution.run<InvestigationPlan>(session, requestMessages, {
            requestType: 'investigationPlan',
        });
        const groundedPlan = groundInvestigationPlan(extraction, parsed);

        // An intentionally empty plan means the diff is self-explanatory. Retry only
        // when the model attempted to investigate but every proposed target violated
        // the deterministic grounding boundary.
        if (!parsed.targets.length || groundedPlan.targets.length || attempt === execution.maxRetries) {
            return groundedPlan;
        }

        requestMessages = [{
            role: 'user',
            content: buildGroundingRetryMessage(extraction, parsed),
        }];
    }

    throw new Error('Investigation planning exhausted its grounding attempts without a result.');
}

function groundInvestigationPlan(
    extraction: ChangeExtraction,
    parsed: InvestigationPlan,
): InvestigationPlan {
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

function buildGroundingRetryMessage(
    extraction: ChangeExtraction,
    parsed: InvestigationPlan,
): string {
    return [
        '<grounding_rejected>',
        'None of the proposed investigation targets could be grounded in the supplied change extraction.',
        `Rejected targets: ${JSON.stringify(parsed.targets.map(target => ({
            target: target.target,
            kind: target.kind,
            file: target.file,
        })))}`,
        `Allowed changed file paths for kind "file": ${JSON.stringify(extraction.changedFiles.map(file => file.path))}`,
        `Allowed changed names for non-file kinds: ${JSON.stringify(Array.from(collectGroundedNames(extraction)))}`,
        'Return a corrected investigation plan using exact values and the matching target kind. Return an empty targets array only if the diff itself fully answers every useful repository question.',
        '</grounding_rejected>',
    ].join('\n');
}

export interface ChangeAnalysisAgentParams {
    snapshot: import('../../../git/repositorySnapshot').RepositorySnapshotReader;
    recorder?: import('../../../memory/recorder').EpisodeRecorder;
    memory?: import('../../../memory/retriever').MemoryRetriever;
    navigation?: import('../../../memory/types').MemoryNavigation[];
    extraction: ChangeExtraction;
    plan: InvestigationPlan;
    repositoryPath: string;
    excludePatterns: string[];
    execution: LLMExecution;
    maxSteps: number;
    evidence: DraftEvidence[];
    evidenceLedger: EvidenceLedger;
    userTemplate?: string;
    onStep?: (event: InvestigationStepEvent) => void;
    onContextCompacted?: (event: { epoch: number; estimatedTokens: number; reason: string }) => void;
}

export async function runChangeAnalysisAgent(
    params: ChangeAnalysisAgentParams,
): Promise<ChangeAnalysisAgentOutput> {
    const runtime = new AgentRuntime({
        wrapSession: session => wrapExecutionSessionForWebview(
            session,
            params.execution,
            params.repositoryPath,
            'investigation',
        ),
        onEvent: event => {
            if (event.type === 'contextCompacted') {
                params.onContextCompacted?.(event);
            } else if (event.type === 'toolComplete') {
                const observation = event.observation;
                params.onStep?.({
                    step: observation.step,
                    tool: observation.tool,
                    source: observation.tool === 'searchRepositoryMemory' || observation.tool === 'readMemorySources'
                        ? 'memory'
                        : 'repository',
                    reason: String(observation.arguments.reason ?? '').trim(),
                    summary: observation.summary ?? observation.output,
                    ok: observation.ok,
                    evidenceCount: observation.evidenceCount ?? 0,
                    ...(observation.sourceStatuses !== undefined
                        ? { sourceStatuses: observation.sourceStatuses }
                        : {}),
                    arguments: observation.arguments,
                    rawOutput: observation.rawOutput,
                    modelVisibleOutput: observation.output,
                    outputTruncated: observation.outputTruncated,
                });
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
            snapshot: params.snapshot,
            recorder: params.recorder,
            memory: params.memory,
            navigation: params.navigation,
            extraction: params.extraction,
            plan: params.plan,
            repositoryPath: params.repositoryPath,
            excludePatterns: params.excludePatterns,
            evidence: params.evidence,
            userTemplate: params.userTemplate,
            maxSteps: params.maxSteps,
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
