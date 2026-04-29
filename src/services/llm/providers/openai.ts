import * as vscode from 'vscode';
import OpenAI from 'openai';
import { LLMError, LLMResponse, ChatFn, ChatMessage, GenerateCommitMessageOptions } from '../llmTypes';
import { BaseLLMService } from '../baseLLMService';
import { TemplateService } from '../../../template/templateService';
import { DiffData } from '../../git/gitTypes';
import { generateCommitMessageChain } from "../../chain/chainThinking";
import { logger } from '../../logger';
import { IRepositoryAnalysisService } from "../../analysis/analysisTypes";
import { stageNotifications } from '../../../ui/StageNotificationManager';
import { OpenAICompatibleUtils } from './utils/OpenAIUtils';
import { safeRun } from '../../../utils/safeRun';
import { getRequestTypeLabel, getValidationSchemaFor } from './utils/requestTypeMaps';
import { ProviderRuntimeConfig, ProviderRules } from './utils/baseProviderUtils';
import { commitMessageSchema } from './schemas/common';
import { ProviderError } from './errors/providerError';

const SECRET_OPENAI_API_KEY = 'gitCommitGenie.secret.openaiApiKey';

/**
 * OpenAI service implementation
 */
export class OpenAIService extends BaseLLMService {
    private openai: OpenAI | null = null;
    protected context: vscode.ExtensionContext;
    private utils: OpenAICompatibleUtils;

    constructor(context: vscode.ExtensionContext, templateService: TemplateService, analysisService?: IRepositoryAnalysisService) {
        super(context, templateService, analysisService);
        this.context = context;
        this.utils = new OpenAICompatibleUtils(context);
        this.refreshFromSettings();
    }

    public async refreshFromSettings(): Promise<void> {
        const apiKey = await this.context.secrets.get(SECRET_OPENAI_API_KEY);
        this.openai = apiKey ? new OpenAI({ apiKey }) : null;
    }

    /**
     * Validate an API key by calling OpenAI and, if successful, return a curated list
     * of available chat models (intersecting with our supported set).
     */
    public async validateApiKeyAndListModels(apiKey: string): Promise<string[]> {
        const preferred = this.listSupportedModels();

        try {
            const client = new OpenAI({ apiKey });
            return await this.utils.tryListModels(client, preferred, 'OpenAI');
        } catch (err: any) {
            throw new Error(err?.message || 'Failed to validate OpenAI API key.');
        }
    }

    public listSupportedModels(): string[] {
        return [
            'gpt-5.4-mini',
            'gpt-5.4',
            'gpt-5.4-nano',
            'gpt-5-mini',
            'gpt-5',
            'gpt-5.2',
            'gpt-5-nano',
        ];
    }

    public async setApiKey(apiKey: string): Promise<void> {
        await this.context.secrets.store(SECRET_OPENAI_API_KEY, apiKey);
        this.openai = apiKey ? new OpenAI({ apiKey }) : null;
    }

    public async clearApiKey(): Promise<void> {
        await this.context.secrets.delete(SECRET_OPENAI_API_KEY);
        this.openai = null;
    }

    /**
     * Get the OpenAI client instance
     */
    public getClient(): OpenAI | null {
        return this.openai;
    }

    /**
     * Get the OpenAI utils instance
     */
    public getUtils(): OpenAICompatibleUtils {
        return this.utils;
    }

    /**
     * Get the provider name for error messages
     */
    protected getProviderName(): string {
        return 'OpenAI';
    }

    /**
     * Get the current model configuration
     */
    protected getCurrentModel(): string {
        return this.context.globalState.get<string>('gitCommitGenie.openaiModel', '');
    }

    /**
     * Get OpenAI-specific configuration
     */
    private getConfig() {
        return this.utils.getProviderConfig('gitCommitGenie', 'openaiModel');
    }

    private async ensureSupportedModel(model: string): Promise<string> {
        const selected = (model || '').trim();
        if (!selected) {
            return selected;
        }

        const supported = this.listSupportedModels();
        if (supported.includes(selected)) {
            return selected;
        }

        // listSupportedModels is already ordered by preference; the first
        // entry is the default fallback.
        const fallback = supported[0];
        if (!fallback) {
            return selected;
        }

        await this.context.globalState.update('gitCommitGenie.openaiModel', fallback);
        logger.warn(`[Genie][OpenAI] Model '${selected}' is unsupported. Auto-switched to '${fallback}'.`);
        return fallback;
    }

