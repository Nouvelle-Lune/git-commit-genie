import Anthropic from '@anthropic-ai/sdk';
import * as vscode from 'vscode';

import { z } from 'zod';
import { TemplateService } from '../../../template/templateService';
import { IRepositoryAnalysisService } from '../../analysis/analysisTypes';
import { generateCommitMessageChain } from '../../chain/chainThinking';
import { DiffData } from '../../git/gitTypes';
import { logger } from '../../logger';
import { stageNotifications } from '../../../ui/StageNotificationManager';
import { AnthropicUtils } from './utils/AnthropicUtils';
import { safeRun } from '../../../utils/safeRun';
import { getRequestTypeLabel, getValidationSchemaFor } from './utils/requestTypeMaps';
import { ProviderRuntimeConfig, ProviderRules } from './utils/baseProviderUtils';
import { ChatFn, ChatMessage, GenerateCommitMessageOptions, LLMError, LLMResponse } from '../llmTypes';
import { BaseLLMService } from '../baseLLMService';
import {
    AnthropicCommitMessageTool,
    AnthropicFileSummaryTool,
    AnthropicClassifyAndDraftTool,
    AnthropicValidateAndFixTool,
    AnthropicRagPreparationTool,
    AnthropicRagRerankTool,
    AnthropicRepoAnalysisTool,
    AnthropicRepoAnalysisActionTool
} from './schemas/anthropicSchemas';
import { commitMessageSchema } from './schemas/common';

const SECRET_ANTHROPIC_API_KEY = 'gitCommitGenie.secret.anthropicApiKey';

/**
 * Anthropic Claude service implementation
 */
export class AnthropicService extends BaseLLMService {
    private client: Anthropic | null = null;
    protected context: vscode.ExtensionContext;
    private utils: AnthropicUtils;

    constructor(context: vscode.ExtensionContext, templateService: TemplateService, analysisService?: IRepositoryAnalysisService) {
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
            'claude-haiku-4-5-20251001',
            'claude-sonnet-4-5-20250929',
            'claude-opus-4-5-20251101',

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
    public getClient(): Anthropic | null {
        return this.client;
    }

    /**
     * Get the Anthropic utils instance
     */
    public getUtils(): AnthropicUtils {
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
            safeRun('Anthropic.logGenerationStart', () => logger.logGenerationStart(repoPath, config.useChain ? 'thinking' : 'default'));

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

        // Map request type to provider-specific tool definition. The
        // validation schema is shared across providers and resolved via
        // getValidationSchemaFor.
        const toolMap: Record<string, any> = {
            summary: AnthropicFileSummaryTool,
            draft: AnthropicClassifyAndDraftTool,
            fix: AnthropicValidateAndFixTool,
            ragPreparation: AnthropicRagPreparationTool,
            ragRerank: AnthropicRagRerankTool,
            commitMessage: AnthropicCommitMessageTool,
            strictFix: AnthropicCommitMessageTool,
            enforceLanguage: AnthropicCommitMessageTool,
            repoAnalysis: AnthropicRepoAnalysisTool,
            repoAnalysisAction: AnthropicRepoAnalysisActionTool,
        };

        const chat: ChatFn = async (messages, chainOptions) => {
            const reqType = chainOptions?.requestType;
            const retries = config.maxRetries ?? 2;
            const totalAttempts = Math.max(1, retries + 1);
            const tool = reqType ? toolMap[reqType] : undefined;

            return await this.runValidatedChatCall({
                reqType,
                totalAttempts,
                initialMessages: messages,
                repoPath,
                validationSchema: getValidationSchemaFor(reqType),
                callOnce: (msgs) => this.utils.callChatCompletion(this.client!, msgs, {
                    model: config.model,
                    provider: 'Anthropic',
                    token: options?.token,
                    trackUsage: true,
                    tools: tool ? [tool] : undefined,
                    toolChoice: tool ? { type: 'tool', name: tool.name } : undefined,
                    repoPath,
                }),
                onUsage: (usage) => {
                    callCount += 1;
                    if (usage) {
                        usages.push(usage);
                        logger.usage(repoPath, 'Anthropic', usage, config.model, getRequestTypeLabel(reqType), callCount);
                    } else {
                        logger.usage(repoPath, 'Anthropic', undefined, config.model, getRequestTypeLabel(reqType), callCount);
                    }
                },
            });
        };

        // Start bottom-right stage notifications
        stageNotifications.begin();
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
                        stageNotifications.update({ type: event.type, data: event.data });
                        const payload = { stage: event.type, data: event.data ?? {} };
                        safeRun('Anthropic.logCommitStage', () => logger.logToolCall('commitStage', JSON.stringify(payload), 'Commit generation stage', repoPath));
                    }
                }
            );
        } finally {
            stageNotifications.end();
        }

        if (usages.length) {
            logger.usageSummary(repoPath, 'Anthropic', usages, config.model, 'thinking', undefined, false);
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
        const messages: ChatMessage[] = [
            { role: 'system', content: rules.baseRule },
            { role: 'user', content: jsonMessage }
        ];

        try {
            const data = await this.runValidatedChatCall({
                reqType: 'commitMessage',
                totalAttempts,
                initialMessages: messages,
                repoPath,
                validationSchema: commitMessageSchema,
                callOnce: (msgs) => this.utils.callChatCompletion(this.client!, msgs, {
                    model: config.model,
                    provider: 'Anthropic',
                    token: options?.token,
                    trackUsage: true,
                    tools: [AnthropicCommitMessageTool],
                    toolChoice: { type: 'tool', name: AnthropicCommitMessageTool.name },
                    repoPath,
                }),
                onUsage: (usage) => {
                    if (usage) {
                        logger.usageSummary(repoPath, 'Anthropic', [usage], config.model, 'default');
                    } else {
                        logger.usageSummary(repoPath, 'Anthropic', [], config.model, 'default');
                    }
                },
            });
            safeRun('Anthropic.logCommitStageDone', () => logger.logToolCall(
                'commitStage',
                JSON.stringify({ stage: 'done', data: { finalMessage: data.commitMessage } }),
                'Commit generation stage',
                repoPath,
            ));
            return { content: data.commitMessage };
        } catch {
            return { message: 'Failed to validate structured commit message from Anthropic.', statusCode: 500 };
        }
    }
}
