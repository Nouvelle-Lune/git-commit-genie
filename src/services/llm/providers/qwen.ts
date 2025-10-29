import * as vscode from 'vscode';
import { ChatMessage, ChatFn, GenerateCommitMessageOptions, LLMError, LLMResponse } from '../llmTypes';
import { BaseLLMService } from '../baseLLMService';
import { TemplateService } from '../../../template/templateService';
import { DiffData } from '../../git/gitTypes';
import OpenAI from 'openai';
import { generateCommitMessageChain } from "../../chain/chainThinking";
import { logger } from '../../logger';
import { OpenAICompatibleUtils } from './utils/index';
import { IRepositoryAnalysisService } from '../../analysis/analysisTypes';
import { stageNotifications } from '../../../ui/StageNotificationManager';
import { z } from "zod";
import {
    fileSummarySchema,
    classifyAndDraftResponseSchema,
    validateAndFixResponseSchema,
    commitMessageSchema
} from './schemas/common';

const QWEN_API_URL_CHINA = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const QWEN_API_URL_INTL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const SECRET_QWEN_API_KEY_CHINA = 'gitCommitGenie.secret.qwenApiKeyChina';
const SECRET_QWEN_API_KEY_INTL = 'gitCommitGenie.secret.qwenApiKeyIntl';
const QWEN_REGION_KEY = 'gitCommitGenie.qwenRegion';

/**
 * Alibaba Qwen LLM service implementation using OpenAI-compatible API
 * 
 * Supports both China (Beijing) and International (Singapore) regions:
 * - China: https://dashscope.aliyuncs.com/compatible-mode/v1
 * - International: https://dashscope-intl.aliyuncs.com/compatible-mode/v1
 * 
 * Note: API keys are region-specific and stored separately.
 */
export class QwenService extends BaseLLMService {
    protected context: vscode.ExtensionContext;
    private openai: OpenAI | null = null;
    private utils: OpenAICompatibleUtils;

    constructor(context: vscode.ExtensionContext, templateService: TemplateService, analysisService?: IRepositoryAnalysisService) {
        super(context, templateService, analysisService);
        this.context = context;
        this.utils = new OpenAICompatibleUtils(context);
        this.refreshFromSettings();
    }

    private getApiUrl(): string {
        const region = this.context.globalState.get<string>(QWEN_REGION_KEY, 'intl');
        return region === 'china' ? QWEN_API_URL_CHINA : QWEN_API_URL_INTL;
    }

    private getSecretKey(): string {
        const region = this.context.globalState.get<string>(QWEN_REGION_KEY, 'intl');
        return region === 'china' ? SECRET_QWEN_API_KEY_CHINA : SECRET_QWEN_API_KEY_INTL;
    }

    /**
     * Get current region setting (for pricing and logging)
     */
    public getRegion(): 'china' | 'intl' {
        return this.context.globalState.get<string>(QWEN_REGION_KEY, 'intl') as 'china' | 'intl';
    }

    public async refreshFromSettings(): Promise<void> {
        const currentRegion = this.context.globalState.get<string>(QWEN_REGION_KEY, 'intl');
        let apiKey = await this.context.secrets.get(this.getSecretKey());

        // If current region's key doesn't exist, try the other region
        if (!apiKey) {
            const otherRegion = currentRegion === 'china' ? 'intl' : 'china';
            const otherSecretKey = otherRegion === 'china' ? SECRET_QWEN_API_KEY_CHINA : SECRET_QWEN_API_KEY_INTL;
            const otherKey = await this.context.secrets.get(otherSecretKey);

            if (otherKey) {
                // Found key in the other region, switch to it
                apiKey = otherKey;
                await this.context.globalState.update(QWEN_REGION_KEY, otherRegion);
                logger.info(`[Genie][Qwen] Automatically switched from ${currentRegion} to ${otherRegion} region`);
            }
        }

        this.openai = apiKey ? new OpenAI({ apiKey, baseURL: this.getApiUrl() }) : null;
    }

