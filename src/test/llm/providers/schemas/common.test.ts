import { describe, it } from 'mocha';
import * as assert from 'assert';
import { z } from 'zod';
import {
    changeExtractionResponseSchema,
    evidenceSummaryResponseSchema,
    investigationActionSchema,
    semanticAnalysisResponseSchema,
} from '../../../../services/llm/providers/schemas/common';

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
    uncertainties: [{ detail: 'metadata does not identify the caller', evidenceHunkIds: ['h1'] }],
};

describe('evidenceSummaryResponseSchema', () => {
    it('accepts hunk-grounded evidence', () => {
        assert.deepStrictEqual(evidenceSummaryResponseSchema.parse(validEvidence), validEvidence);
    });

    it('rejects ungrounded observations without hunk references', () => {
        assert.throws(() => evidenceSummaryResponseSchema.parse({
            ...validEvidence,
            changes: [{ ...validEvidence.changes[0], evidenceHunkIds: [] }],
        }), /evidenceHunkIds/);
    });
});

describe('change-conditioned structured schemas', () => {
    it('rejects object entries in introducedSymbols', () => {
        assert.throws(() => changeExtractionResponseSchema.parse({
            changedSymbols: [],
            introducedSymbols: [{ name: 'refreshMutex' }],
            removedSymbols: [],
            changedCalls: [],
            changedConfigs: [],
            changedTypes: [],
            changedDependencies: [],
        }), /introducedSymbols/);
    });

    it('rejects missing fields instead of filling chain output defaults', () => {
        assert.throws(() => changeExtractionResponseSchema.parse({
            changedSymbols: [],
            introducedSymbols: [],
        }), /removedSymbols/);
    });

    it('rejects investigation actions whose payload contradicts the action kind', () => {
        const base = {
            action: 'tool' as const,
            tool: null,
            reason: null,
            symbol: null,
            filePath: null,
            dirPath: null,
            query: null,
            searchType: null,
            useRegex: null,
            startLine: null,
            maxLines: null,
            maxResults: null,
            final: null,
        };
        assert.throws(() => investigationActionSchema.parse(base), /tool must be set/);
        assert.throws(() => investigationActionSchema.parse({
            ...base,
            action: 'final',
        }), /final must be an object/);
    });

    it('rejects semantic near-miss shapes instead of coercing them', () => {
        assert.throws(() => semanticAnalysisResponseSchema.parse({
            observedChanges: ['bare string claim'],
            behaviorAnalysis: { before: { claim: 'object value' }, after: null, observableEffect: null },
        }));
    });

    it('exports a strict provider JSON Schema', () => {
        const schema = z.toJSONSchema(semanticAnalysisResponseSchema) as Record<string, any>;
        assert.strictEqual(schema.type, 'object');
        assert.ok(schema.properties.dependencyContext);
        assert.strictEqual(schema.additionalProperties, false);
    });
});
