import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ServiceRegistry } from '../core/ServiceRegistry';
import { ConfigurationManager } from '../config/ConfigurationManager';
import { L10N_KEYS as I18N } from '../i18n/keys';

export class StatusBarManager {
    private statusBarItem!: vscode.StatusBarItem;
    private repoAnalysisRunning = false;
    private repoAnalysisMissing = false;
    private hasGitRepo = false;
    private hasApiKey = false;
    private lastProviderChecked: string | null = null;
    private hasModel = false;

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
        const disp = this.context.secrets.onDidChange((e) => {
            try {
                if (!e?.key || !e.key.startsWith('gitCommitGenie.secret.')) { return; }
                // Provider may not change; recheck for current provider
                void this.refreshApiKeyState();
            } catch { /* ignore */ }
        });
        this.context.subscriptions.push(disp);

        // Seed API key availability
        await this.refreshApiKeyState();

        // Initial update
        this.updateStatusBar();
    }

    async dispose(): Promise<void> {
        this.statusBarItem?.dispose();
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
        this.statusBarItem.tooltip = repoTooltip ? `${baseTooltip}\n${repoTooltip}` : baseTooltip;

        // Click action: when no Git repo, jump to official initialize command; otherwise open Genie menu
        this.statusBarItem.command = !this.hasGitRepo ? 'git.init' : 'git-commit-genie.genieMenu';
        this.statusBarItem.show();
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
            const wf = vscode.workspace.workspaceFolders;
            if (!wf || wf.length === 0) {
                return false;
            }
            const repoPath = wf[0].uri.fsPath;
            // Simple and reliable: check for .git folder at root
            return fs.existsSync(path.join(repoPath, '.git'));
        } catch {
            return false;
        }
    }

    private updateRepoAnalysisStatus(): void {
        try {
            if (this.configManager.isRepoAnalysisEnabled() && this.hasGitRepo) {
                const wf = vscode.workspace.workspaceFolders;
                if (wf && wf.length > 0) {
                    const repoPath = wf[0].uri.fsPath;
                    const mdPath = this.serviceRegistry.getAnalysisService().getAnalysisMarkdownFilePath(repoPath);
                    this.repoAnalysisMissing = !fs.existsSync(mdPath);
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
        if (!this.hasApiKey || !this.hasModel) {
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
        if (!this.hasApiKey) {
            return vscode.l10n.t(I18N.repoAnalysis.missingApiKey);
        }
        if (!this.hasModel) {
            return vscode.l10n.t(I18N.repoAnalysis.missingModel);
        }
        if (this.repoAnalysisRunning) {
            return vscode.l10n.t(I18N.repoAnalysis.running);
        }
        if (this.repoAnalysisMissing) {
            return vscode.l10n.t(I18N.repoAnalysis.missing);
        }
        return vscode.l10n.t(I18N.repoAnalysis.idle);
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
