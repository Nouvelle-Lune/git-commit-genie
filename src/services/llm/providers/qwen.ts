import * as vscode from 'vscode';
import { BaseLLMService, ChatMessage, ChatFn, GenerateCommitMessageOptions, LLMError, LLMResponse } from '../llmTypes';
import { TemplateService } from '../../../template/templateService';
import { DiffData } from '../../git/gitTypes';
import OpenAI from 'openai';
import { generateCommitMessageChain } from "../../chain/chainThinking";
import { logger } from '../../logger';
import { OpenAICompatibleUtils } from './utils/index.js';
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

    constructor(context: vscode.ExtensionContext, templateService: TemplateService, analysisService?: any) {
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

    public async refreshFromSettings(): Promise<void> {
        const apiKey = await this.context.secrets.get(this.getSecretKey());
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
     * Get Qwen-specific configuration
     */
    private getConfig() {
        const commonConfig = this.utils.getCommonConfig();
        return {
            ...commonConfig,
            model: this.context.globalState.get<string>('gitCommitGenie.qwenModel', '')
        };
    }

    private getRepoAnalysisOverrideModel(): string | null {
        try {
            const cfg = vscode.workspace.getConfiguration('gitCommitGenie.repositoryAnalysis');
            const value = (cfg.get<string>('model', 'general') || 'general').trim();
            if (!value || value === 'general') { return null; }
            return this.listSupportedModels().includes(value) ? value : null;
        } catch {
            return null;
        }
    }

    /**
     * This function requests a chat completion from Qwen and expects a structured JSON response
     * @param analysisPromptParts an ChatMessage[] containing keys system and user prompt parts
     * @param options 
     */
    async generateRepoAnalysis(analysisPromptParts: AnalysisPromptParts, options: { repositoryPath: string; token?: vscode.CancellationToken }): Promise<LLMAnalysisResponse | LLMError> {
        const systemMessage = analysisPromptParts.system;
        const userMessage = analysisPromptParts.user;

        const model = this.getRepoAnalysisOverrideModel() || this.getConfig().model;
        const repoPath = options.repositoryPath;

        if (!model) {
            return { message: 'Qwen model is not selected. Please configure it via Manage Models.', statusCode: 400 };
        }
        if (!this.openai) {
            return { message: 'Qwen API key is not set. Please set it in the settings.', statusCode: 401 };
        }
        try {
            const parsed = await this.utils.callChatCompletion(
                this.openai,
                [systemMessage, userMessage],
                {
                    model: model,
                    provider: 'Qwen',
                    token: options?.token,
                    trackUsage: true,
                    requestType: 'repoAnalysis'
                }
            );

            if (parsed.usage) {
                logger.usageSummary(repoPath, 'Qwen', [parsed.usage], model, 'RepoAnalysis');
            } else {
                logger.usageSummary(repoPath, 'Qwen', [], model, 'RepoAnalysis');
            }

            const safe = repoAnalysisResponseSchema.safeParse(parsed.parsedResponse);
            if (!safe.success) {
                return { message: 'Failed to validate structured response from Qwen.', statusCode: 500 };
            }

            return {
                summary: safe.data.summary,
                projectType: safe.data.projectType,
                technologies: safe.data.technologies,
                insights: safe.data.insights,
                usage: parsed.usage
            };
        } catch (error: any) {
            return {
                message: error.message || 'An unknown error occurred with the Qwen API.',
                statusCode: error.status,
            };
        }
    }

    async generateCommitMessage(diffs: DiffData[], options?: GenerateCommitMessageOptions): Promise<LLMResponse | LLMError> {
        if (!this.openai) {
            return {
                message: 'Qwen API key is not set. Please set it in the settings.',
                statusCode: 401,
            };
        }

        try {
            const config = this.getConfig();
            const rules = this.utils.getRules();
            const repoPath = this.getRepoPathForLogging(options?.targetRepo);

            if (!config.model) {
                return { message: 'Qwen model is not selected. Please configure it via Manage Models.', statusCode: 400 };
            }

            const jsonMessage = await this.buildJsonMessage(diffs, options?.targetRepo);

            if (config.useChain) {
                return await this.generateThinking(diffs, jsonMessage, config, rules, repoPath, options);
            } else {
                return await this.generateDefault(jsonMessage, config, rules, repoPath, options);
            }
        } catch (error: any) {
            return {
                message: error.message || 'An unknown error occurred with the Qwen API.',
                statusCode: error.status,
            };
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
                        logger.warn(`[Genie][Qwen] Schema validation failed for ${reqType} (attempt ${attempt + 1}/${totalAttempts}). Retrying...`);

                        const jsonSchemaString = JSON.stringify(z.toJSONSchema(validationSchema), null, 2);

                        messages = [
                            ...messages,
                            result.parsedAssistantResponse || { role: 'assistant', content: result.parsedResponse ? JSON.stringify(result.parsedResponse) : '' },
                            {
                                role: 'user',
                                content: `The previous response did not conform to the required format, the zod error is ${safe.error}. Please try again and ensure the response matches the specified JSON format: ${jsonSchemaString}.`
                            }
                        ];
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
            logger.usageSummary(repoPath, 'Qwen', usages, config.model, 'thinking', undefined, false);
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
                logger.usageSummary(repoPath, 'Qwen', [result.usage], config.model, 'default');
            } else {
                logger.usageSummary(repoPath, 'Qwen', [], config.model, 'default');
            }

            const safe = commitMessageSchema.safeParse(result.parsedResponse);
            if (safe.success) {
                return { content: safe.data.commitMessage };
            }

            lastError = safe.error;
            if (attempt < totalAttempts - 1) {
                logger.warn(`[Genie][Qwen] Schema validation failed (attempt ${attempt + 1}/${totalAttempts}). Retrying...`);

                const jsonSchemaString = JSON.stringify(z.toJSONSchema(commitMessageSchema), null, 2);

                messages = [
                    ...messages,
                    result.parsedAssistantResponse || { role: 'assistant', content: result.parsedResponse ? JSON.stringify(result.parsedResponse) : '' },
                    {
                        role: 'user',
                        content: `The previous response did not conform to the required format, the zod error is ${lastError}. Please try again and ensure the response matches the specified JSON format: ${jsonSchemaString} exactly.`
                    }
                ];
            }
        }

        return { message: 'Failed to validate structured commit message from Qwen.', statusCode: 500 };
    }
}
