import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ServiceRegistry } from '../core/ServiceRegistry';
import { ConfigurationManager } from '../config/ConfigurationManager';
import { L10N_KEYS as I18N } from '../i18n/keys';
import { GitExtension } from '../services/git/git';
import { RepoService } from '../services/repo/repo';
import { CostTrackingService } from '../services/cost/costTrackingService';
import { logger } from '../services/logger';
import {
    REPOSITORY_ANALYSIS_MODEL_ID_KEY,
    modelSecretKey,
} from '../services/llm/providers';
import {
    ProviderState,
    AnalysisState,
    GitState,
    AnalysisIcon,
    PROVIDER_LABELS
} from './StatusBarTypes';

/**
 * Manages the status bar item for Git Commit Genie
 */
export class StatusBarManager {
    private statusBarItem!: vscode.StatusBarItem;
    private repoService!: RepoService;
    private costTracker: CostTrackingService | null = null;

    // State management
    private providerState: ProviderState = {
        modelId: '',
        label: '',
        provider: null,
        model: '',
        hasApiKey: false
    };

    private analysisState: AnalysisState = {
        enabled: false,
        running: false,
        missing: false,
        modelId: '',
        label: '',
        provider: null,
        model: null,
        hasApiKey: false,
        runningRepoPath: null,
        runningRepoLabel: null
    };

    private gitState: GitState = {
        hasRepo: false,
        repoPath: null,
        repoLabel: ''
    };

    // Event: analysis running state changed
    private readonly _onAnalysisRunningChanged = new vscode.EventEmitter<{ running: boolean; label?: string | null }>();
    public readonly onAnalysisRunningChanged = this._onAnalysisRunningChanged.event;

    constructor(
        private context: vscode.ExtensionContext,
        private serviceRegistry: ServiceRegistry,
        private configManager: ConfigurationManager
    ) { }

    // ========================================
    // Public API
    // ========================================

    async initialize(): Promise<void> {
        this.createStatusBarItem();
        this.initializeServices();
        this.registerEventListeners();

        await this.refreshAllStates();
        await this.validateAnalysisModelApiKey(true);

        await this.updateStatusBar();
    }

    async dispose(): Promise<void> {
        this.statusBarItem?.dispose();
    }

    async refreshModelStates(): Promise<void> {
        await this.updateStatusBar();
    }

    setRepoAnalysisRunning(running: boolean, repoPath?: string): void {
        this.analysisState.running = running;

        if (running && repoPath) {
            // Store the repository being analyzed
            this.analysisState.runningRepoPath = repoPath;
            this.analysisState.runningRepoLabel = path.basename(repoPath);
        } else if (!running) {
            // Clear when analysis finishes
            this.analysisState.runningRepoPath = null;
            this.analysisState.runningRepoLabel = null;
        }

        vscode.commands.executeCommand('setContext', 'gitCommitGenie.analysisRunning', running);
        this.updateStatusBar();
        try { this._onAnalysisRunningChanged.fire({ running, label: this.analysisState.runningRepoLabel }); } catch { /* ignore */ }
    }

    isRepoAnalysisRunning(): boolean {
        return this.analysisState.running;
    }

    hasGitRepository(): boolean {
        return this.gitState.hasRepo;
    }

    isRepoAnalysisMissing(): boolean {
        return this.analysisState.missing;
    }

    // ========================================
    // Initialization
    // ========================================

