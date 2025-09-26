import * as vscode from 'vscode';
import { ServiceRegistry } from '../core/ServiceRegistry';
import { StatusBarManager } from '../ui/StatusBarManager';
import { ModelCommands } from './ModelCommands';
import { GenerateCommands } from './GenerateCommands';
import { RepoAnalysisCommands } from './RepoAnalysisCommands';
import { MenuCommands } from './MenuCommands';

export class CommandManager {
    private modelCommands!: ModelCommands;
    private generateCommands!: GenerateCommands;
    private repoAnalysisCommands!: RepoAnalysisCommands;
    private menuCommands!: MenuCommands;

    constructor(
        private context: vscode.ExtensionContext,
        private serviceRegistry: ServiceRegistry,
        private statusBarManager: StatusBarManager
    ) { }

    async initialize(): Promise<void> {
        // Initialize command modules
        this.modelCommands = new ModelCommands(this.context, this.serviceRegistry, this.statusBarManager);
        this.generateCommands = new GenerateCommands(this.context, this.serviceRegistry);
        this.repoAnalysisCommands = new RepoAnalysisCommands(this.context, this.serviceRegistry, this.statusBarManager);
        this.menuCommands = new MenuCommands(this.context, this.serviceRegistry, this.statusBarManager);

        // Register all commands
        await this.registerAllCommands();
    }

    async dispose(): Promise<void> {
        // Cleanup if needed
    }

    private async registerAllCommands(): Promise<void> {
        await this.modelCommands.register();
        await this.generateCommands.register();
        await this.repoAnalysisCommands.register();
        await this.menuCommands.register();

        // Register global commands
        this.registerGlobalCommands();
    }

    private registerGlobalCommands(): void {
        // Template selection / creation
        this.context.subscriptions.push(
            vscode.commands.registerCommand('git-commit-genie.selectTemplate', async () => {
                await this.serviceRegistry.getTemplateService().openQuickPicker();
            })
        );

        // Toggle chain prompting mode
        this.context.subscriptions.push(
            vscode.commands.registerCommand('git-commit-genie.toggleChainMode', async () => {
                const currentCfg = vscode.workspace.getConfiguration();
                // Prefer new key if present or previously set
                let current = currentCfg.get<boolean>('gitCommitGenie.chain.enabled');
                if (typeof current !== 'boolean') {
                    current = currentCfg.get<boolean>('gitCommitGenie.useChainPrompts', false);
                }
                await currentCfg.update('gitCommitGenie.chain.enabled', !current, vscode.ConfigurationTarget.Global);

                this.statusBarManager.updateStatusBar();
                vscode.window.showInformationMessage(
                    vscode.l10n.t(
                        'chain.toggled',
                        !current ? vscode.l10n.t('chain.enabled') : vscode.l10n.t('chain.disabled')
                    )
                );
            })
        );

        // Status bar update command (for configuration changes)
        this.context.subscriptions.push(
            vscode.commands.registerCommand('git-commit-genie.updateStatusBar', () => {
                this.statusBarManager.updateStatusBar();
            })
        );
    }
}