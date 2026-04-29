import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { GitExtension, API, Repository, Commit, LogOptions } from '../git/git';
import { logger } from '../logger';
import { L10N_KEYS as I18N } from '../../i18n/keys';

/**
 * Repository service for managing Git repository operations
 * Provides utilities for accessing and working with Git repositories through VS Code's Git extension
 */
export class RepoService {
    private gitExtension: GitExtension | undefined;
    private gitApi: API | undefined;
    private initPromise: Promise<void> | undefined;
    private initialized: boolean = false;

    constructor() {
        this.initPromise = this.initialize();
    }

    /**
     * Returns a promise that resolves when initial Git API initialization completes.
     * Note: Repositories may still be empty if none are detected within the internal timeout.
     */
    public async whenReady(): Promise<void> {
        try {
            await this.initPromise;
        } catch {
            // Swallow errors to avoid blocking callers; callers should handle missing API gracefully
        }
    }

    /**
     * Indicates whether the Git API has been initialized.
     */
    public isInitialized(): boolean {
        return this.initialized && !!this.gitApi;
    }

    /**
     * Initialize Git extension and API
     */
    private async initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }

        try {
            this.gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git')?.exports;
            if (this.gitExtension) {
                this.gitApi = this.gitExtension.getAPI(1);

                // Wait for Git API to be ready and have repositories loaded
                // The Git extension might need time to discover repositories
                if (this.gitApi) {
                    // If repositories are already available, we're good
                    if (this.gitApi.repositories.length === 0) {
                        // Wait for repositories to be discovered
                        await new Promise<void>((resolve) => {
                            const gitApi = this.gitApi!; // We know it exists here

                            const checkRepositories = () => {
                                if (gitApi.repositories.length > 0) {
                                    resolve();
                                } else {
                                    // Check again after a short delay
                                    setTimeout(checkRepositories, 100);
                                }
                            };

                            // Also listen to repository changes
                            const disposable = gitApi.onDidOpenRepository(() => {
                                disposable.dispose();
                                resolve();
                            });

                            // Start checking
                            setTimeout(checkRepositories, 100);

                            // Set a timeout to prevent infinite waiting
                            setTimeout(() => {
                                disposable.dispose();
                                resolve();
                            }, 5000); // Wait max 5 seconds
                        });
                    }
                }

                this.initialized = true;
            }
        } catch (error) {
            logger.error('[Genie][RepoService] Failed to initialize Git extension', error);
            this.initialized = true; // Mark as initialized even on error to prevent infinite retries
        }
    }

    /**
     * Get the VS Code Git API
     * Note: May return undefined if called before initialization completes
     */
    public getGitApi(): API | undefined {
        return this.gitApi;
    }

    /**
     * Get all available Git repositories
     * Note: May return empty array if called before initialization completes
     */
    public getRepositories(): Repository[] {
        return this.gitApi?.repositories || [];
    }

    /**
     * Get repository by URI
     */
    public getRepositoryByUri(uri: vscode.Uri): Repository | null {
        try {
            return this.gitApi?.getRepository(uri) || null;
        } catch (error) {
            logger.error('[Genie][RepoService] Failed to get repository by URI', error);
            return null;
        }
    }

    /**
     * Get the currently selected or active repository
     */
    public getActiveRepository(): Repository | null {
        try {
            const repositories = this.getRepositories();
            if (repositories.length === 0) {
                return null;
            }

            // 1. Try to find UI-selected repository
            const selected = repositories.find((r: any) => r.ui?.selected);
            if (selected) {
                return selected;
            }

            // 2. Try to find repository of active editor
            const activeUri = vscode.window.activeTextEditor?.document?.uri;
            if (activeUri) {
                const activeRepo = this.gitApi?.getRepository(activeUri);
                if (activeRepo) {
                    return activeRepo;
                }
            }

            // 3. If only one repository, return it
            if (repositories.length === 1) {
                return repositories[0];
            }

            // 4. Fallback to first repository
            return repositories[0] || null;
        } catch (error) {
            logger.error('[Genie][RepoService] Failed to get active repository', error);
            return null;
        }
    }

    /**
     * Get the file system path of the currently active repository
     */
    public getRepositoryPath(repo: Repository): string | null {
        try {
            return repo?.rootUri?.fsPath || null;
        } catch (error) {
            logger.error('[Genie][RepoService] Failed to get repository path', error);
            return null;
        }
    }

    /**
     * Resolve the repository's actual git directory. This must not assume
     * repoRoot/.git because worktrees and submodules can use indirection.
     */
    public async getRepositoryGitDir(repo: Repository): Promise<string | null> {
        try {
            const cwd = repo?.rootUri?.fsPath;
            if (!cwd) {
                return null;
            }

            const gitPath = this.gitApi?.git?.path || 'git';
            const gitDir = await this.execGit(gitPath, cwd, ['rev-parse', '--absolute-git-dir']);
            return gitDir || null;
        } catch (error) {
            logger.error('[Genie][RepoService] Failed to resolve repository git dir', error);
            return null;
        }
    }

    public async getActiveRepositoryGitDir(): Promise<string | null> {
        const repo = this.getActiveRepository();
        if (!repo) {
            return null;
        }
        return this.getRepositoryGitDir(repo);
    }

    /**
     * Get the input box value of the active repository
     */
    public getRepoInputBoxValue(): string {
        try {
            const repo = this.getActiveRepository();
            return repo?.inputBox?.value || '';
        } catch (error) {
            logger.error('[Genie][RepoService] Failed to get input box value', error);
            return '';
        }
    }

    /**
     * Get a human-readable label for the specified or active repository.
     * Defaults to the repository folder name.
     */
    public getRepositoryLabel(repo?: Repository | null): string {
        try {
            const targetRepo = repo ?? this.getActiveRepository();
            if (!targetRepo) {
                return '';
            }
            const repoPath = this.getRepositoryPath(targetRepo);
            if (!repoPath) {
                return '';
            }
            return path.basename(repoPath);
        } catch (error) {
            logger.error('[Genie][RepoService] Failed to get repository label', error);
            return '';
        }
    }

    private async execGit(gitPath: string, cwd: string, args: string[]): Promise<string> {
        return await new Promise<string>((resolve, reject) => {
            execFile(gitPath, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(stderr || error.message));
                    return;
                }
                resolve(String(stdout || '').trim());
            });
        });
    }

    /**
     * Check if Git extension is available
     */
    public isGitAvailable(): boolean {
        return !!this.gitApi;
    }

    /**
     * Pick a repository from available repositories when multiple exist.
     * Shows a quick pick UI for user selection when there are multiple repositories.
     * Returns null if user cancels or no repository is available.
     * @param placeHolder Optional placeholder text for the quick pick
     * @returns The repository path or null
     */
    public async pickRepository(placeHolder?: string): Promise<string | null> {
        const repositories = this.getRepositories();

        if (repositories.length === 0) {
            vscode.window.showErrorMessage(vscode.l10n.t(I18N.common.noGitRepository));
            return null;
        }

        // If only one repository, return it directly
        if (repositories.length === 1) {
            return this.getRepositoryPath(repositories[0]);
        }

        // Multiple repositories: show quick pick
        const items = repositories.map(repo => {
            const repoPath = this.getRepositoryPath(repo);
            const label = this.getRepositoryLabel(repo);
            return {
                label: label || 'Unknown',
                description: repoPath || '',
                path: repoPath
            };
        });

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: placeHolder || vscode.l10n.t('Select a repository'),
            matchOnDescription: true
        });

        return selected?.path || null;
    }

    /**
     * Gets the Git commit message log for the repository path.
     * @param repositoryPath Optional path to the Git repository. If not provided, return empty log.
     * @returns A promise that resolves to an array of commit log entries.
     */

    public async getRepositoryGitMessageLog(repositoryPath?: string): Promise<string[]> {
        try {
            const commits = await this.getRepositoryCommits(undefined, repositoryPath);
            if (!commits.length) {
                return [];
            }
            return commits.map(commit => commit.message.trim());
        } catch (error) {
            logger.error('Failed to get git commit log:', error);
            return [];
        }
    }


    /**
     * Get recent commits (hash, message, dates) from the repository path.
     * @param options Optional log options such as maxEntries.
     */
    public async getRepositoryCommits(options?: LogOptions, repositoryPath?: string): Promise<Commit[]> {
        const repoPath = repositoryPath || this.getRepositoryPath(this.getActiveRepository() as Repository);
        if (!repoPath) { return []; }

        try {
            const gitPath = this.gitApi?.git?.path || 'git';
            const args = this.buildGitLogArgs(options);
            const output = await this.execGit(gitPath, repoPath, args);
            return this.parseGitLogOutput(output);
        } catch (error) {
            logger.error('Failed to get git commits:', error);
            throw error;
        }
    }

    public async getRepositoryCommitCount(repositoryPath?: string): Promise<number> {
        const repoPath = repositoryPath || this.getRepositoryPath(this.getActiveRepository() as Repository);
        if (!repoPath) {
            return 0;
        }

        try {
            const gitPath = this.gitApi?.git?.path || 'git';
            const output = await this.execGit(gitPath, repoPath, ['rev-list', '--count', 'HEAD']);
            const count = Number.parseInt(output, 10);
            return Number.isFinite(count) && count > 0 ? count : 0;
        } catch (error) {
            logger.error('Failed to get repository commit count:', error);
            return 0;
        }
    }

    private buildGitLogArgs(options?: LogOptions): string[] {
        const args = ['log', '--format=%H%x1f%P%x1f%aI%x1f%an%x1f%ae%x1f%cI%x1f%B%x1e'];

        if (options?.reverse) {
            args.push('--reverse');
        }
        if (options?.sortByAuthorDate) {
            args.push('--author-date-order');
        }
        if (typeof options?.maxEntries === 'number' && options.maxEntries > 0) {
            args.push(`-n${options.maxEntries}`);
        }
        if (typeof options?.skip === 'number' && options.skip > 0) {
            args.push(`--skip=${options.skip}`);
        }
        if (typeof options?.maxParents === 'number') {
            args.push(`--max-parents=${options.maxParents}`);
        }
        if (options?.author) {
            args.push(`--author=${options.author}`);
        }
        if (options?.grep) {
            args.push(`--grep=${options.grep}`);
        }
        if (options?.refNames?.length) {
            args.push(...options.refNames);
        } else if (options?.range) {
            args.push(options.range);
        }
        if (options?.path) {
            args.push('--', options.path);
        }

        return args;
    }

    private parseGitLogOutput(output: string): Commit[] {
        if (!output.trim()) {
            return [];
        }

        const records = output
            .split('\x1e')
            .map(record => record.trim())
            .filter(Boolean);

        return records.map((record) => {
            const fields = record.split('\x1f');
            const [
                hash = '',
                parentsRaw = '',
                authorDateRaw = '',
                authorName = '',
                authorEmail = '',
                commitDateRaw = '',
                ...messageParts
            ] = fields;

            const message = messageParts.join('\x1f').trim();
            return {
                hash,
                parents: parentsRaw ? parentsRaw.split(' ').filter(Boolean) : [],
                authorDate: this.parseGitDate(authorDateRaw),
                authorName: authorName || undefined,
                authorEmail: authorEmail || undefined,
                commitDate: this.parseGitDate(commitDateRaw),
                message,
            } as Commit;
        });
    }

    private parseGitDate(value: string): Date | undefined {
        if (!value) {
            return undefined;
        }
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? undefined : date;
    }

}
