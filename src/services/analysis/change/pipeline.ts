import { DiffData } from '../../git/gitTypes';
import { LLMExecution } from '../../llm/llmTypes';
import { AIMessage } from '../../llm/providers';
import { IRepositoryAnalysisService } from '../repository/repositoryAnalysisTypes';
import { safeRun } from '../../../utils/safeRun';
import { StageEvent } from '../../../ui/StageNotificationManager';
import {
    DeterministicChangeExtraction,
    extractChanges,
    extractChangesDeterministically,
} from './extraction';
import {
    buildChangeExtractionMessages,
} from './prompts';
import {
    emptyRepositoryEvidence,
    isInvestigationWorthwhile,
    planInvestigation,
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
import { isContextWindowFailure } from '../../llm/inputTokenBudget';
import { EvidenceLedger } from '../../../agent/evidenceLedger';

export type EvidenceRouteTarget = 'changeExtraction' | 'semanticAnalysis' | 'draft';

export interface ChangeAnalysisPipelineParams {
    diffs: DiffData[];
    inputs: ChangeAnalysisInputs;
    execution: LLMExecution;
    getEvidence: () => DraftEvidence[];
    compactFor: (
        target: EvidenceRouteTarget,
        buildTargetMessages: (current: DraftEvidence[]) => AIMessage[],
        force?: boolean,
    ) => Promise<void>;
    investigationOverrides?: Partial<InvestigationSettings>;
    repositoryAnalysisService?: Pick<IRepositoryAnalysisService, 'runChangeAnalysis'>;
    evidenceLedger: EvidenceLedger;
    onStage?: (event: StageEvent) => void;
    onAgentMilestone?: (milestone: 'start' | 'terminal', timestamp: number) => void;
}

/**
 * Runs Change Extraction and Investigation Planning, then delegates repository
 * tools plus compound semantic/selection output to one continued agent session.
 * Analyze and Select remain local projection stages for validation and UI.
 *
 * Evidence compaction is re-run before every remote stage that embeds the diff
 * because each prompt has a different fixed cost and evidence budget.
 */
export async function runChangeAnalysisPipeline(
    params: ChangeAnalysisPipelineParams
): Promise<ChangeAnalysisTrace> {
    const { diffs, inputs, execution, getEvidence, compactFor, onStage } = params;

    const deterministic: DeterministicChangeExtraction = normalizeExtractionEvidenceRefs(
        extractChangesDeterministically(diffs),
        params.evidenceLedger,
    );
    safeRun('Chain.onStage.changeExtractionStart', () => onStage?.({ type: 'changeExtractionStart' }));
    const changeExtractionMessages = (current: DraftEvidence[]) => buildChangeExtractionMessages({
        deterministic,
        evidencePayload: current,
    });
    await compactFor('changeExtraction', changeExtractionMessages);
    const changeExtraction = normalizeExtractionEvidenceRefs(await runEvidenceStage(
        'changeExtraction',
        changeExtractionMessages,
        compactFor,
        () => extractChanges(diffs, getEvidence(), execution, deterministic),
    ), params.evidenceLedger);
    safeRun('Chain.onStage.changeExtracted', () => onStage?.({
        type: 'changeExtracted',
        data: {
            symbolCount: changeExtraction.changedSymbols.length,
            symbols: changeExtraction.changedSymbols.map(symbol => `${symbol.name} (${symbol.changeKind})`),
            configCount: changeExtraction.changedConfigs.length,
            typeCount: changeExtraction.changedTypes.length,
            dependencyCount: changeExtraction.changedDependencies.length,
        },
    }));

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
    if (!settings.enabled) {
        repositoryEvidence = emptyRepositoryEvidence('Repository investigation is disabled by configuration.');
    } else if (!inputs.repositoryPath) {
        repositoryEvidence = emptyRepositoryEvidence('No repository path was available for investigation.');
    } else if (!isInvestigationWorthwhile(changeExtraction)) {
        repositoryEvidence = emptyRepositoryEvidence('The diff alone determines the meaning of this change.');
    } else {
        safeRun('Chain.onStage.investigationPlanStart', () => onStage?.({ type: 'investigationPlanStart' }));
        const plan = await planInvestigation(changeExtraction, execution, inputs.repositoryAnalysis);
        investigationPlan = plan;
        safeRun('Chain.onStage.investigationPlanned', () => onStage?.({
            type: 'investigationPlanned',
            data: {
                targetCount: plan.targets.length,
                targets: plan.targets.map(target => target.target),
                questionCount: plan.targets.reduce((total, target) => total + target.questions.length, 0),
            },
        }));

        if (!plan.targets.length) {
            repositoryEvidence = emptyRepositoryEvidence('No investigation target could be grounded in the change.');
        } else {
            safeRun('Chain.onStage.investigationStart', () => onStage?.({
                type: 'investigationStart',
                data: { maxSteps: settings.maxSteps },
            }));
            if (!params.repositoryAnalysisService) {
                throw new Error('RepositoryAnalysisService is required for change-conditioned repository analysis.');
            }
            try {
                await compactFor('semanticAnalysis', current => [{
                    role: 'user',
                    content: JSON.stringify({ changeExtraction, plan, evidence: current }),
                }]);
                params.onAgentMilestone?.('start', Date.now());
                const agentOutput = await params.repositoryAnalysisService.runChangeAnalysis({
                    extraction: changeExtraction,
                    plan,
                    repositoryPath: inputs.repositoryPath,
                    excludePatterns: settings.excludePatterns,
                    execution,
                    maxSteps: settings.maxSteps,
                    evidence: getEvidence(),
                    evidenceLedger: params.evidenceLedger,
                    repositoryTerminology: inputs.repositoryAnalysis,
                    userTemplate: inputs.userTemplate,
                    onContextCompacted: event => safeRun('Chain.onStage.contextCompacted', () => onStage?.({
                        type: 'contextCompacted',
                        data: event,
                    })),
                    onStep: event => safeRun('Chain.onStage.investigationStep', () => onStage?.({
                        type: 'investigationStep',
                        data: {
                            current: event.step,
                            total: settings.maxSteps,
                            tool: event.tool,
                            reason: event.reason,
                            summary: event.summary,
                            ok: event.ok,
                            evidenceCount: event.evidenceCount,
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
                params.onAgentMilestone?.('terminal', Date.now());
            } catch (error) {
                if (!isContextWindowFailure(error)) {
                    throw error;
                }
                repositoryEvidence = emptyRepositoryEvidence(
                    'Repository investigation reached the configured context budget; continuing from diff evidence.',
                );
                semanticAnalysis = normalizeSemanticAnalysis({}, repositoryEvidence, params.evidenceLedger);
                analysisIssues = [repositoryEvidence.stopReason];
            }
        }
    }

    if (analysisStatus === 'unavailable' && repositoryEvidence.degraded) {
        safeRun('Chain.onStage.investigationSkipped', () => onStage?.({
            type: 'investigationSkipped',
            data: { reason: repositoryEvidence.stopReason },
        }));
    } else {
        safeRun('Chain.onStage.investigationComplete', () => onStage?.({
            type: 'investigationComplete',
            data: {
                steps: repositoryEvidence.steps,
                evidenceCount: repositoryEvidence.items.length,
                findingCount: repositoryEvidence.findings.length,
                unresolvedCount: repositoryEvidence.unresolvedQuestions.length,
                reason: repositoryEvidence.stopReason,
            },
        }));
    }

    if (analysisStatus !== 'complete') {
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
        }));
    }

    safeRun('Chain.onStage.semanticAnalysisStart', () => onStage?.({ type: 'semanticAnalysisStart' }));
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
    }));

    safeRun('Chain.onStage.informationSelectionStart', () => onStage?.({ type: 'informationSelectionStart' }));
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
    }));

    return {
        analysisStatus,
        analysisIssues,
        ...(agentMetrics ? { agentMetrics } : {}),
        agentClaims,
        changeExtraction,
        ...(investigationPlan ? { investigationPlan } : {}),
        repositoryEvidence,
        semanticAnalysis,
        informationSelection,
        selectedInformation,
    };
}

