import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ServiceRegistry } from '../core/ServiceRegistry';
import { ConfigurationManager } from '../config/ConfigurationManager';
import { L10N_KEYS as I18N } from '../i18n/keys';
import { GitExtension } from '../services/git/git';
import { RepoService } from '../services/repo/repo';
import { CostTrackingService } from '../services/cost/costTrackingService';
import { getAllProviderKeys } from '../services/llm/providers/config/ProviderConfig';
import {
    ProviderState,
    AnalysisState,
    GitState,
    AnalysisIcon,
    LLMProvider,
    PROVIDER_LABELS,
    PROVIDER_SECRET_KEYS
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
        provider: '',
        model: '',
        hasApiKey: false
    };

    private analysisState: AnalysisState = {
        enabled: false,
        running: false,
        missing: false,
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

        this.updateStatusBar();
    }

    async dispose(): Promise<void> {
        this.statusBarItem?.dispose();
    }

    onProviderModelChanged(provider?: string): void {
        void this.refreshProviderState(provider);
        void this.refreshAnalysisState();
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
            if (e.affectsConfiguration('gitCommitGenie.repositoryAnalysis.model')) {
                void this.validateAnalysisModelApiKey(true);
                void this.refreshAnalysisState();
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

    private async refreshProviderState(provider?: string): Promise<void> {
        const p = (provider || this.serviceRegistry.getProvider() || 'openai').toLowerCase();
        const model = this.serviceRegistry.getModel(p);
        const secretName = this.getSecretNameForProvider(p);
        const key = await this.context.secrets.get(secretName);

        this.providerState = {
            provider: p,
            model: model || '',
            hasApiKey: !!(key && key.trim())
        };

        this.updateStatusBar();
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
        const cfg = vscode.workspace.getConfiguration('gitCommitGenie.repositoryAnalysis');
        const selected = (cfg.get<string>('model', 'general') || 'general').trim();
        const enabled = this.configManager.isRepoAnalysisEnabled();

        let provider = this.providerState.provider;
        let model = this.providerState.model;

        // If a specific model is selected, find its provider
        if (selected && selected !== 'general') {
            const candidates = getAllProviderKeys();
            for (const p of candidates) {
                const svc = this.serviceRegistry.getLLMService(p);
                if (svc?.listSupportedModels().includes(selected)) {
                    provider = p;
                    model = selected;
                    break;
                }
            }
        }

        // Get API key for the analysis provider
        const key = await this.context.secrets.get(this.getSecretNameForProvider(provider));
        const hasKey = !!(key && key.trim());

        // Check if analysis file exists
        const missing = this.checkAnalysisFileMissing();

        this.analysisState = {
            enabled,
            running: this.analysisState.running,
            missing,
            provider,
            model,
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
        const { hasApiKey, model } = this.providerState;

        if (!hasApiKey || !model.trim()) {
            return vscode.l10n.t(I18N.statusBar.selectModel);
        }

        return this.shortenModelName(model.trim());
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
        const { provider, model, hasApiKey } = this.providerState;
        const providerLabel = this.getProviderLabel(provider);

        if (hasApiKey && model.trim()) {
            return vscode.l10n.t(I18N.statusBar.tooltipConfigured, providerLabel, model);
        }

        return vscode.l10n.t(I18N.statusBar.tooltipNeedConfig, providerLabel);
    }

    private getAnalysisTooltip(): string {
        const { provider, model } = this.analysisState;
        if (!provider || !model) {
            return '';
        }

        const providerLabel = this.getProviderLabel(provider);
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

        const usingGeneral = !this.analysisState.provider ||
            this.analysisState.provider === this.providerState.provider;
        const okKey = usingGeneral ? this.providerState.hasApiKey : this.analysisState.hasApiKey;
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

        const usingGeneral = !this.analysisState.provider ||
            this.analysisState.provider === this.providerState.provider;
        const okKey = usingGeneral ? this.providerState.hasApiKey : this.analysisState.hasApiKey;
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
        try {
            const cfg = vscode.workspace.getConfiguration('gitCommitGenie.repositoryAnalysis');
            const selected = (cfg.get<string>('model', 'general') || 'general').trim();

            let provider: string | null = null;

            if (!selected || selected === 'general') {
                provider = this.providerState.provider;
            } else {
                const candidates = getAllProviderKeys();
                for (const p of candidates) {
                    const svc = this.serviceRegistry.getLLMService(p);
                    if (svc?.listSupportedModels().includes(selected)) {
                        provider = p;
                        break;
                    }
                }
            }

            if (!provider) {
                return;
            }

            const key = await this.context.secrets.get(this.getSecretNameForProvider(provider));
            if (key && key.trim()) {
                return;
            }

            if (!showPrompt) {
                return;
            }

            const providerLabel = this.getProviderLabel(provider);
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

                if (newKey && newKey.trim()) {
                    await this.serviceRegistry.getLLMService(provider)?.setApiKey(newKey.trim());
                    await this.refreshProviderState(provider);
                    await this.refreshAnalysisState();
                    this.updateStatusBar();
                }
            } else if (choice === vscode.l10n.t(I18N.actions.manageModels)) {
                await vscode.commands.executeCommand('git-commit-genie.manageModels');
            }
        } catch {
            // Ignore validation errors
        }
    }

    // ========================================
    // Utility Methods
    // ========================================

    private getSecretNameForProvider(provider: string): string {
        const normalizedProvider = provider.toLowerCase() as LLMProvider;
        return PROVIDER_SECRET_KEYS[normalizedProvider] || PROVIDER_SECRET_KEYS.openai;
    }

    private getProviderLabel(provider: string): string {
        const normalizedProvider = provider.toLowerCase() as LLMProvider;
        return PROVIDER_LABELS[normalizedProvider] || PROVIDER_LABELS.openai;
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
