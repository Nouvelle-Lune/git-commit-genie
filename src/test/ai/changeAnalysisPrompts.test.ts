import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { buildInvestigationPlanMessages } from '../../services/analysis/change/prompts';
import { DraftEvidence } from '../../services/analysis/change/types';

const evidence: DraftEvidence[] = [{
    kind: 'raw',
    fileName: 'parser.ts',
    status: 'modified',
    evidenceIds: ['D1'],
    rawDiff: '@@ -1 +1 @@\n-return old\n+return new',
}];

describe('raw-diff change analysis prompts', () => {
    it('describes raw diff evidence and exactly-once D* planner coverage', () => {
        // Verify the planner prompt makes the raw-diff input and coverage contract explicit to the model.
        const messages = buildInvestigationPlanMessages({ evidence });
        const content = messages.map(message => message.content).join('\n');

        assert.match(content, /complete raw diff/i);
        assert.match(content, /Each D\* hunk must appear exactly once in coverage/);
        assert.match(content, /diff_sufficient/);
        assert.match(content, /target ids/);
        assert.doesNotMatch(content, /change extraction/i);
    });

    it('does not describe the removed semantic extraction payload or embed a full schema', () => {
        // Verify the new prompt exposes only the provider schema contract instead of resurrecting extraction fields.
        const messages = buildInvestigationPlanMessages({ evidence });
        const content = messages.map(message => message.content).join('\n');

        assert.match(content, /provider response schema/);
        assert.doesNotMatch(content, /changedSymbols/);
        assert.doesNotMatch(content, /introducedSymbols/);
        assert.doesNotMatch(content, /"properties":\s*\{/);
    });
});
