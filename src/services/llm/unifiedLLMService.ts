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
    resolveThinkingConfig,
} from './providers';
import { TemplateService } from '../../template/templateService';
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
} from './llmTypes';
import {
    assertChatMessagesWithinTokenBudget,
    DEFAULT_CHAIN_CONTEXT_WINDOW_TOKENS,
    resolveChainTokenBudget,
    ChainTokenBudget,
} from './inputTokenBudget';
import { commitMessageSchema } from './providers/schemas/common';
import { getRequestTypeLabel, getValidationSchemaFor } from './providers/utils/requestTypeMaps';
import { runStructuredCompletion } from './structuredCompletion';
import { buildStructuredFieldIssues } from './structuredFieldIssues';
import {
    ApiRequestLogFailedError,
    completeApiRequestLog,
    failApiRequestLog,
    logCommitStageToWebview,
    logStructuredValidationToWebview,
} from './chatWebviewLogging';
import type { StageEvent } from '../../ui/StageNotificationManager';
import type { CostTrackingService } from '../cost/costTrackingService';
import type { CostQuote } from '../cost/costTypes';
import { resolveModelPricing } from '../cost/costAccounting';
import { summarizeTaskCostQuotes } from '../cost/costDisplay';
import type { AIUsage } from './providers';

export interface UnifiedLLMServiceOptions {
    model: AIModelConfig;
    costTracker: CostTrackingService;
}

/** Coordinates provider-neutral sessions for commit and repository workflows. */
export class UnifiedLLMService extends BaseLLMService {
    private provider: AIProvider | null = null;

    constructor(
        context: vscode.ExtensionContext,
        templateService: TemplateService,
        private readonly options: UnifiedLLMServiceOptions,
    ) {
        super(context, templateService);
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
        const maxRetries = configuration.get<number>('llm.maxRetries', 2);
        const thinkingSettings = {
            defaultThinkingLevel: configuration.get<unknown>('defaultThinkingLevel', 'off'),
            modelThinkingLevels: configuration.get<unknown>('modelThinkingLevels', {}),
            thinkingBudgets: configuration.get<unknown>('thinkingBudgets', {}),
        };
        // Resolve once per execution: model override → global default. Every
        // foreground and background call reuses this exact config.
        const thinking = resolveThinkingConfig(this.options.model, thinkingSettings);
        const contextWindowTokens = configuration.get<number>(
            'chain.contextWindowTokens',
            DEFAULT_CHAIN_CONTEXT_WINDOW_TOKENS,
        );
        const tokenBudget = resolveChainTokenBudget({
            provider: this.options.model.provider,
            model: this.getCurrentModel(),
            contextWindowTokens,
            thinking,
        });
        // Snapshot pricing at execution creation so mid-task override edits do not affect in-flight calls.
        const pricing = resolveModelPricing(this.options.model.model, this.options.model.pricingOverride);
        const recordedQuotes: CostQuote[] = [];
        const costTracker = this.options.costTracker;
        const modelConfig = this.options.model;
        const modelName = this.getCurrentModel();

        const accountCall = async (usage: AIUsage | undefined): Promise<CostQuote> => {
            const quote = await costTracker.recordCall({
                repoPath,
                provider: modelConfig.provider,
                pricing,
                usage,
            });
            recordedQuotes.push(quote);
            return quote;
        };

        return {
            model: modelName,
            signal,
            temperature,
            maxOutputTokens: tokenBudget.maxOutputTokens,
            maxRetries,
            thinking,
            tokenBudget,
            createSession: (messages, id) => provider.createSession({
                id,
                model: modelName,
                systemInstruction: this.systemInstruction(messages),
                thinking,
            }),
            run: <T>(session: AISession, messages: AIMessage[], runOptions: LLMRunOptions) => (
                this.runSession<T>(session, messages, runOptions, repoPath, tokenBudget, signal, accountCall)
            ),
            accountCall,
            getRecordedQuotes: () => recordedQuotes,
            notifyUsageCostIfEnabled: (callType) => {
                const summary = summarizeTaskCostQuotes(recordedQuotes);
                if (!summary) {
                    return;
                }
                const cfg = vscode.workspace.getConfiguration('gitCommitGenie');
                if (!cfg.get('showUsageCost', false)) {
                    return;
                }
                const costLabel = summary.totalUsd === 0 ? 'Free' : `$${summary.totalUsd.toFixed(6)}`;
                const cacheLabel = summary.cacheHitPercent.toFixed(2);
                const messageKey = callType === 'memory'
                    ? 'Repository memory: ${0} | Cache hit: {1}%'
                    : 'Commit message generation: ${0} | Cache hit: {1}%';
                vscode.window.showInformationMessage(vscode.l10n.t(messageKey, costLabel, cacheLabel));
            },
        };
    }

