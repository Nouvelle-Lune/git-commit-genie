import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ServiceRegistry } from '../core/ServiceRegistry';
import { ConfigurationManager } from '../config/ConfigurationManager';
import { L10N_KEYS as I18N } from '../i18n/keys';
import { API, GitExtension } from '../services/git/git';
import { costTracker } from '../services/cost';

export class StatusBarManager {
    private statusBarItem!: vscode.StatusBarItem;
    private repoAnalysisRunning = false;
    private repoAnalysisMissing = false;
    private hasGitRepo = false;
    private hasApiKey = false;
    private lastProviderChecked: string | null = null;
    private hasModel = false;
    // Repository analysis selection state (provider/model may differ from generation)
    private analysisProvider: string | null = null;
    private analysisModel: string | null = null;
    private analysisHasApiKey: boolean = false;
    private lastAnalysisKey: string | null = null;

    constructor(
        private context: vscode.ExtensionContext,
        private serviceRegistry: ServiceRegistry,
        private configManager: ConfigurationManager
    ) { }

    async initialize(): Promise<void> {
        // Create status bar item with right alignment and low priority
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10000);
        this.statusBarItem.command = 'git-commit-genie.genieMenu';

        this.context.subscriptions.push(this.statusBarItem);

        // Watch secret changes to refresh API key availability state
        const disp = this.context.secrets.onDidChange(async (e) => {
            try {
                if (!e?.key || !e.key.startsWith('gitCommitGenie.secret.')) { return; }
                // Refresh both general provider and analysis selection; then validate with prompt
                await this.refreshApiKeyState();
                await this.refreshAnalysisSelectionState();
                await this.validateAnalysisModelApiKey(true);
                this.updateStatusBar();
            } catch { /* ignore */ }
        });
        this.context.subscriptions.push(disp);

        // Watch for workspace folder changes
        const workspaceDisp = vscode.workspace.onDidChangeWorkspaceFolders(() => {
            this.updateStatusBar();
        });
        this.context.subscriptions.push(workspaceDisp);

