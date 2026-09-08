import { parseCommitStageLog, PipelineLogLike } from './pipelineDisplay';

interface MemoryConsolidationEvent {
    operationId: string;
    status: string;
}

interface MemoryConsolidationRetryEvent {
    operationId: string;
    attempt: number;
    totalAttempts: number;
}

const VISIBLE_MEMORY_TERMINAL_STATUSES = new Set(['published', 'failed', 'cancelled']);

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

function parseMemoryConsolidationRetry(log: PipelineLogLike): MemoryConsolidationRetryEvent | undefined {
    const payload = parseCommitStageLog(log);
    const attempt = payload?.data.attempt;
    const totalAttempts = payload?.data.totalAttempts;
    if (payload?.stage !== 'memoryStep'
        || payload.data.tool !== 'consolidation-attempt'
        || payload.data.status !== 'validation-failed'
        || typeof payload.data.operationId !== 'string'
        || payload.data.operationId.trim().length === 0
        || typeof attempt !== 'number'
        || !Number.isSafeInteger(attempt)
        || typeof totalAttempts !== 'number'
        || !Number.isSafeInteger(totalAttempts)
        || attempt < 1
        || totalAttempts <= attempt
        || !Array.isArray(payload.data.issues)
        || payload.data.issues.length === 0
        || !payload.data.issues.every(issue => typeof issue === 'string' && issue.trim().length > 0)) {
        return undefined;
    }
    return {
        operationId: payload.data.operationId,
        attempt,
        totalAttempts,
    };
}

/** Returns true only for a live consolidation operation that is still running. */
export function isRunningMemoryConsolidation(log: PipelineLogLike): boolean {
    return log.restoredFromPreviousSession !== true
        && parseMemoryConsolidation(log)?.status === 'running';
}

/** Returns true only for a validation failure that schedules another attempt. */
export function isRetryingMemoryConsolidation(log: PipelineLogLike): boolean {
    return log.restoredFromPreviousSession !== true
        && parseMemoryConsolidationRetry(log) !== undefined;
}

/** Identifies live lifecycle rows that must become inert after persistence reload. */
export function isMemoryConsolidationLifecycleLog(log: PipelineLogLike): boolean {
    if (log.restoredFromPreviousSession === true) {
        return false;
    }
    const consolidation = parseMemoryConsolidation(log);
    return consolidation?.status === 'running'
        || (consolidation !== undefined && VISIBLE_MEMORY_TERMINAL_STATUSES.has(consolidation.status))
        || parseMemoryConsolidationRetry(log) !== undefined;
}

/**
 * Hide low-level Memory diagnostics while keeping the operation lifecycle visible.
 * A visible terminal event closes its matching running row and replaces it in the
 * list; retry events remain as individual diagnostics and are not removed by the
 * terminal close signal.
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
            if (isRetryingMemoryConsolidation(log)) {
                visible.push(log);
            }
            continue;
        }
        if (VISIBLE_MEMORY_TERMINAL_STATUSES.has(consolidation.status)
            && log.restoredFromPreviousSession !== true) {
            finishedOperations.add(consolidation.operationId);
            visible.push(log);
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
