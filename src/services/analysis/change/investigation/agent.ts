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
import { createInvestigationPlanResponseSchema } from '../../../llm/providers/schemas/common';
import { MissingStructuredOutputError, StructuredFieldRejectionError } from '../../../llm/structuredCompletion';
import { z } from 'zod';

export type { ChangeAnalysisAgentOutput, InvestigationStepEvent } from './changeAnalysisProfile';

export async function planInvestigation(params: {
    evidence: DraftEvidence[];
    execution: LLMExecution;
    maxToolCalls: number;
    repositoryPath: string;
    repositoryMap?: string;
    navigation?: import('../../../memory/types').MemoryNavigation[];
}): Promise<InvestigationPlan> {
    const { evidence, execution, maxToolCalls, repositoryPath } = params;
    const diffEvidenceIds = evidence.flatMap(
        item => item.kind === 'raw' ? item.evidenceIds : item.coveredHunkIds
    );
    // The schema is both the D*-coverage contract and the plan's size limit: it
    // declares one required coverage key per id supplied here, so the model
    // never has to reproduce the list, and it caps the target array at the
    // shared call budget, so a plan the investigation cannot fund is not
    // samplable in the first place.
    const schema = createInvestigationPlanResponseSchema(diffEvidenceIds, maxToolCalls);
    // Measured once per planning run, not per attempt. The shared session path
    // converts the same schema again for `response_format`; that duplication is
    // a cheap pure call, and it keeps the planner's own rejection logs carrying
    // the cost of the contract that rejected them.
    const schemaBytes = JSON.stringify(z.toJSONSchema(schema)).length;
    const messages = buildInvestigationPlanMessages({
        evidence,
        maxToolCalls,
        repositoryMap: params.repositoryMap,
        navigation: params.navigation,
    });
    const session = execution.createSession(messages);
    // One budget for both rejection kinds. A schema rejection and a contract
    // rejection consume the same counter, so a small model cannot multiply its
    // provider calls by failing at both levels in sequence. Each attempt runs
    // exactly one request: `callerOwnedRetry` switches off the shared
    // structured retry loop, which this loop supersedes, and makes the shared
    // path report its rejection against this budget instead of a
    // single-request one.
    const totalAttempts = execution.maxRetries + 1;
    let requestMessages = messages;

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
        let parsed: InvestigationPlan;
        try {
            parsed = await execution.run<InvestigationPlan>(session, requestMessages, {
                requestType: 'investigationPlan',
                validationSchema: schema,
                callerOwnedRetry: { attempt, totalAttempts },
            });
        } catch (error) {
            // The shared structured path already logged the failure and reported
            // the failing fields to the Webview. The planner decides two things:
            // whether another attempt is affordable within the shared budget,
            // and whether this rejection is one another attempt could fix at all.
            const rejection = repairablePlanRejection(error);
            if (attempt === totalAttempts || !rejection) {
                throw error;
            }
            requestMessages = [{ role: 'user', content: buildSchemaCorrectionMessage(rejection) }];
            continue;
        }

        const violations = validateInvestigationPlan(parsed);
        if (!violations.length) {
            return normalizeInvestigationPlan(parsed, diffEvidenceIds);
        }
        logStructuredValidationToWebview(repositoryPath, {
            stage: 'investigationPlan',
            failureKind: 'contractViolation',
            attempt,
            totalAttempts,
            finalFailure: attempt === totalAttempts,
            error: violations.join(' | '),
            rejectedPlan: parsed,
            schemaBytes,
        });
        if (attempt === totalAttempts) {
            throw new Error(`Investigation plan violated the coverage contract: ${violations.join(' | ')}`);
        }
        requestMessages = [{
            role: 'user',
            content: buildPlanCorrectionMessage(parsed, violations),
        }];
    }

    // Unreachable: the final attempt either returns a plan or throws, and every
    // earlier attempt either continues or throws. It stays because a bounded
    // loop leaves the end of the body reachable to the checker, which then
    // rejects the declared return type (TS2366). The condition it reports can
    // only be reached if that invariant is ever broken.
    throw new Error('Investigation planning exhausted its attempts without a result.');
}

/**
 * Walks the request's own D* ids instead of the model's coverage object, so a
 * coverage key can be neither dropped nor duplicated by normalization: the
 * response schema makes every id a required property, and the key order stays
 * the order of the diff rather than the order the model happened to emit.
 */
function normalizeInvestigationPlan(
    parsed: InvestigationPlan,
    diffEvidenceIds: readonly string[],
): InvestigationPlan {
    const coverage: InvestigationPlan['coverage'] = {};
    for (const diffEvidenceId of diffEvidenceIds) {
        const entry = parsed.coverage[diffEvidenceId];
        coverage[diffEvidenceId] = {
            decision: entry.decision,
            targetIds: entry.targetIds.map(id => id.trim()),
        };
    }
    return {
        targets: parsed.targets.map(target => ({
            ...target,
            id: target.id.trim(),
            target: target.target.trim(),
            file: target.file?.trim() || null,
            question: target.question.trim(),
        })),
        coverage,
        notes: parsed.notes?.trim() || null,
    };
}

