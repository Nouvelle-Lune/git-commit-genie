import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { buildChangeConditionedDraftMessages } from '../../../services/chain/generation/prompts';
import { ChainInputs, RagStyleReference } from '../../../services/chain/types';
import { SelectedSemanticInformation } from '../../../services/analysis/change/types';

describe('change-conditioned generator prompt boundary', () => {
    it('contains selected information and diff evidence but no investigation trajectory', () => {
        const selected: SelectedSemanticInformation = {
            analysisStatus: 'complete',
            analysisIssues: [],
            primaryIntent: 'make parsing deterministic',
            mustExpress: ['changes parser branch'],
            optional: [],
            omit: ['internal experiment'],
            suggestedScope: 'parser',
            recommendedType: 'fix',
            behaviorBefore: 'ambiguous',
            behaviorAfter: 'deterministic',
            observableEffect: 'stable output',
            technicalCapability: 'deterministic parsing',
            breakingSignals: [],
            uncertainties: [],
        };
        const inputs: ChainInputs = {
            diffs: [],
            currentTime: '2026-08-30T00:00:00.000Z',
            targetLanguage: 'en',
        };
        const messages = buildChangeConditionedDraftMessages({
            selected,
            evidencePayload: [{ kind: 'raw', fileName: 'parser.ts', rawDiff: '[D1] +stable' }],
            inputs,
        });
        const content = messages.map(message => message.content).join('\n');

        assert.match(content, /changes parser branch/);
        assert.match(content, /\[D1\]/);
        assert.match(content, /selected claims or changed paths/);
        assert.doesNotMatch(content, /changed symbols or paths/);
        assert.doesNotMatch(content, /tool trajectory|investigation trajectory|Completed tool calls|Repository evidence ledger/);
        assert.match(content, /internal experiment/);
    });

    it('instructs the generator to stay diff-only when analysis is unavailable', () => {
        const selected: SelectedSemanticInformation = {
            analysisStatus: 'unavailable',
            analysisIssues: ['terminal failed'],
            primaryIntent: null,
            mustExpress: [],
            optional: [],
            omit: [],
            suggestedScope: null,
            recommendedType: null,
            behaviorBefore: null,
            behaviorAfter: null,
            observableEffect: null,
            technicalCapability: null,
            breakingSignals: [],
            uncertainties: [],
        };
        const messages = buildChangeConditionedDraftMessages({
            selected,
            evidencePayload: [{ kind: 'raw', fileName: 'parser.ts', rawDiff: '[D1] +stable' }],
            inputs: { diffs: [] },
        });
        const content = messages.map(message => message.content).join('\n');

        assert.match(content, /analysis_status/);
        assert.match(content, /analysis_status is unavailable/);
        assert.match(content, /must_express is empty/);
    });

    it('keeps surviving normalized claims available when analysis is degraded', () => {
        const selected: SelectedSemanticInformation = {
            analysisStatus: 'degraded',
            analysisIssues: ['one unrelated claim lost all evidence'],
            primaryIntent: 'preserve grounded behavior',
            mustExpress: ['keeps the repository-backed caller contract'],
            optional: [],
            omit: ['unsupported claim'],
            suggestedScope: 'parser',
            recommendedType: 'fix',
            behaviorBefore: null,
            behaviorAfter: null,
            observableEffect: 'grounded behavior remains available',
            technicalCapability: 'parser dispatch',
            breakingSignals: [],
            uncertainties: ['unsupported claim'],
        };
        const messages = buildChangeConditionedDraftMessages({
            selected,
            evidencePayload: [{ kind: 'raw', fileName: 'parser.ts', rawDiff: '[D1] +stable' }],
            inputs: { diffs: [] },
        });
        const content = messages.map(message => message.content).join('\n');

        assert.match(content, /surviving normalized must_express and optional claims/);
        assert.match(content, /keeps the repository-backed caller contract/);
        assert.doesNotMatch(content, /degraded or unavailable/);
    });

    it('rejects trace identifiers as scope candidates and forbids emitting them', () => {
        const selected: SelectedSemanticInformation = {
            analysisStatus: 'complete',
            analysisIssues: [],
            primaryIntent: null,
            mustExpress: ['updates the configured model'],
            optional: [],
            omit: [],
            suggestedScope: 'C1',
            recommendedType: 'feat',
            behaviorBefore: null,
            behaviorAfter: null,
            observableEffect: null,
            technicalCapability: null,
            breakingSignals: [],
            uncertainties: [],
        };

        const messages = buildChangeConditionedDraftMessages({
            selected,
            evidencePayload: [{ kind: 'raw', fileName: 'example.py', rawDiff: '[D1] +model' }],
            inputs: { diffs: [] },
        });
        const content = messages.map(message => message.content).join('\n');

        assert.match(content, /"suggested_scope": null/);
        assert.match(content, /"discarded_internal_scope": true/);
        assert.match(content, /Never use an internal identifier such as C1/);
        assert.match(content, /Never copy internal claim\/evidence identifiers/);
    });

    it('passes only approved RAG messages and LLM reasons as style-only references', () => {
        const selected: SelectedSemanticInformation = {
            analysisStatus: 'complete',
            analysisIssues: [],
            primaryIntent: 'simplify parsing',
            mustExpress: ['simplifies parser branching'],
            optional: [],
            omit: [],
            suggestedScope: 'parser',
            recommendedType: 'refactor',
            behaviorBefore: null,
            behaviorAfter: null,
            observableEffect: null,
            technicalCapability: null,
            breakingSignals: [],
            uncertainties: [],
        };
        const messages = buildChangeConditionedDraftMessages({
            selected,
            evidencePayload: [{ kind: 'raw', fileName: 'parser.ts', evidenceIds: ['D1'], rawDiff: '[D1] +stable', status: 'modified' }],
            inputs: { diffs: [] },
            ragStyleReferences: [{
                commitHash: 'abc123',
                message: 'refactor(parser): flatten parse flow',
                subject: 'refactor(parser): flatten parse flow',
                matchedBy: ['hybrid'],
                styleReason: 'Uses a concise scoped header.',
                type: 'refactor',
                scope: 'parser',
            }],
        });
        const content = messages.map(message => message.content).join('\n');

        assert.match(content, /"style_reason": "Uses a concise scoped header\."/);
        assert.match(content, /Historical commit messages below are STYLE REFERENCES ONLY/);
        assert.match(content, /must not borrow topic-specific content/);
    });

    it('does not embed the full JSON schema because responseFormat carries it', () => {
        const messages = buildChangeConditionedDraftMessages({
            selected: {
                analysisStatus: 'complete',
                analysisIssues: [],
                primaryIntent: 'simplify parsing',
                mustExpress: ['simplifies parser branching'],
                optional: [],
                omit: [],
                suggestedScope: 'parser',
                recommendedType: 'refactor',
                behaviorBefore: null,
                behaviorAfter: null,
                observableEffect: null,
                technicalCapability: null,
                breakingSignals: [],
                uncertainties: [],
            },
            evidencePayload: [{ kind: 'raw', fileName: 'parser.ts', rawDiff: '[D1] +stable' }],
            inputs: { diffs: [] },
        });
        const content = messages.map(message => message.content).join('\n');

        assert.match(content, /provider response schema/);
        assert.doesNotMatch(content, /"properties":\s*\{/);
        assert.doesNotMatch(content, /"footers":\s*\{/);
    });

    it('requires the draft stage to synthesize one minimal message instead of restating the analysis', () => {
        // Verify the draft contract states that the smallest still-correct message is synthesized from the
        // analysis evidence, that selected_information is evidence rather than a checklist, and that the
        // retired sentence-level coverage rule no longer appears anywhere in the prompt.
        const content = draftPrompt();

        assert.match(content, /You convert an already-completed semantic analysis into the smallest commit message that still identifies the change correctly\./);
        assert.match(content, /Your job is to SYNTHESIZE the selected semantic information into one commit message, not to restate it, enumerate it, or re-analyze the repository\./);
        assert.match(content, /selected_information is evidence for deciding WHAT the commit means\./);
        assert.match(content, /It is NOT a checklist to restate, summarize, or enumerate\./);
        assert.match(content, /Prefer semantic compression over coverage-by-repetition\./);
        assert.match(content, /A shorter message that semantically entails several must_express claims is BETTER than a longer message that restates those claims individually\./);
        assert.doesNotMatch(content, /Every statement in must_express appears in the message\./);
    });

    it('defines must_express as a semantic coverage set where entailment counts as coverage', () => {
        // Verify the content policy lets semantic entailment satisfy must_express, forbids mapping each claim to
        // its own phrase, forbids restating one fact through intent/mechanism/before-after/effect, and drops
        // optional facts unless they carry a distinct necessary fact.
        // The entailment bullet uses the reviewer-corrected wording "explicit restatement is not what establishes
        // it", which replaced "explicit restatement does not" because the old sentence could be read as the
        // opposite of the validation-side rule that a semantically entailing message counts as covering a fact.
        const content = draftPrompt();

        assert.match(content, /must_express is a semantic coverage set, NOT a sentence-level checklist\./);
        assert.match(content, /Preserve the DISTINCT information carried by must_express, but never map each item to a separate phrase or sentence\./);
        assert.match(content, /When multiple claims describe the same underlying change, collapse them into the shortest statement that entails them\./);
        assert.match(content, /Semantic entailment counts as coverage; explicit restatement is not what establishes it\./);
        assert.doesNotMatch(content, /explicit restatement does not\./);
        assert.match(content, /Do not restate the same fact through intent, mechanism, before\/after state, and observable effect\./);
        assert.match(content, /optional is omitted by default\. Include it only when it adds a distinct fact necessary to understand the commit\./);
    });

    it('omits the body by default and requires a null body when body_policy says so', () => {
        // Verify the body policy makes the header the whole message unless a fact the header cannot carry
        // justifies a body, forbids a body created for explicit coverage, and ties the emitted null body back
        // to that policy in the format requirements.
        const content = draftPrompt();

        assert.match(content, /Omit the body by default\./);
        assert.match(content, /Add a body ONLY when there is at least one important, non-redundant semantic fact that: 1\. cannot be naturally expressed in the header, AND 2\. materially changes how a developer would understand the commit\./);
        assert.match(content, /Do not create a body merely to achieve explicit coverage of must_express\./);
        assert.match(content, /Set body to null when body_policy requires no body\./);
    });

    it('orders selected fields by semantic priority instead of treating them as independent facts', () => {
        // Verify every priority level is published with its intended weight so lower-priority views are only
        // reported when they add information the higher-priority fields do not already carry.
        const content = draftPrompt();

        assert.match(content, /Use selected information with the following semantic priority:/);
        assert.match(content, /1\. primary_intent \/ must_express: determine the semantic identity of the commit\./);
        assert.match(content, /2\. observable_effect: use only when it contributes information not already implied by \(1\)\./);
        assert.match(content, /3\. behavior_before \/ behavior_after: reasoning aids only\./);
        assert.match(content, /4\. technical_capability: implementation context only\. Omit unless necessary for precision\./);
        assert.match(content, /5\. optional: omit by default\./);
        assert.match(content, /The selected fields are multiple views over the analyzed change, not a list of independently reportable facts\./);
    });

    it('forbids producing the message by summarizing one input field at a time', () => {
        // Verify the anti-restatement block demands the minimum semantic proposition and treats intent,
        // mechanism, before/after, effect, and capability as interchangeable views of one change, so any phrase
        // that does not reduce ambiguity must be removed.
        const content = draftPrompt();

        assert.match(content, /Do not produce a message by summarizing each input field\./);
        assert.match(content, /Before writing, identify the minimum semantic proposition that explains the change\./);
        assert.match(content, /Treat intent, mechanism, before\/after behavior, observable effect, and technical capability as potentially different views of the SAME change, not automatically different facts worth mentioning\./);
        assert.match(content, /If removing a phrase does not make the commit ambiguous or materially less informative, remove it\./);
    });

    it('keeps style references from overriding the omitted-body default', () => {
        // Verify a RAG example that carries a body cannot justify a body here, because style references stay
        // subordinate to body_policy.
        const content = draftPrompt({
            ragStyleReferences: [{
                commitHash: 'abc123',
                message: 'refactor(parser): flatten parse flow\n\nMoves the branch table into a lookup.',
                subject: 'refactor(parser): flatten parse flow',
                matchedBy: ['hybrid'],
                styleReason: 'Uses a concise scoped header.',
                type: 'refactor',
                scope: 'parser',
            }],
        });

        assert.match(content, /Style references never override body_policy: an example having a body is not a reason for this message to have one\./);
    });

    it('keeps the 72-character header limit as a prompt requirement now that code does not enforce it', () => {
        // Verify the draft prompt still states the 72-character first-line limit, because the header format
        // checker no longer reports length and the limit survives only as prompt-level style guidance.
        const content = draftPrompt();

        assert.match(content, /First line length must be <= 72 characters; imperative; no trailing period\./);
    });

    it('keeps the omit, uncertainty, and internal identifier guards unchanged', () => {
        // Verify the synthesis rewrite did not weaken the safety rules: omitted facts must never appear even
        // reworded, uncertainties are never presented as facts, internal trace ids never enter the message, and
        // the omit/uncertainty values are still carried as input the model can apply them to.
        const content = draftPrompt({
            selected: {
                omit: ['internal experiment behind the flag'],
                uncertainties: ['unverified caller impact'],
                suggestedScope: 'C1',
            },
        });

        assert.match(content, /Statements in omit never appear, not even reworded\./);
        assert.match(content, /uncertainties are never presented as facts; prefer leaving them out entirely\./);
        assert.match(content, /C1, D1, E1, D1\/P1, and similar C\*\/D\*\/E\* values are internal claim\/evidence identifiers, not semantic content\./);
        assert.match(content, /Never copy internal claim\/evidence identifiers into the commit header, body, or footers\./);
        assert.match(content, /internal experiment behind the flag/);
        assert.match(content, /unverified caller impact/);
    });
});

/** Fills the remaining required fields so each test only states the selection it depends on. */
function selectedInformation(overrides: Partial<SelectedSemanticInformation> = {}): SelectedSemanticInformation {
    return {
        analysisStatus: 'complete',
        analysisIssues: [],
        primaryIntent: 'make parsing deterministic',
        mustExpress: ['changes parser branch'],
        optional: [],
        omit: [],
        suggestedScope: 'parser',
        recommendedType: 'fix',
        behaviorBefore: null,
        behaviorAfter: null,
        observableEffect: null,
        technicalCapability: null,
        breakingSignals: [],
        uncertainties: [],
        ...overrides,
    };
}

/**
 * Renders the draft prompt with whitespace collapsed: prompt sentences wrap across source lines, so a contract
 * sentence can only be matched as one string after newlines and indentation are flattened.
 */
function draftPrompt(options: {
    selected?: Partial<SelectedSemanticInformation>;
    evidencePayload?: unknown;
    ragStyleReferences?: RagStyleReference[];
} = {}): string {
    const messages = buildChangeConditionedDraftMessages({
        selected: selectedInformation(options.selected),
        evidencePayload: options.evidencePayload ?? [{ kind: 'raw', fileName: 'parser.ts', rawDiff: '[D1] +stable' }],
        inputs: { diffs: [] } as ChainInputs,
        ragStyleReferences: options.ragStyleReferences,
    });

    return messages.map(message => message.content).join('\n').replace(/\s+/g, ' ');
}
