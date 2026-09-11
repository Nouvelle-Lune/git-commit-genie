import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import {
    deriveLatestPipelineSnapshot,
    formatStructuredFieldIssue,
    parseCommitStageLog,
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
            className: 'stage-badge-warning',
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

    it('renders memory tool calls as MEM entries without creating a separate pipeline step', () => {
        const presentation = presentPipelineEvent({
            stage: 'memoryStep',
            data: {
                current: 1,
                total: 3,
                tool: 'searchRepositoryMemory',
                summary: 'Found 2 historical navigation candidates.',
                ok: true,
                evidenceCount: 0,
            },
        });

        assert.equal(presentation.details?.kind, 'memoryStep');
        assert.match(presentation.title, /searchRepositoryMemory/);
        assert.equal(presentation.description, 'Found 2 historical navigation candidates.');
        assert.equal(presentation.tone, 'success');
        assert.deepEqual(pipelineStageBadge('memoryStep'), {
            label: 'MEM',
            className: 'stage-badge-memory',
        });

        const snapshot = deriveLatestPipelineSnapshot([
            log('generationStart', { generationMode: 'thinking', repoPath: '/tmp/repository' }),
            stage('investigationStart', { maxSteps: 3 }),
            stage('memoryStep', {
                current: 1,
                total: 3,
                tool: 'searchRepositoryMemory',
                summary: 'Found 2 historical navigation candidates.',
                ok: true,
                evidenceCount: 0,
            }),
        ]);

        assert.ok(snapshot);
        assert.equal(snapshot?.state, 'running');
        assert.equal(snapshot?.steps.find(step => step.id === 'investigate')?.state, 'active');
        assert.equal(snapshot?.steps.some(step => (step.id as string) === 'memory'), false);
    });

    it('renders maintenance memory operations without requiring a tool-budget total', () => {
        const presentation = presentPipelineEvent({
            stage: 'memoryStep',
            data: {
                current: 0,
                trigger: 'manual',
                status: 'running',
                tool: 'consolidateMemory',
                summary: 'Consolidating eligible repository memory.',
                ok: true,
            },
        });

        assert.equal(presentation.details?.kind, 'memoryStep');
        if (presentation.details?.kind !== 'memoryStep') {
            throw new Error('Expected memoryStep details');
        }
        assert.equal(presentation.details.trigger, 'manual');
        assert.equal(presentation.details.status, 'running');
        assert.equal(presentation.details.total, undefined);
        assert.deepEqual(presentation.metrics, []);
        assert.equal(presentation.tone, 'active');
    });

    it('parses maintenance memory events with trigger and status while preserving the agent total contract', () => {
        const maintenance = parseCommitStageLog(stage('memoryStep', {
            current: 0,
            trigger: 'manual',
            status: 'published',
            tool: 'consolidateMemory',
            summary: 'Published one handbook entry.',
            ok: true,
        }));
        if (!maintenance) {
            throw new Error('Expected a maintenance memory stage payload');
        }
        const presentation = presentPipelineEvent(maintenance);
        assert.equal(presentation.details?.kind, 'memoryStep');
        if (presentation.details?.kind !== 'memoryStep') {
            throw new Error('Expected maintenance memory details');
        }
        assert.equal(presentation.details.trigger, 'manual');
        assert.equal(presentation.details.status, 'published');
        assert.equal(presentation.details.total, undefined);

        const missingStatus = parseCommitStageLog(stage('memoryStep', {
            current: 0, trigger: 'manual', tool: 'consolidateMemory', ok: true,
        }));
        if (!missingStatus) {
            throw new Error('Expected a memory stage payload');
        }
        assert.throws(() => presentPipelineEvent(missingStatus), /missing required field 'status'/);

        const missingTotal = parseCommitStageLog(stage('memoryStep', {
            current: 1, tool: 'searchRepositoryMemory', ok: true,
        }));
        if (!missingTotal) {
            throw new Error('Expected an agent memory stage payload');
        }
        assert.throws(() => presentPipelineEvent(missingTotal), /missing required field 'total'/);
    });

    it('renders failed maintenance memory status as a warning without inventing progress totals', () => {
        const presentation = presentPipelineEvent({
            stage: 'memoryStep',
            data: {
                current: 0,
                trigger: 'automatic',
                status: 'failed',
                tool: 'consolidateMemory',
                summary: 'Provider unavailable.',
                ok: false,
            },
        });

        assert.equal(presentation.tone, 'warning');
        assert.deepEqual(presentation.metrics, []);
        if (presentation.details?.kind !== 'memoryStep') {
            throw new Error('Expected failed maintenance memory details');
        }
        assert.equal(presentation.details.trigger, 'automatic');
        assert.equal(presentation.details.status, 'failed');
        assert.equal(presentation.details.total, undefined);
        assert.match(presentation.description, /Provider unavailable/);
    });

    it('parses consolidation retry attempt metadata and exposes every validation issue in details', () => {
        // A retry memoryStep keeps its attempt bounds and complete issue list available for the expanded pipeline details view.
        const payload = parseCommitStageLog(stage('memoryStep', {
            current: 0,
            trigger: 'manual',
            status: 'validation-failed',
            tool: 'consolidation-attempt',
            operationId: 'operation-retry',
            attempt: 1,
            totalAttempts: 3,
            issues: ['groups.0: result is missing.', 'groups.1.sourceIds: source is not supported.'],
            summary: 'Memory consolidation attempt 1/3: 2 validation issues.',
            ok: false,
        }));
        if (!payload) {
            throw new Error('Expected a consolidation retry stage payload');
        }

        const presentation = presentPipelineEvent(payload);
        assert.equal(presentation.tone, 'warning');
        assert.deepEqual(presentation.metrics, []);
        assert.equal(presentation.details?.kind, 'memoryStep');
        if (presentation.details?.kind !== 'memoryStep') {
            throw new Error('Expected memoryStep retry details');
        }
        assert.equal(presentation.details.attempt, 1);
        assert.equal(presentation.details.totalAttempts, 3);
        assert.deepEqual(presentation.details.issues, [
            'groups.0: result is missing.',
            'groups.1.sourceIds: source is not supported.',
        ]);
        assert.equal(presentation.details.trigger, 'manual');
        assert.equal(presentation.details.status, 'validation-failed');
    });

    it('renders a failed memory source validation with the evidence count in its details', () => {
        const presentation = presentPipelineEvent({
            stage: 'memoryStep',
            data: {
                current: 2,
                total: 3,
                tool: 'readMemorySources',
                summary: 'Revalidated 1 memory source(s) and produced 0 repository evidence item(s).',
                ok: false,
                evidenceCount: 0,
                reason: 'Source no longer exists.',
            },
        });

        assert.equal(presentation.details?.kind, 'memoryStep');
        assert.equal(presentation.tone, 'warning');
        assert.deepEqual(presentation.metrics, [{ label: 'Progress', value: '2/3' }]);
        assert.match(presentation.description, /0 repository evidence/);
    });

    it('keeps interleaved RAG and agent events running until done', () => {
        const logs = [
            log('generationStart', { generationMode: 'thinking', repoPath: '/tmp/repository' }),
            stage('investigationStart', { maxSteps: 4 }),
            stage('investigationComplete', { steps: 2, evidenceCount: 3 }),
            stage('analysisFinalizing', {}),
            stage('investigationResolved', { findingCount: 1, unresolvedCount: 0, reason: 'Enough evidence.' }),
            stage('semanticAnalysisComplete', semanticAnalysisCompleteData()),
            stage('ragPrepared', ragPreparedData()),
            stage('informationSelected', informationSelectedData({ omitCount: 1 })),
        ];

        const running = deriveLatestPipelineSnapshot(logs);

        assert.ok(running);
        assert.equal(running.state, 'running');
        assert.equal(running.steps.find(step => step.id === 'investigate')?.state, 'complete');
        assert.equal(running.steps.find(step => step.id === 'analyze')?.state, 'complete');
        assert.equal(running.steps.find(step => step.id === 'rag')?.state, 'complete');
        assert.equal(running.steps.find(step => step.id === 'select')?.state, 'complete');
        assert.equal(running.predictedType, 'refactor');
        assert.equal(running.latest.stage, 'informationSelected');

        const degraded = deriveLatestPipelineSnapshot([
            log('generationStart', { generationMode: 'thinking', repoPath: '/tmp/repository' }),
            stage('investigationStart', { maxSteps: 4 }),
            stage('investigationComplete', { steps: 1, evidenceCount: 0 }),
            stage('analysisFinalizing', {}),
            stage('analysisDegraded', { reason: 'partial terminal', issueCount: 1, status: 'unavailable' }),
            stage('semanticAnalysisComplete', semanticAnalysisCompleteData()),
            stage('informationSelected', informationSelectedData()),
            stage('done', { finalMessage: 'feat(ui): improve pipeline logs\n\nBody' }),
        ]);
        assert.ok(degraded);
        assert.equal(degraded.state, 'degraded');
        assert.equal(degraded.steps.find(step => step.id === 'analyze')?.state, 'warning');
        assert.equal(degraded.steps.find(step => step.id === 'select')?.state, 'warning');
    });

    it('does not reactivate a completed investigation for maintenance memory events', () => {
        const snapshot = deriveLatestPipelineSnapshot([
            log('generationStart', { generationMode: 'thinking', repoPath: '/tmp/repository' }),
            stage('investigationStart', { maxSteps: 4 }),
            stage('investigationComplete', { steps: 2, evidenceCount: 3 }),
            stage('investigationResolved', { findingCount: 1, unresolvedCount: 0, reason: 'Enough evidence.' }),
            stage('memoryStep', {
                current: 0,
                trigger: 'automatic',
                status: 'completed',
                tool: 'consolidateMemory',
                summary: 'Consolidation completed.',
                ok: true,
            }),
        ]);

        assert.ok(snapshot);
        assert.equal(snapshot?.steps.find(step => step.id === 'investigate')?.state, 'complete');
        assert.equal(snapshot?.latest.stage, 'investigationResolved');
    });

    it('keeps a completed generation ready when a later maintenance event is appended', () => {
        const snapshot = deriveLatestPipelineSnapshot([
            log('generationStart', { generationMode: 'thinking', repoPath: '/tmp/repository' }),
            stage('investigationStart', { maxSteps: 4 }),
            stage('investigationResolved', { findingCount: 1, unresolvedCount: 0, reason: 'Enough evidence.' }),
            stage('done', { finalMessage: 'feat(memory): publish handbook entry' }),
            stage('memoryStep', {
                current: 0,
                trigger: 'automatic',
                status: 'published',
                tool: 'consolidateMemory',
                summary: 'Consolidation completed.',
                ok: true,
            }),
        ]);

        assert.ok(snapshot);
        assert.equal(snapshot?.state, 'ready');
        assert.equal(snapshot?.latest.stage, 'done');
        assert.equal(snapshot?.steps.some(step => step.state === 'active'), false);
    });

    it('maps investigationComplete and analysisFinalizing presentation details', () => {
        const complete = presentPipelineEvent({
            stage: 'investigationComplete',
            data: { steps: 2, evidenceCount: 3 },
        });
        const finalizing = presentPipelineEvent({
            stage: 'analysisFinalizing',
            data: {},
        });

        assert.equal(complete.details?.kind, 'investigationComplete');
        if (complete.details?.kind !== 'investigationComplete') {
            throw new Error('Expected investigationComplete details');
        }
        assert.equal(complete.details.steps, 2);
        assert.equal(complete.details.evidenceCount, 3);
        assert.equal(finalizing.details, undefined);
        assert.equal(finalizing.tone, 'active');
        assert.match(finalizing.description, /Tools are closed/);
    });

    it('maps investigationResolved presentation details', () => {
        const presentation = presentPipelineEvent({
            stage: 'investigationResolved',
            data: { findingCount: 2, unresolvedCount: 1, reason: 'Collected enough repository evidence.' },
        });

        assert.equal(presentation.details?.kind, 'investigationResolved');
        if (presentation.details?.kind !== 'investigationResolved') {
            throw new Error('Expected investigationResolved details');
        }
        assert.equal(presentation.details.findingCount, 2);
        assert.equal(presentation.details.unresolvedCount, 1);
        assert.equal(presentation.details.reason, 'Collected enough repository evidence.');
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
            'investigationPlanStart',
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
            stage: 'finalization',
            profile: 'change-analysis',
            failureKind: 'missingOutput',
            attempt: 1,
            totalAttempts: 3,
            finalFailure: false,
        }));
        const failed = presentStructuredValidationLog(validationLog({
            stage: 'finalization',
            profile: 'change-analysis',
            failureKind: 'missingOutput',
            attempt: 3,
            totalAttempts: 3,
            finalFailure: true,
        }));

        assert.ok(retry);
        assert.ok(failed);
        assert.match(retry.title, /retrying/i);
        assert.match(failed.title, /failed/i);
        assert.equal(retry.details.failureKind, 'missingOutput');
        assert.equal(retry.details.stage, 'finalization');
        assert.equal(retry.details.status, 'retrying');
        assert.equal(failed.details.status, 'failed');
    });

    it('maps schema mismatch retry and final failure combinations', () => {
        const retry = presentStructuredValidationLog(validationLog({
            stage: 'finalization',
            profile: 'change-analysis',
            failureKind: 'schemaMismatch',
            attempt: 1,
            totalAttempts: 2,
            finalFailure: false,
            error: 'invalid enum',
        }));
        const failed = presentStructuredValidationLog(validationLog({
            stage: 'finalization',
            profile: 'change-analysis',
            failureKind: 'schemaMismatch',
            attempt: 2,
            totalAttempts: 2,
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

    it('parses structured validation fieldIssues and renders them for display', () => {
        const fieldIssues = [{
            path: 'intentAnalysis.supportedBy',
            kind: 'tooManyItems' as const,
            count: 9,
            limit: 8,
        }];
        const presentation = presentStructuredValidationLog(validationLog({
            stage: 'finalization',
            profile: 'change-analysis',
            failureKind: 'schemaMismatch',
            attempt: 1,
            totalAttempts: 2,
            finalFailure: false,
            fieldIssues,
        }));

        assert.ok(presentation);
        assert.deepEqual(presentation.details.fieldIssues, fieldIssues);
        assert.equal(
            formatStructuredFieldIssue(fieldIssues[0]),
            'intentAnalysis.supportedBy has 9 items, at most 8 allowed',
        );
    });

    it('parses all six GLM-style fieldIssues without truncation', () => {
        const fieldIssues = [
            { path: 'investigation.findings[0].evidenceRefs', kind: 'tooManyItems' as const, count: 9, limit: 8 },
            { path: 'changeTargets[0].evidenceRefs', kind: 'tooManyItems' as const, count: 9, limit: 8 },
            { path: 'claims[0].evidenceRefs', kind: 'tooManyItems' as const, count: 9, limit: 8 },
            { path: 'claims[1].evidenceRefs', kind: 'tooManyItems' as const, count: 9, limit: 8 },
            { path: 'claims[2].evidenceRefs', kind: 'tooManyItems' as const, count: 9, limit: 8 },
            { path: 'intentAnalysis.supportedBy', kind: 'tooManyItems' as const, count: 9, limit: 8 },
        ];
        const presentation = presentStructuredValidationLog(validationLog({
            stage: 'finalization',
            profile: 'change-analysis',
            failureKind: 'schemaMismatch',
            attempt: 1,
            totalAttempts: 2,
            finalFailure: false,
            fieldIssues,
        }));

        assert.ok(presentation);
        assert.equal(presentation.details.fieldIssues.length, 6);
        assert.deepEqual(
            presentation.details.fieldIssues.map(issue => issue.path),
            fieldIssues.map(issue => issue.path),
        );
        for (const [index, issue] of presentation.details.fieldIssues.entries()) {
            assert.deepEqual(issue, fieldIssues[index]);
            assert.match(formatStructuredFieldIssue(issue), /has 9 items, at most 8 allowed/);
        }
    });

    it('throws when a structured validation fieldIssue is missing path', () => {
        assert.throws(
            () => presentStructuredValidationLog({
                id: 'missing-field-issue-path',
                timestamp: 3,
                type: 'toolCall',
                title: 'Structured output validation',
                content: JSON.stringify({
                    stage: 'finalization',
                    profile: 'change-analysis',
                    failureKind: 'schemaMismatch',
                    attempt: 1,
                    totalAttempts: 2,
                    finalFailure: false,
                    fieldIssues: [{
                        kind: 'tooManyItems',
                        count: 9,
                        limit: 8,
                    }],
                }),
            }),
            /missing fieldIssues\[0\]\.path/,
        );
    });

    it('throws for unknown failureKind values', () => {
        assert.throws(
            () => presentStructuredValidationLog(validationLog({
                stage: 'finalization',
                failureKind: 'unknown',
                attempt: 1,
                totalAttempts: 1,
                finalFailure: true,
            })),
            /unknown failureKind/,
        );
    });

    it('throws when required structured validation fields are missing', () => {
        assert.throws(
            () => presentStructuredValidationLog({
                id: 'broken-validation',
                timestamp: 1,
                type: 'toolCall',
                title: 'Structured output validation',
                content: JSON.stringify({ failureKind: 'missingOutput' }),
            }),
            /stage/,
        );
    });
});

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
        title: 'Structured output validation',
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
