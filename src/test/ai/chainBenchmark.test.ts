import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import {
    ChainBenchmarkSample,
    evaluateChainBenchmarkGates,
    summarizeChainBenchmark,
} from '../../services/chain/benchmark';

describe('chain benchmark acceptance gates', () => {
    it('accepts a candidate that removes two calls and meets quality and TTD gates', () => {
        const baseline = [sample('a', 1_000, 9, 0.90), sample('b', 2_000, 10, 0.92)];
        const candidate = [sample('a', 800, 7, 0.89), sample('b', 1_700, 8, 0.91)];

        const result = evaluateChainBenchmarkGates(baseline, candidate);

        assert.equal(result.passed, true);
        assert.equal(result.callReductionPassed, true);
        assert.equal(result.candidate.medianTtdMs, 800);
        assert.equal(result.candidate.p95TtdMs, 1_700);
    });

    it('rejects case-set drift and malformed semantic scores', () => {
        assert.throws(
            () => evaluateChainBenchmarkGates([sample('a', 1_000, 9, 0.9)], [sample('b', 800, 7, 0.9)]),
            /case ids do not match/,
        );
        assert.throws(
            () => summarizeChainBenchmark([sample('a', 1_000, 9, 1.1)]),
            /outside \[0, 1\]/,
        );
    });
});

function sample(caseId: string, ttdMs: number, apiCalls: number, quality: number): ChainBenchmarkSample {
    return {
        caseId,
        investigationEnabled: true,
        ttdMs,
        apiCallsBeforeDraft: apiCalls,
        conventionalCommitPassed: true,
        semanticQualityScore: quality,
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 5,
        cachedInputTokens: 40,
        cacheWriteInputTokens: 10,
        schemaRetries: 0,
        contextEpochs: 0,
        invalidReferences: 0,
        degradedClaims: 0,
    };
}
