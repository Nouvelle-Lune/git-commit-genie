import * as vscode from 'vscode';
import { ServiceRegistry } from '../core/ServiceRegistry';
import { L10N_KEYS as I18N } from '../i18n/keys';
import { repositoryCostToDisplay } from '../services/cost/costDisplay';

export class CostCommands {
    constructor(
        private context: vscode.ExtensionContext,
        private serviceRegistry: ServiceRegistry
    ) { }

    public registerCommands(): void {
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
            const snapshot = await costTracker.getRepositoryCostSnapshot(repoPath);
            const display = repositoryCostToDisplay(snapshot);

            switch (display.status) {
                case 'none':
                    vscode.window.showInformationMessage(vscode.l10n.t(I18N.cost.noCostRecorded));
                    break;
                case 'free':
                    vscode.window.showInformationMessage(vscode.l10n.t(I18N.cost.totalCostFree));
                    break;
                case 'partial':
                    vscode.window.showInformationMessage(
                        vscode.l10n.t(I18N.cost.totalCostPartial, (display.amountUsd ?? 0).toFixed(6)),
                    );
                    break;
                default:
                    vscode.window.showInformationMessage(
                        vscode.l10n.t(I18N.cost.totalCost, (display.amountUsd ?? snapshot.totalUsd).toFixed(6)),
                    );
                    break;
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