    private createStatusBarItem(): void {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            -10000
        );
        this.statusBarItem.command = 'git-commit-genie.genieMenu';
        this.context.subscriptions.push(this.statusBarItem);
    }

    private initializeServices(): void {
        this.repoService = this.serviceRegistry.getRepoService();
        this.costTracker = this.serviceRegistry.getCostTrackingService();
    }

    private registerEventListeners(): void {
        this.registerEditorListeners();
        this.registerSecretListeners();
        this.registerWorkspaceListeners();
        this.registerConfigListeners();
        this.registerCostListeners();
        this.registerGitListeners();
    }

    private registerEditorListeners(): void {
        const disposable = vscode.window.onDidChangeActiveTextEditor(() => {
            this.updateStatusBar();
        });
        this.context.subscriptions.push(disposable);
    }

    private registerSecretListeners(): void {
        const disposable = this.context.secrets.onDidChange(async (e) => {
            if (!e?.key?.startsWith('gitCommitGenie.secret.')) {
                return;
            }

            await this.refreshProviderState();
            await this.refreshAnalysisState();
            await this.validateAnalysisModelApiKey(true);
            this.updateStatusBar();
        });
        this.context.subscriptions.push(disposable);
    }

    private registerWorkspaceListeners(): void {
        const disposable = vscode.workspace.onDidChangeWorkspaceFolders(() => {
            this.updateStatusBar();
        });
        this.context.subscriptions.push(disposable);
    }

    private registerConfigListeners(): void {
        const disposable = vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('gitCommitGenie.repositoryAnalysis.enabled')) {
                void this.validateAnalysisModelApiKey(true);
                void this.updateStatusBar();
            }
        });
        this.context.subscriptions.push(disposable);
    }

    private registerCostListeners(): void {
        if (!this.costTracker) {
            return;
        }

        const disposable = this.costTracker.onCostChanged(() => {
            this.updateStatusBar();
        });
        this.context.subscriptions.push({
            dispose: () => (disposable as any)?.dispose?.()
        });
    }

    private registerGitListeners(): void {
        try {
            const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git')?.exports;
            if (!gitExtension) {
                return;
            }

            const api = gitExtension.getAPI(1);

            const openDisposable = api.onDidOpenRepository(() => {
                this.updateStatusBar();
            });
            this.context.subscriptions.push(openDisposable);

            const closeDisposable = api.onDidCloseRepository(() => {
                this.updateStatusBar();
            });
            this.context.subscriptions.push(closeDisposable);
        } catch {
            // Ignore git listener setup errors
        }
    }

    // ========================================
    // State Management
    // ========================================

    private async refreshAllStates(): Promise<void> {
        await this.refreshProviderState();
        await this.refreshGitState();
        await this.refreshAnalysisState();
    }

    private async refreshProviderState(): Promise<void> {
        const selected = this.serviceRegistry.getGenerationModel();
        const key = selected ? await this.context.secrets.get(modelSecretKey(selected)) : undefined;

        this.providerState = {
            modelId: selected?.id ?? '',
            label: selected?.label ?? '',
            provider: selected?.provider ?? null,
            model: selected?.model ?? '',
            hasApiKey: !!(key && key.trim())
        };
    }

    private async refreshGitState(): Promise<void> {
        const hasRepo = this.detectGitRepo();
        const repoPath = hasRepo ? this.getActiveRepositoryPath() : null;
        const repoLabel = repoPath ? this.resolveRepositoryLabel() : '';

        this.gitState = {
            hasRepo,
            repoPath,
            repoLabel
        };

        vscode.commands.executeCommand('setContext', 'gitCommitGenie.hasGitRepo', hasRepo);
    }

    private async refreshAnalysisState(): Promise<void> {
        const selectedId = this.context.globalState.get<string>(REPOSITORY_ANALYSIS_MODEL_ID_KEY, '');
        const selected = this.serviceRegistry.getModel(selectedId);
        const enabled = this.configManager.isRepoAnalysisEnabled();
        if (selectedId && !selected) {
            logger.warn(`Repository analysis model '${selectedId}' is not configured.`);
        }
        const key = selected ? await this.context.secrets.get(modelSecretKey(selected)) : undefined;

        const hasKey = !!(key && key.trim());

        // Check if analysis file exists
        const missing = this.checkAnalysisFileMissing();

        this.analysisState = {
            enabled,
            running: this.analysisState.running,
            missing,
            modelId: selected?.id ?? '',
            label: selected?.label ?? '',
            provider: selected?.provider ?? null,
            model: selected?.model ?? null,
            hasApiKey: hasKey,
            runningRepoPath: this.analysisState.runningRepoPath,
            runningRepoLabel: this.analysisState.runningRepoLabel
        };
    }

    private checkAnalysisFileMissing(): boolean {
        if (!this.configManager.isRepoAnalysisEnabled() || !this.gitState.hasRepo) {
            return false;
        }

        try {
            // Use the current active repository path from gitState
            const repoPath = this.gitState.repoPath;
            if (!repoPath) {
                return false;
            }

            const mdPath = this.serviceRegistry
                .getAnalysisService()
                .getAnalysisMarkdownFilePath(repoPath);

            return !fs.existsSync(mdPath);
        } catch {
            return false;
        }
    }

    // ========================================
    // Status Bar UI Update
    // ========================================

    async updateStatusBar(): Promise<void> {
        await this.refreshProviderState();
        await this.refreshGitState();
        await this.refreshAnalysisState();

        const text = this.buildStatusBarText();
        const tooltip = this.buildStatusBarTooltip();
        const command = this.getStatusBarCommand();

        this.statusBarItem.text = text;
        void this.enrichTooltipWithCost(tooltip);
        this.statusBarItem.command = command;
        this.statusBarItem.show();
    }

    private buildStatusBarText(): string {
        const { model } = this.providerState;
        const chainEnabled = this.configManager.readChainEnabled();

        const chainBadge = chainEnabled ? vscode.l10n.t(I18N.statusBar.chainBadge) : '';
        const modelLabel = this.getModelLabel();
        const analysisIcon = this.getAnalysisIcon();

        return `$(genie-base) Genie: ${modelLabel}${chainBadge} ${analysisIcon}`;
    }

    private getModelLabel(): string {
        const { hasApiKey, label, model } = this.providerState;

        if (!hasApiKey || !model.trim()) {
            return vscode.l10n.t(I18N.statusBar.selectModel);
        }

        return this.shortenModelName(label.trim());
    }

    private buildStatusBarTooltip(): string {
        const lines: string[] = [];

        // Repository label
        if (this.gitState.repoLabel) {
            const prefix = vscode.l10n.t(I18N.manageModels.currentLabel);
            lines.push(`${prefix}: ${this.gitState.repoLabel}`);
        }

        // Main provider/model info
        lines.push(this.getProviderTooltip());

        // Analysis info
        const analysisTooltip = this.getAnalysisTooltip();
        if (analysisTooltip) {
            lines.push(analysisTooltip);
        }

        // Repository status
        const repoTooltip = this.getRepoTooltip();
        if (repoTooltip) {
            lines.push(repoTooltip);
        }

        return lines.join('\n');
    }

    private getProviderTooltip(): string {
        const { provider, label, model, hasApiKey } = this.providerState;
        if (!provider) {
            return vscode.l10n.t(I18N.statusBar.selectModel);
        }
        const providerLabel = `${PROVIDER_LABELS[provider]} · ${label}`;

        if (hasApiKey && model.trim()) {
            return vscode.l10n.t(I18N.statusBar.tooltipConfigured, providerLabel, model);
        }

        return vscode.l10n.t(I18N.statusBar.tooltipNeedConfig, providerLabel);
    }

    private getAnalysisTooltip(): string {
        const { provider, label, model } = this.analysisState;
        if (!provider || !model) {
            return '';
        }

        const providerLabel = `${PROVIDER_LABELS[provider]} · ${label}`;
        const modelLabel = this.shortenModelName(model);

        return vscode.l10n.t(I18N.statusBar.analysisModel, providerLabel, modelLabel || '');
    }

    private getRepoTooltip(): string {
        if (!this.analysisState.enabled) {
            return '';
        }

        if (!this.gitState.hasRepo) {
            return vscode.l10n.t(I18N.repoAnalysis.initGitToEnable);
        }

        const okKey = this.analysisState.hasApiKey;
        const okModel = !!(this.analysisState.model && this.analysisState.model.trim());

        if (!okKey) {
            return vscode.l10n.t(I18N.repoAnalysis.missingApiKey);
        }
        if (!okModel) {
            return vscode.l10n.t(I18N.repoAnalysis.missingModel);
        }
        if (this.analysisState.running) {
            // Show which repository is being analyzed
            if (this.analysisState.runningRepoLabel) {
                return vscode.l10n.t(I18N.repoAnalysis.runningWithRepo, this.analysisState.runningRepoLabel);
            }
            return vscode.l10n.t(I18N.repoAnalysis.running);
        }
        if (this.analysisState.missing) {
            return vscode.l10n.t(I18N.repoAnalysis.missing);
        }

        return vscode.l10n.t(I18N.repoAnalysis.idle);
    }

    private getStatusBarCommand(): string {
        return this.gitState.hasRepo ? 'git-commit-genie.genieMenu' : 'git.init';
    }

    // ========================================
    // Icon and Visual Helpers
    // ========================================

    private getAnalysisIcon(): string {
        if (!this.analysisState.enabled) {
            return AnalysisIcon.None;
        }

        if (!this.gitState.hasRepo) {
            return AnalysisIcon.NoRepo;
        }

        const okKey = this.analysisState.hasApiKey;
        const okModel = !!(this.analysisState.model && this.analysisState.model.trim());

        if (!okKey || !okModel) {
            return AnalysisIcon.Warning;
        }

        if (this.analysisState.running) {
            return AnalysisIcon.Running;
        }

        if (this.analysisState.missing) {
            return AnalysisIcon.Refresh;
        }

        return AnalysisIcon.Complete;
    }

    // ========================================
    // Cost Tracking
    // ========================================

    private async enrichTooltipWithCost(baseTooltip: string): Promise<void> {
        try {
            if (!this.costTracker || !this.gitState.repoPath) {
                this.statusBarItem.tooltip = baseTooltip;
                return;
            }

            const cost = await this.costTracker.getRepositoryCost(this.gitState.repoPath);
            const parts: string[] = [baseTooltip];

            if (cost > 0) {
                const formatted = cost.toFixed(6);
                parts.push(vscode.l10n.t(I18N.cost.totalCost, formatted));
            } else {
                parts.push(vscode.l10n.t(I18N.cost.noCostRecorded));
            }

            this.statusBarItem.tooltip = parts.join('\n');
        } catch {
            this.statusBarItem.tooltip = baseTooltip;
        }
    }

    // ========================================
    // Analysis Model Validation
    // ========================================

    private async validateAnalysisModelApiKey(showPrompt: boolean): Promise<void> {
        const modelId = this.context.globalState.get<string>(REPOSITORY_ANALYSIS_MODEL_ID_KEY, '');
        const model = this.serviceRegistry.getModel(modelId);
        if (!model) {
            return;
        }
        const key = await this.context.secrets.get(modelSecretKey(model));
        if (key?.trim() || !showPrompt) {
            return;
        }

        const providerLabel = PROVIDER_LABELS[model.provider];
        const choice = await vscode.window.showWarningMessage(
            vscode.l10n.t(I18N.repoAnalysis.missingApiKey),
            vscode.l10n.t(I18N.actions.enterKey),
            vscode.l10n.t(I18N.actions.manageModels),
            vscode.l10n.t(I18N.actions.dismiss)
        );

        if (choice === vscode.l10n.t(I18N.actions.enterKey)) {
            const newKey = await vscode.window.showInputBox({
                title: vscode.l10n.t(I18N.manageModels.enterKeyTitle, providerLabel),
                prompt: `${providerLabel} API Key`,
                placeHolder: `${providerLabel} API Key`,
                password: true,
                ignoreFocusOut: true,
            });

            if (newKey?.trim()) {
                const service = this.serviceRegistry.getLLMService(model.id);
                if (!service) {
                    throw new Error(`AI model service '${model.id}' is not configured.`);
                }
                await service.setApiKey(newKey.trim());
                await this.updateStatusBar();
            }
        } else if (choice === vscode.l10n.t(I18N.actions.manageModels)) {
            await vscode.commands.executeCommand('git-commit-genie.manageModels');
        }
    }

    private shortenModelName(modelName: string): string {
        if (!modelName) {
            return modelName;
        }

        try {
            // Remove common date/version suffixes:
            // - Anthropic: -20250219, -20250219-v1
            // - Gemini: -09-2025, -preview-09-2025 (keep "preview")
            // - Generic: any 8-digit date suffix

            // First, try to remove Anthropic-style 8-digit dates (e.g., -20250219)
            let shortened = modelName.replace(/-(20\d{6})(?:[-]?v?\d+)?$/, '');
            if (shortened !== modelName) {
                return shortened;
            }

            // Then try Gemini-style MM-YYYY dates (e.g., -09-2025)
            shortened = modelName.replace(/-(\d{2}-\d{4})$/, '');
            if (shortened !== modelName) {
                return shortened;
            }

            // Fallback: return original model name
            return modelName;
        } catch {
            // Safety fallback: return original on any error
            return modelName;
        }
    }

    private detectGitRepo(): boolean {
        try {
            const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git')?.exports;
            if (!gitExtension) {
                return false;
            }

            const api = gitExtension.getAPI(1);
            return !!(api && api.repositories.length > 0);
        } catch {
            return false;
        }
    }

    private getActiveRepositoryPath(): string | null {
        try {
            const repo = this.repoService.getActiveRepository();
            if (!repo) {
                return null;
            }
            return this.repoService.getRepositoryPath(repo);
        } catch {
            return null;
        }
    }

    private resolveRepositoryLabel(): string {
        try {
            const candidate: any = this.repoService;
            if (candidate && typeof candidate.getRepositoryLabel === 'function') {
                return candidate.getRepositoryLabel();
            }

            const repo = candidate?.getActiveRepository?.();
            if (!repo) {
                return '';
            }

            const repoPath = candidate?.getRepositoryPath?.(repo);
            if (!repoPath) {
                return '';
            }

            return path.basename(repoPath);
        } catch {
            return '';
        }
    }
}
