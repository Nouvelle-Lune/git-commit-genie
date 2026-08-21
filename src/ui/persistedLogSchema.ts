import { LogEntry, LogType } from './types/messages';
import { parseCommitStageLog, presentPipelineEvent } from './pipelineDisplay';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates persisted logs against the fields required by the current Webview.
 * Persisted UI state is an external data boundary because extension upgrades
 * can leave records whose shape no longer matches the active renderer.
 */
export function isCurrentPersistedLogEntry(value: unknown): value is LogEntry {
    if (!isRecord(value)
        || typeof value.id !== 'string'
        || typeof value.timestamp !== 'number'
        || !Number.isFinite(value.timestamp)
        || typeof value.title !== 'string'
        || !Object.values(LogType).includes(value.type as LogType)) {
        return false;
    }

    if (value.type === LogType.GenerationStart) {
        return typeof value.repoPath === 'string'
            && value.repoPath.length > 0
            && (value.generationMode === 'default' || value.generationMode === 'thinking');
    }

    if (value.type === LogType.ToolCall && value.title.startsWith('Commit stage:')) {
        try {
            const payload = parseCommitStageLog(value as unknown as LogEntry);
            if (!payload) {
                return false;
            }
            presentPipelineEvent(payload);
        } catch {
            return false;
        }
    }

    return true;
}
