import * as vscode from 'vscode';
import OpenAI from 'openai';
import { TemplateService } from '../../../template/templateService';
import { IRepositoryAnalysisService } from '../../analysis/analysisTypes';
import { OpenAIChatCompletionsService } from './openaiChatCompletionsService';

const LOCAL_DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1';
const LOCAL_MODELS_CACHE_KEY = 'gitCommitGenie.localModelsCache';

/**
 * Local OpenAI-compatible provider implementation.
 */
export class LocalService extends OpenAIChatCompletionsService {
    constructor(context: vscode.ExtensionContext, templateService: TemplateService, analysisService?: IRepositoryAnalysisService) {
        super(context, templateService, analysisService, {
            providerName: 'Local',
            modelStateKey: 'gitCommitGenie.localModel',
            secretKey: 'gitCommitGenie.secret.localApiKey',
            baseURL: LOCAL_DEFAULT_BASE_URL
        });
    }

    public listSupportedModels(): string[] {
        const cached = this.context.globalState.get<string[]>(LOCAL_MODELS_CACHE_KEY, []);
        return Array.isArray(cached) ? cached : [];
    }

    protected createClient(apiKey: string, baseURL?: string): OpenAI {
        return new OpenAI({
            apiKey,
            baseURL: baseURL || this.getConfiguredBaseUrl()
        });
    }

    public async refreshFromSettings(): Promise<void> {
        const apiKey = await this.context.secrets.get(this.getSecretStorageKey());
        this.openai = apiKey ? this.createClient(apiKey) : null;
    }

    public async validateApiKeyAndListModels(apiKey: string): Promise<string[]> {
        try {
            const client = this.createClient(apiKey);
            const list = await client.models.list();
            const ids = (list.data || [])
                .map((model: any) => String(model?.id || '').trim())
                .filter((id: string) => id.length > 0);

            const unique = Array.from(new Set(ids));
            if (!unique.length) {
                throw new Error('No models returned by local endpoint.');
            }

            await this.context.globalState.update(LOCAL_MODELS_CACHE_KEY, unique);
            return unique;
        } catch (err: any) {
            throw new Error(err?.message || 'Failed to list models from local endpoint.');
        }
    }

    private getConfiguredBaseUrl(): string {
        const cfg = vscode.workspace.getConfiguration('gitCommitGenie');
        const baseUrl = (cfg.get<string>('local.baseUrl', LOCAL_DEFAULT_BASE_URL) || '').trim();

        if (!baseUrl) {
            throw new Error('Local base URL is not configured.');
        }

        let parsed: URL;
        try {
            parsed = new URL(baseUrl);
        } catch {
            throw new Error('Local base URL is invalid. Expected format: http://127.0.0.1:11434/v1');
        }

        if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.pathname.endsWith('/v1')) {
            throw new Error('Local base URL must use OpenAI-compatible base path ending with /v1.');
        }

        return baseUrl;
    }
}