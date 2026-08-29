import * as vscode from 'vscode';
import { DiffData } from '../git/gitTypes';
import { Repository } from '../git/git';
import { ChangeSetSummary, FileSummary, RagStyleReference, RetrievalFeatures } from '../chain/types';
import { AIMessage, AISession, ThinkingLevel } from './providers';

export type RequestType =
    | 'commitMessage'
    | 'summary'
    | 'draft'
    | 'fix'
    | 'ragPreparation'
    | 'ragRerank'
    // Change-conditioned chain stages
    | 'changeExtraction'
    | 'investigationPlan'
    | 'semanticAnalysis'
    | 'informationSelection'
    // More granular chain stages for clearer logging
    | 'strictFix'
    | 'enforceLanguage';

export interface LLMRunOptions {
    requestType: RequestType;
    temperature?: number;
    maxOutputTokens?: number;
}

/** Request-scoped access to provider-neutral sessions. */
export interface LLMExecution {
    readonly signal?: AbortSignal;
    readonly temperature: number;
    readonly maxOutputTokens: number;
    readonly maxRetries: number;
    readonly thinkingLevel: ThinkingLevel;
    readonly thinkingBudget?: number;
    createSession(messages: AIMessage[], id?: string): AISession;
    run<T>(session: AISession, messages: AIMessage[], options: LLMRunOptions): Promise<T>;
}

export interface RagRetrievalAdapter {
    retrieveStyleReferences(params: {
        repo: Repository;
        changeSetSummary: ChangeSetSummary;
        retrievalFeatures: RetrievalFeatures;
        execution: LLMExecution;
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

    createExecution(repoPath?: string, options?: GenerateCommitMessageOptions): LLMExecution;

    generateCommitMessage(diffs: DiffData[], options?: GenerateCommitMessageOptions): Promise<LLMResponse | LLMError>;
}
