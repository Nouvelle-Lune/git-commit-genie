import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { z } from 'zod';
import {
    AIMessage,
    AIProvider,
    AISession,
    AIModelConfig,
    createAIProvider,
    modelSecretKey,
} from './providers';
import { TemplateService } from '../../template/templateService';
import { IRepositoryAnalysisService } from '../analysis/repository/repositoryAnalysisTypes';
import { generateCommitMessageChain } from '../chain/commitMessageChain';
import { DiffData } from '../git/gitTypes';
import { logger } from '../logger';
import { safeRun } from '../../utils/safeRun';
import { stageNotifications } from '../../ui/StageNotificationManager';
import { BaseLLMService } from './baseLLMService';
import {
    GenerateCommitMessageOptions,
    LLMExecution,
    LLMError,
    LLMResponse,
    LLMRunOptions,
    RequestType,
} from './llmTypes';
import { assertChatMessagesWithinTokenBudget } from './inputTokenBudget';
import { commitMessageSchema } from './providers/schemas/common';
import { getRequestTypeLabel, getValidationSchemaFor } from './providers/utils/requestTypeMaps';
import {
    completeApiRequestLog,
    failApiRequestLog,
    logCommitStageToWebview,
    logSchemaValidationToWebview,
} from './chatWebviewLogging';
import type { StageEvent } from '../../ui/StageNotificationManager';

export interface UnifiedLLMServiceOptions {
    model: AIModelConfig;
}

/** Coordinates provider-neutral sessions for commit and repository workflows. */
export class UnifiedLLMService extends BaseLLMService {
    private provider: AIProvider | null = null;

    constructor(
        context: vscode.ExtensionContext,
        templateService: TemplateService,
        analysisService: IRepositoryAnalysisService | undefined,
        private readonly options: UnifiedLLMServiceOptions,
    ) {
        super(context, templateService, analysisService);
    }

    async refreshFromSettings(): Promise<void> {
        const secretKey = modelSecretKey(this.options.model);
        const apiKey = await this.context.secrets.get(secretKey);
        this.provider = apiKey ? createAIProvider({
            kind: this.options.model.provider,
            apiKey,
            baseUrl: this.options.model.baseUrl,
        }) : null;
    }

    async validateApiKeyAndListModels(apiKey: string): Promise<string[]> {
        const provider = createAIProvider({
            kind: this.options.model.provider,
            apiKey,
            baseUrl: this.options.model.baseUrl,
        });
        return provider.listModels();
    }

    listSupportedModels(): string[] {
        return [this.options.model.model];
    }

    async setApiKey(apiKey: string): Promise<void> {
        const key = modelSecretKey(this.options.model);
        await this.context.secrets.store(key, apiKey);
        await this.refreshFromSettings();
    }

    async clearApiKey(): Promise<void> {
        const key = modelSecretKey(this.options.model);
        await this.context.secrets.delete(key);
        this.provider = null;
    }

    public createExecution(repoPath = '', options?: GenerateCommitMessageOptions): LLMExecution {
        if (!this.provider) {
            throw new Error(`${this.getProviderName()} API key is not configured.`);
        }
        const provider = this.provider;
        const signal = this.toAbortSignal(options?.token);
        const configuration = vscode.workspace.getConfiguration('gitCommitGenie');
        const temperature = configuration.get<number>('llm.temperature', 1);
        const maxOutputTokens = configuration.get<number>('llm.maxOutputTokens', 4096);
        return {
            signal,
            temperature,
            maxOutputTokens,
            createSession: (messages, id) => provider.createSession({
                id,
                model: this.getCurrentModel(),
                systemInstruction: this.systemInstruction(messages),
            }),
            run: <T>(session: AISession, messages: AIMessage[], runOptions: LLMRunOptions) => (
                this.runSession<T>(session, messages, runOptions, repoPath, signal)
            ),
        };
    }

