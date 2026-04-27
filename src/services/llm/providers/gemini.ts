import * as vscode from 'vscode';
import { GoogleGenAI, Type } from '@google/genai';
import { LLMError, LLMResponse, ChatFn, ChatMessage, GenerateCommitMessageOptions } from '../llmTypes';
import { BaseLLMService } from '../baseLLMService';
import { TemplateService } from '../../../template/templateService';
import { DiffData } from '../../git/gitTypes';
import { generateCommitMessageChain } from '../../chain/chainThinking';

import { logger } from '../../logger';
import { stageNotifications } from '../../../ui/StageNotificationManager';
import { GeminiUtils } from './utils/GeminiUtils';
import { safeRun } from '../../../utils/safeRun';
import { getRequestTypeLabel, getValidationSchemaFor } from './utils/requestTypeMaps';
import { ProviderRuntimeConfig, ProviderRules } from './utils/baseProviderUtils';
import { IRepositoryAnalysisService } from '../../analysis/analysisTypes';
import {
    GeminiCommitMessageSchema,
    GeminiFileSummarySchema,
    GeminiClassifyAndDraftSchema,
    GeminiValidateAndFixSchema,
    GeminiRagPreparationSchema,
    GeminiRagRerankSchema,
    GeminiRepoAnalysisSchema,
    GeminiRepoAnalysisActionSchema
} from './schemas/geminiSchemas';

import { commitMessageSchema } from './schemas/common';

const SECRET_GEMINI_API_KEY = 'gitCommitGenie.secret.geminiApiKey';

/**
 * Google Gemini service implementation using @google/genai
 */
export class GeminiService extends BaseLLMService {
    private client: GoogleGenAI | null = null;
    protected context: vscode.ExtensionContext;
    private utils: GeminiUtils;

    constructor(context: vscode.ExtensionContext, templateService: TemplateService, analysisService?: IRepositoryAnalysisService) {
        super(context, templateService, analysisService);
        this.context = context;
        this.utils = new GeminiUtils(context);
        this.refreshFromSettings();
    }

    public async refreshFromSettings(): Promise<void> {
        const apiKey = await this.context.secrets.get(SECRET_GEMINI_API_KEY);
        this.client = apiKey ? new GoogleGenAI({ apiKey }) : null;
    }

    public async validateApiKeyAndListModels(apiKey: string): Promise<string[]> {
        const preferred = this.listSupportedModels();
        try {
            const client = new GoogleGenAI({ apiKey });
            await this.utils.validateApiKey(client, preferred[0], 'Gemini');
            return preferred;
        } catch (err: any) {
            throw new Error(err?.message || 'Failed to validate Gemini API key.');
        }
    }

    public listSupportedModels(): string[] {
        return [
            'gemini-2.5-flash',
            'gemini-2.5-flash-preview-09-2025',
            'gemini-3-flash-preview',
            'gemini-2.5-pro',

            'gemini-3-pro-preview'

        ];
    }

    public async setApiKey(apiKey: string): Promise<void> {
        await this.context.secrets.store(SECRET_GEMINI_API_KEY, apiKey);
        await this.refreshFromSettings();
    }

    public async clearApiKey(): Promise<void> {
        await this.context.secrets.delete(SECRET_GEMINI_API_KEY);
        this.client = null;
    }

    /**
     * Get the Gemini client instance
     */
    protected getClient(): GoogleGenAI | null {
        return this.client;
    }

    /**
     * Get the Gemini utils instance
     */
    protected getUtils(): GeminiUtils {
        return this.utils;
    }

    /**
     * Get the provider name for error messages
     */
    protected getProviderName(): string {
        return 'Gemini';
    }

    /**
     * Get the current model configuration
     */
    protected getCurrentModel(): string {
        return this.context.globalState.get<string>('gitCommitGenie.geminiModel', '');
    }

    /**
     * Get Gemini-specific configuration
     */
    private getConfig() {
        return this.utils.getProviderConfig('gitCommitGenie', 'geminiModel');
    }

    async generateCommitMessage(diffs: DiffData[], options?: GenerateCommitMessageOptions): Promise<LLMResponse | LLMError> {
        if (!this.client) {
            return this.createApiKeyNotSetError();
        }

        try {
            const config = this.getConfig();
            const rules = this.utils.getRules();
            const repoPath = this.getRepoPathForLogging(options?.targetRepo);

            if (!config.model) {
                return this.createModelNotSelectedError();
            }

            // Divider in webview: commit generation start
            safeRun('Gemini.logGenerationStart', () => logger.logGenerationStart(repoPath, config.useChain ? 'thinking' : 'default'));

            const jsonMessage = await this.buildJsonMessage(diffs, options?.targetRepo);

            if (config.useChain) {
                return await this.generateThinking(diffs, jsonMessage, config, rules, repoPath, options);
            }

            return await this.generateDefault(jsonMessage, config, rules, repoPath, options);
        } catch (error: any) {
            return this.convertToLLMError(error);
        }
    }

