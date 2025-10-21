import * as vscode from 'vscode';
import { GitExtension, API, Repository } from '../git/git';
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
     * Resolve a repository based on an optional command argument or current UI context.
     * Resolution order:
     * 1. If arg is a repository-like object with rootUri, return it
     * 2. If arg has resourceUri, map it to its repository via Git API
     * 3. Otherwise, fall back to getActiveRepository()
     */
    public getRepository(arg?: any): Repository | null {
        try {
            const api = this.getGitApi();
            if (!api) { return null; }

            // 1) Explicit repository object
            if (arg && typeof arg === 'object' && arg.rootUri?.fsPath) {
                return arg as Repository;
            }

            // 2) Resource URI -> repository
            if (arg && typeof arg === 'object' && arg.resourceUri?.fsPath) {
                const repo = api.getRepository(arg.resourceUri);
                if (repo) { return repo; }
            }

            // 3) Fallback resolution
            return this.getActiveRepository();
        } catch (error) {
            logger.error('[Genie][RepoService] Failed to resolve repository', error);
            return null;
        }
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
    public getRepositoryPath(): string | null {
        try {
            const repo = this.getActiveRepository();
            return repo?.rootUri?.fsPath || null;
        } catch (error) {
            logger.error('[Genie][RepoService] Failed to get repository path', error);
            return null;
        }
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
     * Check if Git extension is available
     */
    public isGitAvailable(): boolean {
        return !!this.getGitApi();
    }

}
