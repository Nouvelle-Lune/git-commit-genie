import { logger } from '../logger';
import { safeRun } from '../../utils/safeRun';
import type { StageEvent } from '../../ui/StageNotificationManager';
import type { RequestType } from './llmTypes';
import type { LLMExecution } from './llmTypes';
import type { AIRunResponse, AIRunRequest, AISession } from './providers';
import type { CostQuote } from '../cost/costTypes';
import { formatWebviewApiResult } from './chatWebviewFormatting';
import { getRequestTypeLabel } from './providers/utils/requestTypeMaps';

export { formatWebviewApiResult } from './chatWebviewFormatting';

export interface WebviewSessionLoggingOptions {
    repoPath: string;
    requestType?: RequestType;
    /**
     * Bound accounting callback from LLMExecution.
     * Agent Runtime bypasses execution.run, so the wrapper must record each successful turn.
     */
    accountCall: (usage: AIRunResponse['usage']) => Promise<CostQuote>;
}

/**
 * Wraps an agent session so each LLM turn is mirrored in the Webview log list
 * and recorded exactly once through the execution-bound accounting callback.
 */
export function wrapSessionWithWebviewLogging(
    session: AISession,
    options: WebviewSessionLoggingOptions,
): AISession {
    const { repoPath, requestType, accountCall } = options;
    return {
        provider: session.provider,
        model: session.model,
        snapshot: () => session.snapshot(),
        run: async (request: AIRunRequest) => {
            const logId = logger.logApiRequest(repoPath || undefined);
            try {
                const response = await session.run(request);
                const quote = await accountCall(response.usage);
                logger.logUsageQuote(
                    session.provider,
                    session.model,
                    quote,
                    requestType ? getRequestTypeLabel(requestType) : '',
                );
                completeApiRequestLog(
                    logId,
                    session.provider,
                    session.model,
                    response.structured ?? response.text,
                    response,
                    requestType,
                    repoPath,
                    quote,
                );
                return response;
            } catch (error) {
                failApiRequestLog(logId, session.provider, session.model, error, repoPath);
                throw error;
            }
        },
    };
}

/** Convenience wrapper used by agent call sites that already hold an LLMExecution. */
export function wrapExecutionSessionForWebview(
    session: AISession,
    execution: LLMExecution,
    repoPath: string,
    requestType?: RequestType,
): AISession {
    return wrapSessionWithWebviewLogging(session, {
        repoPath,
        requestType,
        accountCall: usage => execution.accountCall(usage),
    });
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
    costQuote?: CostQuote,
): void {
    const { result, isFinal } = formatWebviewApiResult(data);
    logger.logApiRequestWithResult(
        logId,
        provider,
        model,
        result,
        isFinal,
        repoPath || undefined,
        requestType,
        costQuote,
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
        false,
        repoPath || undefined,
    ));
}
