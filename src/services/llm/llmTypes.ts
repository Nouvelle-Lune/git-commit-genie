import * as vscode from 'vscode';
import * as fs from 'fs';
import { DiffData } from '../git/gitTypes';
import { TemplateService } from '../../template/templateService';
import { IRepositoryAnalysisService } from '../analysis/analysisTypes';
import { LLMAnalysisResponse, AnalysisPromptParts } from '../analysis/analysisTypes';
import { Repository } from '../git/git';
import { RepoService } from '../repo/repo';

export type ChatRole = 'system' | 'user' | 'assistant' | 'developer';

export interface ChatMessage {
    role: ChatRole;
    content: string;
}

export type RequestType =
    | 'commitMessage'
    | 'summary'
    | 'draft'
    | 'fix'
    | 'repoAnalysis'
    // More granular chain stages for clearer logging
    | 'strictFix'
    | 'enforceLanguage';

export type ChatFn = (
    messages: ChatMessage[],
    options?: {
        model?: string
        temperature?: number
        requestType: RequestType
    }
) => Promise<any>;

/**
 * Represents the response from the LLM service.
 */
export interface LLMResponse {
    content: string;
}

/**
 * Represents an error from the LLM service.
 */
export interface LLMError {
    message: string;
    statusCode?: number;
}

export interface GenerateCommitMessageOptions {
    token?: vscode.CancellationToken;
    targetRepo?: Repository;
}

/**
 * Interface for an LLM service provider.
 */
export interface LLMService {

    refreshFromSettings(): Promise<void>;

    validateApiKeyAndListModels(apiKey: string): Promise<string[]>;

    // Return supported/known models without network calls
    listSupportedModels(): string[];

    setApiKey(apiKey: string): Promise<void>;

    clearApiKey(): Promise<void>;

    generateCommitMessage(diffs: DiffData[], options?: GenerateCommitMessageOptions): Promise<LLMResponse | LLMError>;

    generateRepoAnalysis(analysisPromptParts: AnalysisPromptParts, options: { repositoryPath: string; token?: vscode.CancellationToken }): Promise<LLMAnalysisResponse | LLMError>;
}

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
    abstract generateCommitMessage(diffs: DiffData[], options?: GenerateCommitMessageOptions): Promise<LLMResponse | LLMError>;
    abstract generateRepoAnalysis(analysisPromptParts: AnalysisPromptParts, options: { repositoryPath: string; token?: vscode.CancellationToken }): Promise<LLMAnalysisResponse | LLMError>;

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
                    repositoryAnalysis = JSON.parse(repositoryAnalysis);
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