    /**
     * Validate an API key by calling Alibaba Qwen (OpenAI-compatible) and list models.
     * Returns a curated list intersected with our supported Qwen models.
     * 
     * @param apiKey - The API key to validate
     * @param region - Optional region parameter (only used by Qwen, ignored by other providers)
     */
    public async validateApiKeyAndListModels(apiKey: string): Promise<string[]>;
    public async validateApiKeyAndListModels(apiKey: string, region: string): Promise<string[]>;
    public async validateApiKeyAndListModels(apiKey: string, region?: string): Promise<string[]> {
        const preferred = this.listSupportedModels();
        const apiUrl = region === 'china' ? QWEN_API_URL_CHINA : QWEN_API_URL_INTL;
        try {
            const client = new OpenAI({ apiKey, baseURL: apiUrl });
            return await this.utils.tryListModels(client, preferred, 'Qwen');
        } catch (err: any) {
            throw new Error(err?.message || 'Failed to validate Qwen API key.');
        }
    }

    public listSupportedModels(): string[] {
        return [
            'qwen3-max',
            'qwen3-max-preview',

            'qwen-plus',
            'qwen-plus-latest',

            'qwen3-coder-plus',

            'qwen-flash',
            'qwen3-coder-flash'
        ];
    }

    public async setApiKey(apiKey: string): Promise<void> {
        await this.context.secrets.store(this.getSecretKey(), apiKey);
        this.openai = apiKey ? new OpenAI({ apiKey, baseURL: this.getApiUrl() }) : null;
    }

    public async clearApiKey(): Promise<void> {
        await this.context.secrets.delete(this.getSecretKey());
        this.openai = null;
    }

    /**
     * Get the Qwen client instance
     */
    protected getClient(): OpenAI | null {
        return this.openai;
    }

    /**
     * Get the Qwen utils instance
     */
    protected getUtils(): OpenAICompatibleUtils {
        return this.utils;
    }

    /**
     * Get the provider name for error messages
     */
    protected getProviderName(): string {
        return 'Qwen';
    }

    /**
     * Get the current model configuration
     */
    protected getCurrentModel(): string {
        return this.context.globalState.get<string>('gitCommitGenie.qwenModel', '');
    }

    /**
     * Get Qwen-specific configuration
     */
    private getConfig() {
        return this.utils.getProviderConfig('gitCommitGenie', 'qwenModel');
    }

