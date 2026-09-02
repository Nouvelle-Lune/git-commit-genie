import { logger } from '../logger';
import { safeRun } from '../../utils/safeRun';
import type { StageEvent } from '../../ui/StageNotificationManager';
import type { RequestType } from './llmTypes';
import type { AIRunResponse, AIRunRequest, AISession } from './providers';
import { formatWebviewApiResult } from './chatWebviewFormatting';

export { formatWebviewApiResult } from './chatWebviewFormatting';

/**
 * Wraps an agent session so each LLM turn is mirrored in the Webview log list.
 * AgentRuntime calls provider sessions directly instead of LLMExecution.run,
 * so it needs this wrapper to show API request progress in the dashboard.
 */
export function wrapSessionWithWebviewLogging(
    session: AISession,
    repoPath: string,
    requestType?: RequestType,
): AISession {
    return {
        provider: session.provider,
        model: session.model,
        snapshot: () => session.snapshot(),
        run: async (request: AIRunRequest) => {
            const logId = logger.logApiRequest(repoPath || undefined);
            try {
                const response = await session.run(request);
                completeApiRequestLog(
                    logId,
                    session.provider,
                    session.model,
                    response.structured ?? response.text,
                    response,
                    requestType,
                    repoPath,
                );
                return response;
            } catch (error) {
                failApiRequestLog(logId, session.provider, session.model, error, repoPath);
                throw error;
            }
        },
    };
}

export function logRepositoryAnalysisToolCall(
    repoPath: string,
    toolName: string,
    args: Record<string, unknown>,
    reason: string,
    step: number,
    maxSteps: number,
): void {
    safeRun('RepoAnalysis.logToolCall', () => logger.logToolCall(
        toolName,
        JSON.stringify({ ...args, step, maxSteps }),
        reason,
        repoPath,
    ));
}

/** Mirrors repository-analysis tool logging for change-conditioned investigation. */
export function logInvestigationToolCall(
    repoPath: string,
    toolName: string,
    args: Record<string, unknown>,
    reason: string,
    step: number,
    maxSteps: number,
): void {
    safeRun('Investigation.logToolCall', () => logger.logToolCall(
        toolName,
        JSON.stringify({ ...args, step, maxSteps }),
        reason,
        repoPath,
    ));
}

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
        requestType,
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
