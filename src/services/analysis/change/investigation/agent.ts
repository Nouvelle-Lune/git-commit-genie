// Stages 2 and 3: Investigation Planning and Repository Investigation.
//
// The planner turns "what changed" into "what must still be known". The agent
// then answers those questions with real repository lookups and stops as soon
// as the primary behavioral change is explainable — the stop condition is what
// keeps this from drifting back into a repository summary.

import { LLMExecution } from '../../../llm/llmTypes';
import { AgentRuntime, EvidenceLedger, type FinalizationTrigger } from '../../../../agent';
import {
    buildInvestigationPlanMessages,
} from '../prompts';
import {
    DraftEvidence,
    InvestigationPlan,
    RepositoryEvidence,
} from '../types';
import {
    ChangeAnalysisAgentOutput,
    InvestigationStepEvent,
    runChangeAnalysisProfile,
} from './changeAnalysisProfile';
import {
    logStructuredValidationToWebview,
    wrapExecutionSessionForWebview,
} from '../../../llm/chatWebviewLogging';

export type { ChangeAnalysisAgentOutput, InvestigationStepEvent } from './changeAnalysisProfile';

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

export async function planInvestigation(
    evidence: DraftEvidence[],
    execution: LLMExecution,
    maxToolCalls: number,
    navigation?: import('../../../memory/types').MemoryNavigation[],
): Promise<InvestigationPlan> {
    const messages = buildInvestigationPlanMessages({ evidence, maxToolCalls, navigation });
    const session = execution.createSession(messages);
    let requestMessages = messages;

    for (let attempt = 0; attempt <= execution.maxRetries; attempt += 1) {
        const parsed = await execution.run<InvestigationPlan>(session, requestMessages, {
            requestType: 'investigationPlan',
        });
        const invalid = validateInvestigationPlan(evidence, parsed);
        if (!invalid.length) {
            return normalizeInvestigationPlan(parsed);
        }
        if (attempt === execution.maxRetries) {
            throw new Error(`Investigation plan violated the raw-diff contract: ${invalid.join(' | ')}`);
        }
        requestMessages = [{
            role: 'user',
            content: buildPlanCorrectionMessage(evidence, parsed, invalid, maxToolCalls),
        }];
    }

    throw new Error('Investigation planning exhausted its grounding attempts without a result.');
}

function normalizeInvestigationPlan(parsed: InvestigationPlan): InvestigationPlan {
    return {
        targets: parsed.targets.map(target => ({
            ...target,
            id: target.id.trim(),
            target: target.target.trim(),
            file: target.file?.trim() || null,
            diffEvidenceRefs: target.diffEvidenceRefs.map(ref => ref.trim()),
            questions: dedupeStrings(target.questions),
        })),
        coverage: parsed.coverage.map(entry => ({
            diffEvidenceRef: entry.diffEvidenceRef.trim(),
            decision: entry.decision,
            targetIds: entry.targetIds.map(id => id.trim()),
        })),
        notes: parsed.notes?.trim() || null,
    };
}