    async generateCommitMessage(diffs: DiffData[], options?: GenerateCommitMessageOptions): Promise<LLMResponse | LLMError> {
        if (!this.openai) {
            return this.createApiKeyNotSetError();
        }

        try {
            const config = this.getConfig();
            const rules = this.utils.getRules();
            const repoPath = this.getRepoPathForLogging(options?.targetRepo);

            if (!config.model) {
                return this.createModelNotSelectedError();
            }

            const jsonMessage = await this.buildJsonMessage(diffs, options?.targetRepo);

            if (config.useChain) {
                return await this.generateThinking(diffs, jsonMessage, config, rules, repoPath, options);
            } else {
                return await this.generateDefault(jsonMessage, config, rules, repoPath, options);
            }
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
        const parsed = JSON.parse(jsonMessage);
        const usages: Array<{ prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }> = [];
        let callCount = 0;

        const chat: ChatFn = async (messages, _options) => {
            const reqType = _options?.requestType;
            const labelFor = (t?: string) => {
                switch (t) {
                    case 'summary': return 'summarize';
                    case 'draft': return 'draft';
                    case 'fix': return 'validate-fix';
                    case 'strictFix': return 'strict-fix';
                    case 'enforceLanguage': return 'lang-fix';
                    case 'commitMessage': return 'build-commit-msg';
                    default: return 'thinking';
                }
            };
            const schemaMap: Record<string, any> = {
                summary: fileSummarySchema,
                draft: classifyAndDraftResponseSchema,
                fix: validateAndFixResponseSchema,
                commitMessage: commitMessageSchema,
                strictFix: commitMessageSchema,
                enforceLanguage: commitMessageSchema,
            };

            const validationSchema = reqType ? schemaMap[reqType] : undefined;
            const retries = this.utils.getMaxRetries();
            const totalAttempts = Math.max(1, retries + 1);

            for (let attempt = 0; attempt < totalAttempts; attempt++) {
                const result = await this.utils.callChatCompletion(this.openai!, messages, {
                    model: config.model,
                    provider: 'Qwen',
                    token: options?.token,
                    trackUsage: true,
                    requestType: _options!.requestType
                });

                callCount += 1;
                if (result.usage) {
                    usages.push(result.usage);
                    result.usage.model = config.model;
                    logger.usage(repoPath, 'Qwen', result.usage, config.model, labelFor(reqType), callCount);
                } else {
                    logger.usage(repoPath, 'Qwen', undefined, config.model, labelFor(reqType), callCount);
                }

                if (validationSchema) {
                    const safe = validationSchema.safeParse(result.parsedResponse);
                    if (safe.success) {
                        return safe.data;
                    }
                    if (attempt < totalAttempts - 1) {
                        this.logSchemaValidationRetry(reqType || 'unknown', attempt, totalAttempts);
                        messages = this.buildSchemaValidationRetryMessages(
                            messages,
                            result,
                            safe.error,
                            validationSchema,
                            reqType
                        );
                        continue;
                    }
                    throw new Error(`Qwen structured result failed local validation for ${reqType} after ${totalAttempts} attempts`);
                }

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
                    currentTime: parsed?.["current-time"],
                    userTemplate: parsed?.["user-template"],
                    targetLanguage: parsed?.["target-language"],
                    validationChecklist: rules.checklistText,
                    repositoryAnalysis: parsed?.["repository-analysis"]
                },
                chat,
                {
                    maxParallel: config.chainMaxParallel,
                    onStage: (event) => {
                        try { stageNotifications.update({ type: event.type as any, data: event.data }); } catch { /* ignore */ }
                    }
                }
            );
        } finally {
            try { stageNotifications.end(); } catch { /* ignore */ }
        }

        if (usages.length) {
            logger.usageSummary(repoPath, 'Qwen', usages, config.model, 'thinking', undefined, false, this.getRegion());
        }

        return { content: out.commitMessage };
    }

    /**
     * Generate commit message using legacy single-shot approach
     */
    private async generateDefault(
        jsonMessage: string,
        config: any,
        rules: any,
        repoPath: string,
        options?: GenerateCommitMessageOptions
    ): Promise<LLMResponse | LLMError> {
        const retries = this.utils.getMaxRetries();
        const totalAttempts = Math.max(1, retries + 1);
        let lastError: any;

        let messages: ChatMessage[] = [
            { role: 'system', content: rules.baseRule },
            { role: 'user', content: jsonMessage }
        ];

        for (let attempt = 0; attempt < totalAttempts; attempt++) {
            const result = await this.utils.callChatCompletion(
                this.openai!,
                messages,
                {
                    model: config.model,
                    provider: 'Qwen',
                    token: options?.token,
                    responseFormat: { "type": "json_object" },
                    trackUsage: true,
                    requestType: 'commitMessage'
                }
            );

            if (result.usage) {
                result.usage.model = config.model;
                logger.usageSummary(repoPath, 'Qwen', [result.usage], config.model, 'default', undefined, true, this.getRegion());
            } else {
                logger.usageSummary(repoPath, 'Qwen', [], config.model, 'default', undefined, true, this.getRegion());
            }

            const safe = commitMessageSchema.safeParse(result.parsedResponse);
            if (safe.success) {
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

        return { message: 'Failed to validate structured commit message from Qwen.', statusCode: 500 };
    }

}

