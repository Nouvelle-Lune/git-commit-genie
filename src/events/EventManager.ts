import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ServiceRegistry } from '../core/ServiceRegistry';
import { StatusBarManager } from '../ui/StatusBarManager';
import { Repository } from '../services/git/git';
import { logger } from '../services/logger';

export class EventManager {
    private lastHeadByRepo = new Map<string, string | undefined>();

    constructor(
        private context: vscode.ExtensionContext,
        private serviceRegistry: ServiceRegistry,
        private statusBarManager: StatusBarManager
    ) { }

    async initialize(): Promise<void> {
        await this.setupFileWatchers();
        await this.setupGitWatchers();
        await this.initializeRepositoryAnalysis();
    }

    async dispose(): Promise<void> {
        // Cleanup if needed
    }

    private async setupFileWatchers(): Promise<void> {
        if (!this.isRepoAnalysisEnabled()) {
            return;
        }

        try {
            // Watch for repository-analysis.md changes to refresh the status icon
            const mdWatcher = vscode.workspace.createFileSystemWatcher('**/.gitgenie/repository-analysis.md');

            mdWatcher.onDidCreate(async (uri) => {
                const repo = this.repoFromMdUri(uri);
                if (repo) {
                    await this.serviceRegistry.getAnalysisService().syncAnalysisFromMarkdown(repo).catch(() => { });
                }
                this.statusBarManager.updateStatusBar();
            });

            mdWatcher.onDidChange(async (uri) => {
                const repo = this.repoFromMdUri(uri);
                if (repo) {
                    await this.serviceRegistry.getAnalysisService().syncAnalysisFromMarkdown(repo).catch(() => { });
                }
                this.statusBarManager.updateStatusBar();
            });

            mdWatcher.onDidDelete(async (uri) => {
                const repo = this.repoFromMdUri(uri);
                if (repo) {
                    await this.serviceRegistry.getAnalysisService().clearAnalysis(repo).catch(() => { });
                }
                this.statusBarManager.updateStatusBar();
            });

            this.context.subscriptions.push(mdWatcher);

            // Directory-level watchers to handle full folder deletion/creation and any changes inside
            const dirWatcher = vscode.workspace.createFileSystemWatcher('**/.gitgenie');
            dirWatcher.onDidCreate(() => this.statusBarManager.updateStatusBar());
            dirWatcher.onDidDelete(async (uri) => {
                // If the whole .gitgenie folder is deleted, clear the JSON too
                try {
                    const repo = path.dirname(uri.fsPath);
                    await this.serviceRegistry.getAnalysisService().clearAnalysis(repo);
                } catch { }
                this.statusBarManager.updateStatusBar();
            });
            this.context.subscriptions.push(dirWatcher);

            const anyInDirWatcher = vscode.workspace.createFileSystemWatcher('**/.gitgenie/**');
            anyInDirWatcher.onDidCreate(() => this.statusBarManager.updateStatusBar());
            anyInDirWatcher.onDidDelete(() => this.statusBarManager.updateStatusBar());
            anyInDirWatcher.onDidChange(() => this.statusBarManager.updateStatusBar());
            this.context.subscriptions.push(anyInDirWatcher);
        } catch {
            // ignore errors in file watcher setup
        }
    }

    private async setupGitWatchers(): Promise<void> {
        try {
            // Watch for Git repository initialization (creation/deletion of .git)
            const gitFolderWatcher = vscode.workspace.createFileSystemWatcher('**/.git');
            gitFolderWatcher.onDidCreate(async (uri) => {
                this.statusBarManager.updateStatusBar();
                // Trigger analysis automatically once Git repo is initialized
                await this.initializeRepositoryAnalysis();
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
                // Seed last known HEAD
                const repoPath = repo.rootUri?.fsPath;
                if (repoPath) {
                    this.lastHeadByRepo.set(repoPath, repo.state.HEAD?.commit);
                }

                // Any repository state change (detect HEAD commit changes from all sources)
                const d = repo.state.onDidChange(() => {
                    try {
                        if (!repoPath) {
                            return;
                        }
                        const prev = this.lastHeadByRepo.get(repoPath);
                        const next = repo.state.HEAD?.commit;
                        if (next && next !== prev) {
                            this.lastHeadByRepo.set(repoPath, next);
                            this.runAnalysisCheck(repo, 'HEADChanged');
                        }
                    } catch {
                        // noop
                    }
                });
                this.context.subscriptions.push(d);
            };

            // Attach to existing and future repositories
            for (const r of api.repositories) {
                attachRepoListeners(r);
            }
            api.onDidOpenRepository((repo: Repository) => attachRepoListeners(repo));
        } catch {
            // ignore errors
        }
    }

    private async runAnalysisCheck(repo: Repository, reason: string): Promise<void> {
        try {
            const repoPath = repo.rootUri?.fsPath;
            if (!repoPath) {
                return;
            }
            if (!this.isRepoAnalysisEnabled()) {
                return;
            }

            const analysisService = this.serviceRegistry.getAnalysisService();
            const should = await analysisService.shouldUpdateAnalysis(repoPath);
            if (should) {
                logger.info(`[Genie][RepoAnalysis] Triggered by ${reason}; updating analysis...`);
                this.statusBarManager.setRepoAnalysisRunning(true);
                analysisService.updateAnalysis(repoPath).catch(err => {
                    logger.error('Failed to update repository analysis on Git change:', err);
                }).finally(() => this.statusBarManager.setRepoAnalysisRunning(false));
            }
        } catch (err) {
            logger.error('Error handling Git change:', err);
        }
    }

    private repoFromMdUri(uri: vscode.Uri): string | null {
        try {
            const mdPath = uri.fsPath;
            const dir = path.dirname(mdPath); // .../.gitgenie
            const repo = path.dirname(dir);
            return repo;
        } catch {
            return null;
        }
    }

    private async initializeRepositoryAnalysis(): Promise<void> {
        const enabled = this.isRepoAnalysisEnabled();
        if (!enabled) {
            return;
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            try {
                const repositoryPath = workspaceFolders[0].uri.fsPath;
                // If no Git repository yet, do nothing now; a watcher will trigger once initialized
                if (!fs.existsSync(path.join(repositoryPath, '.git'))) {
                    logger.info('[Genie][RepoAnalysis] Git repository not initialized. Skipping analysis init.');
                    return;
                }

                // Check if analysis already exists
                const analysisService = this.serviceRegistry.getAnalysisService();
                const existingAnalysis = await analysisService.getAnalysis(repositoryPath);
                if (!existingAnalysis) {
                    logger.info('Initializing repository analysis for new workspace...');
                    // Initialize in the background
                    this.statusBarManager.setRepoAnalysisRunning(true);
                    analysisService.initializeRepository(repositoryPath).catch(error => {
                        logger.error('Failed to initialize repository analysis:', error);
                    }).finally(() => {
                        this.statusBarManager.setRepoAnalysisRunning(false);
                    });
                }
            } catch (error) {
                logger.error('Error during repository analysis initialization:', error);
            }
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