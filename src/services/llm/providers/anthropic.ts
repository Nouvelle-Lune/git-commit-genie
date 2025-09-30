import Anthropic from '@anthropic-ai/sdk';
import * as vscode from 'vscode';

import { TemplateService } from '../../../template/templateService';
import { AnalysisPromptParts, LLMAnalysisResponse } from '../../analysis/analysisTypes';
import { generateCommitMessageChain } from '../../chain/chainThinking';
import { DiffData } from '../../git/gitTypes';
import { logger } from '../../logger';
import { AnthropicUtils } from './utils/AnthropicUtils';
import { BaseLLMService, ChatFn, LLMError, LLMResponse } from '../llmTypes';
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
     * Get Anthropic-specific configuration
     */
    private getConfig() {
        const commonConfig = this.utils.getCommonConfig();
        return {
            ...commonConfig,
            model: this.context.globalState.get<string>('gitCommitGenie.anthropicModel', '')
        };
    }

    /**
     * This function requests a chat completion from Anthropic and expects a structured JSON response
     */
    async generateRepoAnalysis(analysisPromptParts: AnalysisPromptParts, options?: { token?: vscode.CancellationToken }): Promise<LLMAnalysisResponse | LLMError> {
        const config = this.getConfig();

        if (!config.model) {
            return { message: 'Anthropic model is not selected. Please configure it via Manage Models.', statusCode: 400 };
        }

        if (!this.client) {
            return { message: 'Anthropic API key is not set. Please set it in the settings.', statusCode: 401 };
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
                logger.usage('Anthropic', response.usage, config.model, 'RepoAnalysis');
            } else {
                logger.usage('Anthropic', undefined, config.model, 'RepoAnalysis');
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
            return {
                message: error?.message || 'An unknown error occurred with the Anthropic API.',
                statusCode: error?.status,
            };
        }
    }

    async generateCommitMessage(diffs: DiffData[], options?: { token?: vscode.CancellationToken }): Promise<LLMResponse | LLMError> {
        if (!this.client) {
            return { message: 'Anthropic API key is not set. Please set it in the settings.', statusCode: 401 };
        }

        try {
            const config = this.getConfig();
            const rules = this.utils.getRules();

            if (!config.model) {
                return { message: 'Anthropic model is not selected. Please configure it via Manage Models.', statusCode: 400 };
            }

            const jsonMessage = await this.buildJsonMessage(diffs);

            if (config.useChain) {
                return await this.generateThinking(diffs, jsonMessage, config, rules, options);
            }

            return await this.generateDefault(jsonMessage, config, rules, options);
        } catch (error: any) {
            return {
                message: error?.message || 'An unknown error occurred with the Anthropic API.',
                statusCode: error?.status,
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
        options?: { token?: vscode.CancellationToken }
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
                    logger.usage('Anthropic', result.usage, config.model, labelFor(reqType), callCount);
                } else {
                    logger.usage('Anthropic', undefined, config.model, labelFor(reqType), callCount);
                }

                if (mapping) {
                    const safe = mapping.schema.safeParse(result.parsedResponse);
                    if (safe.success) {
                        return safe.data;
                    }

                    if (attempt < totalAttempts - 1) {
                        logger.warn(`[Genie][Anthropic] Schema validation failed for ${reqType} (attempt ${attempt + 1}/${totalAttempts}). Retrying...`);

                        const systemMessages = messages.filter(m => m.role === 'system');
                        if (systemMessages.length > 0) {
                            const schemaInstruction = `CRITICAL: You MUST strictly follow the tool schema format. Your previous response failed schema validation. Please ensure your response exactly matches the required structure for the ${mapping.tool.name} tool.`;
                            systemMessages[0].content = schemaInstruction + '\n\n' + systemMessages[0].content;
                        }

                        continue;
                    }

                    throw new Error(`Anthropic tool result failed local validation for ${reqType} after ${totalAttempts} attempts`);
                }

                // Fallback: return raw content text (should not happen in our chain)
                return result.parsedResponse;
            }
        };

        const out = await generateCommitMessageChain(
            {
                diffs,
                baseRulesMarkdown: rules.baseRule,
                currentTime: parsedInput?.['current-time'],
                userTemplate: parsedInput?.['user-template'],
                targetLanguage: parsedInput?.['target-language'],
                validationChecklist: rules.checklistText,
                repositoryAnalysis: parsedInput?.['repository-analysis']
            },
            chat,
            { maxParallel: config.chainMaxParallel }
        );

        if (usages.length) {
            logger.usageSummary('Anthropic', usages, config.model, 'thinking');
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
        options?: { token?: vscode.CancellationToken }
    ): Promise<LLMResponse | LLMError> {
        const retries = config.maxRetries ?? 2;
        const totalAttempts = Math.max(1, retries + 1);
        let lastError: any;

        for (let attempt = 0; attempt < totalAttempts; attempt++) {
            const result = await this.utils.callChatCompletion(
                this.client!,
                [
                    { role: 'system', content: rules.baseRule },
                    { role: 'user', content: jsonMessage }
                ],
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
                logger.usage('Anthropic', result.usage, config.model, 'default');
            } else {
                logger.usage('Anthropic', undefined, config.model, 'default');
            }

            const safe = commitMessageSchema.safeParse(result.parsedResponse);
            if (safe.success) {
                return { content: safe.data.commitMessage };
            }

            lastError = safe.error;
            if (attempt < totalAttempts - 1) {
                logger.warn(`[Genie][Anthropic] Schema validation failed (attempt ${attempt + 1}/${totalAttempts}). Retrying...`);
            }
        }

        return { message: 'Failed to validate structured commit message from Anthropic.', statusCode: 500 };
    }
}
