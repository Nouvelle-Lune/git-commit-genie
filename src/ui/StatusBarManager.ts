import * as vscode from 'vscode';
import * as path from 'path';
import { ServiceRegistry } from '../core/ServiceRegistry';
import { ConfigurationManager } from '../config/ConfigurationManager';
import { L10N_KEYS as I18N } from '../i18n/keys';
import { GitExtension } from '../services/git/git';
import { RepoService } from '../services/repo/repo';
import { CostTrackingService } from '../services/cost/costTrackingService';
import { repositoryCostToDisplay } from '../services/cost/costDisplay';
import { logger } from '../services/logger';
import {
    modelSecretKey,
} from '../services/llm/providers';
import {
    ProviderState,
    GitState,
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

        await this.updateStatusBar();
    }

    async dispose(): Promise<void> {
        this.statusBarItem?.dispose();
    }

    async refreshModelStates(): Promise<void> {
        await this.updateStatusBar();
    }

    hasGitRepository(): boolean {
        return this.gitState.hasRepo;
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
            if (e.affectsConfiguration('gitCommitGenie.memory')) {
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

    // ========================================
    // Status Bar UI Update
    // ========================================

    async updateStatusBar(): Promise<void> {
        await this.refreshProviderState();
        await this.refreshGitState();

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
        const memoryIcon = vscode.workspace.getConfiguration('gitCommitGenie.memory').get<boolean>('enabled', false) ? '$(database)' : '';

        return `$(genie-base) Genie: ${modelLabel}${chainBadge} ${memoryIcon}`;
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

        return lines.join('\n');
    }

    private getProviderTooltip(): string {
        const { provider, label, model, hasApiKey } = this.providerState;
        if (!provider) {
            return vscode.l10n.t(I18N.statusBar.selectModel);
        }

        if (hasApiKey && model.trim()) {
            return vscode.l10n.t(I18N.statusBar.tooltipConfigured, this.shortenModelName(model.trim()));
        }

        return vscode.l10n.t(I18N.statusBar.tooltipNeedConfig, label.trim() || PROVIDER_LABELS[provider]);
    }

    private getStatusBarCommand(): string {
        return this.gitState.hasRepo ? 'git-commit-genie.genieMenu' : 'git.init';
    }

    // ========================================
    // Icon and Visual Helpers
    // ========================================

    // ========================================
    // Cost Tracking
    // ========================================

    private async enrichTooltipWithCost(baseTooltip: string): Promise<void> {
        try {
            if (!this.costTracker || !this.gitState.repoPath) {
                this.statusBarItem.tooltip = baseTooltip;
                return;
            }

            const snapshot = await this.costTracker.getRepositoryCostSnapshot(this.gitState.repoPath);
            const display = repositoryCostToDisplay(snapshot);
            const parts: string[] = [baseTooltip];
            switch (display.status) {
                case 'none':
                    parts.push(vscode.l10n.t(I18N.cost.noCostRecorded));
                    break;
                case 'free':
                    parts.push(vscode.l10n.t(I18N.cost.totalCostFree));
                    break;
                case 'partial':
                    parts.push(vscode.l10n.t(I18N.cost.totalCostPartial, (display.amountUsd ?? 0).toFixed(6)));
                    break;
                case 'amount':
                    parts.push(vscode.l10n.t(I18N.cost.totalCost, (display.amountUsd ?? 0).toFixed(6)));
                    break;
                default:
                    parts.push(vscode.l10n.t(I18N.cost.totalCost, snapshot.totalUsd.toFixed(6)));
                    break;
            }
            this.statusBarItem.tooltip = parts.join('\n');
        } catch {
            this.statusBarItem.tooltip = baseTooltip;
        }
    }

    // ========================================
    // Analysis Model Validation
    // ========================================

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