    /**
     * Generate commit message using chain approach
     */
    private async generateThinking(
        diffs: DiffData[],
        jsonMessage: string,
        config: ProviderRuntimeConfig,
        rules: ProviderRules,
        repoPath: string,
        options?: GenerateCommitMessageOptions
    ): Promise<LLMResponse | LLMError> {
        const parsedInput = JSON.parse(jsonMessage);
        const usages: Array<any> = [];
        let callCount = 0;

        // Map request type to Gemini's response schema (provider-specific).
        const responseSchemaMap: Record<string, any> = {
            summary: GeminiFileSummarySchema,
            draft: GeminiClassifyAndDraftSchema,
            fix: GeminiValidateAndFixSchema,
            ragPreparation: GeminiRagPreparationSchema,
            ragRerank: GeminiRagRerankSchema,
            commitMessage: GeminiCommitMessageSchema,
            strictFix: GeminiCommitMessageSchema,
            enforceLanguage: GeminiCommitMessageSchema,
            repoAnalysis: GeminiRepoAnalysisSchema,
            repoAnalysisAction: GeminiRepoAnalysisActionSchema,
        };

        const chat: ChatFn = async (messages, chainOptions) => {
            const reqType = chainOptions?.requestType;
            const retries = config.maxRetries ?? 2;
            const totalAttempts = Math.max(1, retries + 1);
            const responseSchema = reqType ? responseSchemaMap[reqType] : undefined;

            return await this.runValidatedChatCall({
                reqType,
                totalAttempts,
                initialMessages: messages,
                repoPath,
                validationSchema: getValidationSchemaFor(reqType),
                callOnce: (msgs) => this.utils.callChatCompletion(this.client!, msgs, {
                    model: config.model,
                    provider: 'Gemini',
                    responseSchema,
                    token: options?.token,
                    trackUsage: true,
                    repoPath,
                }),
                onUsage: (usage) => {
                    callCount += 1;
                    if (usage) {
                        usages.push(usage);
                        logger.usage(repoPath, 'Gemini', usage, config.model, getRequestTypeLabel(reqType), callCount);
                    } else {
                        logger.usage(repoPath, 'Gemini', undefined, config.model, getRequestTypeLabel(reqType), callCount);
                    }
                },
            });
        };

        // Start bottom-right stage notifications
        safeRun('Gemini.stageNotifications.begin', () => stageNotifications.begin());
        let out;
        try {
            out = await generateCommitMessageChain(
                {
                    diffs,
                    currentTime: parsedInput?.['current-time'],
                    userTemplate: parsedInput?.['user-template'],
                    targetLanguage: parsedInput?.['target-language'],
                    validationChecklist: rules.checklistText,
                    repositoryPath: repoPath,
                    targetRepo: options?.targetRepo,
                    repositoryAnalysis: parsedInput?.['repository-analysis']
                },
                chat,
                {
                    maxParallel: config.chainMaxParallel,
                    retrieveRagExamples: async (context) => {
                        if (!options?.ragRetrievalService || !options?.targetRepo) {
                            return [];
                        }
                        return await options.ragRetrievalService.retrieveStyleReferences({
                            repo: options.targetRepo,
                            changeSetSummary: context.changeSetSummary,
                            retrievalFeatures: context.retrievalFeatures,
                            chat,
                        });
                    },
                    onStage: (event) => {
                        safeRun('Gemini.stageNotifications.update', () => stageNotifications.update({ type: event.type as any, data: event.data }));
                        const payload = { stage: event.type, data: event.data ?? {} };
                        safeRun('Gemini.logCommitStage', () => logger.logToolCall('commitStage', JSON.stringify(payload), 'Commit generation stage', repoPath));
                    }
                }
            );
        } finally {
            safeRun('Gemini.stageNotifications.end', () => stageNotifications.end());
        }

        if (usages.length) {
            logger.usageSummary(repoPath, 'Gemini', usages, config.model, 'thinking', undefined, false);
        }

        return {
            content: out.commitMessage,
            ragMetadata: {
                fileSummaries: out.fileSummaries,
                changeSetSummary: out.changeSetSummary,
                retrievalFeatures: out.retrievalFeatures,
                ragStyleReferences: out.ragStyleReferences,
            }
        };
    }

    /**
     * Generate commit message using single-shot approach
     */
    private async generateDefault(
        jsonMessage: string,
        config: ProviderRuntimeConfig,
        rules: ProviderRules,
        repoPath: string,
        options?: GenerateCommitMessageOptions
    ): Promise<LLMResponse | LLMError> {
        const retries = config.maxRetries ?? 2;
        const totalAttempts = Math.max(1, retries + 1);
        let lastError: any;
        let messages: ChatMessage[] = [
            { role: 'system', content: rules.baseRule },
            { role: 'user', content: jsonMessage }
        ];

        for (let attempt = 0; attempt < totalAttempts; attempt++) {
            const result = await this.utils.callChatCompletion(
                this.client!,
                messages,
                {
                    model: config.model,
                    provider: 'Gemini',
                    responseSchema: GeminiCommitMessageSchema,
                    token: options?.token,
                    trackUsage: true,
                    repoPath
                }
            );

            if (result.usage) {
                logger.usageSummary(repoPath, 'Gemini', [result.usage], config.model, 'default');
            } else {
                logger.usageSummary(repoPath, 'Gemini', [], config.model, 'default');
            }

            const safe = commitMessageSchema.safeParse(result.parsedResponse);
            if (safe.success) {
                // Emit a final "done" stage in webview logs for default mode
                safeRun('Gemini.logCommitStageDone', () => logger.logToolCall(
                    'commitStage',
                    JSON.stringify({ stage: 'done', data: { finalMessage: safe.data.commitMessage } }),
                    'Commit generation stage',
                    repoPath
                ));
                return { content: safe.data.commitMessage };
            }

            lastError = safe.error;
            if (attempt < totalAttempts - 1) {
                this.logSchemaValidationRetry('commitMessage', attempt, totalAttempts);
                messages = this.buildSchemaValidationRetryMessages(
                    messages,
                    result,
                    safe.error,
                    commitMessageSchema,
                    'commitMessage'
                );
                continue;
            }
        }

        return { message: 'Failed to validate structured commit message from Gemini.', statusCode: 500 };
    }

}
