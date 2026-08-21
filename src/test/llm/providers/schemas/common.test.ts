import { describe, it } from 'mocha';
import * as assert from 'assert';
import { evidenceSummaryResponseSchema } from '../../../../services/llm/providers/schemas/common';

const validEvidence = {
    changes: [{
        action: 'update',
        target: 'parseDiff',
        behavior: 'preserves hunk boundaries',
        exactSymbols: ['parseDiff'],
        evidenceHunkIds: ['h1'],
    }],
    tests: [],
    breakingSignals: [],
    uncertainties: [{
        detail: 'metadata does not identify the caller',
        evidenceHunkIds: ['h1'],
    }],
};

describe('evidenceSummaryResponseSchema', () => {
    it('accepts hunk-grounded evidence', () => {
        assert.deepStrictEqual(evidenceSummaryResponseSchema.parse(validEvidence), validEvidence);
    });

    it('rejects ungrounded observations without hunk references', () => {
        assert.throws(
            () => evidenceSummaryResponseSchema.parse({
                ...validEvidence,
                changes: [{ ...validEvidence.changes[0], evidenceHunkIds: [] }],
            }),
            /evidenceHunkIds/
        );
    });
});
