import * as vscode from 'vscode';
import * as fs from 'fs';
import { z } from 'zod';
import { DiffData } from '../git/gitTypes';
import { TemplateService } from '../../template/templateService';
import { IRepositoryAnalysisService } from '../analysis/analysisTypes';
import { Repository } from '../git/git';
import { RepoService } from '../repo/repo';
import { ProviderError } from './providers/errors/providerError';
import { logger } from '../logger';
import {
    LLMService,
    LLMResponse,
    LLMError,
    GenerateCommitMessageOptions,
    ChatMessage
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
    abstract generateCommitMessage(diffs: DiffData[], options?: GenerateCommitMessageOptions): Promise<LLMResponse | LLMError>;

    /**
     * Get the LLM client instance for raw chat operations
     * @returns Client instance or null if not initialized
     */
    protected abstract getClient(): any | null;

    /**
     * Get the provider utils instance for chat operations
     * @returns Utils instance with callChatCompletion method
     */
    protected abstract getUtils(): any;

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

    /**
     * Build retry messages when schema validation fails
     * This method creates a conversation continuation with error feedback
     * 
     * @param originalMessages Original conversation messages
     * @param lastResponse The failed response from the LLM
     * @param validationError The Zod validation error
     * @param schema The Zod schema that failed validation
     * @param requestType Optional request type for logging context
     * @returns Updated messages array with error feedback
     */
    protected buildSchemaValidationRetryMessages(
        originalMessages: ChatMessage[],
        lastResponse: { parsedAssistantResponse?: ChatMessage; parsedResponse?: any },
        validationError: z.ZodError,
        schema: z.ZodSchema,
        requestType?: string
    ): ChatMessage[] {
        const jsonSchemaString = JSON.stringify(z.toJSONSchema(schema), null, 2);

        return [
            ...originalMessages,
            lastResponse.parsedAssistantResponse || {
                role: 'assistant',
                content: lastResponse.parsedResponse ? JSON.stringify(lastResponse.parsedResponse) : ''
            },
            {
                role: 'user',
                content: `The previous response did not conform to the required format, the zod error is ${validationError}. Please try again and ensure the response matches the specified JSON format: ${jsonSchemaString}.`
            }
        ];
    }

    /**
     * Log schema validation retry warning
     * 
     * @param requestType The type of request being retried
     * @param attempt Current attempt number (0-indexed)
     * @param totalAttempts Total number of attempts allowed
     */
    protected logSchemaValidationRetry(requestType: string, attempt: number, totalAttempts: number): void {
        logger.warn(`[Genie][${this.getProviderName()}] Schema validation failed for ${requestType} (attempt ${attempt + 1}/${totalAttempts}). Retrying...`);
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
