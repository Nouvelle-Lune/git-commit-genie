import * as vscode from 'vscode';
import OpenAI from 'openai';
import { ChatMessage, ChatFn, GenerateCommitMessageOptions, LLMError, LLMResponse } from '../llmTypes';
import { BaseLLMService } from '../baseLLMService';
import { TemplateService } from '../../../template/templateService';
import { DiffData } from '../../git/gitTypes';
import { generateCommitMessageChain } from '../../chain/chainThinking';
import { logger } from '../../logger';
import { OpenAICompatibleUtils } from './utils/index';
import { IRepositoryAnalysisService } from '../../analysis/analysisTypes';
import { stageNotifications } from '../../../ui/StageNotificationManager';
import { safeRun } from '../../../utils/safeRun';
import { getRequestTypeLabel, getValidationSchemaFor } from './utils/requestTypeMaps';
import { ProviderRules } from './utils/baseProviderUtils';
import { commitMessageSchema } from './schemas/common';

interface OpenAIChatRuntimeConfig {
    model: string;
    useChain: boolean;
    chainMaxParallel: number;
    maxRetries: number;
    temperature: number;
}

interface OpenAIChatProviderOptions {
    providerName: string;
    modelStateKey: string;
    secretKey: string;
    baseURL?: string;
    endpointStateKey?: string;
    endpointCandidates?: Record<string, string>;
}

/**
 * Shared implementation for OpenAI-compatible chat/completions providers.
 * OpenAI Responses API remains implemented by the dedicated OpenAIService class.
 */
export abstract class OpenAIChatCompletionsService extends BaseLLMService {
    protected context: vscode.ExtensionContext;
    protected openai: OpenAI | null = null;
    protected utils: OpenAICompatibleUtils;

    constructor(
        context: vscode.ExtensionContext,
        templateService: TemplateService,
        analysisService: IRepositoryAnalysisService | undefined,
        private readonly providerOptions: OpenAIChatProviderOptions
    ) {
        super(context, templateService, analysisService);
        this.context = context;
        this.utils = new OpenAICompatibleUtils(context);
        this.refreshFromSettings();
    }

    public abstract listSupportedModels(): string[];

    protected getSecretStorageKey(): string {
        return this.providerOptions.secretKey;
    }

    protected getDefaultEndpointKey(): string {
        const keys = Object.keys(this.providerOptions.endpointCandidates || {});
        if (keys.length > 0) {
            return keys[0];
        }
        return 'default';
    }

    protected getCurrentEndpointKey(): string {
        if (!this.providerOptions.endpointStateKey) {
            return this.getDefaultEndpointKey();
        }
        return this.context.globalState.get<string>(this.providerOptions.endpointStateKey, this.getDefaultEndpointKey());
    }

    protected getEndpointUrl(endpointKey?: string): string | undefined {
        const key = endpointKey || this.getCurrentEndpointKey();
        const candidates = this.providerOptions.endpointCandidates || {};
        return candidates[key] || this.providerOptions.baseURL;
    }

    protected async setCurrentEndpointKey(endpointKey: string): Promise<void> {
        if (!this.providerOptions.endpointStateKey) {
            return;
        }
        await this.context.globalState.update(this.providerOptions.endpointStateKey, endpointKey);
    }

    protected createClient(apiKey: string, baseURL?: string): OpenAI {
        return new OpenAI({ apiKey, baseURL: baseURL ?? this.getEndpointUrl() });
    }

    protected getValidationClient(apiKey: string): OpenAI {
        return this.createClient(apiKey);
    }

    protected async validateAndListModels(client: OpenAI, preferredModels: string[]): Promise<string[]> {
        return this.utils.tryListModels(client, preferredModels, this.providerOptions.providerName);
    }

    protected getUsageLoggerRegion(): string | undefined {
        return undefined;
    }

    public async refreshFromSettings(): Promise<void> {
        const apiKey = await this.context.secrets.get(this.getSecretStorageKey());
        this.openai = apiKey ? this.createClient(apiKey, this.getEndpointUrl()) : null;
    }

    /**
     * Validate API key and return curated available models.
     */
    public async validateApiKeyAndListModels(apiKey: string): Promise<string[]> {
        const preferred = this.listSupportedModels();
        try {
            const candidates = this.providerOptions.endpointCandidates || {};
            const candidateEntries = Object.keys(candidates).length
                ? Object.entries(candidates)
                : [[this.getDefaultEndpointKey(), this.getEndpointUrl(this.getDefaultEndpointKey()) || this.providerOptions.baseURL || '']];

            const currentKey = this.getCurrentEndpointKey();
            const ordered = [...candidateEntries].sort(([a], [b]) => {
                if (a === currentKey) { return -1; }
                if (b === currentKey) { return 1; }
                return 0;
            });

            let lastErr: any;
            for (const [endpointKey, endpointUrl] of ordered) {
                if (!endpointUrl) {
                    continue;
                }
                try {
                    const client = this.createClient(apiKey, endpointUrl);
                    const models = await this.validateAndListModels(client, preferred);
                    await this.setCurrentEndpointKey(endpointKey);
                    return models;
                } catch (err: any) {
                    lastErr = err;
                }
            }

            throw lastErr || new Error(`Failed to validate ${this.providerOptions.providerName} API key.`);
        } catch (err: any) {
            throw new Error(err?.message || `Failed to validate ${this.providerOptions.providerName} API key.`);
        }
    }

    public async setApiKey(apiKey: string): Promise<void> {
        await this.context.secrets.store(this.getSecretStorageKey(), apiKey);
        this.openai = apiKey ? this.createClient(apiKey) : null;
    }

