import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import {
    deriveLatestPipelineSnapshot,
    pipelineStageBadge,
    presentPipelineEvent,
    presentStructuredValidationLog,
} from '../../ui/pipelineDisplay';

describe('pipeline display for parallel analysis events', () => {
    it('labels the compound analysis handoff before repository tool calls', () => {
        const presentation = presentPipelineEvent({
            stage: 'evidenceRouted',
            data: {
                target: 'semanticAnalysis',
                rawFiles: 2,
                summarizedFiles: 0,
                initialEstimatedInputTokens: 1200,
                estimatedInputTokens: 1200,
                maxInputTokens: 8000,
                didSummarize: false,
            },
        });

        assert.equal(
            presentation.title,
            'Evidence ready for Repository Investigation and Semantic Analysis',
        );
        assert.doesNotMatch(presentation.title, /Semantic analysis input/);
    });

    it('renders degraded analysis as a visible warning', () => {
        const presentation = presentPipelineEvent({
            stage: 'analysisDegraded',
            data: { reason: 'Terminal references were invalid.', issueCount: 1, status: 'unavailable' },
        });

        assert.equal(presentation.tone, 'warning');
        assert.equal(presentation.title, 'Semantic analysis degraded');
        assert.match(presentation.description, /invalid/);
        assert.equal(presentation.details?.kind, 'analysisDegraded');
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
        assert.equal(presentation.details?.kind, 'contextCompacted');
        assert.equal(pipelineStageBadge('contextCompacted').label, 'CTX');
    });

    it('keeps interleaved RAG and agent events running until done', () => {
        const logs = [
            log('generationStart', { generationMode: 'thinking', repoPath: '/tmp/repository' }),
            stage('changeExtractionStart'),
            stage('changeExtracted', changeExtractedData()),
            stage('investigationStart', { maxSteps: 4 }),
            stage('semanticAnalysisStart'),
            stage('ragPrepared', ragPreparedData()),
            stage('informationSelected', informationSelectedData({ omitCount: 1 })),
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
            stage('changeExtracted', changeExtractedData()),
            stage('investigationStart', { maxSteps: 4 }),
            stage('analysisDegraded', { reason: 'partial terminal', issueCount: 1, status: 'unavailable' }),
            stage('semanticAnalysisStart'),
            stage('semanticAnalysisComplete', semanticAnalysisCompleteData()),
            stage('informationSelectionStart'),
            stage('informationSelected', informationSelectedData()),
            stage('done', { finalMessage: 'feat(ui): improve pipeline logs\n\nBody' }),
        ]);
        assert.ok(degraded);
        assert.equal(degraded.state, 'degraded');
        assert.equal(degraded.steps.find(step => step.id === 'analyze')?.state, 'warning');
        assert.equal(degraded.steps.find(step => step.id === 'select')?.state, 'warning');
    });
});

