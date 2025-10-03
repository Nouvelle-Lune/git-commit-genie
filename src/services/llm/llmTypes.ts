import * as vscode from 'vscode';
import * as fs from 'fs';
import { DiffData } from '../git/gitTypes';
import { TemplateService } from '../../template/templateService';
import { IRepositoryAnalysisService } from '../analysis/analysisTypes';
import { LLMAnalysisResponse, AnalysisPromptParts } from '../analysis/analysisTypes';
import { GitExtension } from '../git/git';

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

    generateCommitMessage(diffs: DiffData[], options?: { token?: vscode.CancellationToken }): Promise<LLMResponse | LLMError>;

    generateRepoAnalysis(analysisPromptParts: AnalysisPromptParts, options?: { token?: vscode.CancellationToken }): Promise<LLMAnalysisResponse | LLMError>;
}

export abstract class BaseLLMService implements LLMService {
    protected context: vscode.ExtensionContext;
    protected templateService: TemplateService;
    protected analysisService?: IRepositoryAnalysisService;

    constructor(context: vscode.ExtensionContext, templateService: TemplateService, analysisService?: IRepositoryAnalysisService) {
        this.context = context;
        this.templateService = templateService;
        this.analysisService = analysisService;
    }

    abstract refreshFromSettings(): Promise<void>;
    abstract validateApiKeyAndListModels(apiKey: string): Promise<string[]>;
    abstract listSupportedModels(): string[];
    abstract setApiKey(apiKey: string): Promise<void>;
    abstract clearApiKey(): Promise<void>;
    abstract generateCommitMessage(diffs: DiffData[], options?: { token?: vscode.CancellationToken }): Promise<LLMResponse | LLMError>;
    abstract generateRepoAnalysis(analysisPromptParts: AnalysisPromptParts, options?: { token?: vscode.CancellationToken }): Promise<LLMAnalysisResponse | LLMError>;

    protected getRepositoryPath(): string | null {
        try {
            // Use VS Code Git API to get repository path safely
            const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git')?.exports;
            if (gitExtension) {
                const api = gitExtension.getAPI(1);
                if (api && api.repositories.length > 0) {
                    return api.repositories[0].rootUri?.fsPath || null;
                }
            }
            return null;
        } catch {
            return null;
        }
    }

    protected getRepoInputBoxValue(): string {
        const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
        const api = gitExtension.getAPI(1);
        const repo = api.repositories[0];
        return repo.inputBox.value || '';
    }

    protected async buildJsonMessage(diffs: DiffData[]): Promise<string> {
        const time = new Date().toLocaleString();

        // Get repository analysis instead of workspace files
        const cfg = vscode.workspace.getConfiguration();
        const templatesPath = this.templateService.getActiveTemplate();

        // Get repository analysis
        let repositoryAnalysis = '';
        if (this.analysisService) {
            try {
                const repositoryPath = this.getRepositoryPath();
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
