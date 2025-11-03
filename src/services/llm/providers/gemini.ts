import * as vscode from 'vscode';
import { GoogleGenAI, Type } from '@google/genai';
import { LLMError, LLMResponse, ChatFn, ChatMessage, GenerateCommitMessageOptions } from '../llmTypes';
import { BaseLLMService } from '../baseLLMService';
import { TemplateService } from '../../../template/templateService';
import { DiffData } from '../../git/gitTypes';
import { generateCommitMessageChain } from '../../chain/chainThinking';

import { logger } from '../../logger';
import { stageNotifications } from '../../../ui/StageNotificationManager';
import { GeminiUtils } from './utils/geminiUtils';
import { IRepositoryAnalysisService } from '../../analysis/analysisTypes';
import {
    GeminiCommitMessageSchema,
    GeminiFileSummarySchema,
    GeminiClassifyAndDraftSchema,
    GeminiValidateAndFixSchema,
    GeminiRepoAnalysisSchema,
    GeminiRepoAnalysisActionSchema
} from './schemas/geminiSchemas';

import {
    // Shared Zod schemas used to check structured output
    commitMessageSchema,
    fileSummarySchema,
    classifyAndDraftResponseSchema,
    validateAndFixResponseSchema,
    repoAnalysisResponseSchema,
    repoAnalysisActionSchema
} from "./schemas/common";

const SECRET_GEMINI_API_KEY = 'gitCommitGenie.secret.geminiApiKey';

/**
 * Google Gemini service implementation using @google/genai
 */
export class GeminiService extends BaseLLMService {
    private client: any | null = null;
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
            'gemini-2.5-pro',

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
            try { logger.logGenerationStart(repoPath, config.useChain ? 'thinking' : 'default'); } catch { /* ignore */ }

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
        config: any,
        rules: any,
        repoPath: string,
        options?: GenerateCommitMessageOptions
    ): Promise<LLMResponse | LLMError> {
        const parsedInput = JSON.parse(jsonMessage);
        const usages: Array<any> = [];
        let callCount = 0;

        const chat: ChatFn = async (messages, chainOptions) => {
            const reqType = chainOptions?.requestType;
            const labelFor = (t?: string) => {
                switch (t) {
                    case 'summary': return 'summarize';
                    case 'draft': return 'draft';
                    case 'fix': return 'validate-fix';
                    case 'strictFix': return 'strict-fix';
                    case 'enforceLanguage': return 'lang-fix';
                    case 'commitMessage': return 'build-commit-msg';
                    case 'repoAnalysis': return 'repo-analysis';
                    case 'repoAnalysisAction': return 'repo-analysis-action';
                    default: return 'thinking';
                }
            };
            // Map request type to schema
            const schemaMap: Record<string, any> = {
                summary: GeminiFileSummarySchema,
                draft: GeminiClassifyAndDraftSchema,
                fix: GeminiValidateAndFixSchema,
                commitMessage: GeminiCommitMessageSchema,
                strictFix: GeminiCommitMessageSchema,
                enforceLanguage: GeminiCommitMessageSchema,
                repoAnalysis: GeminiRepoAnalysisSchema,
                repoAnalysisAction: GeminiRepoAnalysisActionSchema,
            };

            const schemaMapValidation: Record<string, any> = {
                summary: fileSummarySchema,
                draft: classifyAndDraftResponseSchema,
                fix: validateAndFixResponseSchema,
                commitMessage: commitMessageSchema,
                strictFix: commitMessageSchema,
                enforceLanguage: commitMessageSchema,
                repoAnalysis: repoAnalysisResponseSchema,
                repoAnalysisAction: repoAnalysisActionSchema,
            };

            const schema = reqType ? schemaMap[reqType] : undefined;
            const retries = config.maxRetries ?? 2;
            const totalAttempts = Math.max(1, retries + 1);

            for (let attempt = 0; attempt < totalAttempts; attempt++) {
                const result = await this.utils.callChatCompletion(this.client!, messages, {
                    model: config.model,
                    provider: 'Gemini',
                    responseSchema: schema,
                    token: options?.token,
                    trackUsage: true,
                    repoPath
                });

                callCount += 1;
                if (result.usage) {
                    usages.push(result.usage);
                    logger.usage(repoPath, 'Gemini', result.usage, config.model, labelFor(reqType), callCount);
                } else {
                    logger.usage(repoPath, 'Gemini', undefined, config.model, labelFor(reqType), callCount);
                }

                // Validate structured output if schema is defined
                const validationSchema = reqType ? schemaMapValidation[reqType] : undefined;

                if (validationSchema) {
                    const safe = validationSchema.safeParse(result.parsedResponse);
                    if (safe.success) {
                        return safe.data;
                    }

                    if (attempt < totalAttempts - 1) {
                        this.logSchemaValidationRetry(reqType || 'unknown', attempt, totalAttempts);
                        try { logger.logToolCall('schemaValidation', JSON.stringify({ stage: reqType, attempt: attempt + 1, totalAttempts, error: String(safe.error) }), 'Schema validation failed', repoPath); } catch { /* ignore */ }
                        messages = this.buildSchemaValidationRetryMessages(
                            messages,
                            result,
                            safe.error,
                            validationSchema,
                            reqType
                        );
                        continue;
                    }
                    try { logger.logToolCall('schemaValidation', JSON.stringify({ stage: reqType, finalFailure: true, error: String(safe.error) }), 'Schema validation failed', repoPath); } catch { /* ignore */ }

                    throw new Error(`Gemini structured result failed local validation for ${reqType} after ${totalAttempts} attempts`);
                }

                // Fallback: return raw data
                return result.parsedResponse;
            }
        };

        // Start bottom-right stage notifications
        try { stageNotifications.begin(); } catch { /* ignore */ }
        let out;
        try {
            out = await generateCommitMessageChain(
                {
                    diffs,
                    currentTime: parsedInput?.['current-time'],
                    userTemplate: parsedInput?.['user-template'],
                    targetLanguage: parsedInput?.['target-language'],
                    validationChecklist: rules.checklistText,
                    repositoryAnalysis: parsedInput?.['repository-analysis']
                },
                chat,
                {
                    maxParallel: config.chainMaxParallel,
                    onStage: (event) => {
                        try {
                            stageNotifications.update({ type: event.type as any, data: event.data });
                            const payload = { stage: event.type, data: event.data ?? {} };
                            try { logger.logToolCall('commitStage', JSON.stringify(payload), 'Commit generation stage', repoPath); } catch { /* ignore */ }
                        } catch { /* ignore */ }
                    }
                }
            );
        } finally {
            try { stageNotifications.end(); } catch { /* ignore */ }
        }

        if (usages.length) {
            logger.usageSummary(repoPath, 'Gemini', usages, config.model, 'thinking', undefined, false);
        }

        return { content: out.commitMessage };
    }

    /**
     * Generate commit message using single-shot approach
     */
    private async generateDefault(
        jsonMessage: string,
        config: any,
        rules: any,
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
                try {
                    logger.logToolCall(
                        'commitStage',
                        JSON.stringify({ stage: 'done', data: { finalMessage: safe.data.commitMessage } }),
                        'Commit generation stage',
                        repoPath
                    );
                } catch { /* ignore */ }
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