function validateInvestigationPlan(
    evidence: DraftEvidence[],
    parsed: InvestigationPlan,
): string[] {
    const allowed = new Set(evidence.flatMap(item => item.kind === 'raw' ? item.evidenceIds : item.coveredHunkIds));
    const errors: string[] = [];
    const targetIds = new Set<string>();
    for (const target of parsed.targets) {
        const targetId = target.id.trim();
        if (!targetId || targetIds.has(targetId)) {
            errors.push(`target id '${target.id}' is empty or duplicated`);
        }
        targetIds.add(targetId);
        if (!target.target.trim()) { errors.push(`target '${target.id}' is empty`); }
        if (!target.diffEvidenceRefs.length) { errors.push(`target '${target.id}' has no diff evidence`); }
        const seenTargetRefs = new Set<string>();
        for (const ref of target.diffEvidenceRefs) {
            const normalizedRef = ref.trim();
            if (seenTargetRefs.has(normalizedRef)) {
                errors.push(`target '${target.id}' repeats diff evidence '${normalizedRef}'`);
            }
            seenTargetRefs.add(normalizedRef);
            if (!allowed.has(normalizedRef)) { errors.push(`target '${target.id}' references unknown diff evidence '${normalizedRef}'`); }
        }
    }
    const seenCoverage = new Set<string>();
    const missingRefsByTarget = new Map<string, string[]>();
    for (const entry of parsed.coverage) {
        const normalizedTargetIds = entry.targetIds.map(id => id.trim());
        if (!allowed.has(entry.diffEvidenceRef)) {
            errors.push(`coverage references unknown diff evidence '${entry.diffEvidenceRef}'`);
        }
        if (seenCoverage.has(entry.diffEvidenceRef)) {
            errors.push(`coverage repeats diff evidence '${entry.diffEvidenceRef}'`);
        }
        seenCoverage.add(entry.diffEvidenceRef);
        if (entry.decision === 'investigate' && entry.targetIds.some(id => !targetIds.has(id))) {
            errors.push(`investigated evidence '${entry.diffEvidenceRef}' references an unknown target`);
        }
        if (entry.decision === 'investigate' && !entry.targetIds.length) {
            errors.push(`investigated evidence '${entry.diffEvidenceRef}' has no target`);
        }
        if (new Set(normalizedTargetIds).size !== normalizedTargetIds.length) {
            errors.push(`coverage for diff evidence '${entry.diffEvidenceRef}' repeats a target id`);
        }
        if (entry.decision === 'diff_sufficient' && entry.targetIds.length) {
            errors.push(`diff-sufficient evidence '${entry.diffEvidenceRef}' must not have investigation targets`);
        }
        if (entry.decision === 'investigate') {
            for (const targetId of entry.targetIds) {
                const target = parsed.targets.find(candidate => candidate.id.trim() === targetId.trim());
                if (target && !target.diffEvidenceRefs.includes(entry.diffEvidenceRef)) {
                    const missing = missingRefsByTarget.get(targetId) ?? [];
                    missing.push(entry.diffEvidenceRef);
                    missingRefsByTarget.set(targetId, missing);
                }
            }
        }
    }
    for (const [targetId, missingRefs] of missingRefsByTarget) {
        errors.push(`target '${targetId}' diffEvidenceRefs is missing investigated evidence ids ${JSON.stringify(missingRefs)}`);
    }
    for (const ref of allowed) {
        if (!seenCoverage.has(ref)) { errors.push(`diff evidence '${ref}' is missing from coverage`); }
    }
    for (const target of parsed.targets) {
        const targetId = target.id.trim();
        const unboundRefs = target.diffEvidenceRefs
            .map(ref => ref.trim())
            .filter(ref => !parsed.coverage.some(entry => (
                entry.diffEvidenceRef.trim() === ref
                && entry.decision === 'investigate'
                && entry.targetIds.some(id => id.trim() === targetId)
            )));
        if (unboundRefs.length) {
            errors.push(`target '${targetId}' diff evidence ids ${JSON.stringify(unboundRefs)} are not bound to investigate coverage rows for that target`);
        }
    }
    return errors;
}

function buildPlanCorrectionMessage(
    evidence: DraftEvidence[],
    parsed: InvestigationPlan,
    errors: string[],
    maxToolCalls: number,
): string {
    const allowed = evidence.flatMap(item => item.kind === 'raw' ? item.evidenceIds : item.coveredHunkIds);
    return [
        '<plan_rejected>',
        ...errors.map(error => `- ${error}`),
        `Allowed diff evidence ids: ${JSON.stringify(allowed)}`,
        `Repository tool budget: ${maxToolCalls}`,
        `Previous plan: ${JSON.stringify(parsed)}`,
        'Return the complete corrected plan. Every allowed D* id must appear once in coverage.',
        'If coverage repeats a D* id, keep exactly one row for that id. Merge and deduplicate its targetIds when the rows agree on investigate; do not silently change a conflicting decision.',
        'Do not remove a hunk from coverage. Use diff_sufficient when no repository lookup is necessary.',
        'For every investigate row, each named target must contain that row\'s D* id in diffEvidenceRefs.',
        'For every D* id in a target, that D* coverage row must use decision investigate and name that target. Remove a ref from the target when its coverage row is diff_sufficient.',
        'If adding the missing ids would exceed 8 diffEvidenceRefs on one target, split it into additional targets and update the affected coverage targetIds in the same response.',
        '</plan_rejected>',
    ].join('\n');
}

export interface ChangeAnalysisAgentParams {
    snapshot?: import('../../../git/repositorySnapshot').RepositorySnapshotReader;
    recorder?: import('../../../memory/recorder').EpisodeRecorder;
    memory?: import('../../../memory/retriever').MemoryRetriever;
    navigation?: import('../../../memory/types').MemoryNavigation[];
    rawDiff: DraftEvidence[];
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
    /**
     * Fires the moment repository lookups stop, before the finalization request
     * is sent. The UI needs this to report the real stage instead of announcing
     * the end of the investigation only once the whole analysis has returned.
     */
    onInvestigationClosed?: (event: {
        trigger: FinalizationTrigger;
        toolSteps: number;
        evidenceCount: number;
        reason: string | null;
    }) => void;
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
            } else if (event.type === 'stageChanged') {
                params.onInvestigationClosed?.({
                    trigger: event.trigger,
                    toolSteps: event.toolSteps,
                    evidenceCount: event.evidenceCount,
                    reason: event.reason,
                });
            } else if (event.type === 'retry') {
                logStructuredValidationToWebview(params.repositoryPath, {
                    stage: event.stage,
                    profile: event.profile,
                    failureKind: event.category,
                    attempt: event.attempt,
                    totalAttempts: event.totalAttempts,
                    finalFailure: event.finalFailure,
                    fieldIssues: event.fieldIssues,
                    error: event.message,
                });
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
            rawDiff: params.rawDiff,
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
