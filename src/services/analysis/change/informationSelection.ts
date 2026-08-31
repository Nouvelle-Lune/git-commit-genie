// Stage 5: Information Selection.
//
// Everything known is not what belongs in a commit message. This stage is the
// chain's actual differentiator: it compresses the analysis into the few claims
// worth stating and produces the only semantic payload the generator sees.

import {
    DraftEvidence,
    ChangeAnalysisStatus,
    InformationSelection,
    SelectedSemanticInformation,
    SemanticChangeAnalysis,
} from './types';

const MAX_UNCERTAINTIES = 3;

/**
 * Collects breaking-change signals already grounded in the diff. Only compacted
 * file evidence carries them; when every file stayed raw the generator judges
 * from the diff itself, so an empty list here is not a claim of "not breaking".
 */
function collectBreakingSignals(evidence: DraftEvidence[]): string[] {
    return Array.from(new Set(
        evidence
            .filter(item => item.kind === 'summary')
            .flatMap(item => item.breakingSignals.map(signal => signal.detail))
    )).slice(0, 4);
}

/**
 * Builds the generator payload. The primary intent is withheld at low
 * confidence: the design forbids manufacturing a single intent just so a commit
 * message can assert a reason, and the generator is instructed to describe the
 * observable change when intent is null.
 */
export function buildSelectedInformation(params: {
    semanticAnalysis: SemanticChangeAnalysis;
    selection: InformationSelection;
    evidence: DraftEvidence[];
    analysisStatus?: ChangeAnalysisStatus;
    analysisIssues?: string[];
}): SelectedSemanticInformation {
    const { semanticAnalysis: analysis, selection } = params;
    const confidentIntent = analysis.intentAnalysis.confidence === 'low'
        ? null
        : analysis.intentAnalysis.primaryIntent;

    return {
        analysisStatus: params.analysisStatus ?? 'complete',
        analysisIssues: params.analysisIssues ?? [],
        primaryIntent: confidentIntent,
        mustExpress: selection.mustExpress,
        optional: selection.optional,
        omit: selection.omit,
        suggestedScope: selection.suggestedScope,
        recommendedType: analysis.changeClassification.recommendedType,
        behaviorBefore: analysis.behaviorAnalysis.before,
        behaviorAfter: analysis.behaviorAnalysis.after,
        observableEffect: analysis.behaviorAnalysis.observableEffect,
        technicalCapability: analysis.capabilityContext.technicalCapability,
        breakingSignals: collectBreakingSignals(params.evidence),
        uncertainties: analysis.uncertainties.slice(0, MAX_UNCERTAINTIES),
    };
}
