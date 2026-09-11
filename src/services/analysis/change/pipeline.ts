import { DiffData } from '../../git/gitTypes';
import { LLMExecution } from '../../llm/llmTypes';
import { safeRun } from '../../../utils/safeRun';
import { StageEvent } from '../../../ui/StageNotificationManager';
import {
    emptyRepositoryEvidence,
    planInvestigation,
    runChangeAnalysisAgent,
} from './investigation/agent';
import {
    InvestigationSettings,
    resolveInvestigationSettings,
} from './investigation/config';
import { normalizeSemanticAnalysis } from './semanticAnalysis';
import { buildSelectedInformation } from './informationSelection';
import {
    ChangeAnalysisInputs,
    ChangeAnalysisTrace,
    DraftEvidence,
    InformationSelection,
    InvestigationPlan,
} from './types';
import { EvidenceLedger } from '../../../agent/evidenceLedger';

export interface ChangeAnalysisPipelineParams {
    diffs: DiffData[];
    inputs: ChangeAnalysisInputs;
    execution: LLMExecution;
    getEvidence: () => DraftEvidence[];
    investigationOverrides?: Partial<InvestigationSettings>;
    evidenceLedger: EvidenceLedger;
    onStage?: (event: StageEvent) => void;
    onAgentMilestone?: (milestone: 'start' | 'terminal', timestamp: number) => void;
}

/**
 * Runs a raw-diff Planner and then delegates repository tools plus the compact
 * fact terminal to one continued AgentRuntime session. The diff ledger remains
 * the source of truth throughout the run; no semantic extraction stage may
 * replace it.
 *
 * The planner and investigation agent receive the complete current diff
 * representation. Downstream draft generation owns any evidence compaction
 * required by its larger prompt.
 */
