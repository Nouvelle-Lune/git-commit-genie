import * as vscode from 'vscode';
import { GoogleGenAI, Type } from '@google/genai';
import { BaseLLMService, LLMError, LLMResponse, ChatFn, GenerateCommitMessageOptions } from '../llmTypes';
import { TemplateService } from '../../../template/templateService';
import { DiffData } from '../../git/gitTypes';
import { generateCommitMessageChain } from '../../chain/chainThinking';

import { logger } from '../../logger';
import { stageNotifications } from '../../../ui/StageNotificationManager';
import { GeminiUtils } from './utils/GeminiUtils.js';
import { LLMAnalysisResponse, AnalysisPromptParts } from '../../analysis/analysisTypes';
import {
    GeminiCommitMessageSchema,
    GeminiRepoAnalysisSchema,
    GeminiFileSummarySchema,
    GeminiClassifyAndDraftSchema,
    GeminiValidateAndFixSchema,
} from './schemas/geminiSchemas';

import {
    // Shared Zod schemas used to check structured output
    commitMessageSchema,
    repoAnalysisResponseSchema,
    fileSummarySchema,
    classifyAndDraftResponseSchema,
    validateAndFixResponseSchema
} from "./schemas/common";

const SECRET_GEMINI_API_KEY = 'gitCommitGenie.secret.geminiApiKey';

/**
 * Google Gemini service implementation using @google/genai
 */
export class GeminiService extends BaseLLMService {
    private client: any | null = null;
    protected context: vscode.ExtensionContext;
    private utils: GeminiUtils;

    constructor(context: vscode.ExtensionContext, templateService: TemplateService, analysisService?: any) {
        super(context, templateService, analysisService);
        this.context = context;
        this.utils = new GeminiUtils(context);
        this.refreshFromSettings();
    }

    public async refreshFromSettings(): Promise<void> {
        const apiKey = await this.context.secrets.get(SECRET_GEMINI_API_KEY);
        this.client = apiKey ? new GoogleGenAI({ apiKey }) : null;
    }

    public async validateApiKeyAndListModels(apiKey: string): Promise<string[]> {
        const preferred = this.listSupportedModels();
        try {
            const client = new GoogleGenAI({ apiKey });
            await this.utils.validateApiKey(client, preferred[0], 'Gemini');
            return preferred;
        } catch (err: any) {
            throw new Error(err?.message || 'Failed to validate Gemini API key.');
        }
    }

    public listSupportedModels(): string[] {
        return [
            'gemini-2.5-flash',
            'gemini-2.5-pro'
        ];
    }

    public async setApiKey(apiKey: string): Promise<void> {
        await this.context.secrets.store(SECRET_GEMINI_API_KEY, apiKey);
        await this.refreshFromSettings();
    }

    public async clearApiKey(): Promise<void> {
        await this.context.secrets.delete(SECRET_GEMINI_API_KEY);
        this.client = null;
    }