describe('pipeline event details', () => {
    it('returns details for semanticAnalysisComplete with full mapping', () => {
        const presentation = presentPipelineEvent({
            stage: 'semanticAnalysisComplete',
            data: semanticAnalysisCompleteData(),
        });

        assert.equal(presentation.details?.kind, 'semanticAnalysisComplete');
        if (presentation.details?.kind !== 'semanticAnalysisComplete') {
            throw new Error('Expected semanticAnalysisComplete details');
        }
        assert.equal(presentation.details.primaryIntent, 'Improve pipeline presentation');
        assert.equal(presentation.details.observableEffect, 'Structured content instead of JSON');
        assert.equal(presentation.details.recommendedType, 'feat');
        assert.equal(presentation.details.confidence, 'high');
        assert.equal(presentation.details.factCount, 8);
        assert.equal(presentation.details.uncertaintyCount, 1);
    });

    it('preserves complete mustExpress and optional lists for informationSelected', () => {
        const presentation = presentPipelineEvent({
            stage: 'informationSelected',
            data: informationSelectedData({
                mustExpress: ['intent one', 'intent two'],
                optional: ['optional one'],
            }),
        });

        assert.equal(presentation.details?.kind, 'informationSelected');
        if (presentation.details?.kind !== 'informationSelected') {
            throw new Error('Expected informationSelected details');
        }
        assert.deepEqual(presentation.details.mustExpress, ['intent one', 'intent two']);
        assert.deepEqual(presentation.details.optional, ['optional one']);
    });

    it('parses nested ragPrepared query, summary, and features', () => {
        const presentation = presentPipelineEvent({
            stage: 'ragPrepared',
            data: ragPreparedData(),
        });

        assert.equal(presentation.details?.kind, 'ragPrepared');
        if (presentation.details?.kind !== 'ragPrepared') {
            throw new Error('Expected ragPrepared details');
        }
        assert.deepEqual(presentation.details.mustExpress, ['update runtime']);
        assert.equal(presentation.details.type, 'refactor');
        assert.equal(presentation.details.scope, 'agent');
        assert.match(presentation.details.changeSetSummary, /update runtime/);
        assert.ok(presentation.details.retrievalFeatures.some(line => line.includes('refactor')));
    });

    it('accepts empty ragPrepared change-set summary when mustExpress is empty', () => {
        const presentation = presentPipelineEvent({
            stage: 'ragPrepared',
            data: {
                query: { mustExpress: [], type: null, scope: null },
                changeSetSummary: { text: '' },
                retrievalFeatures: { fileCount: 0, areas: [], fileKinds: [], changeActions: [], entities: [], touchedPaths: [], fileExtensions: [], statusMix: [], hasDocs: false, hasTests: false, hasConfig: false, hasRenames: false, isCrossLayer: false, breakingLike: false },
            },
        });

        assert.equal(presentation.details?.kind, 'ragPrepared');
        if (presentation.details?.kind !== 'ragPrepared') {
            throw new Error('Expected ragPrepared details');
        }
        assert.deepEqual(presentation.details.mustExpress, []);
        assert.equal(presentation.details.changeSetSummary, '');
    });

    it('keeps all ragRetrieved references', () => {
        const presentation = presentPipelineEvent({
            stage: 'ragRetrieved',
            data: {
                count: 1,
                references: [{
                    commitHash: 'abc123',
                    message: 'feat(scope): example\n\nFooter',
                    subject: 'feat(scope): example',
                    styleReason: 'Similar scope',
                    matchedBy: ['hybrid'],
                }],
            },
        });

        assert.equal(presentation.details?.kind, 'ragRetrieved');
        if (presentation.details?.kind !== 'ragRetrieved') {
            throw new Error('Expected ragRetrieved details');
        }
        assert.equal(presentation.details.references.length, 1);
        assert.match(presentation.details.references[0].message, /Footer/);
    });

    it('preserves complete multiline commit messages for draft and final stages', () => {
        const message = 'feat(ui): headline\n\n- detail\n\nBREAKING CHANGE: note';
        const draft = presentPipelineEvent({ stage: 'classifyDraft', data: { draft: message } });
        const done = presentPipelineEvent({ stage: 'done', data: { finalMessage: message } });

        assert.equal(draft.details?.kind, 'commitMessage');
        assert.equal(done.details?.kind, 'commitMessage');
        if (draft.details?.kind !== 'commitMessage' || done.details?.kind !== 'commitMessage') {
            throw new Error('Expected commit message details');
        }
        assert.equal(draft.details.message, message);
        assert.equal(done.details.message, message);
        assert.equal(draft.details.source, 'draft');
        assert.equal(done.details.source, 'final');
    });

    it('omits details for start-only stages', () => {
        for (const stageName of [
            'summarizeStart',
            'changeExtractionStart',
            'investigationPlanStart',
            'semanticAnalysisStart',
            'informationSelectionStart',
            'ragDisabled',
            'ragRetrievalStart',
            'draftStart',
            'validationStart',
            'enforceLanguageStart',
        ]) {
            const presentation = presentPipelineEvent({ stage: stageName, data: {} });
            assert.equal(presentation.details, undefined, `Expected no details for ${stageName}`);
        }
    });

    it('throws when a detailed stage is missing required fields', () => {
        assert.throws(
            () => presentPipelineEvent({ stage: 'semanticAnalysisComplete', data: { factCount: 1 } }),
            /uncertaintyCount/,
        );
    });
});

