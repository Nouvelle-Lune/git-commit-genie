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
        const chain = this.configManager.readChainEnabled();
        const chainBadge = chain ? vscode.l10n.t(I18N.statusBar.chainBadge) : '';

        // Update Git repo presence and set context for menus
        this.hasGitRepo = this.detectGitRepo();
        vscode.commands.executeCommand('setContext', 'gitCommitGenie.hasGitRepo', this.hasGitRepo);

        // Determine if repo analysis markdown exists (only when enabled and when git repo exists)
        this.updateRepoAnalysisStatus();

        const modelLabel = model && model.trim() ? this.shortenModelName(model.trim()) : vscode.l10n.t(I18N.statusBar.selectModel);
        const analysisIcon = this.getAnalysisIcon();

        this.statusBarItem.text = `$(chat-sparkle) Genie: ${modelLabel}${chainBadge} ${analysisIcon}`;

        const baseTooltip = model && model.trim()
            ? vscode.l10n.t(I18N.statusBar.tooltipConfigured, providerLabel, model)
            : vscode.l10n.t(I18N.statusBar.tooltipNeedConfig, providerLabel);

        const repoTooltip = this.getRepoTooltip();
        this.statusBarItem.tooltip = repoTooltip ? `${baseTooltip}\n${repoTooltip}` : baseTooltip;

        // Click action: when no Git repo, jump to official initialize command; otherwise open Genie menu
        this.statusBarItem.command = !this.hasGitRepo ? 'git.init' : 'git-commit-genie.genieMenu';
        this.statusBarItem.show();
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