/**
 * Checks what the response schema cannot express: the target graph.
 *
 * Structural completeness and the plan's size are deliberately absent. The
 * dynamic schema already requires every D* key exactly once, forbids unknown
 * ones, and caps the target array at the shared call budget, so re-checking
 * either locally would only duplicate a guarantee that constrained decoding
 * already provides.
 */
function validateInvestigationPlan(parsed: InvestigationPlan): string[] {
    const errors: string[] = [];

    const declaredTargetIds = new Set<string>();
    for (const target of parsed.targets) {
        const targetId = target.id.trim();
        if (!targetId) {
            errors.push(`target '${target.id}' has an empty id`);
            continue;
        }
        if (declaredTargetIds.has(targetId)) {
            errors.push(`target id '${targetId}' is declared more than once`);
            continue;
        }
        declaredTargetIds.add(targetId);
    }

    const usedTargetIds = new Set<string>();
    for (const [diffEvidenceRef, entry] of Object.entries(parsed.coverage)) {
        const referencedTargetIds = entry.targetIds.map(id => id.trim());
        if (entry.decision === 'diff_sufficient') {
            if (referencedTargetIds.length) {
                errors.push(`diff-sufficient evidence '${diffEvidenceRef}' must not have investigation targets`);
            }
            continue;
        }
        if (!referencedTargetIds.length) {
            errors.push(`investigated evidence '${diffEvidenceRef}' has no target`);
        }
        if (new Set(referencedTargetIds).size !== referencedTargetIds.length) {
            errors.push(`investigated evidence '${diffEvidenceRef}' repeats a target id`);
        }
        for (const targetId of referencedTargetIds) {
            if (!declaredTargetIds.has(targetId)) {
                errors.push(`investigated evidence '${diffEvidenceRef}' references unknown target '${targetId}'`);
            }
            usedTargetIds.add(targetId);
        }
    }

    for (const targetId of declaredTargetIds) {
        if (!usedTargetIds.has(targetId)) {
            errors.push(`target '${targetId}' is not attached to any investigate coverage entry`);
        }
    }
    return errors;
}

/**
 * Whether another attempt can plausibly produce a different answer.
 *
 * The shared structured path already draws this line — it refuses to re-ask
 * after a provider truncation or content filter, and it never re-asks after a
 * transport failure — so the planner must not undo that decision by catching
 * everything. Spending the shared budget on a request that cannot succeed is
 * worse than failing immediately: it hides the real cause behind a retry
 * sequence and inflates the provider calls the run reports.
 */
function repairablePlanRejection(
    error: unknown,
): StructuredFieldRejectionError | MissingStructuredOutputError | undefined {
    return error instanceof StructuredFieldRejectionError
        || error instanceof MissingStructuredOutputError
        ? error
        : undefined;
}

/**
 * Repair request after the previous turn was rejected.
 *
 * The two repairable rejections need different instructions: a schema
 * mismatch has field-level detail to hand back, while a response with no JSON
 * at all has to be told what shape to produce. Telling a model that its
 * missing JSON "did not match the schema" sends it looking for a field
 * problem that does not exist.
 */
function buildSchemaCorrectionMessage(
    rejection: StructuredFieldRejectionError | MissingStructuredOutputError,
): string {
    const instructions = rejection instanceof MissingStructuredOutputError
        ? [
            'The previous response contained no final JSON object.',
            'Return exactly one complete JSON object matching the schema, with no markdown and no explanation.',
        ]
        : [
            'The previous response did not match the investigation plan schema.',
            ...rejection.fieldIssueLines.map(line => `- ${line}`),
            'Return one complete corrected JSON object matching the schema.',
        ];
    return [
        '<plan_rejected>',
        ...instructions,
        'The coverage object must contain exactly the keys the schema declares, once each, with their spelling unchanged.',
        '</plan_rejected>',
    ].join('\n');
}

function buildPlanCorrectionMessage(
    parsed: InvestigationPlan,
    errors: string[],
): string {
    return [
        '<plan_rejected>',
        ...errors.map(error => `- ${error}`),
        `Previous plan: ${JSON.stringify(parsed)}`,
        'Return the complete corrected plan.',
        'Keep every coverage key exactly as it was supplied: the key set is fixed, and a key must never be removed, renamed, or added.',
        'Use diff_sufficient with an empty targetIds when that hunk needs no repository lookup.',
        'Every declared target must be named by at least one investigate coverage entry.',
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
    repositoryMap?: string;
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
            repositoryMap: params.repositoryMap,
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
