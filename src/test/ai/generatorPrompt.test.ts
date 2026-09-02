import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { buildChangeConditionedDraftMessages } from '../../services/chain/generation/prompts';
import { ChainInputs } from '../../services/chain/types';
import { SelectedSemanticInformation } from '../../services/analysis/change/types';

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
});
