/**
 * Repository analysis data structure
 */
import { ChatMessage } from "../llm/llmTypes";

export interface AnalysisPromptParts {
    system: ChatMessage;
    user: ChatMessage;
}

export type RepoAnalysisRunResult = 'success' | 'skipped';

export interface RepositoryAnalysis {
    /** Repository root path */
    repositoryPath: string;
    /** Analysis timestamp */
    timestamp: string;
    /** The last recorded stateHash at the time of last analysis */
    lastAnalyzedStateHash?: string;
    /** Repository analysis summary */
    summary: string;
    /** Project type (e.g., 'Node.js', 'Python', 'Java', etc.) */
    projectType: string;
    /** Main technologies used */
    technologies: string[];
    /** Key directories found */
    keyDirectories: string[];
    /** Important files found */
    importantFiles: string[];
    /** README content summary */
    readmeContent?: string;
    /** insights of repo */
    insights?: string[];
    /** Package/configuration files content */
    configFiles: { [filename: string]: string };
}

/**
 * Repository scanner results
 */
export interface RepositoryScanResult {
    /** Key directories found */
    keyDirectories: string[];
    /** Important files found with their relative paths */
    importantFiles: { path: string; content?: string }[];
    /** README content */
    readmeContent?: string;
    /** Configuration files content */
    configFiles: { [filename: string]: string };
    /** Files scanned (after ignores) */
    scannedFileCount: number;
    /** Scan duration in milliseconds */
    scanDuration: number;
}

/**
 * Commit history entry
 */
export interface CommitHistoryEntry {
    /** Repository state hash */
    stateHash: string;
    /** Commit message */
    message: string;
    /** Timestamp */
    timestamp: string;
}

/**
 * Analysis service configuration
 */
export interface AnalysisConfig {
    /** Whether repository analysis is enabled */
    enabled: boolean;
    /** File patterns to exclude from scanning */
    excludePatterns: string[];
    /** Number of commits to trigger analysis update */
    updateThreshold: number;
}

/**
 * Repository analysis service interface
 */
export interface IRepositoryAnalysisService {
    /**
     * Initialize analysis for a repository
     */
    initializeRepository(repositoryPath: string): Promise<RepoAnalysisRunResult>;

    /**
     * Get current repository analysis
     */
    getAnalysis(repositoryPath: string): Promise<RepositoryAnalysis | null>;

    /**
     * Update repository analysis
     */
    updateAnalysis(repositoryPath: string, commitMessage?: string): Promise<RepoAnalysisRunResult>;

    /**
     * Get commit history for analysis updates
     */
    getCommitHistory(repositoryPath: string): Promise<CommitHistoryEntry[]>;

    /**
     * Check if analysis update is needed
     */
    shouldUpdateAnalysis(repositoryPath: string): Promise<boolean>;

    /**
     * Get analysis as string for LLM prompt
     */
    getAnalysisForPrompt(repositoryPath: string): Promise<string>;

    /**
     * Sync global JSON analysis from on-repo Markdown (user-edited) file (only summary)
     */
    syncAnalysisFromMarkdown(repositoryPath: string): Promise<void>;

    /**
     * Clear or delete the stored global JSON analysis for the repository
     */
    clearAnalysis(repositoryPath: string): Promise<void>;
}

/**
 * Repository scanner interface
 */
export interface IRepositoryScanner {
    /**
     * Scan repository and collect key information
     */
    scanRepository(repositoryPath: string): Promise<RepositoryScanResult>;
}

/**
 * LLM analysis request
 */
export interface LLMAnalysisRequest {
    /** Repository scan results */
    scanResult: RepositoryScanResult;
    /** Previous analysis for updates */
    previousAnalysis?: RepositoryAnalysis;
    /** Recent commit messages for context */
    recentCommits?: string[];
    /** Repository path */
    repositoryPath: string;
}

/**
 * LLM analysis response
 */
export interface LLMAnalysisResponse {
    /** Analysis summary */
    summary: string;
    /** Project type */
    projectType: string;
    /** Main technologies */
    technologies: string[];
    /** Key insights */
    insights: string[];
    /** Token usage */
    usage?: any;
}
