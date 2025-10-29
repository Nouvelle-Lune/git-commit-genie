import Anthropic from '@anthropic-ai/sdk';
import * as vscode from 'vscode';

import { z } from 'zod';
import { TemplateService } from '../../../template/templateService';
import { AnalysisPromptParts, LLMAnalysisResponse } from '../../analysis/analysisTypes';
import { generateCommitMessageChain } from '../../chain/chainThinking';
import { DiffData } from '../../git/gitTypes';
import { logger } from '../../logger';
import { stageNotifications } from '../../../ui/StageNotificationManager';
import { AnthropicUtils } from './utils/anthropicUtils';
import { ChatFn, ChatMessage, GenerateCommitMessageOptions, LLMError, LLMResponse } from '../llmTypes';
import { BaseLLMService } from '../baseLLMService';
import { AnthropicCommitMessageTool, AnthropicRepoAnalysisTool, AnthropicFileSummaryTool, AnthropicClassifyAndDraftTool, AnthropicValidateAndFixTool } from './schemas/anthropicSchemas';
import {
    fileSummarySchema, classifyAndDraftResponseSchema, validateAndFixResponseSchema, repoAnalysisResponseSchema,
    commitMessageSchema
} from './schemas/common';

const SECRET_ANTHROPIC_API_KEY = 'gitCommitGenie.secret.anthropicApiKey';

/**
 * Anthropic Claude service implementation
 */
export class AnthropicService extends BaseLLMService {
    private client: Anthropic | null = null;
    protected context: vscode.ExtensionContext;
    private utils: AnthropicUtils;

    constructor(context: vscode.ExtensionContext, templateService: TemplateService, analysisService?: any) {
        super(context, templateService, analysisService);
        this.context = context;
        this.utils = new AnthropicUtils(context);
        this.refreshFromSettings();
    }

    public async refreshFromSettings(): Promise<void> {
        const apiKey = await this.context.secrets.get(SECRET_ANTHROPIC_API_KEY);
        this.client = apiKey ? new Anthropic({ apiKey }) : null;
    }

    /**
     * Validate an API key by calling Anthropic and, if successful, return a curated list
     * of available chat models (intersecting with our supported set).
     */
    public async validateApiKeyAndListModels(apiKey: string): Promise<string[]> {
        const preferred = this.listSupportedModels();

        try {
            const client = new Anthropic({ apiKey });
            await this.utils.validateApiKey(client, preferred[0], 'Anthropic');
            return preferred;
        } catch (err: any) {
            throw new Error(err?.message || 'Failed to validate Anthropic API key.');
        }
    }

    public listSupportedModels(): string[] {
        return [
            'claude-3-5-haiku-20241022',
            'claude-sonnet-4-20250514',
            'claude-3-7-sonnet-20250219',
            'claude-3-5-sonnet-20241022',
            'claude-3-5-sonnet-20240620',
            'claude-opus-4-1-20250805',
            'claude-opus-4-20250514'
        ];
    }

    public async setApiKey(apiKey: string): Promise<void> {
        await this.context.secrets.store(SECRET_ANTHROPIC_API_KEY, apiKey);
        this.client = apiKey ? new Anthropic({ apiKey }) : null;
    }

    public async clearApiKey(): Promise<void> {
        await this.context.secrets.delete(SECRET_ANTHROPIC_API_KEY);
        this.client = null;
    }

    /**
     * Get the Anthropic client instance
     */
    protected getClient(): Anthropic | null {
        return this.client;
    }

    /**
     * Get the Anthropic utils instance
     */
    protected getUtils(): AnthropicUtils {
        return this.utils;
    }

    /**
     * Get the provider name for error messages
     */
    protected getProviderName(): string {
        return 'Anthropic';
    }

    /**
     * Get the current model configuration
     */
    protected getCurrentModel(): string {
        return this.context.globalState.get<string>('gitCommitGenie.anthropicModel', '');
    }

    /**
     * Get Anthropic-specific configuration
     */
    private getConfig() {
        return this.utils.getProviderConfig('gitCommitGenie', 'anthropicModel');
    }

    private getRepoAnalysisOverrideModel(): string | null {
        return this.utils.getRepoAnalysisOverrideModel(this.listSupportedModels());
    }

