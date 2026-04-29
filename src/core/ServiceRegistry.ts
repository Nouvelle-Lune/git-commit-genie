import * as vscode from 'vscode';
import { DiffService } from '../services/git/diff';
import { OpenAIService } from '../services/llm/providers/openai';
import { DeepSeekService } from '../services/llm/providers/deepseek';
import { AnthropicService, ANTHROPIC_DATED_TO_UNDATED_MAP } from '../services/llm/providers/anthropic';
import { GeminiService } from '../services/llm/providers/gemini';
import { QwenService } from '../services/llm/providers/qwen';
import { GLMService } from '../services/llm/providers/glm';
import { KimiService } from '../services/llm/providers/kimi';
import { OpenRouterService } from '../services/llm/providers/openrouter';
import { LocalService } from '../services/llm/providers/local';
import { TemplateService } from '../template/templateService';
import { RepositoryAnalysisService } from '../services/analysis';
import { LLMService } from '../services/llm/llmTypes';
import { RepoService } from "../services/repo/repo";
import { CostTrackingService } from "../services/cost/costTrackingService";
import { logger } from '../services/logger';
import { getProviderModelStateKey, getProviderFromSecretKey, QWEN_REGIONS } from '../services/llm/providers/config/ProviderConfig';
import { RagRuntimeService } from '../services/rag/ragRuntimeService';
import { RagHistoricalIndexService } from '../services/rag/ragHistoricalIndexService';
import { RagRetrievalService } from '../services/rag/ragRetrievalService';

export class ServiceRegistry {
    private diffService!: DiffService;
    private templateService!: TemplateService;
    private analysisService!: RepositoryAnalysisService;
    private openAIService!: OpenAIService;
    private deepseekService!: DeepSeekService;
    private anthropicService!: AnthropicService;
    private geminiService!: GeminiService;
    private qwenService!: QwenService;
    private glmService!: GLMService;
    private kimiService!: KimiService;
    private openrouterService!: OpenRouterService;
    private localService!: LocalService;
    private llmServices: Map<string, LLMService>;
    private currentLLMService!: LLMService;
    private repoService!: RepoService;
    private costTrackingService!: CostTrackingService;
    private ragRuntimeService!: RagRuntimeService;
    private ragHistoricalIndexService!: RagHistoricalIndexService;
    private ragRetrievalService!: RagRetrievalService;

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
            this.costTrackingService = new CostTrackingService(this.context);
            this.ragRuntimeService = new RagRuntimeService(this.context, this.repoService);
            this.ragHistoricalIndexService = new RagHistoricalIndexService(
                this.repoService,
                this.ragRuntimeService,
            );
            this.ragRetrievalService = new RagRetrievalService(this.context, this.repoService);
            this.ragRuntimeService.setBackgroundEnsureCallback((reason: string) =>
                this.ragHistoricalIndexService.ensureAllRepositoriesIndexed(reason)
            );

            logger.setCostTracker(this.costTrackingService);

            // Initialize repository analysis service. The LLM service is wired
            // in below once provider services have been constructed; analysis
            // calls before then are guarded by an internal null-check.
            this.analysisService = new RepositoryAnalysisService(this.context, null, this.repoService);

            // Initialize LLM services
            this.openAIService = new OpenAIService(this.context, this.templateService, this.analysisService);
            this.deepseekService = new DeepSeekService(this.context, this.templateService, this.analysisService);
            this.anthropicService = new AnthropicService(this.context, this.templateService, this.analysisService);
            this.geminiService = new GeminiService(this.context, this.templateService, this.analysisService);
            this.qwenService = new QwenService(this.context, this.templateService, this.analysisService);
            this.glmService = new GLMService(this.context, this.templateService, this.analysisService);
            this.kimiService = new KimiService(this.context, this.templateService, this.analysisService);
            this.openrouterService = new OpenRouterService(this.context, this.templateService, this.analysisService);
            this.localService = new LocalService(this.context, this.templateService, this.analysisService);
            // Setup LLM services map
            this.llmServices.set('openai', this.openAIService);
            this.llmServices.set('deepseek', this.deepseekService);
            this.llmServices.set('anthropic', this.anthropicService);
            this.llmServices.set('gemini', this.geminiService);
            this.llmServices.set('qwen', this.qwenService);
            this.llmServices.set('glm', this.glmService);
            this.llmServices.set('kimi', this.kimiService);
            this.llmServices.set('openrouter', this.openrouterService);
            this.llmServices.set('local', this.localService);

            // Migrate stale model selections (e.g., removed/unsupported models after extension updates)
            await this.migrateUnsupportedModelSelections();

            // Set initial LLM service
            this.currentLLMService = this.pickService();
            this.analysisService.setLLMService(this.currentLLMService);
            // Provide resolver so analysis can pick provider based on setting
            this.analysisService.setLLMResolver((provider: string) => this.llmServices.get(provider));
            await this.ragRuntimeService.initialize();
            await this.ragRuntimeService.refreshFromSettings();

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
        try {
            await this.ragRuntimeService?.dispose();
        } catch (error) {
            logger.warn('[Genie][RAG] Failed to dispose runtime service', error as any);
        }
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

    getCostTrackingService(): CostTrackingService {
        return this.costTrackingService;
    }

    getRagRuntimeService(): RagRuntimeService {
        return this.ragRuntimeService;
    }

