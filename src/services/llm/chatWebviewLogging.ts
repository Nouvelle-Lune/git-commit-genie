import { logger } from '../logger';
import { safeRun } from '../../utils/safeRun';
import type { StageEvent } from '../../ui/StageNotificationManager';
import type { RequestType } from './llmTypes';
import type { AIRunResponse } from './providers';
import { formatWebviewApiResult } from './chatWebviewFormatting';

export { formatWebviewApiResult } from './chatWebviewFormatting';

export function logCommitStageToWebview(repoPath: string, event: StageEvent): void {
    const payload = { stage: event.type, data: event.data ?? {} };
    safeRun('LLM.logCommitStage', () => logger.logToolCall(
        'commitStage',
        JSON.stringify(payload),
        'Commit generation stage',
        repoPath,
    ));
}

export function logSchemaValidationToWebview(
    repoPath: string,
    payload: Record<string, unknown>,
    reason: string,
): void {
    safeRun('LLM.logSchemaValidation', () => logger.logToolCall(
        'schemaValidation',
        JSON.stringify(payload),
        reason,
        repoPath,
    ));
}

export function completeApiRequestLog(
    logId: string,
    provider: string,
    model: string,
    data: unknown,
    response: Pick<AIRunResponse, 'usage'>,
    requestType: RequestType | undefined,
    repoPath: string,
): void {
    const { result, isFinal } = formatWebviewApiResult(data);
    logger.logApiRequestWithResult(
        logId,
        provider,
        model,
        result,
        response.usage?.raw,
        isFinal,
        repoPath || undefined,
    );
}

/** Thrown after an API request failure has already been written to the request log. */
export class ApiRequestLogFailedError extends Error {
    constructor(readonly cause: unknown) {
        super(String((cause as Error)?.message ?? cause));
        this.name = 'ApiRequestLogFailedError';
    }
}

export function failApiRequestLog(
    logId: string,
    provider: string,
    model: string,
    error: unknown,
    repoPath: string,
): void {
    safeRun('LLM.failApiRequestLog', () => logger.logApiRequestWithResult(
        logId,
        provider,
        model,
        { error: String((error as Error)?.message || error) },
        undefined,
        false,
        repoPath || undefined,
    ));
}
