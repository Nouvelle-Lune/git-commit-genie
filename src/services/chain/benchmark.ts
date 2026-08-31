/** Metrics emitted by one frozen-diff benchmark case. */
export interface ChainBenchmarkSample {
    caseId: string;
    investigationEnabled: boolean;
    ttdMs: number;
    apiCallsBeforeDraft: number;
    conventionalCommitPassed: boolean;
    semanticQualityScore: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    schemaRetries: number;
    contextEpochs: number;
    invalidReferences: number;
    degradedClaims: number;
}

export interface ChainBenchmarkSummary {
    sampleCount: number;
    medianTtdMs: number;
    p95TtdMs: number;
    conventionalCommitPassRate: number;
    meanSemanticQualityScore: number;
    meanApiCallsBeforeDraft: number;
    tokens: {
        input: number;
        output: number;
        reasoning: number;
        cachedInput: number;
        cacheWriteInput: number;
    };
}

export interface ChainBenchmarkGateResult {
    passed: boolean;
    callReductionPassed: boolean;
    formatRatePassed: boolean;
    semanticQualityPassed: boolean;
    medianTtdPassed: boolean;
    p95TtdPassed: boolean;
    baseline: ChainBenchmarkSummary;
    candidate: ChainBenchmarkSummary;
}

/**
 * Aggregates one frozen run without hiding missing or malformed samples. The
 * harness is expected to run the same case ids on the baseline and candidate
 * checkouts; comparison rejects any mismatch instead of changing denominators.
 */
export function summarizeChainBenchmark(samples: ChainBenchmarkSample[]): ChainBenchmarkSummary {
    if (!samples.length) {
        throw new Error('Chain benchmark requires at least one sample.');
    }
    for (const sample of samples) {
        validateSample(sample);
    }
    return {
        sampleCount: samples.length,
        medianTtdMs: percentile(samples.map(sample => sample.ttdMs), 0.5),
        p95TtdMs: percentile(samples.map(sample => sample.ttdMs), 0.95),
        conventionalCommitPassRate: mean(samples.map(sample => Number(sample.conventionalCommitPassed))),
        meanSemanticQualityScore: mean(samples.map(sample => sample.semanticQualityScore)),
        meanApiCallsBeforeDraft: mean(samples.map(sample => sample.apiCallsBeforeDraft)),
        tokens: {
            input: sum(samples.map(sample => sample.inputTokens)),
            output: sum(samples.map(sample => sample.outputTokens)),
            reasoning: sum(samples.map(sample => sample.reasoningTokens)),
            cachedInput: sum(samples.map(sample => sample.cachedInputTokens)),
            cacheWriteInput: sum(samples.map(sample => sample.cacheWriteInputTokens)),
        },
    };
}

/** Applies the plan's acceptance gates to two runs of the identical frozen set. */
export function evaluateChainBenchmarkGates(
    baselineSamples: ChainBenchmarkSample[],
    candidateSamples: ChainBenchmarkSample[],
): ChainBenchmarkGateResult {
    const baselineById = indexSamples(baselineSamples, 'baseline');
    const candidateById = indexSamples(candidateSamples, 'candidate');
    const baselineIds = Array.from(baselineById.keys()).sort();
    const candidateIds = Array.from(candidateById.keys()).sort();
    if (JSON.stringify(baselineIds) !== JSON.stringify(candidateIds)) {
        throw new Error('Baseline and candidate benchmark case ids do not match.');
    }

    const baseline = summarizeChainBenchmark(baselineSamples);
    const candidate = summarizeChainBenchmark(candidateSamples);
    const investigatedIds = baselineIds.filter(caseId => baselineById.get(caseId)!.investigationEnabled);
    const callReductionPassed = investigatedIds.every(caseId => (
        baselineById.get(caseId)!.apiCallsBeforeDraft
        - candidateById.get(caseId)!.apiCallsBeforeDraft
        >= 2
    ));
    const formatRatePassed = candidate.conventionalCommitPassRate >= baseline.conventionalCommitPassRate;
    const semanticQualityPassed = (
        baseline.meanSemanticQualityScore - candidate.meanSemanticQualityScore <= 0.02
    );
    const medianTtdPassed = candidate.medianTtdMs < baseline.medianTtdMs;
    const p95TtdPassed = candidate.p95TtdMs <= baseline.p95TtdMs * 1.05;

    return {
        passed: callReductionPassed
            && formatRatePassed
            && semanticQualityPassed
            && medianTtdPassed
            && p95TtdPassed,
        callReductionPassed,
        formatRatePassed,
        semanticQualityPassed,
        medianTtdPassed,
        p95TtdPassed,
        baseline,
        candidate,
    };
}

function indexSamples(samples: ChainBenchmarkSample[], label: string): Map<string, ChainBenchmarkSample> {
    const indexed = new Map<string, ChainBenchmarkSample>();
    for (const sample of samples) {
        if (!sample.caseId.trim()) {
            throw new Error(`${label} benchmark contains an empty case id.`);
        }
        if (indexed.has(sample.caseId)) {
            throw new Error(`${label} benchmark contains duplicate case id '${sample.caseId}'.`);
        }
        indexed.set(sample.caseId, sample);
    }
    return indexed;
}

function validateSample(sample: ChainBenchmarkSample): void {
    const nonNegative = [
        sample.ttdMs,
        sample.apiCallsBeforeDraft,
        sample.inputTokens,
        sample.outputTokens,
        sample.reasoningTokens,
        sample.cachedInputTokens,
        sample.cacheWriteInputTokens,
        sample.schemaRetries,
        sample.contextEpochs,
        sample.invalidReferences,
        sample.degradedClaims,
    ];
    if (nonNegative.some(value => !Number.isFinite(value) || value < 0)) {
        throw new Error(`Benchmark sample '${sample.caseId}' contains a negative or non-finite metric.`);
    }
    if (!Number.isFinite(sample.semanticQualityScore)
        || sample.semanticQualityScore < 0
        || sample.semanticQualityScore > 1) {
        throw new Error(`Benchmark sample '${sample.caseId}' has a semantic score outside [0, 1].`);
    }
}

function percentile(values: number[], quantile: number): number {
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.ceil(sorted.length * quantile) - 1;
    return sorted[Math.max(0, index)];
}

function mean(values: number[]): number {
    return sum(values) / values.length;
}

function sum(values: number[]): number {
    return values.reduce((total, value) => total + value, 0);
}
