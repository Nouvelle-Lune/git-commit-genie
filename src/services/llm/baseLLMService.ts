import * as vscode from 'vscode';
import * as fs from 'fs';
import { DiffData } from '../git/gitTypes';
import { TemplateService } from '../../template/templateService';
import { IRepositoryAnalysisService } from '../analysis/repository/repositoryAnalysisTypes';
import { Repository } from '../git/git';
import { RepoService } from '../repo/repo';
import { ProviderError } from './providers/errors/providerError';
import {
    LLMService,
    LLMResponse,
    LLMError,
    GenerateCommitMessageOptions,
    LLMExecution,
} from './llmTypes';

/**
 * Base class for all LLM service providers
 * Provides common functionality and enforces consistent interface
 */
export abstract class BaseLLMService implements LLMService {
    protected context: vscode.ExtensionContext;
    protected templateService: TemplateService;
    protected analysisService?: IRepositoryAnalysisService;
    protected repoService: RepoService;

    constructor(context: vscode.ExtensionContext, templateService: TemplateService, analysisService?: IRepositoryAnalysisService) {
        this.context = context;
        this.templateService = templateService;
        this.analysisService = analysisService;
        this.repoService = new RepoService();
    }

    abstract refreshFromSettings(): Promise<void>;
    abstract validateApiKeyAndListModels(apiKey: string): Promise<string[]>;
    abstract listSupportedModels(): string[];
    abstract setApiKey(apiKey: string): Promise<void>;
    abstract clearApiKey(): Promise<void>;
    abstract createExecution(repoPath?: string, options?: GenerateCommitMessageOptions): LLMExecution;
    abstract generateCommitMessage(diffs: DiffData[], options?: GenerateCommitMessageOptions): Promise<LLMResponse | LLMError>;

    /**
     * Get the provider name for error messages
     * @returns Provider display name (e.g., 'OpenAI', 'Anthropic')
     */
    protected abstract getProviderName(): string;

    /**
     * Get the current model configuration
     * @returns Model string or empty string if not configured
     */
    protected abstract getCurrentModel(): string;

    /**
     * Create a standardized LLMError for API key not set
     */
    protected createApiKeyNotSetError(): LLMError {
        const error = ProviderError.apiKeyNotSet(this.getProviderName());
        return {
            message: error.message,
            statusCode: error.statusCode
        };
    }

    /**
     * Create a standardized LLMError for model not selected
     */
    protected createModelNotSelectedError(): LLMError {
        const error = ProviderError.modelNotSelected(this.getProviderName());
        return {
            message: error.message,
            statusCode: error.statusCode
        };
    }

    /**
     * Convert any error to standardized LLMError
     */
    protected convertToLLMError(error: any): LLMError {
        if (error instanceof ProviderError) {
            return {
                message: error.message,
                statusCode: error.statusCode
            };
        }
        return {
            message: error?.message || `An unknown error occurred with the ${this.getProviderName()} API.`,
            statusCode: error?.status || error?.statusCode || 500
        };
    }

    protected getRepositoryPath(repo?: Repository | null): string | null {
        try {
            if (repo) {
                return this.repoService.getRepositoryPath(repo);
            }
            const activeRepo = this.repoService.getActiveRepository();
            if (!activeRepo) { return null; }
            return this.repoService.getRepositoryPath(activeRepo);
        } catch {
            return null;
        }
    }

    protected getRepoInputBoxValue(repo?: Repository | null): string {
        try {
            if (repo) {
                return repo.inputBox?.value || '';
            }
            return this.repoService.getRepoInputBoxValue();
        } catch {
            return '';
        }
    }

    protected getRepoPathForLogging(targetRepo?: Repository | null): string {
        return this.getRepositoryPath(targetRepo) || '';
    }

    protected async buildJsonMessage(diffs: DiffData[], targetRepo?: Repository): Promise<string> {
        const time = new Date().toLocaleString();

        // Get repository analysis instead of workspace files
        const cfg = vscode.workspace.getConfiguration();
        const templatesPath = this.templateService.getActiveTemplate();

        // Get repository analysis
        let repositoryAnalysis = '';
        if (this.analysisService) {
            try {
                const repositoryPath = this.getRepositoryPath(targetRepo);
                if (repositoryPath) {
                    repositoryAnalysis = await this.analysisService.getAnalysisForPrompt(repositoryPath);
                    if (repositoryAnalysis) {
                        repositoryAnalysis = JSON.parse(repositoryAnalysis);
                    }
                }
            } catch (error) {
                console.error('Failed to get repository analysis:', error);
                repositoryAnalysis = '';
            }
        }

        let userTemplateContent = '';
        if (templatesPath && typeof templatesPath === 'string' && templatesPath.trim()) {
            try {
                if (fs.existsSync(templatesPath)) {
                    const stat = fs.statSync(templatesPath);
                    if (stat.isFile() && stat.size > 0) {
                        const content = fs.readFileSync(templatesPath, 'utf-8');
                        if (content && content.trim().length > 0) {
                            userTemplateContent = content;
                        }
                    }
                }
            } catch {
                userTemplateContent = '';
            }
        }

        // Preferred output language for generated commit message
        let targetLanguage = cfg.get<string>('gitCommitGenie.commitLanguage', 'auto') || 'auto';
        if (!targetLanguage || targetLanguage === 'auto') {
            try { targetLanguage = (vscode.env.language || 'en'); } catch { targetLanguage = 'en'; }
        }

        const data = {
            "diffs": diffs.map(diff => ({
                fileName: diff.fileName,
                rawDiff: diff.rawDiff,
                status: diff.status
            })),
            "current-time": time,
            "repository-analysis": repositoryAnalysis,
            "user-template": userTemplateContent,
            "target-language": targetLanguage
        };
        return JSON.stringify(data, null, 2);
    }
}
