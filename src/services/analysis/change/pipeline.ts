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
    buildSemanticAnalysisMessages,
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
import { analyzeSemantics } from './semanticAnalysis';
import { buildSelectedInformation, selectInformation } from './informationSelection';
import { ChangeAnalysisInputs, ChangeAnalysisTrace, DraftEvidence, InvestigationPlan } from './types';

export type EvidenceRouteTarget = 'changeExtraction' | 'semanticAnalysis' | 'ragPreparation' | 'draft';

export interface ChangeAnalysisPipelineParams {
    diffs: DiffData[];
    inputs: ChangeAnalysisInputs;
    execution: LLMExecution;
    getEvidence: () => DraftEvidence[];
    compactFor: (
        target: EvidenceRouteTarget,
        buildTargetMessages: (current: DraftEvidence[]) => AIMessage[]
    ) => Promise<void>;
    investigationOverrides?: Partial<InvestigationSettings>;
    repositoryAnalysisService?: Pick<IRepositoryAnalysisService, 'runChangeAnalysis'>;
    maxInputTokens: number;
    onStage?: (event: StageEvent) => void;
}

/**
 * Runs Change Extraction, Investigation Planning, Repository Investigation,
 * Semantic Analysis, and Information Selection in order.
 *
 * Evidence compaction is re-run before every stage that embeds the diff because
 * each prompt has a different fixed cost and therefore a different evidence budget.
 */
export async function runChangeAnalysisPipeline(
    params: ChangeAnalysisPipelineParams
): Promise<ChangeAnalysisTrace> {
    const { diffs, inputs, execution, getEvidence, compactFor, maxInputTokens, onStage } = params;

    const deterministic: DeterministicChangeExtraction = extractChangesDeterministically(diffs);
    safeRun('Chain.onStage.changeExtractionStart', () => onStage?.({ type: 'changeExtractionStart' }));
    await compactFor('changeExtraction', current => buildChangeExtractionMessages({
        deterministic,
        evidencePayload: current,
    }));
    const changeExtraction = await extractChanges(diffs, getEvidence(), execution, deterministic);
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
            repositoryEvidence = await params.repositoryAnalysisService.runChangeAnalysis({
                extraction: changeExtraction,
                plan,
                repositoryPath: inputs.repositoryPath,
                excludePatterns: settings.excludePatterns,
                execution,
                maxSteps: settings.maxSteps,
                maxInputTokens,
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
        }
    }

    if (repositoryEvidence.degraded) {
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

    safeRun('Chain.onStage.semanticAnalysisStart', () => onStage?.({ type: 'semanticAnalysisStart' }));
    await compactFor('semanticAnalysis', current => buildSemanticAnalysisMessages({
        changeExtraction,
        repositoryEvidence,
        evidencePayload: current,
        repositoryTerminology: inputs.repositoryAnalysis,
    }));
    const semanticAnalysis = await analyzeSemantics({
        changeExtraction,
        repositoryEvidence,
        evidencePayload: getEvidence(),
        repositoryTerminology: inputs.repositoryAnalysis,
        execution,
    });
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
    const informationSelection = await selectInformation({
        changeExtraction,
        semanticAnalysis,
        userTemplate: inputs.userTemplate,
        execution,
    });
    const selectedInformation = buildSelectedInformation({
        semanticAnalysis,
        selection: informationSelection,
        evidence: getEvidence(),
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
        changeExtraction,
        ...(investigationPlan ? { investigationPlan } : {}),
        repositoryEvidence,
        semanticAnalysis,
        informationSelection,
        selectedInformation,
    };
}
