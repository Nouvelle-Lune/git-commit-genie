// Stage 5: Information Selection.
//
// Everything known is not what belongs in a commit message. This stage is the
// chain's actual differentiator: it compresses the analysis into the few claims
// worth stating and produces the only semantic payload the generator sees.

import { LLMExecution } from '../../llm/llmTypes';
import { buildInformationSelectionMessages } from './prompts';
import {
    ChangeExtraction,
    DraftEvidence,
    InformationSelection,
    SelectedSemanticInformation,
    SemanticChangeAnalysis,
} from './types';

const MAX_MUST_EXPRESS = 3;
const MAX_OPTIONAL = 4;
const MAX_OMIT = 8;
const MAX_UNCERTAINTIES = 3;

function cleanStrings(values: unknown, limit: number): string[] {
    if (!Array.isArray(values)) {
        return [];
    }
    return Array.from(new Set(
        values
            .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
            .map(value => value.trim())
    )).slice(0, limit);
}

function cleanText(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export async function selectInformation(params: {
    changeExtraction: ChangeExtraction;
    semanticAnalysis: SemanticChangeAnalysis;
    userTemplate?: string;
    execution: LLMExecution;
}): Promise<InformationSelection> {
    const messages = buildInformationSelectionMessages({
        changeExtraction: params.changeExtraction,
        semanticAnalysis: params.semanticAnalysis,
        userTemplate: params.userTemplate,
    });
    const session = params.execution.createSession(messages);
    const raw = await params.execution.run<InformationSelection>(session, messages, { requestType: 'informationSelection' });

    const mustExpress = cleanStrings(raw?.mustExpress, MAX_MUST_EXPRESS);
    if (!mustExpress.length) {
        throw new Error('Information selection returned an empty mustExpress list.');
    }

    return {
        mustExpress,
        optional: cleanStrings(raw?.optional, MAX_OPTIONAL),
        omit: cleanStrings(raw?.omit, MAX_OMIT),
        suggestedScope: cleanText(raw?.suggestedScope),
        notes: cleanText(raw?.notes),
    };
}

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
}): SelectedSemanticInformation {
    const { semanticAnalysis: analysis, selection } = params;
    const confidentIntent = analysis.intentAnalysis.confidence === 'low'
        ? null
        : analysis.intentAnalysis.primaryIntent;

    return {
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
