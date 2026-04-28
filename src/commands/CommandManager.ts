import * as vscode from 'vscode';
import { ServiceRegistry } from '../core/ServiceRegistry';
import { StatusBarManager } from '../ui/StatusBarManager';
import { L10N_KEYS as I18N } from '../i18n/keys';
import { ModelCommands } from './ModelCommands';
import { GenerateCommands } from './GenerateCommands';
import { RepoAnalysisCommands } from './RepoAnalysisCommands';
import { MenuCommands } from './MenuCommands';
import { CostCommands } from './CostCommands';
import { Repository } from '../services/git/git';

export class CommandManager {
    private modelCommands!: ModelCommands;
    private generateCommands!: GenerateCommands;
    private repoAnalysisCommands!: RepoAnalysisCommands;
    private menuCommands!: MenuCommands;
    private costCommands!: CostCommands;

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
        this.costCommands = new CostCommands(this.context, this.serviceRegistry);

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
        this.costCommands.registerCommands();

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
                        I18N.chain.toggled,
                        !current ? vscode.l10n.t(I18N.chain.enabled) : vscode.l10n.t(I18N.chain.disabled)
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

        this.context.subscriptions.push(
            vscode.commands.registerCommand('git-commit-genie.configureRagEmbeddingApiKey', async () => {
                const apiKey = await vscode.window.showInputBox({
                    title: vscode.l10n.t(I18N.rag.enterEmbeddingKeyTitle),
                    prompt: vscode.l10n.t(I18N.rag.enterEmbeddingKeyPrompt),
                    placeHolder: vscode.l10n.t(I18N.rag.enterEmbeddingKeyPrompt),
                    password: true,
                    ignoreFocusOut: true,
                });
                if (!apiKey) {
                    return;
                }

                await this.serviceRegistry.getRagRuntimeService().setEmbeddingApiKey(apiKey);
                vscode.window.showInformationMessage(vscode.l10n.t(I18N.rag.embeddingKeySaved));
            })
        );

        this.context.subscriptions.push(
            vscode.commands.registerCommand('git-commit-genie.clearRagEmbeddingApiKey', async () => {
                await this.serviceRegistry.getRagRuntimeService().clearEmbeddingApiKey();
                vscode.window.showInformationMessage(vscode.l10n.t(I18N.rag.embeddingKeyCleared));
            })
        );

        this.context.subscriptions.push(
            vscode.commands.registerCommand('git-commit-genie.startRagIndexing', async (arg?: any) => {
                try {
                    const repo = await this.resolveRagTargetRepository(arg, false);
                    if (!repo) {
                        return;
                    }

                    const repoPath = repo.rootUri.fsPath;
                    const repoLabel = this.serviceRegistry.getRepoService().getRepositoryLabel(repo);
                    const ragRuntime = this.serviceRegistry.getRagRuntimeService();
                    if (!await ragRuntime.isEmbeddingConfigured()) {
                        vscode.window.showErrorMessage(vscode.l10n.t(I18N.rag.backendNotConfigured));
                        return;
                    }
                    const ragHistory = this.serviceRegistry.getRagHistoricalIndexService();
                    if (ragHistory.isRepositoryIndexing(repoPath)) {
                        vscode.window.showInformationMessage(vscode.l10n.t(I18N.rag.indexingAlreadyRunning, repoLabel));
                        return;
                    }

                    vscode.window.showInformationMessage(vscode.l10n.t(I18N.rag.indexingStarted, repoLabel));
                    await vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: vscode.l10n.t(I18N.rag.statusImporting),
                        cancellable: true,
                    }, async (_progress, token) => {
                        token.onCancellationRequested(() => {
                            ragHistory.cancelRepositoryIndexing(repoPath);
                        });

                        await ragHistory.ensureRepositoryIndexed(repo, 'command-start');
                    });

                    const status = ragRuntime.getRepositoryStatus(repoPath);
                    if (status?.kind === 'error') {
                        return;
                    }
                    if (status?.text === vscode.l10n.t(I18N.rag.statusIndexingCancelled)) {
                        vscode.window.showInformationMessage(vscode.l10n.t(I18N.rag.indexingCancelled, repoLabel));
                        return;
                    }
                    vscode.window.showInformationMessage(vscode.l10n.t(I18N.rag.indexingCompleted, repoLabel));
                } catch (error: any) {
                    vscode.window.showErrorMessage(vscode.l10n.t(I18N.rag.statusImportFailed, error?.message || String(error)));
                }
            })
        );

        this.context.subscriptions.push(
            vscode.commands.registerCommand('git-commit-genie.repairRagEmbeddings', async (arg?: any) => {
                const repo = await this.resolveRagTargetRepository(arg, false);
                if (!repo) {
                    return;
                }
                const ragRuntime = this.serviceRegistry.getRagRuntimeService();
                if (!await ragRuntime.isEmbeddingConfigured()) {
                    vscode.window.showErrorMessage(vscode.l10n.t(I18N.rag.backendNotConfigured));
                    return;
                }
                await this.serviceRegistry.getRagHistoricalIndexService().repairRepositoryEmbeddings(repo);
            })
        );

        this.context.subscriptions.push(
            vscode.commands.registerCommand('git-commit-genie.cancelRagIndexing', async (arg?: any) => {
                const repo = await this.resolveRagTargetRepository(arg, true);
                if (!repo) {
                    vscode.window.showInformationMessage(vscode.l10n.t(I18N.rag.indexingNothingToCancel));
                    return;
                }

                const repoPath = repo.rootUri.fsPath;
                const repoLabel = this.serviceRegistry.getRepoService().getRepositoryLabel(repo);
                this.serviceRegistry.getRagHistoricalIndexService().cancelRepositoryIndexing(repoPath);
                vscode.window.showInformationMessage(vscode.l10n.t(I18N.rag.indexingCancelRequested, repoLabel));
            })
        );

    }

    private async resolveRagTargetRepository(arg?: any, onlyIndexing?: boolean): Promise<Repository | null> {
        const repoService = this.serviceRegistry.getRepoService();
        const ragHistory = this.serviceRegistry.getRagHistoricalIndexService();

        if (arg?.rootUri) {
            const repo = repoService.getRepositoryByUri(arg.rootUri);
            if (!onlyIndexing || (repo && ragHistory.isRepositoryIndexing(repo.rootUri.fsPath))) {
                return repo;
            }
        }

        const activeRepo = repoService.getActiveRepository();
        if (activeRepo && (!onlyIndexing || ragHistory.isRepositoryIndexing(activeRepo.rootUri.fsPath))) {
            return activeRepo;
        }

        const candidateRepos = onlyIndexing
            ? repoService.getRepositories().filter(repo => ragHistory.isRepositoryIndexing(repo.rootUri.fsPath))
            : repoService.getRepositories();

        if (candidateRepos.length === 0) {
            return null;
        }
        if (candidateRepos.length === 1) {
            return candidateRepos[0];
        }

        const selected = await vscode.window.showQuickPick(candidateRepos.map(repo => ({
            label: repoService.getRepositoryLabel(repo) || 'Unknown',
            description: repo.rootUri.fsPath,
            repo,
        })), {
            placeHolder: vscode.l10n.t(I18N.repoAnalysis.selectRepository),
            matchOnDescription: true,
        });

        return selected?.repo || null;
    }
}
