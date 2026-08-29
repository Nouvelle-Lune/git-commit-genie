import * as vscode from 'vscode';
import { DiffData } from '../git/gitTypes';
import { Repository } from '../git/git';
import { ChangeSetSummary, FileSummary, RagStyleReference, RetrievalFeatures } from '../chain/types';

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
    // Change-conditioned chain stages
    | 'changeExtraction'
    | 'investigationPlan'
    | 'investigationAction'
    | 'semanticAnalysis'
    | 'informationSelection'
    // More granular chain stages for clearer logging
    | 'strictFix'
    | 'enforceLanguage';

export type ChatFn = (
    messages: ChatMessage[],
    options?: {
        model?: string
        temperature?: number
        requestType: RequestType
        /** Reuses one provider session across an agent loop. */
        sessionId?: string
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

    /** Creates a provider-neutral chat function with optional session support. */
    createChat?(repoPath?: string, options?: GenerateCommitMessageOptions): ChatFn;
}
