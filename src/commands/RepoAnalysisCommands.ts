import * as vscode from 'vscode';
import * as fs from 'fs';
import { ServiceRegistry } from '../core/ServiceRegistry';
import { StatusBarManager } from '../ui/StatusBarManager';
import { L10N_KEYS as I18N } from '../i18n/keys';
import { RepoAnalysisRunResult } from '../services/analysis/analysisTypes';
import { logger } from '../services/logger';
import { GitExtension } from '../services/git/git';

export class RepoAnalysisCommands {
    constructor(
        private context: vscode.ExtensionContext,
        private serviceRegistry: ServiceRegistry,
        private statusBarManager: StatusBarManager
    ) { }

    async register(): Promise<void> {
        // View repository analysis
        this.context.subscriptions.push(
            vscode.commands.registerCommand('git-commit-genie.viewRepositoryAnalysis', this.viewRepositoryAnalysis.bind(this))
        );

        // Refresh repository analysis
        this.context.subscriptions.push(
            vscode.commands.registerCommand('git-commit-genie.refreshRepositoryAnalysis', this.refreshRepositoryAnalysis.bind(this))
        );

        // Cancel repository analysis
        this.context.subscriptions.push(
            vscode.commands.registerCommand('git-commit-genie.cancelRepositoryAnalysis', this.cancelRepositoryAnalysis.bind(this))
        );

        // Developer: view internal analysis JSON
        this.context.subscriptions.push(
            vscode.commands.registerCommand('git-commit-genie.openAnalysisJson', this.openAnalysisJson.bind(this))
        );
    }

    private getRepositoryPath(): string | null {
        try {
            // Use VS Code Git API to get repository path safely
            const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git')?.exports;
            if (gitExtension) {
                const api = gitExtension.getAPI(1);
                if (api && api.repositories.length > 0) {
                    return api.repositories[0].rootUri?.fsPath || null;
                }
            }
            return null;
        } catch {
            return null;
        }
    }

    private async viewRepositoryAnalysis(): Promise<void> {
        if (!this.isRepoAnalysisEnabled()) {
            return;
        }

        const repositoryPath = this.getRepositoryPath();
        if (!repositoryPath) {
            vscode.window.showErrorMessage('No Git repository found.');
            return;
        }

        try {
            const analysisService = this.serviceRegistry.getAnalysisService();
            const analysis = await analysisService.getAnalysis(repositoryPath);

            if (!analysis) {
                const initialize = await vscode.window.showInformationMessage(
                    vscode.l10n.t(I18N.repoAnalysis.promptInitialize),
                    vscode.l10n.t(I18N.repoAnalysis.initialize),
                    vscode.l10n.t(I18N.manageModels.cancel)
                );

                if (initialize === 'Initialize') {
                    let initResult;
                    await vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: vscode.l10n.t(I18N.repoAnalysis.initializingTitle),
                        cancellable: false
                    }, async () => {
                        this.statusBarManager.setRepoAnalysisRunning(true);
                        try {
                            initResult = await analysisService.initializeRepository(repositoryPath);
                        } finally {
                            this.statusBarManager.setRepoAnalysisRunning(false);
                        }
                    });

                    if (initResult !== 'success') {
                        return;
                    }

                    // After initialization, ensure markdown exists and open it for editing
                    const newAnalysis = await analysisService.getAnalysis(repositoryPath);
                    if (newAnalysis) {
                        const mdPath = await analysisService.saveAnalysisMarkdown(repositoryPath, newAnalysis, { overwrite: false });
                        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(mdPath));
                        await vscode.window.showTextDocument(doc);
                    }
                }
                return;
            }

            // Ensure markdown exists and open it for editing
            const mdPath = await analysisService.saveAnalysisMarkdown(repositoryPath, analysis, { overwrite: false });
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(mdPath));
            await vscode.window.showTextDocument(doc);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to view repository analysis: ${error}`);
        }
    }

    private async refreshRepositoryAnalysis(): Promise<void> {
        if (!this.isRepoAnalysisEnabled()) {
            return;
        }

        const repositoryPath = this.getRepositoryPath();
        if (!repositoryPath) {
            vscode.window.showErrorMessage('No Git repository found.');
            return;
        }

        try {
            const analysisService = this.serviceRegistry.getAnalysisService();

            let updateResult = 'skipped';
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: vscode.l10n.t(I18N.repoAnalysis.refreshingTitle),
                cancellable: false
            }, async () => {
                this.statusBarManager.setRepoAnalysisRunning(true);
                try {
                    updateResult = await analysisService.updateAnalysis(repositoryPath);
                } finally {
                    this.statusBarManager.setRepoAnalysisRunning(false);
                }
            });
            if (updateResult === 'success') {
                vscode.window.showInformationMessage(vscode.l10n.t(I18N.repoAnalysis.refreshed));
            }
        } catch (error: any) {
            const msg = String(error?.message || error || '');
            const cancelled = /abort|cancel/i.test(msg);
            if (cancelled) {
                logger.warn('[Genie][RepoAnalysis] Refresh cancelled by user.');
            } else {
                logger.error('[Genie][RepoAnalysis] Failed to refresh repository analysis', error);
            }
        }
    }

    private async cancelRepositoryAnalysis(): Promise<void> {
        try {
            this.serviceRegistry.getAnalysisService().cancelCurrentAnalysis();
            this.statusBarManager.setRepoAnalysisRunning(false);
            logger.warn('[Genie][RepoAnalysis] Refresh cancelled by user.');
        } catch {
            // ignore
        }
    }

    private async openAnalysisJson(): Promise<void> {
        const cfg = vscode.workspace.getConfiguration('gitCommitGenie');
        const dev = cfg.get<boolean>('developerMode', false);

        if (!dev) {
            const choice = await vscode.window.showInformationMessage(
                'Developer mode required.',
                vscode.l10n.t(I18N.actions.openSettings)
            );
            if (choice === vscode.l10n.t(I18N.actions.openSettings)) {
                vscode.commands.executeCommand('workbench.action.openSettings', 'gitCommitGenie.developerMode');
            }
            return;
        }

        const wf = vscode.workspace.workspaceFolders;
        if (!wf || wf.length === 0) {
            vscode.window.showErrorMessage(vscode.l10n.t(I18N.common.noWorkspace));
            return;
        }

        const repositoryPath = wf[0].uri.fsPath;
        const analysisService = this.serviceRegistry.getAnalysisService();
        const analysis = await analysisService.getAnalysis(repositoryPath);

        if (!analysis) {
            vscode.window.showInformationMessage('No analysis data found.');
            return;
        }

        const doc = await vscode.workspace.openTextDocument({
            language: 'json',
            content: JSON.stringify(analysis, null, 2)
        });
        await vscode.window.showTextDocument(doc, { preview: false });
    }

    private isRepoAnalysisEnabled(): boolean {
        try {
            return vscode.workspace.getConfiguration('gitCommitGenie.repositoryAnalysis').get<boolean>('enabled', true);
        } catch {
            return true;
        }
    }


    private async handleError(result: any): Promise<void> {
        if (result.statusCode === 401) {
            return;
        }
        //TODO: handle other errors
    }
}
