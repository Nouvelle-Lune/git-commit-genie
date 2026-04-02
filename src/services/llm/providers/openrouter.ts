import * as vscode from 'vscode';
import OpenAI from 'openai';
import { TemplateService } from '../../../template/templateService';
import { IRepositoryAnalysisService } from '../../analysis/analysisTypes';
import { OpenAIChatCompletionsService } from './openaiChatCompletionsService';
import { getOpenRouterModelIds } from './config/openrouterModels';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1';

/**
 * OpenRouter provider implementation via OpenAI-compatible chat completions.
 * Model availability is constrained to the static curated mapping registry.
 */
export class OpenRouterService extends OpenAIChatCompletionsService {
    constructor(context: vscode.ExtensionContext, templateService: TemplateService, analysisService?: IRepositoryAnalysisService) {
        super(context, templateService, analysisService, {
            providerName: 'OpenRouter',
            modelStateKey: 'gitCommitGenie.openrouterModel',
            secretKey: 'gitCommitGenie.secret.openrouterApiKey',
            baseURL: OPENROUTER_API_URL
        });
    }

    protected createClient(apiKey: string, baseURL?: string): OpenAI {
        return new OpenAI({
            apiKey,
            baseURL: baseURL || OPENROUTER_API_URL,
            defaultHeaders: {
                'HTTP-Referer': 'https://github.com/Nouvelle-Lune/git-commit-genie',
                'X-Title': 'Git Commit Genie'
            }
        });
    }

    public listSupportedModels(): string[] {
        return getOpenRouterModelIds();
    }

    /**
     * Validate API key and return the intersection between OpenRouter account models
     * and our curated static mapping list. If list API fails, fall back to static list.
     */
    public async validateApiKeyAndListModels(apiKey: string): Promise<string[]> {
        const preferred = this.listSupportedModels();
        const client = this.createClient(apiKey);
        try {
            const list = await client.models.list();
            const ids = list.data?.map(m => (m as any).id) || [];
            const available = preferred.filter(id => ids.includes(id));
            return available.length ? available : preferred;
        } catch (err: any) {
            const code = err?.status || err?.statusCode || err?.code;
            if (code === 401 || code === 403) {
                throw new Error(err?.message || 'Failed to validate OpenRouter API key.');
            }
            return preferred;
        }
    }
}
