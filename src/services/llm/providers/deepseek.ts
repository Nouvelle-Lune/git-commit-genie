import * as vscode from 'vscode';
import { LLMError, LLMResponse } from '../llmTypes';
import { BaseLLMService } from "../llmTypes";
import { TemplateService } from '../../../template/templateService';
import { DiffData } from '../../git/gitTypes';
import OpenAI from 'openai';
import { generateCommitMessageChain } from "../../chain/chainThinking";
import { ChatFn } from "../../chain/chainTypes";
import { logger } from '../../logger';
import { OpenAICompatibleUtils } from './utils';

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
        const preferred = [
            'deepseek-chat',
            'deepseek-reasoner'
        ];
        try {
            const client = new OpenAI({ apiKey, baseURL: DEEPSEEK_API_URL });
            return await this.utils.tryListModels(client, preferred, 'DeepSeek');
        } catch (err: any) {
            throw new Error(err?.message || 'Failed to validate DeepSeek API key.');
        }
    }

    public async setApiKey(apiKey: string): Promise<void> {
        await this.context.secrets.store(SECRET_DEEPSEEK_API_KEY, apiKey);
        this.openai = apiKey ? new OpenAI({ apiKey, baseURL: DEEPSEEK_API_URL }) : null;
    }

    public async clearApiKey(): Promise<void> {
        await this.context.secrets.delete(SECRET_DEEPSEEK_API_KEY);
        this.openai = null;
    }

    public async getChatFn(options?: { token?: vscode.CancellationToken }): Promise<ChatFn | LLMError> {
        if (!this.openai) {
            return { message: 'DeepSeek API key is not set. Please set it in the settings.', statusCode: 401 } satisfies LLMError;
        }

        const config = this.getConfig();
        if (!config.model) {
            return { message: 'DeepSeek model is not selected. Please configure it via Manage Models.', statusCode: 400 } satisfies LLMError;
        }

        const chat: ChatFn = async (messages, _opts) => {
            const result = await this.utils.callChatCompletion(this.openai!, messages, {
                model: config.model,
                provider: 'DeepSeek',
                token: options?.token
            });
            return result.content;
        };

        return chat satisfies ChatFn;
    }

    /**
     * Get DeepSeek-specific configuration
     */
    private getConfig() {
        const commonConfig = this.utils.getCommonConfig();
        return {
            ...commonConfig,
            model: this.context.globalState.get<string>('gitCommitGenie.deepseekModel', '')
        };
    }

    async generateCommitMessage(diffs: DiffData[], options?: { token?: vscode.CancellationToken }): Promise<LLMResponse | LLMError> {
        if (!this.openai) {
            return {
                message: 'DeepSeek API key is not set. Please set it in the settings.',
                statusCode: 401,
            };
        }

        try {
            const config = this.getConfig();
            const rules = this.utils.getRules();

            if (!config.model) {
                return { message: 'DeepSeek model is not selected. Please configure it via Manage Models.', statusCode: 400 };
            }

            const jsonMessage = await this.buildJsonMessage(diffs);

            if (config.useChain) {
                return await this.generateWithChain(diffs, jsonMessage, config, rules, options);
            } else {
                return await this.generateLegacy(jsonMessage, config, rules, options);
            }
        } catch (error: any) {
            return {
                message: error.message || 'An unknown error occurred with the DeepSeek API.',
                statusCode: error.status,
            };
        }
    }

    /**
     * Generate commit message using chain approach
     */
    private async generateWithChain(
        diffs: DiffData[],
        jsonMessage: string,
        config: any,
        rules: any,
        options?: { token?: vscode.CancellationToken }
    ): Promise<LLMResponse | LLMError> {
        const parsed = JSON.parse(jsonMessage);
        const usages: Array<{ prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }> = [];
        let callCount = 0;

        const chat: ChatFn = async (messages, _options) => {
            const result = await this.utils.callChatCompletion(this.openai!, messages, {
                model: config.model,
                provider: 'DeepSeek',
                token: options?.token,
                trackUsage: true
            });

            callCount += 1;
            if (result.usage) {
                usages.push(result.usage);
                this.utils.logTokenUsage('DeepSeek', result.usage, 'Chain', callCount);
            } else {
                this.utils.logTokenUsage('DeepSeek', undefined, 'Chain', callCount);
            }

            return result.content;
        };

        const out = await generateCommitMessageChain(
            {
                diffs,
                baseRulesMarkdown: rules.baseRule,
                currentTime: parsed?.["current-time"],
                userTemplate: parsed?.["user-template"],
                targetLanguage: parsed?.["target-language"],
                validationChecklist: rules.checklistText,
                repositoryAnalysis: parsed?.["repository-analysis"]
            },
            chat,
            { maxParallel: config.chainMaxParallel }
        );

        if (usages.length) {
            const sum = this.utils.sumTokenUsage(usages);
            logger.info(`[Genie][DeepSeek] Chain total tokens: prompt=${sum.prompt}, completion=${sum.completion}, total=${sum.total}`);
        }

        return { content: out.commitMessage };
    }

    /**
     * Generate commit message using legacy single-shot approach
     */
    private async generateLegacy(
        jsonMessage: string,
        config: any,
        rules: any,
        options?: { token?: vscode.CancellationToken }
    ): Promise<LLMResponse | LLMError> {
        const result = await this.utils.callChatCompletion(
            this.openai!,
            [
                { role: 'system', content: rules.baseRule },
                { role: 'user', content: jsonMessage }
            ],
            {
                model: config.model,
                provider: 'DeepSeek',
                token: options?.token,
                responseFormat: { "type": "json_object" },
                trackUsage: true
            }
        );

        this.utils.logTokenUsage('DeepSeek', result.usage, 'Legacy');

        if (result.content) {
            const jsonResponse = JSON.parse(result.content.trim());
            if (jsonResponse?.commit_message) {
                return { content: jsonResponse.commit_message };
            }
            return { content: result.content };
        } else {
            return { message: 'Failed to generate commit message from DeepSeek.', statusCode: 500 };
        }
    }
}
