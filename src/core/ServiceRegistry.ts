import * as vscode from 'vscode';
import {
    AI_MODELS_KEY,
    GENERATION_MODEL_ID_KEY,
    AIModelConfig,
    modelSecretKey,
} from '../services/llm/providers';
import { DiffService } from '../services/git/diff';
import { TemplateService } from '../template/templateService';
import { LLMService } from '../services/llm/llmTypes';
import { UnifiedLLMService } from '../services/llm/unifiedLLMService';
import { migrateAIConfiguration } from '../services/llm/configMigration';
import { RepoService } from '../services/repo/repo';
import { CostTrackingService } from '../services/cost/costTrackingService';
import { logger } from '../services/logger';
import { RagRuntimeService } from '../services/rag/ragRuntimeService';
import { RagHistoricalIndexService } from '../services/rag/ragHistoricalIndexService';
import { RagRetrievalService } from '../services/rag/ragRetrievalService';
import { RepositoryMemoryService } from '../services/memory/service';

export class ServiceRegistry {
    private diffService!: DiffService;
    private templateService!: TemplateService;
    private readonly llmServices = new Map<string, UnifiedLLMService>();
    private currentLLMService?: UnifiedLLMService;
    private repoService!: RepoService;
    private costTrackingService!: CostTrackingService;
    private ragRuntimeService!: RagRuntimeService;
    private ragHistoricalIndexService!: RagHistoricalIndexService;
    private ragRetrievalService!: RagRetrievalService;
    private memoryService!: RepositoryMemoryService;

    constructor(private readonly context: vscode.ExtensionContext) {}

    async initialize(): Promise<void> {
        logger.info('Initializing services...');
        await migrateAIConfiguration(this.context);

        this.repoService = new RepoService();
        this.memoryService = new RepositoryMemoryService(this.context);
        this.diffService = new DiffService(this.repoService);
        this.templateService = new TemplateService(this.context);
        this.costTrackingService = new CostTrackingService(this.context);
        this.ragRuntimeService = new RagRuntimeService(this.context, this.repoService);
        this.ragHistoricalIndexService = new RagHistoricalIndexService(this.repoService, this.ragRuntimeService);
        this.ragRetrievalService = new RagRetrievalService(this.context, this.repoService);
        this.ragRuntimeService.setBackgroundEnsureCallback(reason => this.ragHistoricalIndexService.ensureAllRepositoriesIndexed(reason));

        await this.reloadProviderServices();
        this.updateCurrentLLMService();
        if (!this.currentLLMService) {
            logger.warn('No active AI model is configured. Model management remains available.');
        }

        await this.ragRuntimeService.initialize();
        await this.ragRuntimeService.refreshFromSettings();
        const secretDisposable = this.context.secrets.onDidChange(async event => {
            if (!event.key.startsWith('gitCommitGenie.secret.ai.')) {
                return;
            }
            const services = this.servicesForSecret(event.key);
            if (!services.length) {
                throw new Error(`No AI service owns changed secret '${event.key}'.`);
            }
            await Promise.all(services.map(service => service.refreshFromSettings()));
            this.updateCurrentLLMService();
            await vscode.commands.executeCommand('git-commit-genie.updateStatusBar');
        });
        this.context.subscriptions.push(secretDisposable);
        logger.info('Services initialized successfully');
    }

    async reloadProviderServices(): Promise<void> {
        this.llmServices.clear();
        for (const model of this.getModels()) {
            const service = new UnifiedLLMService(
                this.context,
                this.templateService,
                { model, costTracker: this.costTrackingService },
            );
            await service.refreshFromSettings();
            this.llmServices.set(model.id, service);
        }
    }

    async dispose(): Promise<void> {
        this.memoryService?.dispose();
        await this.ragRuntimeService?.dispose();
    }

    getDiffService(): DiffService { return this.diffService; }
    getMemoryService(): RepositoryMemoryService { return this.memoryService; }
    getTemplateService(): TemplateService { return this.templateService; }
    getCurrentLLMService(): LLMService {
        if (!this.currentLLMService) {
            throw new Error('No active AI model is configured. Select a model with Git Commit Genie: Manage Models.');
        }
        return this.currentLLMService;
    }
    getRepoService(): RepoService { return this.repoService; }
    getCostTrackingService(): CostTrackingService { return this.costTrackingService; }
    getRagRuntimeService(): RagRuntimeService { return this.ragRuntimeService; }
    getRagHistoricalIndexService(): RagHistoricalIndexService { return this.ragHistoricalIndexService; }
    getRagRetrievalService(): RagRetrievalService { return this.ragRetrievalService; }

    getModels(): AIModelConfig[] {
        const models = this.context.globalState.get<AIModelConfig[]>(AI_MODELS_KEY, []);
        if (!Array.isArray(models)) {
            throw new Error('AI model configuration is not an array.');
        }
        return models;
    }

    getModel(modelId: string): AIModelConfig | undefined {
        return this.getModels().find(model => model.id === modelId);
    }

    getGenerationModelId(): string {
        return this.context.globalState.get<string>(GENERATION_MODEL_ID_KEY, '');
    }

    getGenerationModel(): AIModelConfig | undefined {
        return this.getModel(this.getGenerationModelId());
    }

    requireGenerationModel(): AIModelConfig {
        const id = this.getGenerationModelId();
        const model = this.getModel(id);
        if (!model) {
            throw new Error(`Commit message model '${id}' is not configured.`);
        }
        return model;
    }

    getLLMService(modelId: string): UnifiedLLMService | undefined {
        return this.llmServices.get(modelId);
    }

    pickService(): UnifiedLLMService {
        const modelId = this.getGenerationModelId();
        const service = this.getLLMService(modelId);
        if (!service) {
            throw new Error(`AI model service '${modelId}' is not configured.`);
        }
        return service;
    }

    updateCurrentLLMService(): void {
        const service = this.getLLMService(this.getGenerationModelId());
        this.currentLLMService = service;
    }

    private servicesForSecret(secretKey: string): UnifiedLLMService[] {
        return this.getModels()
            .filter(model => modelSecretKey(model) === secretKey)
            .map(model => this.llmServices.get(model.id))
            .filter((service): service is UnifiedLLMService => service !== undefined);
    }
}
