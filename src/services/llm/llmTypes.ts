import * as vscode from 'vscode';
import { DiffData } from '../git/gitTypes';
import { Repository } from '../git/git';

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
}
