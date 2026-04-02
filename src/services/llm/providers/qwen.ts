import * as vscode from 'vscode';
import OpenAI from 'openai';
import { TemplateService } from '../../../template/templateService';
import { IRepositoryAnalysisService } from '../../analysis/analysisTypes';
import { logger } from '../../logger';
import { OpenAIChatCompletionsService } from './openaiChatCompletionsService';

const QWEN_API_URL_CHINA = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const QWEN_API_URL_INTL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const SECRET_QWEN_API_KEY_CHINA = 'gitCommitGenie.secret.qwenApiKeyChina';
const SECRET_QWEN_API_KEY_INTL = 'gitCommitGenie.secret.qwenApiKeyIntl';
const QWEN_REGION_KEY = 'gitCommitGenie.qwenRegion';

/**
 * Alibaba Qwen LLM service implementation using OpenAI-compatible chat completions.
 * Supports both China and International regions.
 */
export class QwenService extends OpenAIChatCompletionsService {
    constructor(context: vscode.ExtensionContext, templateService: TemplateService, analysisService?: IRepositoryAnalysisService) {
        super(context, templateService, analysisService, {
            providerName: 'Qwen',
            modelStateKey: 'gitCommitGenie.qwenModel',
            secretKey: SECRET_QWEN_API_KEY_INTL,
            baseURL: QWEN_API_URL_INTL
        });
    }

    private getApiUrl(region?: string): string {
        const resolved = region || this.context.globalState.get<string>(QWEN_REGION_KEY, 'intl');
        return resolved === 'china' ? QWEN_API_URL_CHINA : QWEN_API_URL_INTL;
    }

    protected getSecretStorageKey(): string {
        const region = this.context.globalState.get<string>(QWEN_REGION_KEY, 'intl');
        return region === 'china' ? SECRET_QWEN_API_KEY_CHINA : SECRET_QWEN_API_KEY_INTL;
    }

    protected createClient(apiKey: string, baseURL?: string): OpenAI {
        return new OpenAI({ apiKey, baseURL: baseURL || this.getApiUrl() });
    }

    /**
     * Get current region setting (for pricing and logging).
     */
    public getRegion(): 'china' | 'intl' {
        return this.context.globalState.get<string>(QWEN_REGION_KEY, 'intl') as 'china' | 'intl';
    }

    protected getUsageLoggerRegion(): string | undefined {
        return this.getRegion();
    }

    public async refreshFromSettings(): Promise<void> {
        const currentRegion = this.context.globalState.get<string>(QWEN_REGION_KEY, 'intl');
        let apiKey = await this.context.secrets.get(this.getSecretStorageKey());

        if (!apiKey) {
            const otherRegion = currentRegion === 'china' ? 'intl' : 'china';
            const otherSecretKey = otherRegion === 'china' ? SECRET_QWEN_API_KEY_CHINA : SECRET_QWEN_API_KEY_INTL;
            const otherKey = await this.context.secrets.get(otherSecretKey);

            if (otherKey) {
                apiKey = otherKey;
                await this.context.globalState.update(QWEN_REGION_KEY, otherRegion);
                logger.info(`[Genie][Qwen] Automatically switched from ${currentRegion} to ${otherRegion} region`);
            }
        }

        this.openai = apiKey ? this.createClient(apiKey) : null;
    }

    /**
     * Validate an API key and list Qwen models for a selected region.
     */
    public async validateApiKeyAndListModels(apiKey: string): Promise<string[]>;
    public async validateApiKeyAndListModels(apiKey: string, region: string): Promise<string[]>;
    public async validateApiKeyAndListModels(apiKey: string, region?: string): Promise<string[]> {
        const preferred = this.listSupportedModels();
        const apiUrl = this.getApiUrl(region || 'intl');
        try {
            const client = this.createClient(apiKey, apiUrl);
            return await this.validateAndListModels(client, preferred);
        } catch (err: any) {
            throw new Error(err?.message || 'Failed to validate Qwen API key.');
        }
    }

    public listSupportedModels(): string[] {
        return [
            'qwen3-max',
            'qwen3-max-preview',
            'qwen3.5-plus',
            'qwen-plus',
            'qwen-plus-latest',
            'qwen3-coder-plus',
            'qwen-flash',
            'qwen3-coder-flash'
        ];
    }
}
