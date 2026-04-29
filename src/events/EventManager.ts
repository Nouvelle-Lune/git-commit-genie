import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ServiceRegistry } from '../core/ServiceRegistry';
import { StatusBarManager } from '../ui/StatusBarManager';
import { Repository } from '../services/git/git';
import { logger } from '../services/logger';

export class EventManager {
    private lastHeadByRepo = new Map<string, string | undefined>();
    private repoDisposables = new Map<string, vscode.Disposable>();
    private initializationAttempted = false;

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
        for (const d of this.repoDisposables.values()) {
            d.dispose();
        }
        this.repoDisposables.clear();
        this.lastHeadByRepo.clear();
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
                            void this.runAnalysisCheck(repo, 'HEADChanged');
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
                this.initializeRepositoryAnalysis();
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
                this.statusBarManager.setRepoAnalysisRunning(true, repoPath);
                analysisService.updateAnalysis(repoPath).catch(err => {
                    logger.error('Failed to update repository analysis on Git change:', err);
                }).finally(() => this.statusBarManager.setRepoAnalysisRunning(false));
            }
        } catch (err) {
            logger.error('Error handling Git change:', err);
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

    private repoFromMdUri(uri: vscode.Uri): string | null {
        try {
            // Use Git API to find the actual repository for this file
            const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
            if (gitExtension) {
                const api = gitExtension.getAPI(1);
                for (const repo of api.repositories) {
                    // Check if this URI is within this repository
                    const repoRoot = repo.rootUri?.fsPath;
                    if (repoRoot && uri.fsPath.startsWith(repoRoot)) {
                        return repoRoot;
                    }
                }
            }

            // Fallback: assume .gitgenie is in repo root
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

        try {
            // Use VS Code Git API to detect repository
            const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
            if (!gitExtension) {
                logger.info('[Genie][RepoAnalysis] VS Code Git extension not found. Skipping analysis init.');
                return;
            }

            const api = gitExtension.getAPI(1);
            if (!api || api.repositories.length === 0) {
                // Retry
                if (!this.initializationAttempted) {
                    this.initializationAttempted = true;

                    // Retry after a delay as a fallback
                    setTimeout(() => {
                        this.initializationAttempted = false;
                        this.initializeRepositoryAnalysis();
                    }, 2000);
                }
                return;
            }

            const repositoryPath = api.repositories[0].rootUri?.fsPath;
            if (!repositoryPath) {
                return;
            }

            // Check if analysis already exists
            const analysisService = this.serviceRegistry.getAnalysisService();
            const existingAnalysis = await analysisService.getAnalysis(repositoryPath);
            if (!existingAnalysis) {
                // Only notify when successfully starting initialization
                logger.info('[Genie][RepoAnalysis] Repository detected, initializing analysis...');
                // Initialize in the background
                this.statusBarManager.setRepoAnalysisRunning(true, repositoryPath);
                analysisService.initializeRepository(repositoryPath).catch(error => {
                    logger.error('Failed to initialize repository analysis:', error);
                }).finally(() => {
                    this.statusBarManager.setRepoAnalysisRunning(false);
                });
            }

            // Mark as successfully initialized
            this.initializationAttempted = true;
        } catch (error) {
            logger.error('Error during repository analysis initialization:', error);
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