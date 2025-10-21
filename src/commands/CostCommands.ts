import * as vscode from 'vscode';
import { ServiceRegistry } from '../core/ServiceRegistry';

export class CostCommands {
    constructor(
        private context: vscode.ExtensionContext,
        private serviceRegistry: ServiceRegistry
    ) { }

    public registerCommands(): void {
        // Register cost-related commands
        this.context.subscriptions.push(
            vscode.commands.registerCommand('git-commit-genie.showRepositoryCost', this.showRepositoryCost.bind(this))
        );

        this.context.subscriptions.push(
            vscode.commands.registerCommand('git-commit-genie.resetRepositoryCost', this.resetRepositoryCost.bind(this))
        );
    }

    private async showRepositoryCost(): Promise<void> {
        try {
            const repoService = this.serviceRegistry.getRepoService();
            const repo = repoService.getActiveRepository();
            if (!repo) {
                vscode.window.showWarningMessage(
                    vscode.l10n.t('No active Git repository detected. Open a repository before viewing cost.')
                );
                return;
            }

            const repoPath = repoService.getRepositoryPath(repo);
            if (!repoPath) {
                vscode.window.showWarningMessage(
                    vscode.l10n.t('Unable to resolve the repository path. Please try again.')
                );
                return;
            }

            const costTracker = this.serviceRegistry.getCostTrackingService();
            const cost = await costTracker.getRepositoryCost(repoPath);
            const formattedCost = cost.toFixed(6);

            if (cost === 0) {
                vscode.window.showInformationMessage(
                    vscode.l10n.t('No Genie usage cost recorded for this repository yet.')
                );
            } else {
                vscode.window.showInformationMessage(
                    vscode.l10n.t('Total Genie usage cost for this repository: ${0}', formattedCost)
                );
            }
        } catch (error) {
            vscode.window.showErrorMessage(
                vscode.l10n.t('Failed to get repository cost: {0}', String(error))
            );
        }
    }

    private async resetRepositoryCost(): Promise<void> {
        try {
            const choice = await vscode.window.showWarningMessage(
                vscode.l10n.t('Are you sure you want to reset the cost tracking for this repository?'),
                { modal: true, detail: vscode.l10n.t('This action cannot be undone.') },
                {
                    title: vscode.l10n.t('Reset')
                },
                {
                    title: vscode.l10n.t('Cancel'),
                    isCloseAffordance: true
                }
            );

            if (choice?.title === vscode.l10n.t('Reset')) {
                const repoService = this.serviceRegistry.getRepoService();
                const repo = repoService.getActiveRepository();
                if (!repo) {
                    vscode.window.showWarningMessage(
                        vscode.l10n.t('No active Git repository detected. Open a repository before resetting cost.')
                    );
                    return;
                }

                const repoPath = repoService.getRepositoryPath(repo);
                if (!repoPath) {
                    vscode.window.showWarningMessage(
                        vscode.l10n.t('Unable to resolve the repository path. Please try again.')
                    );
                    return;
                }

                const costTracker = this.serviceRegistry.getCostTrackingService();
                await costTracker.resetRepositoryCost(repoPath);
                vscode.window.showInformationMessage(
                    vscode.l10n.t('Repository cost has been reset to $0.00')
                );
            }
        } catch (error) {
            vscode.window.showErrorMessage(
                vscode.l10n.t('Failed to reset repository cost: {0}', String(error))
            );
        }
    }
}