export async function runChangeAnalysisPipeline(
    params: ChangeAnalysisPipelineParams
): Promise<ChangeAnalysisTrace> {
    const { diffs, inputs, execution, getEvidence, onStage } = params;

    const rawDiff = getEvidence();
    const rawDiffContext = {
        changedFiles: diffs.map(diff => ({ path: diff.fileName, changeType: diff.status })),
        evidenceIds: rawDiff.flatMap(item => item.kind === 'raw' ? item.evidenceIds : item.coveredHunkIds),
    };

    const settings: InvestigationSettings = {
        ...resolveInvestigationSettings(),
        ...params.investigationOverrides,
    };

    let repositoryEvidence = emptyRepositoryEvidence('Repository investigation did not run.');
    let semanticAnalysis = normalizeSemanticAnalysis({}, repositoryEvidence, params.evidenceLedger);
    let informationSelection: InformationSelection = {
        mustExpress: [],
        optional: [],
        omit: [],
        suggestedScope: null,
        notes: null,
    };
    let analysisStatus: ChangeAnalysisTrace['analysisStatus'] = 'unavailable';
    let analysisIssues: string[] = [];
    let agentMetrics: ChangeAnalysisTrace['agentMetrics'];
    let agentClaims: ChangeAnalysisTrace['agentClaims'] = [];
    let investigationPlan: InvestigationPlan | undefined;
    let memoryUsage: ChangeAnalysisTrace['memoryUsage'];
    const canInvestigate = settings.enabled && Boolean(inputs.repositoryPath && inputs.snapshot);
    if (canInvestigate) {
        safeRun('Chain.onStage.investigationPlanStart', () => onStage?.({
            type: 'investigationPlanStart',
            rawData: { input: { evidence: rawDiff } },
        }));
        const memoryQuery = { paths: diffs.map(diff => diff.fileName), symbols: [], keywords: [] };
        const memory = inputs.loadMemory ? await inputs.loadMemory(memoryQuery) : inputs.memory;
        memory?.setInputBudget(execution.tokenBudget.hardInputTokens);
        const navigation = memory?.retrieveNavigation(memoryQuery) ?? [];
        if (memory) {
            safeRun('Chain.onStage.memoryNavigation', () => onStage?.({ type: 'memoryStep',
                data: { current: 0, tool: 'retrieveNavigation', trigger: 'agent', status: 'completed', summary: `Found ${navigation.length} historical navigation candidate(s).`, ok: true, budget: memory.budget },
                rawData: { input: memoryQuery, output: { navigation, budget: memory.budget, settings: memory.settings } } }));
        }
        const plan = await planInvestigation(rawDiff, execution, navigation);
        if (memory) { memoryUsage = { ...memory.usage }; }
        investigationPlan = plan;
        safeRun('Chain.onStage.investigationPlanned', () => onStage?.({
            type: 'investigationPlanned',
            data: {
                targetCount: plan.targets.length,
                targets: plan.targets.map(target => target.target),
                questionCount: plan.targets.reduce((total, target) => total + target.questions.length, 0),
            },
            rawData: {
                input: { memoryQuery, navigation },
                output: plan,
            },
        }));

        safeRun('Chain.onStage.investigationStart', () => onStage?.({
                type: 'investigationStart',
                data: { maxSteps: settings.maxSteps },
                rawData: {
                    input: {
                        rawDiff,
                        plan,
                        evidence: getEvidence(),
                        navigation,
                        maxSteps: settings.maxSteps,
                    },
                },
            }));
            try {
                params.onAgentMilestone?.('start', Date.now());
                const agentOutput = await runChangeAnalysisAgent({
                    snapshot: inputs.snapshot,
                    recorder: inputs.recorder,
                    memory,
                    navigation,
                    rawDiff,
                    plan,
                    repositoryPath: inputs.repositoryPath ?? '',
                    excludePatterns: settings.excludePatterns,
                    execution,
                    maxSteps: plan.targets.length ? settings.maxSteps : 0,
                    evidence: getEvidence(),
                    evidenceLedger: params.evidenceLedger,
                    userTemplate: inputs.userTemplate,
                    onContextCompacted: event => safeRun('Chain.onStage.contextCompacted', () => onStage?.({
                        type: 'contextCompacted',
                        data: event,
                        rawData: { output: event },
                    })),
                    // Reports the two real requests in order: repository lookups
                    // have stopped, and the finalization request is now in flight.
                    // Findings only exist after that request validates, so they
                    // are reported later by investigationResolved.
                    onInvestigationClosed: event => safeRun('Chain.onStage.investigationClosed', () => {
                        onStage?.({
                            type: 'investigationComplete',
                            data: { steps: event.toolSteps, evidenceCount: event.evidenceCount },
                            rawData: { output: event },
                        });
                        onStage?.({
                            type: 'analysisFinalizing',
                            data: {},
                            rawData: { output: event },
                        });
                    }),
                    onStep: event => safeRun('Chain.onStage.investigationStep', () => onStage?.({
                        type: event.source === 'memory' ? 'memoryStep' : 'investigationStep',
                        data: {
                            current: event.step,
                            total: settings.maxSteps,
                            tool: event.tool,
                            reason: event.reason,
                            summary: event.summary,
                            ok: event.ok,
                            evidenceCount: event.evidenceCount,
                            ...(event.sourceStatuses !== undefined
                                ? { sourceStatuses: event.sourceStatuses }
                                : {}),
                        },
                        rawData: {
                            toolCall: {
                                name: event.tool,
                                arguments: event.arguments,
                            },
                            toolResult: {
                                ok: event.ok,
                                rawOutput: event.rawOutput,
                                modelVisibleOutput: event.modelVisibleOutput,
                                truncated: event.outputTruncated,
                                ...(!event.ok ? { error: event.modelVisibleOutput } : {}),
                            },
                        },
                    })),
                });
                repositoryEvidence = agentOutput.repositoryEvidence;
                semanticAnalysis = agentOutput.semanticAnalysis;
                informationSelection = agentOutput.informationSelection;
                analysisStatus = agentOutput.analysisStatus;
                analysisIssues = agentOutput.issues;
                agentMetrics = agentOutput.runtimeMetrics;
                agentClaims = agentOutput.claims;
                if (memory) {
                    const adopted = new Set(agentClaims.filter(claim => claim.disposition !== 'omit').flatMap(claim => claim.evidenceRefs));
                    memory.recordAdoption(repositoryEvidence.items.filter(item => adopted.has(item.id)).flatMap(item => item.provenance ? [item.provenance] : []));
                    memoryUsage = { ...memory.usage };
                }
                params.onAgentMilestone?.('terminal', Date.now());
            } finally {
                if (memory) { memoryUsage = { ...memory.usage }; }
            }
    } else {
        // A disabled or unavailable repository branch still runs the same
        // structured terminal with a zero-step, diff-only plan. This preserves
        // observable facts without pretending that repository evidence exists.
        investigationPlan = {
            targets: [],
            coverage: rawDiffContext.evidenceIds.map(diffEvidenceRef => ({
                diffEvidenceRef,
                decision: 'diff_sufficient' as const,
                targetIds: [],
            })),
            notes: !settings.enabled
                ? 'Repository investigation is disabled by configuration.'
                : 'No captured repository snapshot is available for investigation.',
        };
        const agentOutput = await runChangeAnalysisAgent({
            snapshot: inputs.snapshot,
            recorder: inputs.recorder,
            memory: undefined,
            navigation: [],
            rawDiff,
            plan: investigationPlan,
            repositoryPath: inputs.repositoryPath ?? '',
            excludePatterns: settings.excludePatterns,
            execution,
            maxSteps: 0,
            evidence: rawDiff,
            evidenceLedger: params.evidenceLedger,
            userTemplate: inputs.userTemplate,
        });
        repositoryEvidence = agentOutput.repositoryEvidence;
        semanticAnalysis = agentOutput.semanticAnalysis;
        informationSelection = agentOutput.informationSelection;
        analysisStatus = agentOutput.analysisStatus;
        analysisIssues = agentOutput.issues;
        agentMetrics = agentOutput.runtimeMetrics;
        agentClaims = agentOutput.claims;
    }

    if (analysisStatus === 'unavailable' && repositoryEvidence.degraded) {
        safeRun('Chain.onStage.investigationSkipped', () => onStage?.({
            type: 'investigationSkipped',
            data: { reason: repositoryEvidence.stopReason },
            rawData: { output: { repositoryEvidence } },
        }));
    } else {
        safeRun('Chain.onStage.investigationResolved', () => onStage?.({
            type: 'investigationResolved',
            data: {
                findingCount: repositoryEvidence.findings.length,
                unresolvedCount: repositoryEvidence.unresolvedQuestions.length,
                reason: repositoryEvidence.stopReason,
            },
            rawData: { output: { repositoryEvidence } },
        }));
    }

    if (analysisStatus === 'degraded' || analysisStatus === 'unavailable') {
        if (!analysisIssues.length) {
            analysisIssues = [repositoryEvidence.stopReason];
        }
        safeRun('Chain.onStage.analysisDegraded', () => onStage?.({
            type: 'analysisDegraded',
            data: {
                status: analysisStatus,
                reason: analysisIssues.join(' | '),
                issueCount: analysisIssues.length,
            },
            rawData: { output: { analysisStatus, analysisIssues } },
        }));
    }

    // Semantic analysis and information selection arrive inside the same
    // validated finalization response as the findings. Announcing a "start" for
    // them here would describe a request that was never sent.
    safeRun('Chain.onStage.semanticAnalysisComplete', () => onStage?.({
        type: 'semanticAnalysisComplete',
        data: {
            primaryIntent: semanticAnalysis.intentAnalysis.primaryIntent,
            confidence: semanticAnalysis.intentAnalysis.confidence,
            recommendedType: semanticAnalysis.changeClassification.recommendedType,
            observableEffect: semanticAnalysis.behaviorAnalysis.observableEffect,
            factCount: semanticAnalysis.repositoryFacts.length,
            uncertaintyCount: semanticAnalysis.uncertainties.length,
        },
        rawData: { output: { semanticAnalysis } },
    }));

    const selectedInformation = buildSelectedInformation({
        semanticAnalysis,
        selection: informationSelection,
        evidence: getEvidence(),
        analysisStatus,
        analysisIssues,
    });
    safeRun('Chain.onStage.informationSelected', () => onStage?.({
        type: 'informationSelected',
        data: {
            mustExpress: informationSelection.mustExpress,
            optional: informationSelection.optional,
            omitCount: informationSelection.omit.length,
            suggestedScope: informationSelection.suggestedScope,
            recommendedType: selectedInformation.recommendedType,
        },
        rawData: { output: { informationSelection, selectedInformation } },
    }));

    return {
        ...(inputs.snapshot?.metrics ? { snapshotMetrics: { ...inputs.snapshot.metrics } } : {}),
        ...(memoryUsage ? { memoryUsage } : {}),
        analysisStatus,
        analysisIssues,
        ...(agentMetrics ? { agentMetrics } : {}),
        agentClaims,
        rawDiff: rawDiffContext,
        ...(investigationPlan ? { investigationPlan } : {}),
        repositoryEvidence,
        semanticAnalysis,
        informationSelection,
        selectedInformation,
    };
}
