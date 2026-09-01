import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import {
    deriveLatestPipelineSnapshot,
    pipelineStageBadge,
    presentPipelineEvent,
} from '../../ui/pipelineDisplay';

describe('pipeline display for parallel analysis events', () => {
    it('renders degraded analysis as a visible warning', () => {
        const presentation = presentPipelineEvent({
            stage: 'analysisDegraded',
            data: { reason: 'Terminal references were invalid.', issueCount: 1 },
        });

        assert.equal(presentation.tone, 'warning');
        assert.equal(presentation.title, 'Semantic analysis degraded');
        assert.match(presentation.description, /invalid/);
        assert.deepEqual(pipelineStageBadge('analysisDegraded'), {
            label: 'WARN',
            className: 'stage-badge-skipped',
        });
    });

    it('renders context compaction as a successful observable context event', () => {
        const presentation = presentPipelineEvent({
            stage: 'contextCompacted',
            data: { epoch: 1, reason: 'Input budget reached.' },
        });

        assert.equal(presentation.tone, 'success');
        assert.equal(presentation.metrics[0].value, '1');
        assert.equal(pipelineStageBadge('contextCompacted').label, 'CTX');
    });

    it('keeps interleaved RAG and agent events running until done', () => {
        const logs = [
            log('generationStart', { generationMode: 'thinking', repoPath: '/tmp/repository' }),
            stage('changeExtractionStart'),
            stage('changeExtracted'),
            stage('investigationStart'),
            stage('semanticAnalysisStart'),
            stage('ragPrepared', {
                changeSetSummary: { text: 'update runtime' },
                retrievalFeatures: { predictedType: 'refactor', predictedScope: 'agent' },
            }),
            stage('informationSelected', { mustExpress: [], omitCount: 1 }),
        ];

        const running = deriveLatestPipelineSnapshot(logs);

        assert.ok(running);
        assert.equal(running.state, 'running');
        assert.equal(running.steps.find(step => step.id === 'rag')?.state, 'complete');
        assert.equal(running.steps.find(step => step.id === 'select')?.state, 'complete');
        assert.equal(running.predictedType, 'refactor');
        assert.equal(running.latest.stage, 'informationSelected');

        const degraded = deriveLatestPipelineSnapshot([
            log('generationStart', { generationMode: 'thinking', repoPath: '/tmp/repository' }),
            stage('changeExtractionStart'),
            stage('changeExtracted'),
            stage('investigationStart'),
            stage('analysisDegraded', { reason: 'partial terminal' }),
            stage('semanticAnalysisStart'),
            stage('semanticAnalysisComplete'),
            stage('informationSelectionStart'),
            stage('informationSelected', { mustExpress: [] }),
            stage('done'),
        ]);
        assert.ok(degraded);
        assert.equal(degraded.state, 'degraded');
        assert.equal(degraded.steps.find(step => step.id === 'analyze')?.state, 'warning');
        assert.equal(degraded.steps.find(step => step.id === 'select')?.state, 'warning');
    });
});

function stage(stageName: string, data: Record<string, unknown> = {}) {
    return log('toolCall', { stage: stageName, data });
}

function log(type: string, content: Record<string, unknown>): {
    id: string;
    timestamp: number;
    type: string;
    title: string;
    content?: string;
    repoPath?: string;
    generationMode?: 'default' | 'thinking';
} {
    if (type === 'generationStart') {
        return {
            id: `log-${type}`,
            timestamp: 1,
            type,
            title: 'Generation started',
            repoPath: content.repoPath as string,
            generationMode: content.generationMode as 'thinking',
        };
    }
    const id = `log-${content.stage ?? type}-${JSON.stringify(content.data ?? {})}`;
    return {
        id,
        timestamp: 2,
        type,
        title: 'Commit stage: event',
        content: JSON.stringify(content),
        repoPath: '/tmp/repository',
    };
}