    /**
     * Get Gemini-specific configuration
     */
    private getConfig() {
        const commonConfig = this.utils.getCommonConfig();
        return {
            ...commonConfig,
            model: this.context.globalState.get<string>('gitCommitGenie.geminiModel', '')
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
     * Generate repository analysis using structured output
     */
    async generateRepoAnalysis(
        analysisPromptParts: AnalysisPromptParts,
        options?: { token?: vscode.CancellationToken }
    ): Promise<LLMAnalysisResponse | LLMError> {
        const config = { ...this.getConfig(), model: this.getRepoAnalysisOverrideModel() || this.getConfig().model };
        const repoPath = this.getRepoPathForLogging();

        if (!config.model) {
            return { message: 'Gemini model is not selected. Please configure it via Manage Models.', statusCode: 400 };
        }

        if (!this.client) {
            return { message: 'Gemini API key is not set or SDK unavailable.', statusCode: 401 };
        }

        try {
            const response = await this.utils.callChatCompletion(
                this.client,
                [analysisPromptParts.system, analysisPromptParts.user],
                {
                    model: config.model,
                    provider: 'Gemini',
                    responseSchema: GeminiRepoAnalysisSchema,
                    token: options?.token,
                    trackUsage: true,
                    maxTokens: 2048
                }
            );

            if (response.usage) {
                logger.usageSummary(repoPath, 'Gemini', [response.usage], config.model, 'RepoAnalysis');
            } else {
                logger.usageSummary(repoPath, 'Gemini', [], config.model, 'RepoAnalysis');
            }

            const safe = repoAnalysisResponseSchema.safeParse(response.parsedResponse);
            if (!safe.success) {
                return { message: 'Failed to validate structured response from Gemini.', statusCode: 500 };
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
                message: error?.message || 'An unknown error occurred with the Gemini API.',
                statusCode: error?.status,
            };
        }
    }



    async generateCommitMessage(diffs: DiffData[], options?: GenerateCommitMessageOptions): Promise<LLMResponse | LLMError> {
        if (!this.client) {
            return { message: 'Gemini API key is not set or SDK unavailable.', statusCode: 401 };
        }

        try {
            const config = this.getConfig();
            const rules = this.utils.getRules();
            const repoPath = this.getRepoPathForLogging(options?.targetRepo);

            if (!config.model) {
                return { message: 'Gemini model is not selected. Please configure it via Manage Models.', statusCode: 400 };
            }

            const jsonMessage = await this.buildJsonMessage(diffs, options?.targetRepo);

            if (config.useChain) {
                return await this.generateThinking(diffs, jsonMessage, config, rules, repoPath, options);
            }

            return await this.generateDefault(jsonMessage, config, rules, repoPath, options);
        } catch (error: any) {
            return {
                message: error?.message || 'An unknown error occurred with the Gemini API.',
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
            // Map request type to schema
            const schemaMap: Record<string, any> = {
                summary: GeminiFileSummarySchema,
                draft: GeminiClassifyAndDraftSchema,
                fix: GeminiValidateAndFixSchema,
                commitMessage: GeminiCommitMessageSchema,
                strictFix: GeminiCommitMessageSchema,
                enforceLanguage: GeminiCommitMessageSchema,
            };

            const schemaMapValidation: Record<string, any> = {
                summary: fileSummarySchema,
                draft: classifyAndDraftResponseSchema,
                fix: validateAndFixResponseSchema,
                commitMessage: commitMessageSchema,
                strictFix: commitMessageSchema,
                enforceLanguage: commitMessageSchema,
            };

            const schema = reqType ? schemaMap[reqType] : undefined;
            const retries = config.maxRetries ?? 2;
            const totalAttempts = Math.max(1, retries + 1);

            for (let attempt = 0; attempt < totalAttempts; attempt++) {
                const result = await this.utils.callChatCompletion(this.client!, messages, {
                    model: config.model,
                    provider: 'Gemini',
                    responseSchema: schema,
                    token: options?.token,
                    trackUsage: true
                });

                callCount += 1;
                if (result.usage) {
                    usages.push(result.usage);
                    logger.usage(repoPath, 'Gemini', result.usage, config.model, labelFor(reqType), callCount);
                } else {
                    logger.usage(repoPath, 'Gemini', undefined, config.model, labelFor(reqType), callCount);
                }

                // Validate structured output if schema is defined
                const validationSchema = reqType ? schemaMapValidation[reqType] : undefined;

                if (validationSchema) {
                    const safe = validationSchema.safeParse(result.parsedResponse);
                    if (safe.success) {
                        return safe.data;
                    }

                    if (attempt < totalAttempts - 1) {
                        logger.warn(`[Genie][Gemini] Schema validation failed for ${reqType} (attempt ${attempt + 1}/${totalAttempts}). Retrying...`);
                        continue;
                    }

                    throw new Error(`Gemini structured result failed local validation for ${reqType} after ${totalAttempts} attempts`);
                }

                // Fallback: return raw data
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
            logger.usageSummary(repoPath, 'Gemini', usages, config.model, 'thinking', undefined, false);
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

        for (let attempt = 0; attempt < totalAttempts; attempt++) {
            const result = await this.utils.callChatCompletion(
                this.client!,
                [
                    { role: 'system', content: rules.baseRule },
                    { role: 'user', content: jsonMessage }
                ],
                {
                    model: config.model,
                    provider: 'Gemini',
                    responseSchema: GeminiCommitMessageSchema,
                    token: options?.token,
                    trackUsage: true
                }
            );

            if (result.usage) {
                logger.usageSummary(repoPath, 'Gemini', [result.usage], config.model, 'default');
            } else {
                logger.usageSummary(repoPath, 'Gemini', [], config.model, 'default');
            }

            const safe = commitMessageSchema.safeParse(result.parsedResponse);
            if (safe.success) {
                return { content: safe.data.commitMessage };
            }

            lastError = safe.error;
            if (attempt < totalAttempts - 1) {
                logger.warn(`[Genie][Gemini] Schema validation failed (attempt ${attempt + 1}/${totalAttempts}). Retrying...`);
            }
        }

        return { message: 'Failed to validate structured commit message from Gemini.', statusCode: 500 };
    }
}