describe('structured validation presentation', () => {
    it('maps missing output retry and final failure combinations', () => {
        const retry = presentStructuredValidationLog(validationLog({
            stage: 'changeExtraction',
            attempt: 1,
            totalAttempts: 3,
            missingResponse: true,
            finalFailure: false,
        }));
        const failed = presentStructuredValidationLog(validationLog({
            stage: 'changeExtraction',
            attempt: 3,
            totalAttempts: 3,
            missingResponse: true,
            finalFailure: true,
        }));

        assert.ok(retry);
        assert.ok(failed);
        assert.match(retry.title, /retrying/i);
        assert.match(failed.title, /failed/i);
        assert.equal(retry.details.failureKind, 'missingOutput');
        assert.equal(retry.details.status, 'retrying');
        assert.equal(failed.details.status, 'failed');
    });

    it('maps schema mismatch retry and final failure combinations', () => {
        const retry = presentStructuredValidationLog(validationLog({
            stage: 'semanticAnalysis',
            attempt: 1,
            totalAttempts: 2,
            error: 'invalid enum',
        }));
        const failed = presentStructuredValidationLog(validationLog({
            stage: 'semanticAnalysis',
            finalFailure: true,
            error: 'invalid enum',
        }));

        assert.ok(retry);
        assert.ok(failed);
        assert.equal(retry.details.failureKind, 'schemaMismatch');
        assert.equal(failed.details.failureKind, 'schemaMismatch');
        assert.equal(retry.details.status, 'retrying');
        assert.equal(failed.details.status, 'failed');
        assert.equal(failed.details.error, 'invalid enum');
    });
});

function changeExtractedData() {
    return {
        symbolCount: 1,
        symbols: ['foo (modified)'],
        configCount: 0,
        typeCount: 0,
        dependencyCount: 0,
    };
}

function semanticAnalysisCompleteData() {
    return {
        primaryIntent: 'Improve pipeline presentation',
        observableEffect: 'Structured content instead of JSON',
        recommendedType: 'feat',
        confidence: 'high',
        factCount: 8,
        uncertaintyCount: 1,
    };
}

function informationSelectedData(overrides: Record<string, unknown> = {}) {
    return {
        mustExpress: [],
        optional: [],
        omitCount: 0,
        suggestedScope: 'ui',
        recommendedType: 'feat',
        ...overrides,
    };
}

function ragPreparedData() {
    return {
        query: {
            mustExpress: ['update runtime'],
            type: 'refactor',
            scope: 'agent',
        },
        changeSetSummary: {
            text: 'update runtime',
        },
        retrievalFeatures: {
            predictedType: 'refactor',
            predictedScope: 'agent',
            fileCount: 2,
            areas: ['agent'],
            fileKinds: ['ts'],
            changeActions: ['refactor'],
            entities: [],
            touchedPaths: ['src/a.ts'],
            fileExtensions: ['.ts'],
            statusMix: ['modified'],
            hasDocs: false,
            hasTests: true,
            hasConfig: false,
            hasRenames: false,
            isCrossLayer: false,
            breakingLike: false,
        },
    };
}

function stage(stageName: string, data: Record<string, unknown> = {}) {
    return log('toolCall', { stage: stageName, data });
}

function validationLog(payload: Record<string, unknown>) {
    return {
        id: `validation-${JSON.stringify(payload)}`,
        timestamp: 3,
        type: 'toolCall',
        title: 'Structured output missing',
        content: JSON.stringify(payload),
    };
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
