import * as vscode from 'vscode';
import { DiffService } from '../services/git/diff';
import { OpenAIService } from '../services/llm/providers/openai';
import { DeepSeekService } from '../services/llm/providers/deepseek';
import { AnthropicService } from '../services/llm/providers/anthropic';
import { GeminiService } from '../services/llm/providers/gemini';
import { TemplateService } from '../template/templateService';
import { RepositoryAnalysisService } from '../services/analysis';
import { LLMService } from '../services/llm/llmTypes';
import { RepoService } from "../services/repo/repo";
import { logger } from '../services/logger';

export class ServiceRegistry {
    private diffService!: DiffService;
    private templateService!: TemplateService;
    private analysisService!: RepositoryAnalysisService;
    private openAIService!: OpenAIService;
    private deepseekService!: DeepSeekService;
    private anthropicService!: AnthropicService;
    private geminiService!: GeminiService;
    private llmServices: Map<string, LLMService>;
    private currentLLMService!: LLMService;
    private repoService!: RepoService;

    constructor(private context: vscode.ExtensionContext) {
        this.llmServices = new Map();
    }

    async initialize(): Promise<void> {
        try {
            logger.info('Initializing services...');

            // Initialize basic services
            this.repoService = new RepoService();
            this.diffService = new DiffService(this.repoService);
            this.templateService = new TemplateService(this.context);

            // Initialize repository analysis service with placeholder LLM service
            this.analysisService = new RepositoryAnalysisService(this.context, null as any, this.repoService);

            // Initialize LLM services
            this.openAIService = new OpenAIService(this.context, this.templateService, this.analysisService);
            this.deepseekService = new DeepSeekService(this.context, this.templateService, this.analysisService);
            this.anthropicService = new AnthropicService(this.context, this.templateService, this.analysisService);
            this.geminiService = new GeminiService(this.context, this.templateService, this.analysisService);

            // Setup LLM services map
            this.llmServices.set('openai', this.openAIService);
            this.llmServices.set('deepseek', this.deepseekService);
            this.llmServices.set('anthropic', this.anthropicService);
            this.llmServices.set('gemini', this.geminiService);

            // Set initial LLM service
            this.currentLLMService = this.pickService();
            this.analysisService.setLLMService(this.currentLLMService);
            // Provide resolver so analysis can pick provider based on setting
            this.analysisService.setLLMResolver((provider: string) => this.llmServices.get(provider));

            // Keep in-memory provider clients in sync with SecretStorage changes
            const secretDisp = this.context.secrets.onDidChange(async (e) => {
                try {
                    const key = e?.key || '';
                    if (!key.startsWith('gitCommitGenie.secret.')) { return; }
                    const provider = this.secretKeyToProvider(key);
                    if (!provider) { return; }
                    const svc = this.llmServices.get(provider);
                    await svc?.refreshFromSettings();
                    // Update current service mapping (no provider switch here)
                    this.updateCurrentLLMService();
                    // Refresh status bar
                    await (vscode.commands.executeCommand('git-commit-genie.updateStatusBar'));
                } catch { /* ignore */ }
            });
            try {
                (this.context.subscriptions || []).push(secretDisp);
            } catch { /* ignore */ }

            logger.info('Services initialized successfully');
        } catch (error) {
            logger.error('Error initializing services:', error);
            throw error;
        }
    }

    async dispose(): Promise<void> {
        // Cleanup services if needed
    }

    // Service getters
    getDiffService(): DiffService {
        return this.diffService;
    }

    getTemplateService(): TemplateService {
        return this.templateService;
    }

    getAnalysisService(): RepositoryAnalysisService {
        return this.analysisService;
    }

    getCurrentLLMService(): LLMService {
        return this.currentLLMService;
    }

    getLLMService(provider: string): LLMService | undefined {
        return this.llmServices.get(provider);
    }

    getRepoService(): RepoService {
        return this.repoService;
    }

    // Provider and model management
    getProvider(): string {
        return this.context.globalState.get<string>('gitCommitGenie.provider', 'openai');
    }

    getModel(provider: string): string {
        switch (provider) {
            case 'deepseek':
                return this.context.globalState.get<string>('gitCommitGenie.deepseekModel', '');
            case 'anthropic':
                return this.context.globalState.get<string>('gitCommitGenie.anthropicModel', '');
            case 'gemini':
                return this.context.globalState.get<string>('gitCommitGenie.geminiModel', '');
            default:
                return this.context.globalState.get<string>('gitCommitGenie.openaiModel', '');
        }
    }

    pickService(): LLMService {
        const provider = this.getProvider();
        const service = this.llmServices.get(provider || 'openai') || this.openAIService;
        return service;
    }

    updateCurrentLLMService(): void {
        this.currentLLMService = this.pickService();
        this.analysisService.setLLMService(this.currentLLMService);
    }

    private secretKeyToProvider(secretKey: string): string | null {
        if (secretKey.endsWith('.openaiApiKey')) { return 'openai'; }
        if (secretKey.endsWith('.deepseekApiKey')) { return 'deepseek'; }
        if (secretKey.endsWith('.anthropicApiKey')) { return 'anthropic'; }
        if (secretKey.endsWith('.geminiApiKey')) { return 'gemini'; }
        return null;
    }
}
