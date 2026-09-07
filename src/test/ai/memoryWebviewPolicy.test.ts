import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { parseCommitStageLog, PipelineLogLike, presentPipelineEvent } from '../../ui/pipelineDisplay';
import { filterMemoryLogsForWebview, isRunningMemoryConsolidation } from '../../ui/memoryWebviewPolicy';

describe('Memory Webview log policy', () => {
    it('keeps active consolidation alongside non-Memory logs and preserves their order', () => {
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
            'generation-start', 'api-request', 'memory-running', 'reason',
        ]);
        assert.equal(isRunningMemoryConsolidation(running), true);
    });

    it('renders the production running label and exposes the running spinner predicate', () => {
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

    it('removes an active row after its matching terminal event without removing unrelated logs', () => {
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
            'before', 'between', 'after',
        ]);
        assert.equal(isRunningMemoryConsolidation(afterTerminal[1]), true);
        assert.equal(isRunningMemoryConsolidation(matchingTerminal), false);
    });

    it('does not close a running operation for a budget event or another operation terminal', () => {
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

        assert.deepEqual(filterMemoryLogsForWebview(logs).map(log => log.id), ['running']);
    });

    it('hides preflight outcomes and other Memory operations without a task operationId', () => {
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
