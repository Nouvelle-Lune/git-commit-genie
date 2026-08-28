import { describe, it } from 'mocha';
import * as assert from 'assert';
import {
    DEFAULT_PIPELINE_TEXT,
    deriveLatestPipelineSnapshot,
    isLocalizedPipelineLanguage,
    parseCommitStageLog,
    PIPELINE_STAGE_BADGES,
    PipelineLogLike,
    pipelineStageBadge,
    presentPipelineEvent,
} from '../../ui/pipelineDisplay';
import { isCurrentPersistedLogEntry } from '../../ui/persistedLogSchema';

function generationStart(timestamp = 1): PipelineLogLike {
    return {
        id: `generation-${timestamp}`,
        timestamp,
        type: 'generationStart',
        title: 'Generation Started: demo — Thinking',
        repoPath: '/repo/demo',
        generationMode: 'thinking',
    };
}

function stageLog(stage: string, data: Record<string, unknown> = {}, timestamp = 2): PipelineLogLike {
    return {
        id: `${stage}-${timestamp}`,
        timestamp,
        type: 'toolCall',
        title: `Commit stage: ${stage}`,
        content: JSON.stringify({ stage, data }),
        repoPath: '/repo/demo',
    };
}

describe('pipeline display model', () => {
    it('rejects persisted generation logs from schemas that cannot be rendered', () => {
        assert.strictEqual(isCurrentPersistedLogEntry(generationStart()), true);
        assert.strictEqual(isCurrentPersistedLogEntry({
            ...generationStart(),
            generationMode: undefined,
        }), false);
        assert.strictEqual(isCurrentPersistedLogEntry({
            ...generationStart(),
            repoPath: undefined,
        }), false);
        assert.strictEqual(isCurrentPersistedLogEntry({
            ...stageLog('done', { finalMessage: 'chore: update parser' }),
            content: JSON.stringify({ data: {} }),
        }), false);
    });

    it('rejects malformed structured-validation logs before Webview rendering', () => {
        const base = {
            id: 'validation-1',
            timestamp: 1,
            type: 'toolCall',
            title: 'Structured output retry: summary',
        };
        assert.strictEqual(isCurrentPersistedLogEntry({
            ...base,
            content: JSON.stringify({
                stage: 'summary',
                attempt: 1,
                totalAttempts: 4,
                missingResponse: true,
                finalFailure: false,
            }),
        }), true);

        for (const content of ['{not-json}', JSON.stringify({ stage: '' }), JSON.stringify({ finalFailure: true })]) {
            assert.strictEqual(isCurrentPersistedLogEntry({ ...base, content }), false);
        }
        assert.strictEqual(isCurrentPersistedLogEntry({
            ...base,
            title: 'Tool call',
            reason: 'Structured output failed',
            content: '{not-json}',
        }), false);
    });

    it('localizes only the exact VS Code languages supported by the extension', () => {
        assert.strictEqual(isLocalizedPipelineLanguage('zh-cn'), true);
        assert.strictEqual(isLocalizedPipelineLanguage('ZH-TW'), true);
        assert.strictEqual(isLocalizedPipelineLanguage('en'), false);
        assert.strictEqual(isLocalizedPipelineLanguage('zh-hk'), false);
        assert.strictEqual(isLocalizedPipelineLanguage('fr'), false);
    });

    it('returns no snapshot when the log buffer has no generation stages', () => {
        assert.strictEqual(deriveLatestPipelineSnapshot([
            {
                id: 'analysis-1',
                timestamp: 1,
                type: 'analysisStart',
                title: 'Analysis Started: demo',
                repoPath: '/repo/demo',
            },
            generationStart(2),
        ]), null);
    });

    it('does not present the Thinking rail for a default generation run', () => {
        const snapshot = deriveLatestPipelineSnapshot([
            {
                ...generationStart(1),
                title: 'Generation Started: demo — Default',
                generationMode: 'default',
            },
            stageLog('done', { finalMessage: 'chore: update parser' }, 2),
        ]);

        assert.strictEqual(snapshot, null);
    });

    it('isolates the latest generation by repository path', () => {
        const snapshot = deriveLatestPipelineSnapshot([
            generationStart(1),
            stageLog('done', { finalMessage: 'chore: old run' }, 2),
            generationStart(3),
            {
                ...stageLog('done', { finalMessage: 'chore: other repository' }, 4),
                repoPath: '/repo/other',
            },
            stageLog('draftStart', {}, 5),
        ]);

        assert.ok(snapshot);
        assert.strictEqual(snapshot.state, 'running');
        assert.strictEqual(snapshot.latest.stage, 'draftStart');
        assert.strictEqual(snapshot.repoPath, '/repo/demo');
    });

    it('rejects malformed commit-stage payloads instead of silently inventing state', () => {
        assert.throws(
            () => parseCommitStageLog({
                id: 'bad-json',
                timestamp: 1,
                type: 'toolCall',
                title: 'Commit stage: done',
                content: '{not-json}',
            }),
            SyntaxError
        );
        assert.throws(
            () => parseCommitStageLog({
                id: 'missing-stage',
                timestamp: 1,
                type: 'toolCall',
                title: 'Commit stage: done',
                content: JSON.stringify({ data: {} }),
            }),
            /missing a stage/
        );
    });

    it('presents every current chain event with an actionable title', () => {
        const payloads: Array<{ stage: string; data: Record<string, unknown> }> = [
            { stage: 'evidenceReady', data: { fileCount: 1, rawFiles: 1, maxInputTokens: 32_000 } },
            { stage: 'evidenceRouted', data: { target: 'draft', rawFiles: 1, summarizedFiles: 0, estimatedInputTokens: 100, maxInputTokens: 32_000 } },
            { stage: 'summarizeStart', data: {} },
            { stage: 'summarizeProgress', data: { file: 'src/a.ts', current: 1, total: 1 } },
            { stage: 'summarizeFailed', data: { target: 'ragPreparation', error: 'context limit exceeded' } },
            { stage: 'ragDisabled', data: {} },
            { stage: 'ragPreparationStart', data: {} },
            { stage: 'ragPrepared', data: { changeSetSummary: { text: 'Update parser' }, retrievalFeatures: {} } },
            { stage: 'ragRetrievalStart', data: {} },
            { stage: 'ragRetrieved', data: { count: 0 } },
            { stage: 'ragPreparationSkipped', data: { error: 'unavailable' } },
            { stage: 'ragRetrievalSkipped', data: { error: 'unavailable' } },
            { stage: 'draftStart', data: {} },
            { stage: 'classifyDraft', data: { draft: 'chore: update parser' } },
            { stage: 'validationStart', data: {} },
            { stage: 'validateFix', data: { validMessage: 'chore: update parser' } },
            { stage: 'strictFixStart', data: {} },
            { stage: 'strictFix', data: { message: 'chore: update parser' } },
            { stage: 'enforceLanguageStart', data: { targetLanguage: 'en' } },
            { stage: 'enforceLanguage', data: { message: 'chore: update parser' } },
            { stage: 'done', data: { finalMessage: 'chore: update parser' } },
        ];

        for (const payload of payloads) {
            const presentation = presentPipelineEvent(payload);
            assert.ok(presentation.title.trim(), `stage '${payload.stage}' should have a title`);
            assert.ok(presentation.phase.trim(), `stage '${payload.stage}' should have a phase`);
            assert.strictEqual(presentation.stage, payload.stage);
        }
    });

    it('shows raw evidence flowing through a budgeted draft without summary', () => {
        const snapshot = deriveLatestPipelineSnapshot([
            generationStart(),
            stageLog('evidenceReady', { fileCount: 1, rawFiles: 1, maxInputTokens: 14_000 }, 2),
            stageLog('ragDisabled', { reason: 'disabled' }, 3),
            stageLog('evidenceRouted', {
                target: 'draft',
                rawFiles: 1,
                summarizedFiles: 0,
                estimatedInputTokens: 1_840,
                maxInputTokens: 14_000,
                didSummarize: false,
            }, 4),
            stageLog('draftStart', {}, 5),
        ]);

        assert.ok(snapshot);
        assert.strictEqual(snapshot.state, 'running');
        assert.strictEqual(snapshot.steps.find(step => step.id === 'evidence')?.state, 'complete');
        assert.strictEqual(snapshot.steps.find(step => step.id === 'summary')?.state, 'skipped');
        assert.strictEqual(snapshot.steps.find(step => step.id === 'rag')?.state, 'skipped');
        assert.strictEqual(snapshot.steps.find(step => step.id === 'draft')?.state, 'active');
        assert.deepStrictEqual(snapshot.latestHandoff, {
            target: 'draft',
            rawFiles: 1,
            summarizedFiles: 0,
            estimatedInputTokens: 1_840,
            maxInputTokens: 14_000,
        });
    });

    it('retains the RAG query and marks a completed degraded run', () => {
        const snapshot = deriveLatestPipelineSnapshot([
            generationStart(),
            stageLog('evidenceReady', { fileCount: 5, rawFiles: 5, maxInputTokens: 14_000 }, 2),
            stageLog('summarizeStart', {}, 3),
            stageLog('summarizeProgress', { file: 'uv.lock', current: 1, total: 5 }, 4),
            stageLog('evidenceRouted', {
                target: 'ragPreparation',
                rawFiles: 4,
                summarizedFiles: 1,
                estimatedInputTokens: 12_200,
                maxInputTokens: 14_000,
                didSummarize: true,
            }, 5),
            stageLog('ragPrepared', {
                changeSetSummary: { text: 'Add the initial project scaffold.' },
                retrievalFeatures: { predictedType: 'chore', predictedScope: null },
            }, 6),
            stageLog('ragRetrievalSkipped', { error: 'Index unavailable' }, 7),
            stageLog('classifyDraft', { draft: 'chore: initialize project' }, 8),
            stageLog('done', { finalMessage: 'chore: initialize project' }, 9),
        ]);

        assert.ok(snapshot);
        assert.strictEqual(snapshot.state, 'degraded');
        assert.strictEqual(snapshot.queryText, 'Add the initial project scaffold.');
        assert.strictEqual(snapshot.predictedType, 'chore');
        assert.strictEqual(snapshot.steps.find(step => step.id === 'summary')?.state, 'complete');
        assert.strictEqual(snapshot.steps.find(step => step.id === 'rag')?.state, 'warning');
        assert.strictEqual(snapshot.steps.find(step => step.id === 'verify')?.state, 'complete');
    });

    it('presents RAG preparation as the exact retrieval query handoff', () => {
        const payload = parseCommitStageLog(stageLog('ragPrepared', {
            changeSetSummary: { text: 'Configure an MCP project.' },
            retrievalFeatures: { predictedType: 'chore', predictedScope: 'mcp', fileCount: 5 },
        }));

        assert.ok(payload);
        const presentation = presentPipelineEvent(payload);
        assert.strictEqual(presentation.title, 'Retrieval query prepared');
        assert.strictEqual(presentation.description, 'Configure an MCP project.');
        assert.deepStrictEqual(presentation.metrics.map(metric => metric.value), ['chore', 'mcp', '5']);
    });

    it('attributes RAG-input compaction errors to Summary without marking RAG preparation as failed', () => {
        const snapshot = deriveLatestPipelineSnapshot([
            generationStart(),
            stageLog('evidenceReady', { fileCount: 3, rawFiles: 3, maxInputTokens: 14_000 }, 2),
            stageLog('summarizeStart', {}, 3),
            stageLog('summarizeFailed', {
                target: 'ragPreparation',
                error: 'maximum context length exceeded',
            }, 4),
        ]);

        assert.ok(snapshot);
        assert.strictEqual(snapshot.latest.stage, 'summarizeFailed');
        assert.strictEqual(snapshot.latest.title, 'Evidence compaction failed');
        assert.strictEqual(snapshot.latest.description, 'maximum context length exceeded');
        assert.strictEqual(snapshot.latest.phase, 'Transform');
        assert.strictEqual(snapshot.steps.find(step => step.id === 'summary')?.state, 'warning');
        assert.strictEqual(snapshot.steps.find(step => step.id === 'rag')?.state, 'skipped');
        assert.strictEqual(snapshot.state, 'degraded');
    });

    it('gives every presentable stage a badge, so a new stage cannot break the log list', () => {
        for (const stage of Object.keys(PIPELINE_STAGE_BADGES)) {
            const payload = parseCommitStageLog(stageLog(stage));
            assert.ok(payload, `stage '${stage}' did not parse`);
            // Throws for a stage the presenter does not know, which is the
            // failure this pairing is meant to prevent.
            presentPipelineEvent(payload);

            const badge = pipelineStageBadge(stage);
            assert.ok(badge.label.length > 0 && badge.label.length <= 4, `badge label for '${stage}' is not compact`);
            assert.ok(badge.className.startsWith('stage-badge-'), `badge class for '${stage}' is not a stage badge`);
        }
    });

    it('distinguishes stages whose names overlap', () => {
        // Substring matching mislabels these: `investigationPlanStart` contains
        // "investigation", so exact matching is required.
        assert.strictEqual(pipelineStageBadge('investigationPlanStart').label, 'PLAN');
        assert.strictEqual(pipelineStageBadge('investigationPlanned').label, 'PLAN');
        assert.strictEqual(pipelineStageBadge('investigationStep').label, 'INVG');
        assert.strictEqual(pipelineStageBadge('investigationSkipped').label, 'SKIP');
        assert.strictEqual(pipelineStageBadge('changeExtracted').label, 'EXTR');
        assert.strictEqual(pipelineStageBadge('semanticAnalysisComplete').label, 'SEM');
        assert.strictEqual(pipelineStageBadge('informationSelectionStart').label, 'SEL');
        assert.strictEqual(pipelineStageBadge('informationSelected').label, 'SEL');
    });

    it('falls back to a generic badge instead of throwing on an unknown stage', () => {
        const badge = pipelineStageBadge('someStageFromANewerBuild');
        assert.strictEqual(badge.label, 'STG');
        assert.strictEqual(badge.className, 'stage-badge-tool');
    });

    it('uses the localized catalog for the visible flow labels', () => {
        const text = {
            ...DEFAULT_PIPELINE_TEXT,
            stepEvidence: '证据',
            phaseOutput: '输出',
            doneTitle: '提交信息已生成',
        };
        const snapshot = deriveLatestPipelineSnapshot([
            generationStart(),
            stageLog('done', { finalMessage: 'chore: update parser' }),
        ], text);

        assert.ok(snapshot);
        assert.strictEqual(snapshot.steps[0].label, '证据');
        assert.strictEqual(snapshot.latest.phase, '输出');
        assert.strictEqual(snapshot.latest.title, '提交信息已生成');
    });
});
