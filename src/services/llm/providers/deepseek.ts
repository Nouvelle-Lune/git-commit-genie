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
import {
    fileSummarySchema, classifyAndDraftResponseSchema, validateAndFixResponseSchema,
    commitMessageSchema, repoAnalysisResponseSchema, repoAnalysisActionSchema
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

    constructor(context: vscode.ExtensionContext, templateService: TemplateService, analysisService?: IRepositoryAnalysisService) {
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

            // Divider in webview: commit generation start
            try { logger.logGenerationStart(repoPath, config.useChain ? 'thinking' : 'default'); } catch { /* ignore */ }

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
                    case 'repoAnalysis': return 'repo-analysis';
                    case 'repoAnalysisAction': return 'repo-analysis-action';
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
                repoAnalysis: repoAnalysisResponseSchema,
                repoAnalysisAction: repoAnalysisActionSchema,
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
                    requestType: _options!.requestType,
                    repoPath
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
                    requestType: 'commitMessage',
                    repoPath
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
                try { logger.logToolCall('schemaValidation', JSON.stringify({ stage: 'commitMessage', attempt: attempt + 1, totalAttempts, error: String(safe.error) }), 'Schema validation failed', repoPath); } catch { /* ignore */ }
                messages = this.buildSchemaValidationRetryMessages(
                    messages,
                    result,
                    safe.error,
                    commitMessageSchema,
                    'commitMessage'
                );
                continue;
            }
            try { logger.logToolCall('schemaValidation', JSON.stringify({ stage: 'commitMessage', finalFailure: true, error: String(lastError) }), 'Schema validation failed', repoPath); } catch { /* ignore */ }
        }

        return { message: 'Failed to validate structured commit message from DeepSeek.', statusCode: 500 };
    }

}
