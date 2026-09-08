import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { parseCommitStageLog, PipelineLogLike, presentPipelineEvent } from '../../ui/pipelineDisplay';
import {
    filterMemoryLogsForWebview,
    isRetryingMemoryConsolidation,
    isRunningMemoryConsolidation,
} from '../../ui/memoryWebviewPolicy';

describe('Memory Webview log policy', () => {
    it('keeps successful model memory tools and active consolidation alongside non-Memory logs', () => {
        // Successful model memory tool calls remain visible while maintenance rows stay hidden and ordinary logs retain their order.
        const running = stage('memory-running', 'memoryStep', {
            current: 0,
            tool: 'consolidate',
            trigger: 'manual',
            status: 'running',
            operationId: 'operation-running',
            label: 'Organizing memory',
            summary: 'Organizing memory',
            ok: true,
        });
        const logs = [
            ordinary('generation-start', 'generationStart', 'Generation started'),
            stage('memory-search', 'memoryStep', {
                current: 1,
                total: 2,
                tool: 'searchRepositoryMemory',
                summary: 'Found historical navigation.',
                ok: true,
            }),
            ordinary('api-request', 'apiRequest', 'API request'),
            stage('memory-sources', 'memoryStep', {
                current: 2,
                total: 2,
                tool: 'readMemorySources',
                summary: 'Revalidated memory sources.',
                ok: true,
            }),
            stage('memory-budget', 'memoryStep', {
                current: 0,
                tool: 'consolidation-budget',
                trigger: 'manual',
                status: 'ready',
                operationId: 'operation-running',
                summary: 'Memory consolidation input budget: 100 tokens.',
                ok: true,
            }),
            running,
            stage('memory-inspect', 'memoryStep', {
                current: 0,
                tool: 'inspect',
                trigger: 'manual',
                status: 'completed',
                summary: 'Inspected memory.',
                ok: true,
            }),
            ordinary('reason', 'reason', 'Reason'),
        ];

        const visible = filterMemoryLogsForWebview(logs);

        assert.deepEqual(visible.map(log => log.id), [
            'generation-start', 'memory-search', 'api-request', 'memory-sources', 'memory-running', 'reason',
        ]);
        assert.equal(isRunningMemoryConsolidation(running), true);
    });

    it('renders the production running label and exposes the running spinner predicate', () => {
        // A live consolidation memoryStep keeps its production label and is recognized as an active spinner row.
        const running = stage('running', 'memoryStep', {
            current: 0,
            tool: 'consolidate',
            trigger: 'automatic',
            status: 'running',
            operationId: 'operation-label',
            label: 'Organizing memory',
            summary: 'Organizing memory',
            ok: true,
        });
        const payload = parseCommitStageLog(running);
        assert.ok(payload);

        const presentation = presentPipelineEvent(payload);
        assert.equal(presentation.title, 'Organizing memory');
        assert.equal(presentation.description, 'Organizing memory');
        assert.equal(isRunningMemoryConsolidation(running), true);
    });

    it('keeps failed model memory tool calls visible while hiding navigation and maintenance preflight rows', () => {
        // Failed model memory tool calls remain visible, while retrieveNavigation and consolidation preflight diagnostics remain hidden.
        const logs = [
            ordinary('before'),
            stage('search-failed', 'memoryStep', {
                current: 1,
                total: 2,
                tool: 'searchRepositoryMemory',
                summary: 'Memory search failed.',
                reason: 'Memory search unavailable.',
                ok: false,
            }),
            stage('navigation-preflight', 'memoryStep', {
                current: 0,
                tool: 'retrieveNavigation',
                trigger: 'manual',
                status: 'preflight',
                operationId: 'operation-failed-tools',
                summary: 'Navigation preflight completed.',
                ok: false,
            }),
            stage('read-failed', 'memoryStep', {
                current: 2,
                total: 2,
                tool: 'readMemorySources',
                summary: 'Memory source read failed.',
                reason: 'Memory sources unavailable.',
                ok: false,
            }),
            stage('consolidation-preflight', 'memoryStep', {
                current: 0,
                tool: 'consolidation-budget',
                trigger: 'manual',
                status: 'ready',
                operationId: 'operation-failed-tools',
                summary: 'Memory consolidation input budget prepared.',
                ok: true,
            }),
            ordinary('after'),
        ];

        assert.deepEqual(filterMemoryLogsForWebview(logs).map(log => log.id), [
            'before', 'search-failed', 'read-failed', 'after',
        ]);
    });

    it('replaces an active row with its matching published terminal event without removing unrelated logs', () => {
        // The current contract keeps the published terminal row in original order and hides only its matching running row.
        const running = stage('running', 'memoryStep', {
            current: 0,
            tool: 'consolidate',
            trigger: 'manual',
            status: 'running',
            operationId: 'operation-terminal',
            label: 'Organizing memory',
            summary: 'Organizing memory',
            ok: true,
        });
        const beforeTerminal = [
            ordinary('before'),
            running,
            ordinary('between'),
        ];
        assert.deepEqual(filterMemoryLogsForWebview(beforeTerminal).map(log => log.id), [
            'before', 'running', 'between',
        ]);

        const otherTerminal = stage('other-terminal', 'memoryStep', {
            current: 0,
            tool: 'consolidate',
            trigger: 'automatic',
            status: 'published',
            operationId: 'different-operation',
            summary: 'Published another operation.',
            ok: true,
        });
        const matchingTerminal = stage('matching-terminal', 'memoryStep', {
            current: 0,
            tool: 'consolidate',
            trigger: 'manual',
            status: 'published',
            operationId: 'operation-terminal',
            summary: 'Consolidation completed.',
            ok: true,
        });
        const afterTerminal = [
            ...beforeTerminal,
            otherTerminal,
            matchingTerminal,
            ordinary('after'),
        ];

        assert.deepEqual(filterMemoryLogsForWebview(afterTerminal).map(log => log.id), [
            'before', 'between', 'other-terminal', 'matching-terminal', 'after',
        ]);
        assert.equal(isRunningMemoryConsolidation(afterTerminal[1]), true);
        assert.equal(isRunningMemoryConsolidation(matchingTerminal), false);
    });

    it('replaces a running operation with a matching failed terminal event', () => {
        // A failed terminal status is visible for the current session and replaces only the running row with the same operationId.
        const logs = [
            ordinary('before'),
            stage('running', 'memoryStep', {
                current: 0,
                tool: 'consolidate',
                trigger: 'manual',
                status: 'running',
                operationId: 'operation-failed',
                label: 'Organizing memory',
                summary: 'Organizing memory',
                ok: true,
            }),
            stage('failed', 'memoryStep', {
                current: 0,
                tool: 'consolidate',
                trigger: 'manual',
                status: 'failed',
                operationId: 'operation-failed',
                summary: 'Provider unavailable.',
                ok: false,
            }),
            ordinary('after'),
        ];

        assert.deepEqual(filterMemoryLogsForWebview(logs).map(log => log.id), [
            'before', 'failed', 'after',
        ]);
        assert.equal(isRunningMemoryConsolidation(logs[1]), true);
        assert.equal(isRunningMemoryConsolidation(logs[2]), false);
    });

    it('replaces a running operation with a matching cancelled terminal event', () => {
        // A cancelled terminal status remains visible for the current session while its matching running row is hidden.
        const logs = [
            ordinary('before'),
            stage('running', 'memoryStep', {
                current: 0,
                tool: 'consolidate',
                trigger: 'manual',
                status: 'running',
                operationId: 'operation-cancelled',
                label: 'Organizing memory',
                summary: 'Organizing memory',
                ok: true,
            }),
            stage('cancelled', 'memoryStep', {
                current: 0,
                tool: 'consolidate',
                trigger: 'manual',
                status: 'cancelled',
                operationId: 'operation-cancelled',
                summary: 'Consolidation cancelled.',
                ok: true,
            }),
            ordinary('after'),
        ];

        assert.deepEqual(filterMemoryLogsForWebview(logs).map(log => log.id), [
            'before', 'cancelled', 'after',
        ]);
        assert.equal(isRunningMemoryConsolidation(logs[1]), true);
        assert.equal(isRunningMemoryConsolidation(logs[2]), false);
    });

    it('keeps a running operation open for hidden preflight data and a different operation terminal', () => {
        // Only a published, failed, or cancelled terminal with the same operationId may close the running row.
        const running = stage('running', 'memoryStep', {
            current: 0,
            tool: 'consolidate',
            trigger: 'manual',
            status: 'running',
            operationId: 'operation-kept-open',
            label: 'Organizing memory',
            summary: 'Organizing memory',
            ok: true,
        });
        const logs = [
            running,
            stage('budget', 'memoryStep', {
                current: 0,
                tool: 'consolidation-budget',
                trigger: 'manual',
                status: 'ready',
                operationId: 'operation-kept-open',
                summary: 'Budget prepared.',
                ok: true,
            }),
            stage('other-terminal', 'memoryStep', {
                current: 0,
                tool: 'consolidate',
                trigger: 'automatic',
                status: 'failed',
                operationId: 'different-operation',
                summary: 'Other operation failed.',
                ok: false,
            }),
        ];

        assert.deepEqual(filterMemoryLogsForWebview(logs).map(log => log.id), ['running', 'other-terminal']);
    });

    it('hides preflight outcomes, non-terminal consolidation results, and other Memory operations', () => {
        // Low-level maintenance and preflight states remain hidden even when they carry an operationId or use a familiar result status.
        const logs = [
            ordinary('first'),
            stage('running-without-id', 'memoryStep', {
                current: 0, tool: 'consolidate', trigger: 'manual', status: 'running',
                label: 'Organizing memory', summary: 'Organizing memory', ok: true,
            }),
            stage('already-running', 'memoryStep', {
                current: 0, tool: 'consolidate', trigger: 'manual', status: 'already-running', ok: true,
            }),
            stage('foreground-busy', 'memoryStep', {
                current: 0, tool: 'consolidate', trigger: 'manual', status: 'foreground-busy', ok: true,
            }),
            stage('automatic-paused', 'memoryStep', {
                current: 0, tool: 'consolidate', trigger: 'automatic', status: 'automatic-paused', ok: true,
            }),
            stage('memory-disabled', 'memoryStep', {
                current: 0, tool: 'consolidate', trigger: 'manual', status: 'memory-disabled', ok: true,
            }),
            stage('partial', 'memoryStep', {
                current: 0, tool: 'consolidate', trigger: 'manual', status: 'partial', operationId: 'hidden-partial', ok: true,
            }),
            stage('no-findings', 'memoryStep', {
                current: 0, tool: 'consolidate', trigger: 'manual', status: 'no-findings', operationId: 'hidden-no-findings', ok: true,
            }),
            stage('budget-exhausted', 'memoryStep', {
                current: 0, tool: 'consolidate', trigger: 'manual', status: 'budget-exhausted', operationId: 'hidden-budget', ok: true,
            }),
            stage('validated', 'memoryStep', {
                current: 0, tool: 'consolidation-attempt', trigger: 'manual', status: 'validated', operationId: 'hidden-validated',
                attempt: 1, totalAttempts: 1, issues: [], ok: true,
            }),
            stage('management', 'memoryStep', {
                current: 0, tool: 'clear', trigger: 'manual', status: 'completed', ok: true,
            }),
            ordinary('last'),
        ];

        assert.deepEqual(filterMemoryLogsForWebview(logs).map(log => log.id), ['first', 'last']);
        for (const log of logs.slice(1, -1)) {
            assert.equal(isRunningMemoryConsolidation(log), false);
        }
    });

    it('keeps a validation-failed consolidation attempt only when another request is scheduled', () => {
        // A validation failure with complete identity and attempt metadata is the only consolidation-attempt row exposed as a retry.
        const retry = stage('retry', 'memoryStep', {
            current: 0,
            tool: 'consolidation-attempt',
            trigger: 'manual',
            status: 'validation-failed',
            operationId: 'operation-retry',
            attempt: 1,
            totalAttempts: 2,
            issues: ['groups.0: result is missing.'],
            ok: false,
        });

        assert.equal(isRetryingMemoryConsolidation(retry), true);
        assert.deepEqual(filterMemoryLogsForWebview([ordinary('before'), retry, ordinary('after')]).map(log => log.id), [
            'before', 'retry', 'after',
        ]);
        assert.equal(isRunningMemoryConsolidation(retry), false);
    });

    it('hides final, validated, incomplete, and incomplete-metadata consolidation attempts from retry display', () => {
        // Final validation failures, non-retry statuses, and incomplete operation or issue metadata must never appear as retry rows.
        const attempts = [
            stage('final-validation-failed', 'memoryStep', {
                current: 0, tool: 'consolidation-attempt', trigger: 'manual', status: 'validation-failed', operationId: 'final',
                attempt: 2, totalAttempts: 2, issues: ['final issue'], ok: false,
            }),
            stage('validated', 'memoryStep', {
                current: 0, tool: 'consolidation-attempt', trigger: 'manual', status: 'validated', operationId: 'validated',
                attempt: 1, totalAttempts: 2, issues: [], ok: true,
            }),
            stage('response-incomplete', 'memoryStep', {
                current: 0, tool: 'consolidation-attempt', trigger: 'manual', status: 'response-incomplete', operationId: 'incomplete',
                attempt: 1, totalAttempts: 2, issues: ['Response stopped without completing.'], ok: false,
            }),
            stage('missing-operation-id', 'memoryStep', {
                current: 0, tool: 'consolidation-attempt', trigger: 'manual', status: 'validation-failed',
                attempt: 1, totalAttempts: 2, issues: ['missing operation'], ok: false,
            }),
            stage('missing-attempt', 'memoryStep', {
                current: 0, tool: 'consolidation-attempt', trigger: 'manual', status: 'validation-failed', operationId: 'missing-attempt',
                totalAttempts: 2, issues: ['missing attempt'], ok: false,
            }),
            stage('missing-total-attempts', 'memoryStep', {
                current: 0, tool: 'consolidation-attempt', trigger: 'manual', status: 'validation-failed', operationId: 'missing-total',
                attempt: 1, issues: ['missing total attempts'], ok: false,
            }),
            stage('empty-operation-id', 'memoryStep', {
                current: 0, tool: 'consolidation-attempt', trigger: 'manual', status: 'validation-failed', operationId: '',
                attempt: 1, totalAttempts: 2, issues: ['empty operation'], ok: false,
            }),
            stage('blank-operation-id', 'memoryStep', {
                current: 0, tool: 'consolidation-attempt', trigger: 'manual', status: 'validation-failed', operationId: '   ',
                attempt: 1, totalAttempts: 2, issues: ['blank operation'], ok: false,
            }),
            stage('missing-issues', 'memoryStep', {
                current: 0, tool: 'consolidation-attempt', trigger: 'manual', status: 'validation-failed', operationId: 'missing-issues',
                attempt: 1, totalAttempts: 2, ok: false,
            }),
            stage('empty-issues', 'memoryStep', {
                current: 0, tool: 'consolidation-attempt', trigger: 'manual', status: 'validation-failed', operationId: 'empty-issues',
                attempt: 1, totalAttempts: 2, issues: [], ok: false,
            }),
            stage('invalid-issues', 'memoryStep', {
                current: 0, tool: 'consolidation-attempt', trigger: 'manual', status: 'validation-failed', operationId: 'invalid-issues',
                attempt: 1, totalAttempts: 2, issues: ['valid issue', '  '], ok: false,
            }),
        ];

        for (const attempt of attempts) {
            assert.equal(isRetryingMemoryConsolidation(attempt), false, attempt.id);
        }
        assert.deepEqual(filterMemoryLogsForWebview(attempts).map(log => log.id), []);
    });

    it('hides restored running, retry, and terminal consolidation rows', () => {
        // Persisted rows from a previous session cannot reopen a spinner, retry diagnostic, or terminal result in the current session.
        const restoredRunning = {
            ...stage('restored-running', 'memoryStep', {
                current: 0, tool: 'consolidate', trigger: 'manual', status: 'running', operationId: 'restored-operation',
                label: 'Organizing memory', summary: 'Organizing memory', ok: true,
            }),
            restoredFromPreviousSession: true,
        };
        const restoredRetry = {
            ...stage('restored-retry', 'memoryStep', {
                current: 0, tool: 'consolidation-attempt', trigger: 'manual', status: 'validation-failed', operationId: 'restored-operation',
                attempt: 1, totalAttempts: 2, issues: ['retry issue'], ok: false,
            }),
            restoredFromPreviousSession: true,
        };
        const restoredTerminal = {
            ...stage('restored-terminal', 'memoryStep', {
                current: 0, tool: 'consolidate', trigger: 'manual', status: 'failed', operationId: 'restored-operation',
                summary: 'Provider unavailable.', ok: false,
            }),
            restoredFromPreviousSession: true,
        };
        const logs = [ordinary('before'), restoredRunning, restoredRetry, restoredTerminal, ordinary('after')];

        assert.deepEqual(filterMemoryLogsForWebview(logs).map(log => log.id), ['before', 'after']);
        assert.equal(isRunningMemoryConsolidation(restoredRunning), false);
        assert.equal(isRetryingMemoryConsolidation(restoredRetry), false);
        assert.equal(isRunningMemoryConsolidation(restoredTerminal), false);
    });
});

function stage(id: string, stageName: string, data: Record<string, unknown>): PipelineLogLike {
    return {
        id,
        timestamp: 1,
        type: 'toolCall',
        title: 'Commit stage: event',
        content: JSON.stringify({ stage: stageName, data }),
    };
}

function ordinary(id: string, type = 'reason', title = 'Reason'): PipelineLogLike {
    return {
        id,
        timestamp: 1,
        type,
        title,
        content: id,
    };
}
