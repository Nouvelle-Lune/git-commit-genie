// Stage 4: Evidence-Backed Semantic Analysis.
//
// The model produces the frozen analysis schema; this module then enforces the
// evidence contract in code. Prompt instructions alone do not guarantee
// traceability, so unsupported conclusions are demoted here rather than trusted.

import { ChatFn } from '../../llm/llmTypes';
import { buildSemanticAnalysisMessages } from './prompts';
import {
    ChangeExtraction,
    EvidenceBackedClaim,
    RepositoryEvidence,
    SemanticChangeAnalysis,
    RepositoryAnalysisContext,
} from './types';

const EVIDENCE_ID_PATTERN = /^E\d+$/;

type DeepPartial<T> = T extends Array<infer Item>
    ? Array<DeepPartial<Item>>
    : T extends object
    ? { [Key in keyof T]?: DeepPartial<T[Key]> }
    : T;

export type RawSemanticAnalysis = DeepPartial<SemanticChangeAnalysis>;

const ALLOWED_COMMIT_TYPES = new Set([
    'feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert',
]);

function cleanStrings(values: unknown): string[] {
    if (!Array.isArray(values)) {
        return [];
    }
    return Array.from(new Set(
        values
            .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
            .map(value => value.trim())
    ));
}

function cleanText(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Drops citations that point at evidence ids the investigation never produced.
 * A fabricated citation is worse than a missing one because it makes an
 * unsupported claim look traceable.
 */
function filterEvidenceRefs(refs: unknown, knownIds: Set<string>): string[] {
    return cleanStrings(refs).filter(ref => !EVIDENCE_ID_PATTERN.test(ref) || knownIds.has(ref));
}

function normalizeClaims(claims: unknown, knownIds: Set<string>): EvidenceBackedClaim[] {
    if (!Array.isArray(claims)) {
        return [];
    }
    return claims
        .map(entry => {
            if (!entry || typeof entry !== 'object') {
                return null;
            }
            const record = entry as Record<string, unknown>;
            const claim = cleanText(record.claim);
            if (!claim) {
                return null;
            }
            return {
                claim,
                evidenceRefs: filterEvidenceRefs(
                    record.evidenceRefs,
                    knownIds
                ),
            };
        })
        .filter((entry): entry is EvidenceBackedClaim => entry !== null);
}

function normalizeBehaviorText(value: unknown): string | null {
    return cleanText(value);
}

/**
 * Applies the evidence contract to a raw model analysis:
 *   - repository facts and supported inferences without a surviving citation
 *     become uncertain inferences;
 *   - a product capability is refused when no repository fact was established;
 *   - an uncited primary intent keeps its text but loses confidence, which is
 *     what later stages read when deciding whether to state a "why" at all.
 */
export function normalizeSemanticAnalysis(
    raw: RawSemanticAnalysis,
    repositoryEvidence: RepositoryEvidence
): SemanticChangeAnalysis {
    const knownIds = new Set(repositoryEvidence.items.map(item => item.id));
    const uncertainties = cleanStrings(raw.uncertainties);

    const observedChanges = normalizeClaims(raw.observedChanges, knownIds);
    const repositoryFactCandidates = normalizeClaims(raw.repositoryFacts, knownIds);
    const supportedCandidates = normalizeClaims(raw.supportedInferences, knownIds);
    const uncertainInferences = normalizeClaims(raw.uncertainInferences, knownIds);

    const repositoryFacts: EvidenceBackedClaim[] = [];
    for (const fact of repositoryFactCandidates) {
        if (fact.evidenceRefs.length) {
            repositoryFacts.push(fact);
        } else {
            uncertainInferences.push(fact);
        }
    }

    const supportedInferences: EvidenceBackedClaim[] = [];
    for (const inference of supportedCandidates) {
        if (inference.evidenceRefs.length) {
            supportedInferences.push(inference);
        } else {
            uncertainInferences.push(inference);
        }
    }

    const rawIntent = raw.intentAnalysis;
    const primaryIntent = cleanText(rawIntent?.primaryIntent);
    const supportedBy = filterEvidenceRefs(rawIntent?.supportedBy, knownIds);
    let confidence: SemanticChangeAnalysis['intentAnalysis']['confidence'] =
        rawIntent?.confidence === 'high' || rawIntent?.confidence === 'medium' ? rawIntent.confidence : 'low';
    if (primaryIntent && !supportedBy.length && !observedChanges.length) {
        confidence = 'low';
        uncertainties.push(`The primary intent "${primaryIntent}" carries no evidence citation.`);
    }

    const recommendedTypeRaw = cleanText(raw.changeClassification?.recommendedType)?.toLowerCase() ?? null;
    const recommendedType = recommendedTypeRaw && ALLOWED_COMMIT_TYPES.has(recommendedTypeRaw)
        ? recommendedTypeRaw
        : null;

    const productCapability = cleanText(raw.capabilityContext?.productCapability);

    return {
        changeTargets: (Array.isArray(raw.changeTargets) ? raw.changeTargets : [])
            .map(target => ({
                symbol: cleanText(target?.symbol) ?? '',
                file: cleanText(target?.file) ?? '',
                role: cleanText(target?.role) ?? '',
                evidenceRefs: filterEvidenceRefs(target?.evidenceRefs, knownIds),
            }))
            .filter(target => target.symbol && target.role),
        dependencyContext: {
            callers: cleanStrings(raw.dependencyContext?.callers),
            callees: cleanStrings(raw.dependencyContext?.callees),
            stateDependencies: cleanStrings(raw.dependencyContext?.stateDependencies),
            relatedConfigs: cleanStrings(raw.dependencyContext?.relatedConfigs),
            relatedTypes: cleanStrings(raw.dependencyContext?.relatedTypes),
        },
        observedChanges,
        repositoryFacts,
        behaviorAnalysis: {
            before: normalizeBehaviorText(raw.behaviorAnalysis?.before),
            after: normalizeBehaviorText(raw.behaviorAnalysis?.after),
            observableEffect: normalizeBehaviorText(raw.behaviorAnalysis?.observableEffect),
        },
        capabilityContext: {
            technicalCapability: cleanText(raw.capabilityContext?.technicalCapability),
            // Without a single established repository fact there is no path from
            // this change to a product-level capability.
            productCapability: repositoryFacts.length ? productCapability : null,
        },
        supportedInferences,
        uncertainInferences,
        intentAnalysis: {
            primaryIntent,
            supportedBy,
            confidence,
        },
        changeClassification: {
            existingBehaviorCorrected: raw.changeClassification?.existingBehaviorCorrected === true,
            newCapabilityAdded: raw.changeClassification?.newCapabilityAdded === true,
            externalBehaviorChanged: raw.changeClassification?.externalBehaviorChanged === true,
            structuralOnly: raw.changeClassification?.structuralOnly === true,
            recommendedType,
            reason: cleanText(raw.changeClassification?.reason),
        },
        uncertainties: Array.from(new Set(uncertainties)),
    };
}

export async function analyzeSemantics(params: {
    changeExtraction: ChangeExtraction;
    repositoryEvidence: RepositoryEvidence;
    evidencePayload: unknown;
    repositoryTerminology?: RepositoryAnalysisContext;
    chat: ChatFn;
}): Promise<SemanticChangeAnalysis> {
    const messages = buildSemanticAnalysisMessages({
        changeExtraction: params.changeExtraction,
        repositoryEvidence: params.repositoryEvidence,
        evidencePayload: params.evidencePayload,
        repositoryTerminology: params.repositoryTerminology,
    });
    const raw = await params.chat(messages, { requestType: 'semanticAnalysis' }) as SemanticChangeAnalysis;
    return normalizeSemanticAnalysis(raw, params.repositoryEvidence);
}
