import { strict as assert } from 'assert';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { Logger } from '../../services/logger/logger';
import {
    filterMemoryLogsForWebview,
    isRetryingMemoryConsolidation,
    isRunningMemoryConsolidation,
} from '../../ui/memoryWebviewPolicy';
import { LogEntry, LogType } from '../../ui/types/messages';

describe('persisted Memory Webview logs', () => {
    const logger = Logger.getInstance();

    beforeEach(() => {
        resetLogger();
    });

    afterEach(() => {
        resetLogger();
    });

    it('preserves an orphaned running consolidation as restored diagnostics without rewriting storage', async () => {
        // Reloaded running, retry, and published lifecycle rows are marked restored and remain hidden without updating persisted state.
        const persisted = [
            ordinary('ordinary-before'),
            memoryStage('memory-running', {
                current: 0,
                tool: 'consolidate',
                trigger: 'manual',
                status: 'running',
                operationId: 'stale-operation',
                label: 'Organizing memory',
                summary: 'Organizing memory',
                ok: true,
            }),
            memoryStage('memory-retry', {
                current: 0,
                tool: 'consolidation-attempt',
                trigger: 'manual',
                status: 'validation-failed',
                operationId: 'completed-operation',
                attempt: 1,
                totalAttempts: 2,
                issues: ['groups.0: result is missing.'],
                summary: 'Memory consolidation attempt 1/2: 1 validation issue.',
                ok: false,
            }),
            memoryStage('memory-terminal', {
                current: 0,
                tool: 'consolidate',
                trigger: 'manual',
                status: 'published',
                operationId: 'completed-operation',
                summary: 'Consolidation completed.',
                ok: true,
            }),
            memoryStage('memory-search', {
                current: 1,
                total: 1,
                tool: 'searchRepositoryMemory',
                summary: 'Found historical navigation.',
                ok: true,
            }),
            memoryStage('memory-budget', {
                current: 0,
                tool: 'consolidation-budget',
                trigger: 'manual',
                status: 'ready',
                operationId: 'completed-operation',
                summary: 'Memory consolidation input budget: 100 tokens.',
                ok: true,
            }),
            ordinary('ordinary-after'),
        ];
        const { context, updates } = mockContext(persisted);
        (logger as any).context = context;

        await logger.loadPersistedLogs();

        const buffer = (logger as any).logBuffer as LogEntry[];
        assert.deepEqual(buffer.map(log => log.id), [
            'ordinary-before', 'memory-running', 'memory-retry', 'memory-terminal', 'memory-search', 'memory-budget', 'ordinary-after',
        ]);
        const restoredRunning = buffer.find(log => log.id === 'memory-running');
        const restoredRetry = buffer.find(log => log.id === 'memory-retry');
        const restoredTerminal = buffer.find(log => log.id === 'memory-terminal');
        assert.ok(restoredRunning);
        assert.ok(restoredRetry);
        assert.ok(restoredTerminal);
        assert.equal(restoredRunning.restoredFromPreviousSession, true);
        assert.equal(restoredRetry.restoredFromPreviousSession, true);
        assert.equal(restoredTerminal.restoredFromPreviousSession, true);
        assert.equal(isRunningMemoryConsolidation(restoredRunning), false);
        assert.equal(isRetryingMemoryConsolidation(restoredRetry), false);
        assert.equal(isRunningMemoryConsolidation(restoredTerminal), false);
        assert.deepEqual(filterMemoryLogsForWebview(buffer).map(log => log.id), [
            'ordinary-before', 'ordinary-after',
        ]);
        assert.equal(updates.length, 0);
    });
});

function resetLogger(): void {
    const logger = Logger.getInstance() as any;
    logger.context = null;
    logger.logBuffer = [];
    logger.outputChannel = null;
    logger.webviewProvider = null;
}

function mockContext(persisted: LogEntry[]): {
    context: vscode.ExtensionContext;
    updates: Array<{ key: string; value: unknown }>;
} {
    const updates: Array<{ key: string; value: unknown }> = [];
    const globalState = {
        get: <T>(_key: string): T => persisted as unknown as T,
        update: async (key: string, value: unknown): Promise<void> => {
            updates.push({ key, value });
        },
        keys: (): string[] => [],
        setKeysForSync: (_keys: readonly string[]): void => undefined,
    };
    const workspaceState = {
        get: <T>(_key: string): T | undefined => undefined,
        update: async (_key: string, _value: unknown): Promise<void> => undefined,
        keys: (): string[] => [],
        setKeysForSync: (_keys: readonly string[]): void => undefined,
    };
    return {
        context: { globalState, workspaceState } as unknown as vscode.ExtensionContext,
        updates,
    };
}

function ordinary(id: string): LogEntry {
    return {
        id,
        timestamp: 1,
        type: LogType.FinalResult,
        title: 'Ordinary log',
        content: id,
    };
}

function memoryStage(id: string, data: Record<string, unknown>): LogEntry {
    return {
        id,
        timestamp: 1,
        type: LogType.ToolCall,
        title: 'Commit stage: event',
        content: JSON.stringify({ stage: 'memoryStep', data }),
    };
}
