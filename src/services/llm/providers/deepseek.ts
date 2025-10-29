import * as vscode from 'vscode';
import { ChatMessage, ChatFn, GenerateCommitMessageOptions, LLMError, LLMResponse } from '../llmTypes';
import { BaseLLMService } from '../baseLLMService';
import { TemplateService } from '../../../template/templateService';
import { DiffData } from '../../git/gitTypes';
import OpenAI from 'openai';
import { generateCommitMessageChain } from "../../chain/chainThinking";
import { logger } from '../../logger';
import { OpenAICompatibleUtils } from './utils/index';
import { AnalysisPromptParts, LLMAnalysisResponse } from '../../analysis/analysisTypes';
import { stageNotifications } from '../../../ui/StageNotificationManager';
import { z } from "zod";
import {
    fileSummarySchema,
    classifyAndDraftResponseSchema,
    validateAndFixResponseSchema,
    repoAnalysisResponseSchema,
    commitMessageSchema
} from './schemas/common';

const DEEPSEEK_API_URL = 'https://api.deepseek.com';
const SECRET_DEEPSEEK_API_KEY = 'gitCommitGenie.secret.deepseekApiKey';

/**
 * DeepSeek LLM service implementation using OpenAI-compatible API
 */
export class DeepSeekService extends BaseLLMService {
    protected context: vscode.ExtensionContext;
    private openai: OpenAI | null = null;
    private utils: OpenAICompatibleUtils;

    constructor(context: vscode.ExtensionContext, templateService: TemplateService, analysisService?: any) {
        super(context, templateService, analysisService);
        this.context = context;
        this.utils = new OpenAICompatibleUtils(context);
        this.refreshFromSettings();
    }

    public async refreshFromSettings(): Promise<void> {
        const apiKey = await this.context.secrets.get(SECRET_DEEPSEEK_API_KEY);
        this.openai = apiKey ? new OpenAI({ apiKey, baseURL: DEEPSEEK_API_URL }) : null;
    }

    /**
     * Validate an API key by calling DeepSeek (OpenAI-compatible) and list models.
     * Returns a curated list intersected with our supported DeepSeek models.
     */
    public async validateApiKeyAndListModels(apiKey: string): Promise<string[]> {
        const preferred = this.listSupportedModels();
        try {
            const client = new OpenAI({ apiKey, baseURL: DEEPSEEK_API_URL });
            return await this.utils.tryListModels(client, preferred, 'DeepSeek');
        } catch (err: any) {
            throw new Error(err?.message || 'Failed to validate DeepSeek API key.');
        }
    }

    public listSupportedModels(): string[] {
        return [
            'deepseek-chat',
            'deepseek-reasoner'
        ];
    }

    public async setApiKey(apiKey: string): Promise<void> {
        await this.context.secrets.store(SECRET_DEEPSEEK_API_KEY, apiKey);
        this.openai = apiKey ? new OpenAI({ apiKey, baseURL: DEEPSEEK_API_URL }) : null;
    }

    public async clearApiKey(): Promise<void> {
        await this.context.secrets.delete(SECRET_DEEPSEEK_API_KEY);
        this.openai = null;
    }

    /**
     * Get the DeepSeek client instance
     */
    protected getClient(): OpenAI | null {
        return this.openai;
    }

    /**
     * Get the DeepSeek utils instance
     */
    protected getUtils(): OpenAICompatibleUtils {
        return this.utils;
    }

    /**
     * Get the provider name for error messages
     */
    protected getProviderName(): string {
        return 'DeepSeek';
    }

    /**
     * Get the current model configuration
     */
    protected getCurrentModel(): string {
        return this.context.globalState.get<string>('gitCommitGenie.deepseekModel', '');
    }

    /**
     * Get DeepSeek-specific configuration
     */
    private getConfig() {
        return this.utils.getProviderConfig('gitCommitGenie', 'deepseekModel');
    }

    private getRepoAnalysisOverrideModel(): string | null {
        return this.utils.getRepoAnalysisOverrideModel(this.listSupportedModels());
    }

    /**
     * This function requests a chat completion from DeepSeek and expects a structured JSON response
     * @param analysisPromptParts an ChatMessage[] containing keys system and user prompt parts
     * @param options 
     */
    async generateRepoAnalysis(analysisPromptParts: AnalysisPromptParts, options: { repositoryPath: string; token?: vscode.CancellationToken }): Promise<LLMAnalysisResponse | LLMError> {
        const systemMessage = analysisPromptParts.system;
        const userMessage = analysisPromptParts.user;

        const modle = this.getRepoAnalysisOverrideModel() || this.getConfig().model;
        const repoPath = options.repositoryPath;

        if (!modle) {
            return this.createModelNotSelectedError();
        }
        if (!this.openai) {
            return this.createApiKeyNotSetError();
        }
        try {
            const prased = await this.utils.callChatCompletion(
                this.openai,
                [systemMessage, userMessage],
                {
                    model: modle,
                    provider: 'DeepSeek',
                    token: options?.token,
                    trackUsage: true,
                    requestType: 'repoAnalysis'
                }
            );

            if (prased.usage) {
                logger.usageSummary(repoPath, 'DeepSeek', [prased.usage], modle, 'RepoAnalysis');
            } else {
                logger.usageSummary(repoPath, 'DeepSeek', [], modle, 'RepoAnalysis');
            }

            const safe = repoAnalysisResponseSchema.safeParse(prased.parsedResponse);
            if (!safe.success) {
                return { message: 'Failed to validate structured response from DeepSeek.', statusCode: 500 };
            }

            return {
                summary: safe.data.summary,
                projectType: safe.data.projectType,
                technologies: safe.data.technologies,
                insights: safe.data.insights,
                usage: prased.usage
            };
        } catch (error: any) {
            return this.convertToLLMError(error);
        }


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
                    provider: 'DeepSeek',
                    token: options?.token,
                    trackUsage: true,
                    requestType: _options!.requestType
                });

                callCount += 1;
                if (result.usage) {
                    usages.push(result.usage);
                    result.usage.model = config.model;
                    logger.usage(repoPath, 'DeepSeek', result.usage, config.model, labelFor(reqType), callCount);
                } else {
                    logger.usage(repoPath, 'DeepSeek', undefined, config.model, labelFor(reqType), callCount);
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
                    throw new Error(`DeepSeek structured result failed local validation for ${reqType} after ${totalAttempts} attempts`);
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
            logger.usageSummary(repoPath, 'DeepSeek', usages, config.model, 'thinking', undefined, false);
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
                    provider: 'DeepSeek',
                    token: options?.token,
                    responseFormat: { "type": "json_object" },
                    trackUsage: true,
                    requestType: 'commitMessage'
                }
            );

            if (result.usage) {
                result.usage.model = config.model;
                logger.usageSummary(repoPath, 'DeepSeek', [result.usage], config.model, 'default');
            } else {
                logger.usageSummary(repoPath, 'DeepSeek', [], config.model, 'default');
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

        return { message: 'Failed to validate structured commit message from DeepSeek.', statusCode: 500 };
    }

}


