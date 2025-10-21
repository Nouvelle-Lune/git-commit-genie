import * as vscode from 'vscode';
import * as path from 'path';
import { GitExtension, API, Repository, Commit, LogOptions } from '../git/git';
import { logger } from '../logger';

/**
 * Repository service for managing Git repository operations
 * Provides utilities for accessing and working with Git repositories through VS Code's Git extension
 */
export class RepoService {
    private gitExtension: GitExtension | undefined;
    private gitApi: API | undefined;

    constructor() {
        this.initialize();
    }

    /**
     * Initialize Git extension and API
     */
    private initialize(): void {
        try {
            this.gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git')?.exports;
            if (this.gitExtension) {
                this.gitApi = this.gitExtension.getAPI(1);
            }
        } catch (error) {
            logger.error('[Genie][RepoService] Failed to initialize Git extension', error);
        }
    }

    /**
     * Get the VS Code Git API
     */
    public getGitApi(): API | undefined {
        if (!this.gitApi) {
            this.initialize();
        }
        return this.gitApi;
    }

    /**
     * Get all available Git repositories
     */
    public getRepositories(): Repository[] {
        const api = this.getGitApi();
        return api?.repositories || [];
    }

    /**
     * Get repository by URI
     */
    public getRepositoryByUri(uri: vscode.Uri): Repository | null {
        try {
            const api = this.getGitApi();
            return api?.getRepository(uri) || null;
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
                const activeRepo = this.getGitApi()?.getRepository(activeUri);
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

    /**
     * Check if Git extension is available
     */
    public isGitAvailable(): boolean {
        return !!this.getGitApi();
    }

    /**
     * Gets the Git commit message log for the repository path.
     * @param repositoryPath Optional path to the Git repository. If not provided, return empty log.
     * @returns A promise that resolves to an array of commit log entries.
     */

    public async getRepositoryGitMessageLog(repositoryPath?: string): Promise<string[]> {
        try {

            let repo: Repository | null = null;


            if (repositoryPath) {
                try {
                    const uri = vscode.Uri.file(repositoryPath);
                    repo = this.getRepositoryByUri(uri);
                } catch { repo = null; }
            }

            if (!repo) {
                return [];
            }
            const commits: Commit[] = await repo.log();

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
        try {

            let repo: Repository | null = null;

            if (repositoryPath) {
                try {
                    const uri = vscode.Uri.file(repositoryPath);
                    repo = this.getRepositoryByUri(uri);

                } catch { repo = null; }
            }

            if (!repo) { return []; }

            const commits: Commit[] = await repo.log(options);
            return commits || [];
        } catch (error) {
            logger.error('Failed to get git commits:', error);
            return [];
        }
    }

}
