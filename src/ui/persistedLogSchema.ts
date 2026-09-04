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

    // Legacy numeric cost field is no longer valid — drop those records.
    if ('cost' in value && value.cost !== undefined) {
        return false;
    }
    if (value.costDisplay !== undefined && !isCostDisplay(value.costDisplay)) {
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

    if (value.type === LogType.ToolCall && isStructuredValidationLog(value.title, value.reason)) {
        if (typeof value.content !== 'string' || !isStructuredValidationPayload(value.content)) {
            return false;
        }
    }

    return true;
}

function isCostDisplay(value: unknown): boolean {
    if (!isRecord(value) || typeof value.status !== 'string') {
        return false;
    }
    const allowed = new Set(['amount', 'free', 'unpriced', 'unavailable', 'none', 'partial']);
    if (!allowed.has(value.status)) {
        return false;
    }
    if (value.amountUsd !== undefined
        && (typeof value.amountUsd !== 'number' || !Number.isFinite(value.amountUsd))) {
        return false;
    }
    return true;
}

function isStructuredValidationLog(title: string, reason: unknown): boolean {
    const normalizedTitle = title.toLowerCase();
    const normalizedReason = typeof reason === 'string' ? reason.toLowerCase() : '';
    return normalizedTitle.includes('schema validation')
        || normalizedTitle.includes('structured output')
        || normalizedReason.includes('schema validation')
        || normalizedReason.includes('structured output');
}

function isStructuredValidationPayload(content: string): boolean {
    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch {
        return false;
    }

    if (!isRecord(parsed) || typeof parsed.stage !== 'string' || parsed.stage.length === 0) {
        return false;
    }
    if (parsed.finalFailure !== undefined && typeof parsed.finalFailure !== 'boolean') {
        return false;
    }
    if (parsed.missingResponse !== undefined && typeof parsed.missingResponse !== 'boolean') {
        return false;
    }
    return true;
}