        // React to repository analysis model setting changes
        const cfgDisp = vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('gitCommitGenie.repositoryAnalysis.model')) {
                // Warn if selected analysis model provider has no API key
                this.validateAnalysisModelApiKey(true).catch(() => { /* ignore */ });
                void this.refreshAnalysisSelectionState();
            }
        });
        this.context.subscriptions.push(cfgDisp);

        // Refresh immediately when repository cost changes
        const costDisp = costTracker.onCostChanged(() => this.updateStatusBar());
        this.context.subscriptions.push({ dispose: () => (costDisp as any)?.dispose?.() || undefined });

        // Setup Git repository change listeners
        this.setupGitRepositoryListeners();

        // Seed API key availability
        await this.refreshApiKeyState();
        await this.refreshAnalysisSelectionState();
        // One-time validation on activation
        await this.validateAnalysisModelApiKey(true);

        // Initial update
        this.updateStatusBar();
    }

    async dispose(): Promise<void> {
        this.statusBarItem?.dispose();
    }

    // Notify status bar that provider/model for general usage changed
    onProviderModelChanged(provider?: string): void {
        try {
            void this.refreshApiKeyState(provider);
            void this.refreshAnalysisSelectionState();
        } catch { /* ignore */ }
    }

    setRepoAnalysisRunning(running: boolean): void {
        this.repoAnalysisRunning = running;
        // Expose a context key so commands/menus can hide the refresh action while running
        vscode.commands.executeCommand('setContext', 'gitCommitGenie.analysisRunning', running);
        this.updateStatusBar();
    }

    updateStatusBar(): void {
        const provider = this.serviceRegistry.getProvider().toLowerCase();
        const model = this.serviceRegistry.getModel(provider);
        const providerLabel = this.getProviderLabel(provider);
        const chainEnabled = this.configManager.readChainEnabled();
        const chainBadge = chainEnabled ? vscode.l10n.t(I18N.statusBar.chainBadge) : '';

        // If provider changed since last API key check, refresh async
        if (this.lastProviderChecked !== provider) {
            void this.refreshApiKeyState(provider);
        }

        // Update Git repo presence and set context for menus
        this.hasGitRepo = this.detectGitRepo();
        vscode.commands.executeCommand('setContext', 'gitCommitGenie.hasGitRepo', this.hasGitRepo);

        // Determine if repo analysis markdown exists (only when enabled and when git repo exists)
        this.updateRepoAnalysisStatus();

        this.hasModel = !!(model && model.trim());
        const modelLabel = (this.hasApiKey && this.hasModel)
            ? this.shortenModelName(model.trim())
            : vscode.l10n.t(I18N.statusBar.selectModel);
        const analysisIcon = this.getAnalysisIcon();

        this.statusBarItem.text = `$(genie-base) Genie: ${modelLabel}${chainBadge} ${analysisIcon}`;

        const baseTooltip = (this.hasApiKey && this.hasModel)
            ? vscode.l10n.t(I18N.statusBar.tooltipConfigured, providerLabel, model)
            : vscode.l10n.t(I18N.statusBar.tooltipNeedConfig, providerLabel);

        const repoTooltip = this.getRepoTooltip();
        const analysisTooltip = this.getAnalysisTooltipLine();
        // Order: base -> repo status -> repository analysis model -> cost
        const baseWithRepo = repoTooltip ? `${baseTooltip}\n${repoTooltip}` : baseTooltip;
        const fullBase = analysisTooltip ? `${baseWithRepo}\n${analysisTooltip}` : baseWithRepo;
        this.statusBarItem.tooltip = fullBase;
        void this.enrichTooltipWithCost(fullBase, '');

        // Click action: when no Git repo, jump to official initialize command; otherwise open Genie menu
        this.statusBarItem.command = !this.hasGitRepo ? 'git.init' : 'git-commit-genie.genieMenu';
        this.statusBarItem.show();
    }

    private async enrichTooltipWithCost(baseTooltip: string, _unused: string): Promise<void> {
        try {

            const cost = await costTracker.getRepositoryCost();
            const parts: string[] = [baseTooltip];

            // Prepare cost line (use i18n messages)
            if (cost > 0) {
                const formatted = cost.toFixed(6);
                parts.push(vscode.l10n.t(I18N.cost.totalCost, formatted));
            } else {
                parts.push(vscode.l10n.t(I18N.cost.noCostRecorded));
            }

            // Only update if tooltip still corresponds to current provider/model state
            this.statusBarItem.tooltip = parts.join('\n');
        } catch {
            // Silently ignore; keep baseline tooltip
        }
    }

    private secretNameFor(provider: string): string {
        switch (provider) {
            case 'deepseek': return 'gitCommitGenie.secret.deepseekApiKey';
            case 'anthropic': return 'gitCommitGenie.secret.anthropicApiKey';
            case 'gemini': return 'gitCommitGenie.secret.geminiApiKey';
            default: return 'gitCommitGenie.secret.openaiApiKey';
        }
    }

    private async refreshApiKeyState(provider?: string): Promise<void> {
        try {
            const p = (provider || this.serviceRegistry.getProvider() || 'openai').toLowerCase();
            const secretName = this.secretNameFor(p);
            const key = await this.context.secrets.get(secretName);
            this.hasApiKey = !!(key && key.trim());
            this.lastProviderChecked = p;
            this.updateStatusBar();
        } catch {
            this.hasApiKey = false;
            this.lastProviderChecked = provider || null;
            this.updateStatusBar();
        }
    }

    private getProviderLabel(provider: string): string {
        switch (provider) {
            case 'deepseek': return 'DeepSeek';
            case 'anthropic': return 'Anthropic';
            case 'gemini': return 'Gemini';
            default: return 'OpenAI';
        }
    }

    private shortenModelName(modelName: string): string {
        if (!modelName) {
            return modelName;
        }
        // Remove trailing date/version suffix like -20250219 or -20250219-v1
        const datePattern = /(.*?)-(20\d{6})(?:[-]?v?\d+)?$/;
        const match = modelName.match(datePattern);
        return match ? match[1] : modelName;
    }

    private detectGitRepo(): boolean {
        try {
            // Use VS Code Git API to detect any repository
            const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git')?.exports;
            if (gitExtension) {
                const api = gitExtension.getAPI(1);
                return api && api.repositories.length > 0;
            }
            return false;
        } catch {
            return false;
        }
    }



    private setupGitRepositoryListeners(): void {
        try {
            const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git')?.exports;
            if (!gitExtension) {
                return;
            }

            const api = gitExtension.getAPI(1);

            // Listen for repository changes
            const repoDisp = api.onDidOpenRepository(() => {
                this.updateStatusBar();
            });
            this.context.subscriptions.push(repoDisp);

            const repoCloseDisp = api.onDidCloseRepository(() => {
                this.updateStatusBar();
            });
            this.context.subscriptions.push(repoCloseDisp);

        } catch {
            // ignore errors in git listener setup
        }
    }

    private updateRepoAnalysisStatus(): void {
        try {
            if (this.configManager.isRepoAnalysisEnabled() && this.hasGitRepo) {
                // Use VS Code Git API to get repository path
                const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git')?.exports;
                if (gitExtension) {
                    const api = gitExtension.getAPI(1);
                    if (api && api.repositories.length > 0) {
                        const repoPath = api.repositories[0].rootUri?.fsPath;
                        if (repoPath) {
                            const mdPath = this.serviceRegistry.getAnalysisService().getAnalysisMarkdownFilePath(repoPath);
                            this.repoAnalysisMissing = !fs.existsSync(mdPath);
                        } else {
                            this.repoAnalysisMissing = false;
                        }
                    } else {
                        this.repoAnalysisMissing = false;
                    }
                } else {
                    this.repoAnalysisMissing = false;
                }
            } else {
                this.repoAnalysisMissing = false;
            }
        } catch {
            this.repoAnalysisMissing = false;
        }
    }

    private getAnalysisIcon(): string {
        if (!this.configManager.isRepoAnalysisEnabled()) {
            return '';
        }
        if (!this.hasGitRepo) {
            return '$(search-stop)';
        }
        // If not properly configured, warn instead of showing check
        const usingGeneral = !this.analysisProvider || this.analysisProvider === this.serviceRegistry.getProvider().toLowerCase();
        const okKey = usingGeneral ? this.hasApiKey : this.analysisHasApiKey;
        const okModel = !!(this.analysisModel && this.analysisModel.trim());
        if (!okKey || !okModel) {
            return '$(warning)';
        }
        if (this.repoAnalysisRunning) {
            return '$(sync~spin)';
        }
        if (this.repoAnalysisMissing) {
            return '$(refresh)';
        }

        return '$(check)';
    }

    private getRepoTooltip(): string {
        if (!this.configManager.isRepoAnalysisEnabled()) {
            return '';
        }
        if (!this.hasGitRepo) {
            return vscode.l10n.t(I18N.repoAnalysis.initGitToEnable);
        }
        const usingGeneral = !this.analysisProvider || this.analysisProvider === this.serviceRegistry.getProvider().toLowerCase();
        const okKey = usingGeneral ? this.hasApiKey : this.analysisHasApiKey;
        const okModel = !!(this.analysisModel && this.analysisModel.trim());
        if (!okKey) { return vscode.l10n.t(I18N.repoAnalysis.missingApiKey); }
        if (!okModel) { return vscode.l10n.t(I18N.repoAnalysis.missingModel); }
        if (this.repoAnalysisRunning) {
            return vscode.l10n.t(I18N.repoAnalysis.running);
        }
        if (this.repoAnalysisMissing) {
            return vscode.l10n.t(I18N.repoAnalysis.missing);
        }
        return vscode.l10n.t(I18N.repoAnalysis.idle);
    }

    private async refreshAnalysisSelectionState(): Promise<void> {
        try {
            const cfg = vscode.workspace.getConfiguration('gitCommitGenie.repositoryAnalysis');
            const selected = (cfg.get<string>('model', 'general') || 'general').trim();

            let provider = this.serviceRegistry.getProvider().toLowerCase();
            let model = this.serviceRegistry.getModel(provider);
            if (selected && selected !== 'general') {
                const candidates = ['openai', 'deepseek', 'anthropic', 'gemini'];
                for (const p of candidates) {
                    const svc = this.serviceRegistry.getLLMService(p);
                    if (svc && svc.listSupportedModels().includes(selected)) {
                        provider = p;
                        model = selected;
                        break;
                    }
                }
            }

            // Resolve API key for the analysis provider
            const key = await this.context.secrets.get(this.secretNameFor(provider));
            const hasKey = !!(key && key.trim());

            const newKey = `${provider}:${model || ''}:${hasKey ? 1 : 0}`;
            const changed = newKey !== this.lastAnalysisKey;
            this.analysisProvider = provider;
            this.analysisModel = model || '';
            this.analysisHasApiKey = hasKey;
            this.lastAnalysisKey = newKey;
            if (changed) {
                this.updateStatusBar();
            }
        } catch {
            // ignore
        }
    }

    private getAnalysisTooltipLine(): string {
        try {
            const provider = (this.analysisProvider || this.serviceRegistry.getProvider() || 'openai').toLowerCase();
            const model = this.analysisModel || this.serviceRegistry.getModel(provider) || '';
            const providerLabel = this.getProviderLabel(provider);
            const modelLabel = this.shortenModelName(model);
            if (!providerLabel && !modelLabel) { return ''; }
            return vscode.l10n.t(I18N.statusBar.analysisModel, providerLabel, modelLabel || '');
        } catch {
            return '';
        }
    }

    private async validateAnalysisModelApiKey(showPrompt: boolean): Promise<void> {
        try {
            const cfg = vscode.workspace.getConfiguration('gitCommitGenie.repositoryAnalysis');
            const selected = (cfg.get<string>('model', 'general') || 'general').trim();
            const candidates = ['openai', 'deepseek', 'anthropic', 'gemini'];
            let provider: string | null = null;
            if (!selected || selected === 'general') {
                provider = (this.serviceRegistry.getProvider() || 'openai').toLowerCase();
            } else {
                for (const p of candidates) {
                    const svc = this.serviceRegistry.getLLMService(p);
                    if (svc && svc.listSupportedModels().includes(selected)) { provider = p; break; }
                }
            }
            if (!provider) { return; }
            const key = await this.context.secrets.get(this.secretNameFor(provider));
            if (!key || !key.trim()) {
                if (showPrompt) {
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
                            await this.refreshApiKeyState(provider);
                            await this.refreshAnalysisSelectionState();
                            this.updateStatusBar();
                        }
                    } else if (choice === vscode.l10n.t(I18N.actions.manageModels)) {
                        await vscode.commands.executeCommand('git-commit-genie.manageModels');
                    }
                }
            }
        } catch {
            // ignore
        }
    }

    // Getters for external access
    isRepoAnalysisRunning(): boolean {
        return this.repoAnalysisRunning;
    }

    hasGitRepository(): boolean {
        return this.hasGitRepo;
    }

    isRepoAnalysisMissing(): boolean {
        return this.repoAnalysisMissing;
    }
}