    public async clearApiKey(): Promise<void> {
        await this.context.secrets.delete(this.getSecretStorageKey());
        this.openai = null;
    }

    /**
     * Get the provider client instance
     */
    public getClient(): OpenAI | null {
        return this.openai;
    }

    /**
     * Get provider utils instance
     */
    public getUtils(): OpenAICompatibleUtils {
        return this.utils;
    }

    /**
     * Get provider display name for errors/logs
     */
    protected getProviderName(): string {
        return this.providerOptions.providerName;
    }

    /**
     * Get current selected model from global state.
     */
    protected getCurrentModel(): string {
        return this.context.globalState.get<string>(this.providerOptions.modelStateKey, '');
    }

    protected getProviderConfig(): OpenAIChatRuntimeConfig {
        const cfg = vscode.workspace.getConfiguration('gitCommitGenie');
        return {
            useChain: cfg.get<boolean>('chain.enabled', true),
            chainMaxParallel: cfg.get<number>('chain.maxParallel', 2),
            maxRetries: cfg.get<number>('llm.maxRetries', 2),
            temperature: cfg.get<number>('llm.temperature', 1),
            model: this.context.globalState.get<string>(this.providerOptions.modelStateKey, '')
        };
    }

    async generateCommitMessage(diffs: DiffData[], options?: GenerateCommitMessageOptions): Promise<LLMResponse | LLMError> {
        if (!this.openai) {
            return this.createApiKeyNotSetError();
        }

        try {
            const config = this.getProviderConfig();
            const rules = this.utils.getRules();
            const repoPath = this.getRepoPathForLogging(options?.targetRepo);

            if (!config.model) {
                return this.createModelNotSelectedError();
            }

            safeRun(`${this.providerOptions.providerName}.logGenerationStart`, () => logger.logGenerationStart(repoPath, config.useChain ? 'thinking' : 'default'));

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
     * Generate commit message using chain approach.
     */
    private async generateThinking(
        diffs: DiffData[],
        jsonMessage: string,
        config: OpenAIChatRuntimeConfig,
        rules: ProviderRules,
        repoPath: string,
        options?: GenerateCommitMessageOptions
    ): Promise<LLMResponse | LLMError> {
        const parsed = JSON.parse(jsonMessage);
        const usages: Array<{ prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }> = [];
        let callCount = 0;
        const providerName = this.providerOptions.providerName;
        const usageRegion = this.getUsageLoggerRegion();

        const chat: ChatFn = async (messages, _options) => {
            const reqType = _options?.requestType;
            const retries = this.utils.getMaxRetries();
            const totalAttempts = Math.max(1, retries + 1);

            return await this.runValidatedChatCall({
                reqType,
                totalAttempts,
                initialMessages: messages,
                repoPath,
                validationSchema: getValidationSchemaFor(reqType),
                callOnce: (msgs) => this.utils.callChatCompletion(this.openai!, msgs, {
                    model: config.model,
                    provider: providerName,
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
                        logger.usage(repoPath, providerName, usage, config.model, getRequestTypeLabel(reqType), callCount, usageRegion);
                    } else {
                        logger.usage(repoPath, providerName, undefined, config.model, getRequestTypeLabel(reqType), callCount, usageRegion);
                    }
                },
            });
        };

        stageNotifications.begin();
        let out;
        try {
            out = await generateCommitMessageChain(
                {
                    diffs,
                    currentTime: parsed?.['current-time'],
                    userTemplate: parsed?.['user-template'],
                    targetLanguage: parsed?.['target-language'],
                    validationChecklist: rules.checklistText,
                    repositoryPath: repoPath,
                    targetRepo: options?.targetRepo,
                    repositoryAnalysis: parsed?.['repository-analysis']
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
                        safeRun(`${providerName}.logCommitStage`, () => logger.logToolCall('commitStage', JSON.stringify(payload), 'Commit generation stage', repoPath));
                    }
                }
            );
        } finally {
            stageNotifications.end();
        }

        if (usages.length) {
            logger.usageSummary(repoPath, providerName, usages, config.model, 'thinking', undefined, false, usageRegion);
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
     * Generate commit message using single-shot approach.
     */
    private async generateDefault(
        jsonMessage: string,
        config: OpenAIChatRuntimeConfig,
        rules: ProviderRules,
        repoPath: string,
        options?: GenerateCommitMessageOptions
    ): Promise<LLMResponse | LLMError> {
        const retries = this.utils.getMaxRetries();
        const totalAttempts = Math.max(1, retries + 1);
        const providerName = this.providerOptions.providerName;
        const usageRegion = this.getUsageLoggerRegion();
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
                    provider: providerName,
                    token: options?.token,
                    responseFormat: { type: 'json_object' },
                    trackUsage: true,
                    requestType: 'commitMessage',
                    repoPath,
                }),
                onUsage: (usage) => {
                    if (usage) {
                        usage.model = config.model;
                        logger.usageSummary(repoPath, providerName, [usage], config.model, 'default', undefined, true, usageRegion);
                    } else {
                        logger.usageSummary(repoPath, providerName, [], config.model, 'default', undefined, true, usageRegion);
                    }
                },
            });
            safeRun(`${providerName}.logCommitStageDone`, () => logger.logToolCall(
                'commitStage',
                JSON.stringify({ stage: 'done', data: { finalMessage: data.commitMessage } }),
                'Commit generation stage',
                repoPath,
            ));
            return { content: data.commitMessage };
        } catch {
            return { message: `Failed to validate structured commit message from ${providerName}.`, statusCode: 500 };
        }
    }
}
