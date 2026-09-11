import * as vscode from 'vscode';
import { DiffData } from '../git/gitTypes';
import { Repository } from '../git/git';
import { ChangeSetSummary, FileSummary, RagRetrievalQuery, RagStyleReference, RetrievalFeatures } from '../chain/types';
import { AIMessage, AISession, AIThinkingConfig, AIUsage } from './providers';
import type { ChainTokenBudget } from './inputTokenBudget';
import type { CostQuote } from '../cost/costTypes';

export type RequestType =
    | 'commitMessage'
    | 'summary'
    | 'draft'
    | 'fix'
    | 'ragRerank'
    // Change-conditioned chain stages
    | 'investigationPlan'
    | 'investigation'
    | 'enforceLanguage';

export interface LLMRunOptions {
    requestType: RequestType;
    temperature?: number;
    maxOutputTokens?: number;
}

/** Request-scoped access to provider-neutral sessions. */
export interface LLMExecution {
    readonly model?: string;
    readonly signal?: AbortSignal;
    readonly temperature: number;
    readonly maxOutputTokens: number;
    readonly maxRetries: number;
    /**
     * Thinking config resolved once at createExecution (model override → global default).
     * Every session and provider call for this execution must reuse this exact config.
     */
    readonly thinking: AIThinkingConfig;
    readonly tokenBudget: ChainTokenBudget;
    createSession(messages: AIMessage[], id?: string): AISession;
    run<T>(session: AISession, messages: AIMessage[], options: LLMRunOptions): Promise<T>;
    /**
     * Record one successful API response using the pricing snapshot bound at createExecution.
     * Shared by ordinary runs, structured retries, and Agent Runtime wrappers.
     */
    accountCall(usage: AIUsage | undefined): Promise<CostQuote>;
    /** Quotes already recorded for this execution (task-scoped). */
    getRecordedQuotes(): readonly CostQuote[];
    /** Show showUsageCost notification from recorded quotes; does not recompute or re-accumulate. */
    notifyUsageCostIfEnabled(callType: 'commit' | 'memory'): void;
}

export interface RagRetrievalAdapter {
    retrieveStyleReferences(params: {
        repo: Repository;
        query: RagRetrievalQuery;
        execution: LLMExecution;
        maxResults?: number;
    }): Promise<RagStyleReference[]>;
}

/**
 * Represents the response from the LLM service.
 */
export interface LLMResponse {
    content: string;
    episode?: import('../memory/types').InvestigationEpisode;
    memoryUsage?: import('../memory/types').MemoryUsage;
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
    snapshot?: import('../git/repositorySnapshot').RepositorySnapshotReader;
    memoryRun?: import('../memory/service').MemoryRun;
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
