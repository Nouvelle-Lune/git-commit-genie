import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { resolveRepositoryAnalysisAgentResult } from '../../services/analysis/repository/repositoryAnalysisService';
import { RepositoryAnalysis } from '../../services/analysis/repository/repositoryAnalysisTypes';

describe('RepositoryAnalysisService persistence policy', () => {
    it('rejects an initial failure before any empty result can be persisted', () => {
        assert.throws(
            () => resolveRepositoryAnalysisAgentResult({
                analysis: null,
                status: 'failed',
                issues: ['terminal unavailable'],
            }),
            /Initial repository analysis failed/,
        );
    });

    it('preserves the existing snapshot after an incremental failure', () => {
        const previous: RepositoryAnalysis = {
            repositoryPath: '/tmp/repository',
            timestamp: '2026-08-30T00:00:00.000Z',
            summary: 'Existing analysis.',
            projectType: 'Library',
            technologies: ['TypeScript'],
            insights: ['Layered runtime.'],
        };

        const result = resolveRepositoryAnalysisAgentResult({
            analysis: null,
            status: 'failed',
            issues: ['terminal unavailable'],
        }, previous);

        assert.equal(result, null);
        assert.equal(previous.summary, 'Existing analysis.');
    });
});
