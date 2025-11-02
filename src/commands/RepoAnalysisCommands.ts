import * as vscode from 'vscode';
import { ServiceRegistry } from '../core/ServiceRegistry';
import { StatusBarManager } from '../ui/StatusBarManager';
import { L10N_KEYS as I18N } from '../i18n/keys';
import { logger } from '../services/logger';

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

        // Clear repository analysis cache (JSON in globalState)
        this.context.subscriptions.push(
            vscode.commands.registerCommand('git-commit-genie.clearRepositoryAnalysisCache', this.clearRepositoryAnalysisCache.bind(this))
        );
    }

    private async viewRepositoryAnalysis(): Promise<void> {
        if (!this.isRepoAnalysisEnabled()) {
            return;
        }

        const repoService = this.serviceRegistry.getRepoService();
        const repositoryPath = await repoService.pickRepository();
        if (!repositoryPath) {
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
                        this.statusBarManager.setRepoAnalysisRunning(true, repositoryPath);
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

    private async refreshRepositoryAnalysis(repositoryPath?: string): Promise<void> {
        if (!this.isRepoAnalysisEnabled()) {
            return;
        }

        const repoService = this.serviceRegistry.getRepoService();

        // If repositoryPath is not provided, let user pick one
        if (!repositoryPath) {
            const pickedPath = await repoService.pickRepository();
            if (!pickedPath) {
                return;
            }
            repositoryPath = pickedPath;
        }

        try {
            const analysisService = this.serviceRegistry.getAnalysisService();

            let updateResult = 'skipped';
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: vscode.l10n.t(I18N.repoAnalysis.refreshingTitle),
                cancellable: false
            }, async () => {
                this.statusBarManager.setRepoAnalysisRunning(true, repositoryPath);
                try {
                    updateResult = await analysisService.updateAnalysis(repositoryPath!);
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
            // Stop any loading spinners in the webview logs and mark as cancelled
            logger.cancelPendingLogs();
            logger.warn('[Genie][RepoAnalysis] Refresh cancelled by user.');
        } catch {
            // ignore
        }
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

    private async clearRepositoryAnalysisCache(): Promise<void> {
        if (!this.isRepoAnalysisEnabled()) {
            return;
        }

        const repoService = this.serviceRegistry.getRepoService();
        const repositoryPath = await repoService.pickRepository();
        if (!repositoryPath) {
            return;
        }

        // Confirm action with the user
        const cancelLabel = vscode.l10n.t(I18N.cost.cancel);
        const clearLabel = vscode.l10n.t(I18N.repoAnalysis.clear);
        const choice = await vscode.window.showWarningMessage(
            vscode.l10n.t(I18N.repoAnalysis.clearConfirm),
            { modal: true },
            { title: clearLabel },
            { title: cancelLabel, isCloseAffordance: true }

        );
        if (!choice || choice.title !== clearLabel) {
            return;
        }

        try {
            const analysisService = this.serviceRegistry.getAnalysisService();
            await analysisService.clearAnalysis(repositoryPath);
            // Refresh status bar state
            await this.statusBarManager.updateStatusBar();
            vscode.window.showInformationMessage(vscode.l10n.t(I18N.repoAnalysis.cleared));
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to clear repository analysis cache: ${error}`);
        }
    }
}
