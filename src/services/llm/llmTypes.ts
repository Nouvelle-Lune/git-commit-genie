import * as vscode from 'vscode';
import { DiffData } from '../git/gitTypes';
import { Repository } from '../git/git';
import { ChangeSetSummary, FileSummary, RagStyleReference, RetrievalFeatures } from '../chain/chainTypes';

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
    | 'ragPreparation'
    | 'ragRerank'
    | 'repoAnalysis'
    | 'repoAnalysisAction'
    | 'compression'
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

export interface RagRetrievalAdapter {
    retrieveStyleReferences(params: {
        repo: Repository;
        changeSetSummary: ChangeSetSummary;
        retrievalFeatures: RetrievalFeatures;
        chat: (messages: ChatMessage[], options?: { requestType: 'ragRerank'; model?: string; temperature?: number; }) => Promise<any>;
        maxResults?: number;
    }): Promise<RagStyleReference[]>;
}

/**
 * Represents the response from the LLM service.
 */
export interface LLMResponse {
    content: string;
    ragMetadata?: {
        fileSummaries?: FileSummary[];
        changeSetSummary?: ChangeSetSummary;
        retrievalFeatures?: RetrievalFeatures;
        ragStyleReferences?: RagStyleReference[];
    };
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
    ragRetrievalService?: RagRetrievalAdapter;
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

    // Provider-specific raw client (e.g., OpenAI, Anthropic, GoogleGenAI). Typed as unknown
    // because each provider's SDK exposes a different shape; callers must narrow.
    getClient(): unknown | null;

    // Provider-specific utils with chat-completion helpers. Typed as unknown for the same reason.
    getUtils(): unknown;
}