    /**
     * This function requests a chat completion from Anthropic and expects a structured JSON response
     */
    async generateRepoAnalysis(analysisPromptParts: AnalysisPromptParts, options: { repositoryPath: string; token?: vscode.CancellationToken }): Promise<LLMAnalysisResponse | LLMError> {
        const config = { ...this.getConfig(), model: this.getRepoAnalysisOverrideModel() || this.getConfig().model };
        const repoPath = options.repositoryPath;

        if (!config.model) {
            return this.createModelNotSelectedError();
        }

        if (!this.client) {
            return this.createApiKeyNotSetError();
        }

        try {
            const response = await this.utils.callChatCompletion(
                this.client,
                [analysisPromptParts.system, analysisPromptParts.user],
                {
                    model: config.model,
                    provider: 'Anthropic',
                    token: options?.token,
                    maxTokens: 2048,
                    trackUsage: true,
                    tools: [AnthropicRepoAnalysisTool],
                    toolChoice: { type: 'tool', name: AnthropicRepoAnalysisTool.name }
                }
            );

            if (response.usage) {
                logger.usageSummary(repoPath, 'Anthropic', [response.usage], config.model, 'RepoAnalysis');
            } else {
                logger.usageSummary(repoPath, 'Anthropic', [], config.model, 'RepoAnalysis');
            }

            const safe = repoAnalysisResponseSchema.safeParse(response.parsedResponse);
            if (!safe.success) {
                return { message: 'Failed to validate structured response from Anthropic.', statusCode: 500 };
            }

            return {
                summary: safe.data.summary,
                projectType: safe.data.projectType,
                technologies: safe.data.technologies,
                insights: safe.data.insights,
                usage: response.usage
            };
        } catch (error: any) {
            return this.convertToLLMError(error);
        }
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
                    default: return 'thinking';
                }
            };
            // Map request type to tool and schema
            const toolMap: Record<string, { tool: any, schema: any }> = {
                summary: { tool: AnthropicFileSummaryTool, schema: fileSummarySchema },
                draft: { tool: AnthropicClassifyAndDraftTool, schema: classifyAndDraftResponseSchema },
                fix: { tool: AnthropicValidateAndFixTool, schema: validateAndFixResponseSchema },
                commitMessage: { tool: AnthropicCommitMessageTool, schema: commitMessageSchema },
                strictFix: { tool: AnthropicCommitMessageTool, schema: commitMessageSchema },
                enforceLanguage: { tool: AnthropicCommitMessageTool, schema: commitMessageSchema },
            };

            const mapping = reqType ? toolMap[reqType] : undefined;
            const retries = config.maxRetries ?? 2;
            const totalAttempts = Math.max(1, retries + 1);

            for (let attempt = 0; attempt < totalAttempts; attempt++) {
                const result = await this.utils.callChatCompletion(this.client!, messages, {
                    model: config.model,
                    provider: 'Anthropic',
                    token: options?.token,
                    trackUsage: true,
                    tools: mapping ? [mapping.tool] : undefined,
                    toolChoice: mapping ? { type: 'tool', name: mapping.tool.name } : undefined
                });

                callCount += 1;
                if (result.usage) {
                    usages.push(result.usage);
                    logger.usage(repoPath, 'Anthropic', result.usage, config.model, labelFor(reqType), callCount);
                } else {
                    logger.usage(repoPath, 'Anthropic', undefined, config.model, labelFor(reqType), callCount);
                }

                if (mapping) {
                    const safe = mapping.schema.safeParse(result.parsedResponse);
                    if (safe.success) {
                        return safe.data;
                    }

                    if (attempt < totalAttempts - 1) {
                        this.logSchemaValidationRetry(reqType || 'unknown', attempt, totalAttempts);
                        messages = this.buildSchemaValidationRetryMessages(
                            messages,
                            result,
                            safe.error,
                            mapping.schema,
                            reqType
                        );
                        continue;
                    }

                    throw new Error(`Anthropic tool result failed local validation for ${reqType} after ${totalAttempts} attempts`);
                }

                // Fallback: return raw content text (should not happen in our chain)
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
                        try { stageNotifications.update({ type: event.type as any, data: event.data }); } catch { /* ignore */ }
                    }
                }
            );
        } finally {
            try { stageNotifications.end(); } catch { /* ignore */ }
        }

        if (usages.length) {
            logger.usageSummary(repoPath, 'Anthropic', usages, config.model, 'thinking', undefined, false);
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
                    provider: 'Anthropic',
                    token: options?.token,
                    trackUsage: true,
                    tools: [AnthropicCommitMessageTool],
                    toolChoice: { type: 'tool', name: AnthropicCommitMessageTool.name }
                }
            );

            if (result.usage) {
                logger.usageSummary(repoPath, 'Anthropic', [result.usage], config.model, 'default');
            } else {
                logger.usageSummary(repoPath, 'Anthropic', [], config.model, 'default');
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

        return { message: 'Failed to validate structured commit message from Anthropic.', statusCode: 500 };
    }
}