    getRagHistoricalIndexService(): RagHistoricalIndexService {
        return this.ragHistoricalIndexService;
    }

    getRagRetrievalService(): RagRetrievalService {
        return this.ragRetrievalService;
    }

    // Provider and model management
    getProvider(): string {
        return this.context.globalState.get<string>('gitCommitGenie.provider', 'openai');
    }

    getModel(provider: string): string {
        const modelKey = getProviderModelStateKey(provider);
        return this.context.globalState.get<string>(modelKey, '');
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
        // Check Qwen regional keys first
        for (const regionConfig of Object.values(QWEN_REGIONS)) {
            if (secretKey === regionConfig.secretKey) {
                return 'qwen';
            }
        }
        return getProviderFromSecretKey(secretKey);
    }

    private getPreferredFallbackModel(provider: string, supportedModels: string[]): string {
        if (!supportedModels.length) {
            return '';
        }

        const preferredByProvider: Record<string, string[]> = {
            openai: ['gpt-5.4-mini', 'gpt-5.4', 'gpt-5.4-nano', 'gpt-5-mini', 'gpt-5', 'gpt-5.2', 'gpt-5-nano'],
            deepseek: ['deepseek-v4-flash', 'deepseek-v4-pro'],
            anthropic: ['claude-sonnet-4-6'],
            gemini: ['gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-pro-preview'],
            qwen: ['qwen3.5-plus', 'qwen3.5-flash', 'qwen-plus-latest', 'qwen-plus', 'qwen3-max-preview', 'qwen3-max'],
            glm: ['glm-5-turbo', 'glm-5', 'glm-4.7', 'glm-4.5', 'glm-4.7-flashx', 'glm-4.5-air', 'glm-4.7-flash'],
            kimi: ['kimi-k2.5', 'kimi-k2-thinking', 'kimi-k2'],
            openrouter: ['openai/gpt-5.4-mini', 'openai/gpt-5.4', 'openai/gpt-5-mini', 'anthropic/claude-sonnet-4.6', 'deepseek/deepseek-v4-flash'],
            local: []
        };

        const preferred = preferredByProvider[provider.toLowerCase()] || [];
        for (const candidate of preferred) {
            if (supportedModels.includes(candidate)) {
                return candidate;
            }
        }

        return supportedModels[0];
    }

    private async migrateUnsupportedModelSelections(): Promise<void> {
        const migrated: string[] = [];

        for (const [provider, service] of this.llmServices.entries()) {
            const modelKey = getProviderModelStateKey(provider);
            let selected = (this.context.globalState.get<string>(modelKey, '') || '').trim();
            if (!selected) {
                continue;
            }

            // Normalize dated Anthropic model names to undated aliases
            const normalized = ANTHROPIC_DATED_TO_UNDATED_MAP[selected];
            if (normalized) {
                await this.context.globalState.update(modelKey, normalized);
                selected = normalized;
            }

            const supported = service.listSupportedModels();
            if (!supported.length || supported.includes(selected)) {
                continue;
            }

            const fallback = this.getPreferredFallbackModel(provider, supported);
            if (!fallback) {
                continue;
            }

            await this.context.globalState.update(modelKey, fallback);
            migrated.push(`${provider}: ${selected} -> ${fallback}`);
            logger.warn(`[Genie][ModelMigration] Migrated unsupported ${provider} model '${selected}' to '${fallback}'.`);
        }

        // Also migrate repository analysis model override if it points to an unsupported model.
        try {
            const cfg = vscode.workspace.getConfiguration('gitCommitGenie.repositoryAnalysis');
            let selected = (cfg.get<string>('model', 'general') || 'general').trim();

            // Normalize dated Anthropic model names to undated aliases
            const repoAnalysisNormalized = ANTHROPIC_DATED_TO_UNDATED_MAP[selected];
            if (repoAnalysisNormalized) {
                await cfg.update('model', repoAnalysisNormalized, vscode.ConfigurationTarget.Global);
                selected = repoAnalysisNormalized;
            }

            if (selected && selected !== 'general') {
                let supportedByAny = false;
                for (const service of this.llmServices.values()) {
                    if (service.listSupportedModels().includes(selected)) {
                        supportedByAny = true;
                        break;
                    }
                }

                if (!supportedByAny) {
                    await cfg.update('model', 'general', vscode.ConfigurationTarget.Global);
                    migrated.push(`repositoryAnalysis: ${selected} -> general`);
                    logger.warn(`[Genie][ModelMigration] Migrated unsupported repository analysis model '${selected}' to 'general'.`);
                }
            }
        } catch (error) {
            logger.warn(`[Genie][ModelMigration] Failed to migrate repository analysis model: ${error}`);
        }

        if (!migrated.length) {
            return;
        }

        const details = migrated.join(', ');
        const actionManage = 'Manage Models';
        const actionDismiss = 'Dismiss';
        void vscode.window.showWarningMessage(
            `Git Commit Genie migrated unsupported model selections after update: ${details}.`,
            actionManage,
            actionDismiss
        ).then(async (choice) => {
            if (choice === actionManage) {
                try {
                    await vscode.commands.executeCommand('git-commit-genie.manageModels');
                } catch {
                    // Ignore command execution failures during startup race conditions.
                }
            }
        });
    }
}