    private async runSession<T>(
        session: AISession,
        messages: AIMessage[],
        runOptions: LLMRunOptions,
        repoPath: string,
        tokenBudget: ChainTokenBudget,
        signal: AbortSignal | undefined,
        accountCall: (usage: AIUsage | undefined) => Promise<CostQuote>,
    ): Promise<T> {
        const requestType = runOptions.requestType;
        const schema = getValidationSchemaFor(requestType);
        const maxRetries = vscode.workspace.getConfiguration('gitCommitGenie').get<number>('llm.maxRetries', 2);
        const temperature = runOptions.temperature
            ?? vscode.workspace.getConfiguration('gitCommitGenie').get<number>('llm.temperature', 1);
        const maxOutputTokens = runOptions.maxOutputTokens ?? tokenBudget.maxOutputTokens;
        assertChatMessagesWithinTokenBudget(messages, tokenBudget, requestType);

        const delta = messages.filter(message => message.role !== 'system' && message.role !== 'developer');
        const provider = this.options.model.provider;
        const model = this.getCurrentModel();
        let currentLogId: string | undefined;
        let firstRun = true;
        const budgetMessages = [...messages];
        let lastCostQuote: CostQuote | undefined;

        const runMessages = async (runDelta: AIMessage[]) => {
            if (!firstRun) {
                budgetMessages.push(...runDelta);
            }
            firstRun = false;
            assertChatMessagesWithinTokenBudget(budgetMessages, tokenBudget, requestType);
            currentLogId = logger.logApiRequest(repoPath || undefined);
            try {
                // Thinking stays session-bound; do not override per request or stage.
                const response = await session.run({
                    messages: runDelta,
                    responseFormat: schema ? {
                        name: requestType,
                        schema: z.toJSONSchema(schema) as Record<string, unknown>,
                    } : undefined,
                    temperature,
                    maxOutputTokens,
                    signal,
                });
                if (response.text) {
                    budgetMessages.push({ role: 'assistant', content: response.text });
                }
                // Account once per successful HTTP response; quote is shared with the webview log.
                lastCostQuote = await accountCall(response.usage);
                logger.logUsageQuote(
                    provider,
                    model,
                    lastCostQuote,
                    getRequestTypeLabel(requestType),
                );
                logger.info(
                    `[Genie][${this.getProviderName()}] ${requestType} stop=${response.stopReason}` +
                    `${response.stopReasonRaw ? ` (${response.stopReasonRaw})` : ''}; ` +
                    `input=${response.usage?.inputTokens ?? 'unknown'}, ` +
                    `reasoning=${response.usage?.reasoningTokens ?? 'unknown'}, ` +
                    `visibleOutput=${response.usage?.visibleOutputTokens ?? response.usage?.outputTokens ?? 'unknown'}.`,
                );
                return response;
            } catch (error) {
                if (currentLogId) {
                    failApiRequestLog(currentLogId, provider, model, error, repoPath);
                }
                throw new ApiRequestLogFailedError(error);
            }
        };

        if (!schema) {
            const response = await runMessages(delta);
            const result = response.structured ?? response.text;
            completeApiRequestLog(currentLogId!, provider, model, result, response, requestType, repoPath, lastCostQuote);
            return result as T;
        }

        try {
            const { data, response } = await runStructuredCompletion<T>({
                run: runMessages,
                schema: schema as z.ZodType<T>,
                initialMessages: delta,
                maxRetries,
                label: requestType,
                callbacks: {
                    onMissingStructured: (attempt, attempts, response) => {
                        if (attempt < attempts) {
                            logger.warn(`[Genie][${this.getProviderName()}] Provider returned no structured output for ${requestType} (attempt ${attempt}/${attempts}). Retrying...`);
                        }
                        logStructuredValidationToWebview(repoPath, {
                            stage: requestType,
                            failureKind: 'missingOutput',
                            attempt,
                            totalAttempts: attempts,
                            finalFailure: attempt === attempts,
                        });
                        completeApiRequestLog(currentLogId!, provider, model, undefined, response, requestType, repoPath, lastCostQuote);
                    },
                    onValidationFailed: (attempt, attempts, response, error) => {
                        if (attempt < attempts) {
                            logger.warn(`[Genie][${this.getProviderName()}] Schema validation failed for ${requestType} (attempt ${attempt}/${attempts}). Retrying...`);
                        }
                        logStructuredValidationToWebview(repoPath, {
                            stage: requestType,
                            failureKind: 'schemaMismatch',
                            attempt,
                            totalAttempts: attempts,
                            finalFailure: attempt === attempts,
                            fieldIssues: buildStructuredFieldIssues(error, response.structured),
                            error: String(error.message),
                        });
                        completeApiRequestLog(currentLogId!, provider, model, response.structured, response, requestType, repoPath, lastCostQuote);
                    },
                },
            });
            completeApiRequestLog(currentLogId!, provider, model, data, response, requestType, repoPath, lastCostQuote);
            return data;
        } catch (error) {
            if (currentLogId && !(error instanceof ApiRequestLogFailedError)) {
                failApiRequestLog(currentLogId, provider, model, error, repoPath);
            }
            throw error instanceof ApiRequestLogFailedError ? error.cause : error;
        }
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
            try {
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
                        snapshot: options?.snapshot,
                        loadMemory: options?.memoryRun?.loadMemory,
                        recorder: options?.memoryRun?.recorder,
                        targetRepo: options?.targetRepo,
                    }, execution, {
                        maxParallel: cfg.get<number>('chain.maxParallel', 2),
                        tokenBudget: execution.tokenBudget,
                        retrieveRagExamples: async context => {
                            if (!options?.ragRetrievalService || !options.targetRepo) {
                                return [];
                            }
                            return options.ragRetrievalService.retrieveStyleReferences({
                                repo: options.targetRepo,
                                query: context,
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
                        memoryUsage: out.changeAnalysis.memoryUsage,
                        episode: options?.memoryRun?.seal({
                            changedPaths: out.changeAnalysis.rawDiff.changedFiles.map(file => file.path),
                            changedSymbols: [],
                            questions: out.changeAnalysis.investigationPlan?.targets.flatMap(target => target.questions) ?? [],
                            claims: out.changeAnalysis.agentClaims.map(claim => ({ claim: claim.claim, evidenceRefs: claim.evidenceRefs, disposition: claim.disposition })),
                            status: out.changeAnalysis.analysisStatus === 'complete_diff_only'
                                ? 'complete'
                                : out.changeAnalysis.analysisStatus,
                        }),
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
            } finally {
                // Show once per task from already-recorded quotes (success, failure, or cancel).
                execution.notifyUsageCostIfEnabled('commit');
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

    private readRules(): { baseRule: string; checklistText: string } {
        const basePath = this.context.asAbsolutePath(path.join('resources', 'agentRules', 'baseRules.md'));
        const checklistPath = this.context.asAbsolutePath(path.join('resources', 'agentRules', 'validationChecklist.md'));
        return {
            baseRule: fs.readFileSync(basePath, 'utf8'),
            checklistText: fs.readFileSync(checklistPath, 'utf8'),
        };
    }

}