function normalizeExtractionEvidenceRefs<T extends ChangeAnalysisTrace['changeExtraction']>(
    extraction: T,
    ledger: EvidenceLedger,
): T {
    return {
        ...extraction,
        changedSymbols: extraction.changedSymbols.map(symbol => ({
            ...symbol,
            evidenceRefs: Array.from(new Set(symbol.evidenceRefs.flatMap(ref => {
                if (/^D\d+$/.test(ref) && ledger.has(ref)) {
                    return [ref];
                }
                const match = ref.match(/^(.*):(\d+)$/);
                if (!match) {
                    return [];
                }
                const id = ledger.resolveDiffAnchor(match[1], Number(match[2]));
                return id ? [id] : [];
            }))),
        })),
    };
}

async function runEvidenceStage<T>(
    target: EvidenceRouteTarget,
    buildMessages: (current: DraftEvidence[]) => AIMessage[],
    compactFor: ChangeAnalysisPipelineParams['compactFor'],
    run: () => Promise<T>,
): Promise<T> {
    try {
        return await run();
    } catch (error) {
        if (!isContextWindowFailure(error)) {
            throw error;
        }
        await compactFor(target, buildMessages, true);
        // Every stage action creates a new provider session, so the retry does not
        // inherit the failed request or its partial assistant response.
        return run();
    }
}
