import * as vscode from 'vscode';
import { DiffService } from '../services/git/diff';
import { OpenAIService } from '../services/llm/providers/openai';
import { DeepSeekService } from '../services/llm/providers/deepseek';
import { AnthropicService } from '../services/llm/providers/anthropic';
import { GeminiService } from '../services/llm/providers/gemini';
import { TemplateService } from '../template/templateService';
import { RepositoryAnalysisService } from '../services/analysis';
import { LLMService } from '../services/llm/llmTypes';
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

    constructor(private context: vscode.ExtensionContext) {
        this.llmServices = new Map();
    }

    async initialize(): Promise<void> {
        try {
            logger.info('Initializing services...');

            // Initialize basic services
            this.diffService = new DiffService();
            this.templateService = new TemplateService(this.context);

            // Initialize repository analysis service with placeholder LLM service
            this.analysisService = new RepositoryAnalysisService(this.context, null as any);

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
}