    async generateCommitMessage(diffs: DiffData[], options?: GenerateCommitMessageOptions): Promise<LLMResponse | LLMError> {
        if (!this.openai) {
            return this.createApiKeyNotSetError();
        }

        try {
            const config = this.getConfig();
            config.model = await this.ensureSupportedModel(config.model);
            const rules = this.utils.getRules();
            const repoPath = this.getRepoPathForLogging(options?.targetRepo);

            if (!config.model) {
                return this.createModelNotSelectedError();
            }

            // Divider in webview: commit generation start
            safeRun('OpenAI.logGenerationStart', () => logger.logGenerationStart(repoPath, config.useChain ? 'thinking' : 'default'));

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
        config: ProviderRuntimeConfig,
        rules: ProviderRules,
        repoPath: string,
        options?: GenerateCommitMessageOptions
    ): Promise<LLMResponse | LLMError> {
        const parsed = JSON.parse(jsonMessage);
        const usages: Array<any> = [];
        let callCount = 0;

        const chat: ChatFn = async (messages, _options) => {
            const reqType = _options?.requestType;
            const retries = config.maxRetries ?? 2;
            const totalAttempts = Math.max(1, retries + 1);

            return await this.runValidatedChatCall({
                reqType,
                totalAttempts,
                initialMessages: messages,
                repoPath,
                validationSchema: getValidationSchemaFor(reqType),
                callOnce: (msgs) => this.utils.callChatCompletion(this.openai!, msgs, {
                    model: config.model,
                    provider: 'OpenAI',
                    token: options?.token,
                    trackUsage: true,
                    requestType: _options!.requestType,
                    repoPath,
                }),
                onUsage: (usage) => {
                    callCount += 1;
                    if (usage) {
                        usages.push(usage);
                        usage.model = config.model;
                        logger.usage(repoPath, 'OpenAI', usage, config.model, getRequestTypeLabel(reqType), callCount);
                    } else {
                        logger.usage(repoPath, 'OpenAI', undefined, config.model, getRequestTypeLabel(reqType), callCount);
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
                    currentTime: parsed?.["current-time"],
                    userTemplate: parsed?.["user-template"],
                    targetLanguage: parsed?.["target-language"],
                    validationChecklist: rules.checklistText,
                    repositoryPath: repoPath,
                    targetRepo: options?.targetRepo,
                    repositoryAnalysis: parsed?.["repository-analysis"]
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
                        safeRun('OpenAI.logCommitStage', () => logger.logToolCall('commitStage', JSON.stringify(payload), 'Commit generation stage', repoPath));
                    }
                }
            );
        } finally {
            stageNotifications.end();
        }

        if (usages.length) {
            // Per-step costs already added; summarize without re-adding cost
            logger.usageSummary(repoPath, 'OpenAI', usages, config.model, 'thinking', undefined, false);
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
                callOnce: (msgs) => this.utils.callChatCompletion(this.openai!, msgs, {
                    model: config.model,
                    provider: 'OpenAI',
                    token: options?.token,
                    trackUsage: true,
                    requestType: 'commitMessage',
                    repoPath,
                }),
                onUsage: (usage) => {
                    if (usage) {
                        usage.model = config.model;
                        logger.usageSummary(repoPath, 'OpenAI', [usage], config.model, 'default');
                    } else {
                        logger.usageSummary(repoPath, 'OpenAI', [], config.model, 'default');
                    }
                },
            });
            safeRun('OpenAI.logCommitStageDone', () => logger.logToolCall(
                'commitStage',
                JSON.stringify({ stage: 'done', data: { finalMessage: data.commitMessage } }),
                'Commit generation stage',
                repoPath,
            ));
            return { content: data.commitMessage };
        } catch (error: any) {
            // Preserve cancellation signals instead of silently converting to 500
            if (error instanceof ProviderError) {
                return { message: error.message, statusCode: error.statusCode };
            }
            if (error?.name === 'AbortError' || error?.message === 'Cancelled' || error?.message?.includes('aborted')) {
                return { message: error?.message || 'Operation cancelled', statusCode: 499 };
            }
            return { message: 'Failed to validate structured commit message from OpenAI.', statusCode: 500 };
        }
    }

}