    private async runSession<T>(
        session: AISession,
        messages: AIMessage[],
        runOptions: LLMRunOptions,
        repoPath: string,
        signal?: AbortSignal,
    ): Promise<T> {
        const requestType = runOptions.requestType;
        const schema = getValidationSchemaFor(requestType);
        const maxRetries = vscode.workspace.getConfiguration('gitCommitGenie').get<number>('llm.maxRetries', 2);
        const maxInputTokens = vscode.workspace.getConfiguration('gitCommitGenie').get<number>('chain.maxInputTokens', 32_000);
        const temperature = runOptions.temperature
            ?? vscode.workspace.getConfiguration('gitCommitGenie').get<number>('llm.temperature', 1);
        const maxOutputTokens = runOptions.maxOutputTokens
            ?? vscode.workspace.getConfiguration('gitCommitGenie').get<number>('llm.maxOutputTokens', 4096);
        if (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) {
            throw new Error(`gitCommitGenie.llm.maxOutputTokens must be a positive integer; received ${maxOutputTokens}.`);
        }
        assertChatMessagesWithinTokenBudget(messages, maxInputTokens, requestType);

        let delta = messages.filter(message => message.role !== 'system' && message.role !== 'developer');
        const totalAttempts = maxRetries + 1;
        const provider = this.options.model.provider;
        const model = this.getCurrentModel();

        for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
            let logId: string | undefined;
            try {
                logId = logger.logApiRequest(repoPath || undefined);
                const response = await session.run({
                    messages: delta,
                    responseFormat: schema ? {
                        name: requestType ?? 'structuredResponse',
                        schema: z.toJSONSchema(schema) as Record<string, unknown>,
                    } : undefined,
                    temperature,
                    maxOutputTokens,
                    signal,
                });
                this.logUsage(repoPath, requestType, response.usage?.raw);

                if (!schema) {
                    const result = response.structured ?? response.text;
                    completeApiRequestLog(logId, provider, model, result, response, requestType, repoPath);
                    return result as T;
                }

                const structured = response.structured;
                if (structured === undefined) {
                    const retryPayload = {
                        stage: requestType,
                        attempt: attempt + 1,
                        totalAttempts,
                        missingResponse: true,
                        finalFailure: attempt === totalAttempts - 1,
                    };
                    if (attempt < totalAttempts - 1) {
                        logger.warn(`[Genie][${this.getProviderName()}] Provider returned no structured output for ${requestType || 'unknown'} (attempt ${attempt + 1}/${totalAttempts}). Retrying...`);
                        logSchemaValidationToWebview(repoPath, retryPayload, 'Structured output missing');
                        completeApiRequestLog(logId, provider, model, undefined, response, requestType, repoPath);
                        delta = [{
                            role: 'user',
                            content: `The previous response contained no final JSON object. Return exactly one complete JSON object matching the requested schema. Do not include markdown or explanation.`,
                        }];
                        continue;
                    }
                    logSchemaValidationToWebview(repoPath, retryPayload, 'Structured output missing');
                    completeApiRequestLog(logId, provider, model, undefined, response, requestType, repoPath);
                    throw new Error(`${this.getProviderName()} returned no structured output for ${requestType ?? 'unknown'} after ${totalAttempts} attempts`);
                }

                const parsed = schema.safeParse(structured);
                if (parsed.success) {
                    completeApiRequestLog(logId, provider, model, structured, response, requestType, repoPath);
                    return parsed.data as T;
                }

                if (attempt < totalAttempts - 1) {
                    logger.warn(`[Genie][${this.getProviderName()}] Schema validation failed for ${requestType || 'unknown'} (attempt ${attempt + 1}/${totalAttempts}). Retrying...`);
                    logSchemaValidationToWebview(repoPath, {
                        stage: requestType,
                        attempt: attempt + 1,
                        totalAttempts,
                        error: String(parsed.error),
                    }, 'Schema validation failed');
                    completeApiRequestLog(logId, provider, model, structured, response, requestType, repoPath);
                    delta = [{
                        role: 'user',
                        content: `The previous response failed schema validation: ${parsed.error}. Return one corrected JSON object matching the requested schema.`,
                    }];
                    continue;
                }

                logSchemaValidationToWebview(repoPath, {
                    stage: requestType,
                    finalFailure: true,
                    error: String(parsed.error),
                }, 'Schema validation failed');
                completeApiRequestLog(logId, provider, model, structured, response, requestType, repoPath);
                throw new Error(`${this.getProviderName()} structured result failed local validation for ${requestType} after ${totalAttempts} attempts: ${parsed.error}`);
            } catch (error) {
                if (logId) {
                    failApiRequestLog(logId, provider, model, error, repoPath);
                }
                throw error;
            }
        }
        throw new Error(`${this.getProviderName()} structured request exited retry loop unexpectedly.`);
    }

    async generateCommitMessage(diffs: DiffData[], options?: GenerateCommitMessageOptions): Promise<LLMResponse | LLMError> {
        if (!this.provider) {
            return this.createApiKeyNotSetError();
        }
        const model = this.getCurrentModel();
        if (!model) {
            return this.createModelNotSelectedError();
        }

        try {
            const cfg = vscode.workspace.getConfiguration('gitCommitGenie');
            const useChain = cfg.get<boolean>('chain.enabled', true);
            const repoPath = this.getRepoPathForLogging(options?.targetRepo);
            safeRun('UnifiedLLM.logGenerationStart', () => logger.logGenerationStart(repoPath, useChain ? 'thinking' : 'default'));
            const jsonMessage = await this.buildJsonMessage(diffs, options?.targetRepo);
            const execution = this.createExecution(repoPath, options);
            if (!useChain) {
                const rules = this.readRules();
                const messages: AIMessage[] = [
                    { role: 'system', content: rules.baseRule },
                    { role: 'user', content: jsonMessage },
                ];
                const session = execution.createSession(messages);

                const result = await execution.run<z.infer<typeof commitMessageSchema>>(
                    session,
                    messages,
                    { requestType: 'commitMessage' },
                );
                safeRun('UnifiedLLM.logCommitStageDone', () => logCommitStageToWebview(repoPath, {
                    type: 'done',
                    data: { finalMessage: result.commitMessage },
                }));
                return { content: result.commitMessage };
            }

            const parsedInput = JSON.parse(jsonMessage);
            stageNotifications.begin();
            try {
                const out = await generateCommitMessageChain({
                    diffs,
                    currentTime: parsedInput?.['current-time'],
                    userTemplate: parsedInput?.['user-template'],
                    targetLanguage: parsedInput?.['target-language'],
                    validationChecklist: this.readRules().checklistText,
                    repositoryPath: repoPath,
                    targetRepo: options?.targetRepo,
                    repositoryAnalysis: parsedInput?.['repository-analysis'],
                }, execution, {
                    maxParallel: cfg.get<number>('chain.maxParallel', 2),
                    maxInputTokens: cfg.get<number>('chain.maxInputTokens', 32_000),
                    model,
                    repositoryAnalysisService: this.analysisService,
                    retrieveRagExamples: async context => {
                        if (!options?.ragRetrievalService || !options.targetRepo) {
                            return [];
                        }
                        return options.ragRetrievalService.retrieveStyleReferences({
                            repo: options.targetRepo,
                            changeSetSummary: context.changeSetSummary,
                            retrievalFeatures: context.retrievalFeatures,
                            execution,
                        });
                    },
                    onStage: (event: StageEvent) => {
                        stageNotifications.update({ type: event.type, data: event.data });
                        safeRun('UnifiedLLM.logCommitStage', () => logCommitStageToWebview(repoPath, event));
                    },
                });
                return {
                    content: out.commitMessage,
                    ragMetadata: {
                        fileSummaries: out.fileSummaries,
                        changeSetSummary: out.changeSetSummary,
                        retrievalFeatures: out.retrievalFeatures,
                        ragStyleReferences: out.ragStyleReferences,
                    },
                };
            } finally {
                stageNotifications.end();
            }
        } catch (error: any) {
            return this.convertToLLMError(error);
        }
    }

    protected getProviderName(): string {
        return this.options.model.provider === 'google' ? 'Google Gemini'
            : this.options.model.provider === 'custom' ? this.options.model.label
                : this.options.model.provider[0].toUpperCase() + this.options.model.provider.slice(1);
    }

    protected getCurrentModel(): string {
        return this.options.model.model;
    }

    private systemInstruction(messages: AIMessage[]): string {
        return messages
            .filter(message => message.role === 'system' || message.role === 'developer')
            .map(message => message.content)
            .join('\n\n');
    }

    private toAbortSignal(token?: vscode.CancellationToken): AbortSignal | undefined {
        if (!token) {
            return undefined;
        }
        const controller = new AbortController();
        if (token.isCancellationRequested) {
            controller.abort();
        } else {
            token.onCancellationRequested(() => controller.abort());
        }
        return controller.signal;
    }

    private logUsage(repoPath: string, requestType: RequestType | undefined, usage: any): void {
        logger.usage(repoPath, this.options.model.provider, usage, this.getCurrentModel(), getRequestTypeLabel(requestType));
    }

    private readRules(): { baseRule: string; checklistText: string } {
        const basePath = this.context.asAbsolutePath(path.join('resources', 'agentRules', 'baseRules.md'));
        const checklistPath = this.context.asAbsolutePath(path.join('resources', 'agentRules', 'validationChecklist.md'));
        return {
            baseRule: fs.readFileSync(basePath, 'utf8'),
            checklistText: fs.readFileSync(checklistPath, 'utf8'),
        };
    }

}
