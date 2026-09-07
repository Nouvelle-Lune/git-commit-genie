import { parseCommitStageLog, PipelineLogLike } from './pipelineDisplay';

interface MemoryConsolidationEvent {
    operationId: string;
    status: string;
}

function parseMemoryConsolidation(log: PipelineLogLike): MemoryConsolidationEvent | undefined {
    const payload = parseCommitStageLog(log);
    if (payload?.stage !== 'memoryStep'
        || payload.data.tool !== 'consolidate'
        || typeof payload.data.operationId !== 'string'
        || typeof payload.data.status !== 'string') {
        return undefined;
    }
    return {
        operationId: payload.data.operationId,
        status: payload.data.status,
    };
}

/** Returns true only for the one Memory state exposed in the Webview. */
export function isRunningMemoryConsolidation(log: PipelineLogLike): boolean {
    return log.restoredFromPreviousSession !== true
        && parseMemoryConsolidation(log)?.status === 'running';
}

/**
 * Hide Memory diagnostics and retain only consolidation work that is still active.
 * Terminal events stay in the underlying log stream for diagnostics, but close the
 * matching running row instead of adding another user-facing Memory status.
 */
export function filterMemoryLogsForWebview<T extends PipelineLogLike>(logs: readonly T[]): T[] {
    const finishedOperations = new Set<string>();
    const visible: T[] = [];

    for (let index = logs.length - 1; index >= 0; index -= 1) {
        const log = logs[index];
        const payload = parseCommitStageLog(log);
        if (payload?.stage !== 'memoryStep') {
            visible.push(log);
            continue;
        }

        const consolidation = parseMemoryConsolidation(log);
        if (!consolidation) {
            continue;
        }
        if (consolidation.status !== 'running') {
            finishedOperations.add(consolidation.operationId);
            continue;
        }
        if (!finishedOperations.has(consolidation.operationId) && isRunningMemoryConsolidation(log)) {
            visible.push(log);
        }
    }

    return visible.reverse();
}
