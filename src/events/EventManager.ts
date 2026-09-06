import * as vscode from 'vscode';
import { ServiceRegistry } from '../core/ServiceRegistry';
import { StatusBarManager } from '../ui/StatusBarManager';
import { Repository } from '../services/git/git';
import { logger } from '../services/logger';

export class EventManager {
    private lastHeadByRepo = new Map<string, string | undefined>();
    private repoDisposables = new Map<string, vscode.Disposable>();

    constructor(
        private context: vscode.ExtensionContext,
        private serviceRegistry: ServiceRegistry,
        private statusBarManager: StatusBarManager
    ) { }

    async initialize(): Promise<void> {
        await this.setupGitWatchers();
    }

    async dispose(): Promise<void> {
        for (const d of this.repoDisposables.values()) {
            d.dispose();
        }
        this.repoDisposables.clear();
        this.lastHeadByRepo.clear();
    }

    private async setupGitWatchers(): Promise<void> {
        try {
            // Watch for Git repository initialization (creation/deletion of .git)
            const gitFolderWatcher = vscode.workspace.createFileSystemWatcher('**/.git');
            gitFolderWatcher.onDidCreate(() => {
                this.statusBarManager.updateStatusBar();
            });
            gitFolderWatcher.onDidDelete(() => {
                this.statusBarManager.updateStatusBar();
            });
            this.context.subscriptions.push(gitFolderWatcher);

            // Hook into Git changes to drive analysis updates
            this.setupGitChangeListeners();
        } catch {
            // ignore errors in git watcher setup
        }
    }

    private setupGitChangeListeners(): void {
        try {
            const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
            if (!gitExtension) {
                return;
            }

            const api = gitExtension.getAPI(1);

            const attachRepoListeners = (repo: Repository) => {
                const repoPath = repo.rootUri?.fsPath;
                if (!repoPath) {
                    return;
                }

                // Dispose previous listener if repo was previously opened
                const existing = this.repoDisposables.get(repoPath);
                if (existing) {
                    existing.dispose();
                }

                // Seed last known HEAD
                this.lastHeadByRepo.set(repoPath, repo.state.HEAD?.commit);

                // Any repository state change (detect HEAD commit changes from all sources)
                const d = repo.state.onDidChange(() => {
                    try {
                        const prev = this.lastHeadByRepo.get(repoPath);
                        const next = repo.state.HEAD?.commit;
                        if (next && next !== prev) {
                            this.lastHeadByRepo.set(repoPath, next);
                            void this.runPassiveRagIndexingOnHeadChange(repo);
                        }
                    } catch {
                        // noop
                    }
                });
                this.repoDisposables.set(repoPath, d);
            };

            // Attach to existing and future repositories
            for (const r of api.repositories) {
                attachRepoListeners(r);
            }

            // Listen for new repositories being opened/detected
            const onDidOpenRepo = api.onDidOpenRepository((repo: Repository) => {
                attachRepoListeners(repo);
            });
            this.context.subscriptions.push(onDidOpenRepo);

            const onDidCloseRepo = api.onDidCloseRepository((repo: Repository) => {
                const repoPath = repo.rootUri?.fsPath;
                if (repoPath) {
                    this.lastHeadByRepo.delete(repoPath);
                    const disposable = this.repoDisposables.get(repoPath);
                    if (disposable) {
                        disposable.dispose();
                        this.repoDisposables.delete(repoPath);
                    }
                }
            });
            this.context.subscriptions.push(onDidCloseRepo);
        } catch {
            // ignore errors
        }
    }

    private async runPassiveRagIndexingOnHeadChange(repo: Repository): Promise<void> {
        const repoPath = repo.rootUri?.fsPath;
        if (!repoPath) {
            return;
        }

        try {
            const ragRuntimeService = this.serviceRegistry.getRagRuntimeService();
            if (!await ragRuntimeService.isRagEnabled()) {
                logger.info(`[Genie][RAG] Skipping passive HEAD change indexing for ${repoPath}: RAG is disabled.`);
                return;
            }
            if (!await ragRuntimeService.isEmbeddingConfigured()) {
                logger.info(`[Genie][RAG] Skipping passive HEAD change indexing for ${repoPath}: embedding is not configured.`);
                return;
            }
            if (!await ragRuntimeService.hasExistingRepositoryIndex(repo)) {
                logger.info(`[Genie][RAG] Skipping passive HEAD change indexing for ${repoPath}: repository index does not exist.`);
                return;
            }

            await this.serviceRegistry.getRagHistoricalIndexService().ensureRepositoryIndexed(repo, 'HEADChanged');
        } catch (error) {
            logger.error('Error handling passive RAG HEAD change:', error);
        }
    }

}
