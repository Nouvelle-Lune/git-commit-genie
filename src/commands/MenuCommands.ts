import * as vscode from 'vscode';
import * as fs from 'fs';
import { ServiceRegistry } from '../core/ServiceRegistry';
import { StatusBarManager } from '../ui/StatusBarManager';
import { L10N_KEYS as I18N } from '../i18n/keys';

export class MenuCommands {
    constructor(
        private context: vscode.ExtensionContext,
        private serviceRegistry: ServiceRegistry,
        private statusBarManager: StatusBarManager
    ) { }

    async register(): Promise<void> {
        // Genie menu command
        this.context.subscriptions.push(
            vscode.commands.registerCommand('git-commit-genie.genieMenu', this.genieMenu.bind(this))
        );
    }

    private async genieMenu(): Promise<void> {
        const wf = vscode.workspace.workspaceFolders;
        const items: Array<vscode.QuickPickItem & { action: string }> = [];

        items.push({
            label: vscode.l10n.t(I18N.genieMenu.manageModels),
            action: 'models'
        });

        if (this.isRepoAnalysisEnabled() && this.statusBarManager.hasGitRepository()) {
            if (this.statusBarManager.isRepoAnalysisRunning()) {
                items.push({
                    label: vscode.l10n.t(I18N.genieMenu.cancelAnalysis),
                    action: 'cancel'
                });
            } else {
                items.push({
                    label: vscode.l10n.t(I18N.genieMenu.refreshAnalysis),
                    action: 'refresh'
                });
            }
            items.push({
                label: vscode.l10n.t(I18N.genieMenu.openMarkdown),
                action: 'open'
            });
        }

        const pick = await vscode.window.showQuickPick(items, {
            placeHolder: vscode.l10n.t(I18N.genieMenu.placeholder)
        });

        if (!pick) {
            return;
        }

        if (pick.action === 'models') {
            vscode.commands.executeCommand('git-commit-genie.manageModels');
            return;
        }

        if (!wf || wf.length === 0) {
            return;
        }

        const repositoryPath = wf[0].uri.fsPath;

        switch (pick.action) {
            case 'cancel':
                vscode.commands.executeCommand('git-commit-genie.cancelRepositoryAnalysis');
                break;
            case 'refresh':
                vscode.commands.executeCommand('git-commit-genie.refreshRepositoryAnalysis');
                break;
            case 'open':
                await this.openMarkdown(repositoryPath);
                break;
        }
    }

    private async openMarkdown(repositoryPath: string): Promise<void> {
        const analysisService = this.serviceRegistry.getAnalysisService();
        const mdPath = analysisService.getAnalysisMarkdownFilePath(repositoryPath);

        if (fs.existsSync(mdPath)) {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(mdPath));
            await vscode.window.showTextDocument(doc);
        } else {
            vscode.window.showInformationMessage(vscode.l10n.t(I18N.repoAnalysis.mdNotFound));
        }
    }

    private isRepoAnalysisEnabled(): boolean {
        try {
            return vscode.workspace.getConfiguration('gitCommitGenie.repositoryAnalysis').get<boolean>('enabled', true);
        } catch {
            return true;
        }
    }
}