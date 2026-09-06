import * as vscode from 'vscode';
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
            label: vscode.l10n.t(I18N.genieMenu.toggleThinking),
            action: 'toggle'
        });

        items.push({
            label: vscode.l10n.t(I18N.genieMenu.manageModels),
            action: 'models'
        });

        items.push({ label: vscode.l10n.t('Repository Memory'), action: 'memory' });

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

        switch (pick.action) {
            case 'toggle':
                await vscode.commands.executeCommand('git-commit-genie.toggleChainMode');
                break;
            case 'memory':
                await vscode.commands.executeCommand('git-commit-genie.manageMemory');
                break;
        }
    }
}
