import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as util from 'util';
import { exec } from 'child_process';

import {
    IRepositoryAnalysisService,
    RepositoryAnalysis,
    CommitHistoryEntry,
    AnalysisConfig,
    LLMAnalysisResponse,
    RepoAnalysisRunResult
} from './analysisTypes';

import { LLMService, LLMError, ChatMessage } from '../llm/llmTypes';
import { z } from 'zod';
import { RepoService } from '../repo/repo';
import { logger } from '../logger';
import { L10N_KEYS as I18N } from '../../i18n/keys';
import { getProviderLabel, getProviderModelStateKey, getAllProviderKeys } from '../llm/providers/config/providerConfig';
import { AnthropicRepoAnalysisActionTool, AnthropicCompressionTool } from '../llm/providers/schemas/anthropicSchemas';
import { GeminiRepoAnalysisFunctionDeclarations } from '../llm/providers/schemas/geminiFunctions';
import { repoAnalysisActionSchema, compressionResponseSchema } from '../llm/providers/schemas/common';

// Tools
import { listDirectory } from './tools/directoryTools';
import { searchFiles } from './tools/searchTools';
import { readFileContent } from './tools/fileTools';
import { compressContext } from './tools/compressionTools';
import { DirectoryEntry, SearchFilesResult, ToolResult } from './tools/toolTypes';
import { getMaxContextByFunction } from './tools/modelContext';

/**
 * Tool-driven repository analysis service
 * 
 * This module provides an LLM-driven repository analysis flow
 * where the model decides how to explore the repository by calling tools
 * (listDirectory, searchFiles, readFileContent, compressContext).
 */
export class RepositoryAnalysisService implements IRepositoryAnalysisService {
    private static readonly ANALYSIS_MD_FILE_NAME = 'repository-analysis.md';
    private static readonly ANALYSIS_STATE_KEY_PREFIX = 'gitCommitGenie.analysis.';

    private llmService: LLMService | null;
    private resolveLLMService?: (provider: string) => (LLMService | undefined);

    private repoService: RepoService;
    private context: vscode.ExtensionContext;
    private currentCancelSource?: vscode.CancellationTokenSource;
    private apiKeyWaiters: Map<string, vscode.Disposable> = new Map();
    // In-flight guards to prevent duplicate work per repository
    private initInflight: Map<string, Promise<RepoAnalysisRunResult>> = new Map();
    private updateInflight: Map<string, Promise<RepoAnalysisRunResult>> = new Map();
    // Safety timers to auto-clear stuck in-flight entries
    private initInflightTimers: Map<string, NodeJS.Timeout> = new Map();
    private updateInflightTimers: Map<string, NodeJS.Timeout> = new Map();
    private readonly inflightTimeoutMs = 10 * 60 * 1000; // 10 minutes
    // Promisified exec for git CLI usage
    private static readonly execPromise = util.promisify(exec);

    constructor(context: vscode.ExtensionContext, llmService: LLMService | null, repoService: RepoService) {
        this.context = context;
        this.llmService = llmService;
        this.repoService = repoService;
    }

    /**
     * Sets the LLM service instance for repository analysis
     * 
     * @param service The LLM service instance to use for analysis
     */
    public setLLMService(service: LLMService) {
        this.llmService = service;
    }

    /**
     * Sets a resolver function to dynamically obtain LLM services by provider name
     * 
     * @param resolver Function that resolves provider names to LLM service instances
     */
    public setLLMResolver(resolver: (provider: string) => (LLMService | undefined)) {
        this.resolveLLMService = resolver;
    }

    /**
     * Retrieves repository analysis configuration from workspace settings
     * 
     * @returns Configuration object with enabled status, exclude patterns, and update threshold
     */
    private getConfig(): AnalysisConfig {
        const cfg = vscode.workspace.getConfiguration('gitCommitGenie.repositoryAnalysis');
        return {
            enabled: cfg.get<boolean>('enabled', true),
            excludePatterns: cfg.get<string[]>('excludePatterns', []),
            updateThreshold: cfg.get<number>('updateThreshold', 10)
        };
    }



    /**
     * Initializes repository analysis for a given repository path
     * 
     * Performs the initial AI-driven analysis of a repository by:
     * 1. Checking if analysis is enabled in configuration
     * 2. Verifying if analysis already exists
     * 3. Running the agentive analysis process
     * 4. Saving results to global state and markdown file
     * 
     * @param repositoryPath Absolute path to the repository root
     * @returns Result status: 'success' if completed, 'skipped' if disabled or cancelled, 'error' on failure
     */
    async initializeRepository(repositoryPath: string): Promise<RepoAnalysisRunResult> {
        // Deduplicate concurrent initialization attempts for the same repository
        const inflight = this.initInflight.get(repositoryPath);
        if (inflight) {
            logger.info('[Genie][RepoAnalysis] Initialization already in progress; waiting for result.');
            return inflight;
        }

        const task = (async (): Promise<RepoAnalysisRunResult> => {
            const cfg = this.getConfig();
            this.currentCancelSource = new vscode.CancellationTokenSource();

            if (!cfg.enabled) {
                return 'skipped';
            }

            try {
                const existing = await this.getAnalysis(repositoryPath);
                if (existing) {
                    logger.info('[Genie][RepoAnalysis] Analysis exists, skip init.');
                    return 'skipped';
                }

                logger.info(`[Genie][RepoAnalysis] Initializing for: ${repositoryPath}`);
                logger.logAnalysisStart(repositoryPath);

                const commitMessageLog = await this.repoService.getRepositoryGitMessageLog(repositoryPath);

                const llmResp = await this.runAgenticAnalysis({
                    repositoryPath,
                    recentCommits: (commitMessageLog || []).slice(0, cfg.updateThreshold) || [],
                    excludePatterns: cfg.excludePatterns || []
                });
                if (!llmResp) { return 'skipped'; }

                if (this.currentCancelSource?.token.isCancellationRequested) {
                    logger.warn('[Genie][RepoAnalysis] Initialization cancelled after LLM response; aborting save.');
                    return 'skipped';
                }

                const historyAtInit = await this.getCommitHistory(repositoryPath);
                const lastHashAtInit = historyAtInit.length > 0 ? historyAtInit[0].stateHash : undefined;
                const analysis: RepositoryAnalysis = {
                    repositoryPath,
                    timestamp: new Date().toISOString(),
                    lastAnalyzedStateHash: lastHashAtInit,
                    summary: llmResp.summary,
                    insights: llmResp.insights,
                    projectType: llmResp.projectType,
                    technologies: llmResp.technologies,
                    // In tool-driven mode, we do not force a scan. Keep these optional
                    keyDirectories: [],
                    importantFiles: [],
                    readmeContent: undefined,
                    configFiles: {}
                };

                await this.saveAnalysis(repositoryPath, analysis);
                await this.saveAnalysisMarkdown(repositoryPath, analysis);

                logger.info('[Genie][RepoAnalysis] Initialization completed.');
                return 'success';
            } catch (error: any) {
                return this.handleAnalysisError(error, 'Initialization');
            }
        })();

        this.initInflight.set(repositoryPath, task);
        // Safety: auto-clear if something gets stuck
        try {
            const oldTimer = this.initInflightTimers.get(repositoryPath);
            if (oldTimer) { clearTimeout(oldTimer); }
        } catch { /* ignore */ }
        const timer = setTimeout(() => {
            try {
                if (this.initInflight.has(repositoryPath)) {
                    this.initInflight.delete(repositoryPath);
                    logger.warn(`[Genie][RepoAnalysis] Initialization in-flight guard expired; resetting for ${repositoryPath}`);
                }
            } catch { /* ignore */ }
            this.initInflightTimers.delete(repositoryPath);
        }, this.inflightTimeoutMs);
        this.initInflightTimers.set(repositoryPath, timer);
        try {
            return await task;
        } finally {
            this.initInflight.delete(repositoryPath);
            try {
                const t = this.initInflightTimers.get(repositoryPath);
                if (t) { clearTimeout(t); }
            } catch { /* ignore */ }
            this.initInflightTimers.delete(repositoryPath);
        }
    }

    /**
     * Updates existing repository analysis with fresh insights
     * 
     * Refreshes the AI-driven analysis of a repository by:
     * 1. Checking if analysis is enabled in configuration
     * 2. Retrieving existing analysis or initializing if none exists
     * 3. Running the agentive analysis process with previous analysis context
     * 4. Updating results while preserving structural information
     * 
     * @param repositoryPath Absolute path to the repository root
     * @returns Result status: 'success' if completed, 'skipped' if disabled or cancelled, 'error' on failure
     */
    async updateAnalysis(repositoryPath: string): Promise<RepoAnalysisRunResult> {
        // Deduplicate concurrent update attempts for the same repository
        const inflight = this.updateInflight.get(repositoryPath);
        if (inflight) {
            logger.info('[Genie][RepoAnalysis] Update already in progress; waiting for result.');
            return inflight;
        }

        const task = (async (): Promise<RepoAnalysisRunResult> => {
            const cfg = this.getConfig();
            if (!cfg.enabled) { return 'skipped'; }
            this.currentCancelSource = new vscode.CancellationTokenSource();

            try {
                const existing = await this.getAnalysis(repositoryPath);
                if (!existing) {
                    return await this.initializeRepository(repositoryPath);
                }

                const commitHistory = await this.getCommitHistory(repositoryPath);
                const recentCommits = commitHistory
                    .slice(0, cfg.updateThreshold)
                    .map(e => e.message);

                const llmResp = await this.runAgenticAnalysis({
                    repositoryPath,
                    recentCommits,
                    excludePatterns: cfg.excludePatterns || [],
                    previousAnalysis: existing
                });
                if (!llmResp) { return 'skipped'; }

                const lastHashNow = commitHistory.length > 0 ? commitHistory[0].stateHash : existing.lastAnalyzedStateHash;
                const updated: RepositoryAnalysis = {
                    ...existing,
                    timestamp: new Date().toISOString(),
                    lastAnalyzedStateHash: lastHashNow,
                    summary: llmResp.summary,
                    insights: llmResp.insights,
                    projectType: llmResp.projectType,
                    technologies: llmResp.technologies,
                    // Keep previously saved structural hints if any
                    keyDirectories: existing.keyDirectories || [],
                    importantFiles: existing.importantFiles || [],
                    readmeContent: existing.readmeContent,
                    configFiles: existing.configFiles || {}
                };

                if (this.currentCancelSource?.token.isCancellationRequested) {
                    logger.warn('[Genie][RepoAnalysis] Update cancelled after LLM response; aborting save.');
                    return 'skipped';
                }

                await this.saveAnalysis(repositoryPath, updated);
                await this.saveAnalysisMarkdown(repositoryPath, updated);
                logger.info('[Genie][RepoAnalysis] Update completed.');
                return 'success';
            } catch (error: any) {
                return this.handleAnalysisError(error, 'Update');
            }
        })();

        this.updateInflight.set(repositoryPath, task);
        // Safety: auto-clear if something gets stuck
        try {
            const oldTimer = this.updateInflightTimers.get(repositoryPath);
            if (oldTimer) { clearTimeout(oldTimer); }
        } catch { /* ignore */ }
        const timer = setTimeout(() => {
            try {
                if (this.updateInflight.has(repositoryPath)) {
                    this.updateInflight.delete(repositoryPath);
                    logger.warn(`[Genie][RepoAnalysis] Update in-flight guard expired; resetting for ${repositoryPath}`);
                }
            } catch { /* ignore */ }
            this.updateInflightTimers.delete(repositoryPath);
        }, this.inflightTimeoutMs);
        this.updateInflightTimers.set(repositoryPath, timer);
        try {
            return await task;
        } finally {
            this.updateInflight.delete(repositoryPath);
            try {
                const t = this.updateInflightTimers.get(repositoryPath);
                if (t) { clearTimeout(t); }
            } catch { /* ignore */ }
            this.updateInflightTimers.delete(repositoryPath);
        }
    }

    /**
     * Retrieves stored repository analysis from extension global state
     * 
     * @param repositoryPath Absolute path to the repository root
     * @returns Repository analysis object if found, null otherwise
     */
    async getAnalysis(repositoryPath: string): Promise<RepositoryAnalysis | null> {
        try {
            const key = this.getAnalysisStateKey(repositoryPath);
            const analysis = this.context.globalState.get<RepositoryAnalysis | undefined>(key);
            return analysis ?? null;
        } catch (error) {
            logger.error('[Genie][RepoAnalysis] Failed to read repository analysis', error as any);
            return null;
        }
    }

    /**
     * Retrieves commit history for a repository
     * 
     * Fetches commit information from Git and transforms it into a standardized
     * format with hash, message, and timestamp.
     * 
     * @param repositoryPath Absolute path to the repository root
     * @returns Array of commit history entries, empty array on error
     */
    async getCommitHistory(repositoryPath: string): Promise<CommitHistoryEntry[]> {
        try {
            const commits = await this.repoService.getRepositoryCommits({}, repositoryPath);
            const entries: CommitHistoryEntry[] = (commits || []).map(c => ({
                stateHash: c.hash,
                message: c.message || '',
                timestamp: (c.commitDate || c.authorDate || new Date())?.toISOString?.() || new Date().toISOString()
            })).filter(e => e.stateHash && e.message);
            return entries;
        } catch (error) {
            logger.warn('[Genie][RepoAnalysis] Failed to retrieve commit history from Git', error as any);
            return [];
        }
    }

    /**
     * Determines if repository analysis should be updated based on commit history
     * 
     * Compares the last analyzed commit hash with current history to decide if
     * enough changes have occurred to warrant a new analysis.
     * 
     * @param repositoryPath Absolute path to the repository root
     * @returns True if analysis should be updated, false otherwise
     */
    async shouldUpdateAnalysis(repositoryPath: string): Promise<boolean> {
        const history = await this.getCommitHistory(repositoryPath);
        if (!Array.isArray(history)) { return false; }
        const cfg = this.getConfig();
        const threshold = Math.max(1, cfg.updateThreshold || 1);
        const analysis = await this.getAnalysis(repositoryPath);
        if (!analysis) { return true; }

        const anchor = (analysis as any).lastAnalyzedStateHash as string | undefined;
        if (!anchor || anchor.length === 0) { return true; }
        const idx = history.findIndex(e => e.stateHash === anchor);
        if (idx === -1) { return true; }
        return idx >= threshold;
    }

    /**
     * Formats repository analysis as a JSON string for use in prompts
     * 
     * Creates a simplified representation of the analysis with only the
     * most relevant fields for context in LLM prompts.
     * 
     * @param repositoryPath Absolute path to the repository root
     * @returns JSON string with analysis data, empty string if not available
     */
    async getAnalysisForPrompt(repositoryPath: string): Promise<string> {
        try {
            const cfg = this.getConfig();
            if (!cfg.enabled) { return ''; }
            const analysis = await this.getAnalysis(repositoryPath);
            if (!analysis) { return ''; }

            const payload = {
                summary: analysis.summary || '',
                projectType: analysis.projectType || '',
                technologies: Array.isArray(analysis.technologies) ? analysis.technologies : [],
                insights: Array.isArray(analysis.insights) ? analysis.insights : [],
                importantFiles: Array.isArray(analysis.importantFiles) ? analysis.importantFiles : []
            };
            return JSON.stringify(payload, null, 2);
        } catch (error) {
            logger.error('[Genie][RepoAnalysis] Failed to get analysis for prompt', error as any);
            return '';
        }
    }

    /**
     * Cancels any ongoing repository analysis operation
     * 
     * Triggers cancellation token to abort LLM calls and other async operations
     */
    public cancelCurrentAnalysis(): void {
        try { this.currentCancelSource?.cancel(); } catch { /* ignore */ }
    }



    /**
     * Run the tool-driven agent loop until the model returns a final analysis.
     * 
     * @param input.repositoryPath Absolute repository root path
     * @param input.recentCommits Recent commit messages for context
     * @param input.excludePatterns User-provided exclude patterns (optional)
     * @param input.previousAnalysis Previous analysis snapshot (optional)
     * @returns Structured analysis on success, null otherwise
     */
    private async runAgenticAnalysis(input: {
        repositoryPath: string;
        recentCommits: string[];
        excludePatterns: string[];
        previousAnalysis?: RepositoryAnalysis;
    }): Promise<LLMAnalysisResponse | null> {
        const repoPath = input.repositoryPath;
        logger.info(`[Genie][RepoAnalysis] Begin analysis for: ${repoPath}`);

        const toolsSpec = [
            {
                name: 'listDirectory',
                args: '{ dirPath: string; depth?: number; excludePatterns?: string[] }',
                desc: 'List directory entries up to a depth; dirPath must be inside repository.'
            },
            {
                name: 'searchFiles',
                args: '{ query: string; searchType: "name"|"content"; useRegex?: boolean; searchPath?: string; maxResults?: number; caseSensitive?: boolean; excludePatterns?: string[]; maxMatchesPerFile?: number; contextLines?: number }',
                desc: 'Search by file name or content; paths must be inside repository.'
            },
            {
                name: 'readFileContent',
                args: '{ filePath: string; startLine?: number; maxLines?: number; encoding?: string }',
                desc: 'Read a file segment; filePath must be inside repository.'
            },
            {
                name: 'compressContext',
                args: '{ content: string; targetTokens?: number; preserveStructure?: boolean; language?: string }',
                desc: 'Use LLM summarization to compress long context before continuing exploration.'
            }
        ];

        const userExcludes = this.normalizeExcludePatterns(input.excludePatterns);
        const isIncremental = !!input.previousAnalysis;
        const commitWindowSize = Array.isArray(input.recentCommits) ? input.recentCommits.length : 0;
        const system = [
            'You are an autonomous repository analysis agent. You can call tools to explore the repository and then produce a final structured analysis.',
            'Respond with STRICT JSON only, no markdown code fences.',
            'For every tool action, include a concise English "reason" describing what you will do next (e.g., "I will use searchFiles to look for framework imports").',
            'If your provider supports function calling, always prefer calling the provided tools directly and do not output free-form plans. To finish, call the finalize tool with the final analysis object.',
            '',
            (isIncremental
                ? [
                    'Mode: INCREMENTAL UPDATE. There is an existing repository analysis. Prefer focused exploration over full rescans.',
                    `Consider the last ${commitWindowSize} commit messages to decide if the project\'s purpose, architecture, key technologies, or capabilities materially changed.`,
                    'Strategy: start from the changed files and their immediate neighbors (imports/configs/entry modules). Use searchFiles to locate related code and readFileContent to verify impact.',
                    'Guidelines (flexible): avoid broad scans when targeted reads can answer the question; if evidence is insufficient, you MAY expand to list specific subpaths or read additional related files until impact is clear.',
                    'Material change examples: new/removed public APIs or commands, substantial config changes (e.g., dependencies in package.json/pyproject), new services/modules, or core feature behavior changes.',
                    'Non-material examples: docs-only, style/formatting, test-only, CI/chore/refactor with no functional effect.',
                    'When no material change is found: immediately finalize by returning the previous summary/projectType/technologies unchanged. In insights, add a short line like: "Incremental: No significant changes in the last commits (N)."',
                    'When a material change is found: minimally update summary/projectType/technologies only where required and add an insights line starting with "Incremental:" summarizing the change, the commit count reviewed, and the key impacted areas/files.',
                    'Tip: If commit messages mention specific files/dirs (e.g., package.json, config.ts), prefer searchFiles for those names then readFileContent on HEAD to verify actual functional impact.',
                    'Note: You may conceptually think of using a "git show"-style view for specific commits; however, your available tools are limited to searchFiles and readFileContent on the working tree. Use them to approximate the diff impact.',
                ].join('\n')
                : [
                    'Mode: INITIAL ANALYSIS. Explore efficiently and focus on high-signal files (e.g., README, package/config files, entry points).',
                ].join('\n')
            ),
            '',
            'Action schema (discriminated union):',
            '{',
            '  // Tool branch:',
            '  "action": "tool",',
            '  "toolName": "listDirectory" | "searchFiles" | "readFileContent" | "compressContext",',
            '  "args": object,',
            '  "reason": string',
            '}',
            'OR',
            '{',
            '  // Final branch:',
            '  "action": "final",',
            '  "final": {',
            '     "summary": string,',
            '     "projectType": string,',
            '     "technologies": string[],',
            '     "insights": string[]',
            '  }',
            '}',
            'Note: Always include all top-level keys required by the schema. When action is "tool", set "final" to null. When action is "final", set "toolName", "args", and "reason" to null.',
            '',
            'Tool catalog:'
        ].concat(toolsSpec.map(t => `- ${t.name} ${t.args}: ${t.desc}`)).join('\n');

        // Pre-fetch root directory structure only for initial analysis to seed context without encouraging a full scan in incremental mode
        let rootDirContext = '';
        if (!isIncremental) {
            try {
                const rootList = await listDirectory(repoPath, { depth: 1, excludePatterns: userExcludes });
                if (rootList.success && rootList.data) {
                    const entries = rootList.data.entries || [];
                    const dirs = entries.filter(e => e.type === 'directory').map(e => e.name);
                    const files = entries.filter(e => e.type === 'file').map(e => e.name);
                    rootDirContext = [
                        '',
                        '## Root Directory Structure (depth=1)',
                        dirs.length ? `Directories (${dirs.length}): ${dirs.slice(0, 30).join(', ')}${dirs.length > 30 ? ', ...' : ''}` : 'No directories',
                        files.length ? `Files (${files.length}): ${files.slice(0, 30).join(', ')}${files.length > 30 ? ', ...' : ''}` : 'No files'
                    ].join('\n');
                }
            } catch (err) {
                logger.warn('[Genie][RepoAnalysis] Failed to pre-fetch root directory structure', err as any);
            }
        }

        // Build recent commit change details for incremental mode
        let recentChangesContext = '';
        // Preserve changed file paths separately so they survive conversation compression
        let preservedChangedFiles = '';
        // Keep structured recent commit summaries (hash, subject, changed files)
        let recentCommitFiles: Array<{ hash: string; shortHash: string; subject: string; files: string[] }> = [];
        if (isIncremental && commitWindowSize > 0) {
            try {
                const commits = await this.getRecentCommitsWithFiles(repoPath, commitWindowSize);
                recentCommitFiles = commits || [];
                if (recentCommitFiles.length) {
                    const sections = recentCommitFiles.map(c => {
                        const filesLine = c.files.length ? `Files (${c.files.length}): ${c.files.join(', ')}` : 'Files: none';
                        return [
                            `- [${c.shortHash}] ${c.subject}`,
                            filesLine
                        ].filter(Boolean).join('\n');
                    });
                    // Intentionally omit raw diffs to reduce context size. Encourage targeted exploration.
                    const header = [
                        '## Recent Commit Changes',
                        'Use commit messages together with the changed file names below to hypothesize impact. Raw diffs are intentionally omitted; prefer searchFiles and selective readFileContent when needed.'
                    ];
                    recentChangesContext = ['', ...header, ...sections].join('\n');

                    // Build preserved filenames block (no diffs) to keep across compression cycles
                    const preserved = recentCommitFiles.map(c => {
                        const filesLine = c.files.length ? c.files.join(', ') : '(none)';
                        return `- [${c.shortHash}] ${c.subject}\n  Files (${c.files.length}): ${filesLine}`;
                    }).join('\n');
                    preservedChangedFiles = ['## Changed Files (preserved; do not compress)', preserved].join('\n');
                }
            } catch (err) {
                logger.warn('[Genie][RepoAnalysis] Failed to gather recent commit diffs', err as any);
            }
        }

        // Build recent commits block, annotated with changed files when available
        let recentCommitsBlock = '';
        if (Array.isArray(input.recentCommits) && input.recentCommits.length > 0) {
            if (recentCommitFiles.length > 0) {
                const lines = recentCommitFiles.map((c, i) => {
                    const filesLine = c.files.length ? `Files (${c.files.length}): ${c.files.join(', ')}` : 'Files: none';
                    return `C${i + 1}: ${c.subject}\n${filesLine}`;
                }).join('\n');
                recentCommitsBlock = `Recent commits (last ${commitWindowSize}):\n${lines}`;
            } else {
                recentCommitsBlock = `Recent commits (last ${commitWindowSize}):\n${input.recentCommits.map((c, i) => `C${i + 1}: ${c}`).join('\n')}`;
            }
        }

        // If we have annotated recent commits with files above, we don't need
        // the separate Recent Commit Changes section to avoid duplication.
        const includeRecentChangesSection = !(Array.isArray(recentCommitFiles) && recentCommitFiles.length > 0);

        let msgs: ChatMessage[] = [
            { role: 'system', content: system },
            {
                role: 'user', content: [
                    `Repository root: ${repoPath}`,
                    userExcludes.length ? `Exclude patterns (from settings, optional): ${JSON.stringify(userExcludes)}` : undefined,
                    input.previousAnalysis ? `Previous summary: ${this.truncateTo(input.previousAnalysis.summary || '', 800)}` : undefined,
                    input.previousAnalysis ? `Previous technologies: ${(input.previousAnalysis.technologies || []).join(', ')}` : undefined,
                    input.previousAnalysis ? `Previous insights: ${(input.previousAnalysis.insights || []).join('; ')}` : undefined,
                    isIncremental ? `Analysis mode: incremental (review at most ${commitWindowSize} commits; update only if material change).` : 'Analysis mode: initial',
                    recentCommitsBlock || undefined,
                    isIncremental ? 'Use commit messages above to hypothesize impacted areas. Prefer targeted searchFiles and a few readFileContent calls to verify. Avoid full scans.' : undefined,
                    rootDirContext, // Include pre-fetched root directory structure
                    includeRecentChangesSection ? recentChangesContext : undefined, // Avoid duplication
                    '',
                    'Goal: Provide global context strictly for commit message generation. In incremental mode, focus on whether the latest commits change repository functionality or architecture, and finalize early if not. Include an insights line starting with "Incremental:" that states whether a repo-level update is needed and why. When done, return action="final".'
                ].filter(Boolean).join('\n')
            }
        ];

        // Track usage for all tool calls
        const usages: Array<{ prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }> = [];
        // Track OpenAI Responses API previous_response_id to chain state
        let previousResponseId: string | undefined;
        // Track OpenAI function calling pending tool output
        let openaiPendingCallId: string | undefined;
        let openaiPendingToolOutput: string | undefined;
        const { provider } = this.pickRepoAnalysisService();
        const model = this.getActiveModelForProvider(provider) || '';
        const normalizedProvider = (provider || '').toLowerCase();

        // For Qwen models, track region for usage logging
        const qwenRegion = normalizedProvider === 'qwen'
            ? (this.context.globalState.get<string>('gitCommitGenie.qwenRegion', 'intl') as 'china' | 'intl')
            : undefined;


        // Limit total thinking/acting steps to prevent runaway loops
        let maxSteps = vscode.workspace.getConfiguration('gitCommitGenie').get<number>('repositoryAnalysis.MaxCount', 99999);
        if (maxSteps === -1) {
            maxSteps = 99999;
        }
        const maxContextTokens = getMaxContextByFunction('repoAnalysis', model);
        const contextThreshold = maxContextTokens * 0.9; // Force compress at 90% of context limit

        for (let step = 0; step <= maxSteps; step++) {

            if (step === maxSteps) {
                let choice = await this.isResetStep();
                if (choice) {
                    step = 0;
                } else {
                    logger.warn('[Genie][RepoAnalysis] Reached maximum analysis steps; aborting.');
                    return null;
                }
            }

            // Check context size and force compression if needed
            const totalContextLength = msgs.map(m => m.content.length).reduce((a, b) => a + b, 0);
            const estimatedTokens = totalContextLength / 4; // Rough estimate: 1 token ≈ 4 chars

            if (estimatedTokens > contextThreshold) {
                logger.warn(`[Genie][RepoAnalysis] Context at ${Math.round((estimatedTokens / maxContextTokens) * 100)}% (${Math.round(estimatedTokens)}/${maxContextTokens} tokens), forcing compression...`);

                try {
                    // Preserve system message (contains tool specs and instructions)
                    // Only compress user/assistant conversation history
                    const conversationHistory = msgs.slice(1).map(m => `[${m.role.toUpperCase()}]\n${m.content}`).join('\n\n---\n\n');

                    const compressResult = await this.runTool(repoPath, 'compressContext', {
                        content: conversationHistory,
                        targetTokens: Math.floor(maxContextTokens * 0.5),
                        preserveStructure: true
                    }, userExcludes);

                    // Track compression usage
                    if (compressResult.usage) {
                        if (Array.isArray(compressResult.usage)) {
                            let tryIdx = 0;
                            for (const u of compressResult.usage) {
                                tryIdx += 1;
                                usages.push(u);
                                logger.usage(repoPath, provider, u, model, `compression-step-${step + 1}-try-${tryIdx}` as any, step + 1, qwenRegion);
                            }
                        } else {
                            usages.push(compressResult.usage);
                            logger.usage(repoPath, provider, compressResult.usage, model, `compression-step-${step + 1}`, step + 1, qwenRegion);
                        }
                    }

                    if (compressResult.success && compressResult.data) {
                        // Keep original system message, re-attach preserved changed files, then replace conversation with compressed version
                        const newMsgs: ChatMessage[] = [msgs[0]]; // Preserve original system message with tool specs
                        if (preservedChangedFiles && preservedChangedFiles.trim().length > 0) {
                            newMsgs.push({ role: 'user', content: preservedChangedFiles });
                        }
                        newMsgs.push({ role: 'user', content: `Here is the compressed Exploration History for last conversation, Continue exploring: \n\n${compressResult.data.compressed}` });
                        msgs = newMsgs;
                        const newSize = msgs.map(m => m.content.length).reduce((a, b) => a + b, 0);
                        logger.info(`[Genie][RepoAnalysis] Compression successful: ${Math.round(totalContextLength / 4)} → ${Math.round(newSize / 4)} tokens (${(compressResult.data.compressionRatio * 100).toFixed(1)}% reduction)`);
                    } else {
                        logger.warn(`[Genie][RepoAnalysis] Compression failed: ${compressResult.error || 'Unknown error'}`);
                    }
                } catch (err: any) {
                    logger.warn(`[Genie][RepoAnalysis] Compression exception: ${err?.message || 'unknown'}`);
                }
            }

            const toolOutputToSend = openaiPendingCallId && openaiPendingToolOutput ? { call_id: openaiPendingCallId, output: openaiPendingToolOutput } : undefined;
            const isFirstRequest = step === 0; // Mark first iteration as first request
            const result = await this.safeJsonCall(msgs, repoPath, previousResponseId, toolOutputToSend, isFirstRequest);
            if (!result) { return null; }

            const action = result.action;

            // For OpenAI Responses API, remember response id to improve multi-turn fidelity
            if ((result as any).responseId) {
                previousResponseId = (result as any).responseId;
            }

            // Track usage
            if (result.usage) {
                if (Array.isArray(result.usage)) {
                    let tryIdx = 0;
                    for (const u of result.usage) {
                        tryIdx += 1;
                        usages.push(u);
                        logger.usage(repoPath, provider, u, model, `tool-step-${step + 1}-try-${tryIdx}`, step + 1, qwenRegion);
                    }
                } else {
                    usages.push(result.usage);
                    logger.usage(repoPath, provider, result.usage, model, `tool-step-${step + 1}`, step + 1, qwenRegion);
                }
            }

            // Clear sent tool output after successful call
            if (toolOutputToSend) { openaiPendingCallId = undefined; openaiPendingToolOutput = undefined; }

            if (action.action === 'final') {
                logger.info('[Genie][RepoAnalysis] Model produced final analysis.');
                const f = action.final || {};
                if (typeof f.summary === 'string' && Array.isArray(f.technologies) && Array.isArray(f.insights) && typeof f.projectType === 'string') {
                    logger.info(`[Genie][RepoAnalysis] Final: projectType=${f.projectType}; technologies=${(f.technologies || []).slice(0, 5).join(', ')}; insights=${(f.insights || []).length}`);

                    // Log usage summary
                    if (usages.length) {
                        logger.usageSummary(repoPath, provider, usages, model, 'RepoAnalysis', undefined, false, qwenRegion);
                    }

                    return {
                        summary: f.summary,
                        technologies: f.technologies,
                        insights: f.insights,
                        projectType: f.projectType
                    };
                }
                // invalid final -> nudge model to return required fields instead of aborting
                logger.warn('[Genie][RepoAnalysis] Final action missing required fields; requesting correction.');
                msgs.push({ role: 'assistant', content: JSON.stringify(action) });
                msgs.push({ role: 'user', content: 'The final object is missing required fields. Please return strictly valid JSON with fields: { "final": { "summary": string, "projectType": string, "technologies": string[], "insights": string[] } } and no extra text.' });
                continue;
            }

            if (action.action === 'tool') {
                const toolName = String(action.toolName || '');
                const args = (action.args || {}) as any;
                const reason = String(action.reason || '');

                logger.info(`[Genie][RepoAnalysis] Step ${step + 1}: Model chose tool '${toolName}'. Reason: ${reason.slice(0, 500)}`);

                // Don't log tool call here - readFileContent will call logFileRead internally
                // For other tools, we can add specific logging if needed
                // logger.logToolCall(toolName, JSON.stringify(args, null, 2), reason);

                const toolResult = await this.runTool(repoPath, toolName, args, userExcludes);
                this.logToolOutcome(toolName, toolResult);
                // For OpenAI function calling, queue function_call_output instead of text TOOL_RESULT
                if (provider.toLowerCase() === 'openai' && (result as any).functionCallId) {
                    openaiPendingCallId = String((result as any).functionCallId || '');
                    openaiPendingToolOutput = JSON.stringify(toolResult || {});

                } else {
                    // Other providers: keep text-based conversation
                    msgs.push({ role: 'assistant', content: JSON.stringify(action) });
                    msgs.push({ role: 'user', content: `TOOL_RESULT(${toolName}): ${JSON.stringify(toolResult)}` });
                }
                continue;
            }

            // Unknown action -> continue a bit, or abort
            msgs.push({ role: 'assistant', content: JSON.stringify({ error: 'Unknown action; please correct' }) });
        }

        // Log usage summary even if we didn't get final result
        if (usages.length) {
            logger.usageSummary(repoPath, provider, usages, model, 'RepoAnalysis', undefined, false, qwenRegion);
        }


        return null;
    }

    /**
     * Make a JSON-only LLM call via the provider service.
     * Ensures temperature and token limits come from settings.
     * Returns both the parsed action and usage statistics.
     */
    private async safeJsonCall(history: ChatMessage[], repoPath: string, previousResponseId?: string, openaiToolOutput?: { call_id: string; output: string }, isFirstRequest: boolean = false): Promise<{ action: any; usage?: any; responseId?: string; functionCallId?: string } | null> {
        try {
            const { provider, service } = this.pickRepoAnalysisService();
            if (!service) {
                throw Object.assign(new Error(`${provider} service is not available`), { statusCode: 400 });
            }

            const model = this.getActiveModelForProvider(provider) || '';

            const client = (service as any).getClient();
            const utils = (service as any).getUtils();

            if (!client) {
                throw Object.assign(new Error(`${provider} client is not initialized`), { statusCode: 401 });
            }

            // Local mutable copy of messages to allow validation retry guidance
            let messages: ChatMessage[] = [...history];

            // For OpenAI Responses API
            let currentResponseId = previousResponseId;

            const validationSchema = repoAnalysisActionSchema;
            const maxRetries = typeof utils?.getMaxRetries === 'function' ? utils.getMaxRetries() : 2;
            const totalAttempts = Math.max(1, maxRetries + 1);

            // Track cumulative usage across attempts
            const attemptUsages: any[] = [];

            for (let attempt = 0; attempt < totalAttempts; attempt++) {
                // Build provider-specific call options per attempt to include chaining/tool outputs
                let callOptions: any = {
                    model,
                    provider,
                    token: this.currentCancelSource?.token,
                    trackUsage: true,
                    isFirstRequest: isFirstRequest && attempt === 0 // Only mark first attempt of first call as first request
                };

                switch (provider.toLowerCase()) {
                    case 'openai': {
                        callOptions.requestType = 'repoAnalysisAction';
                        if (currentResponseId) {
                            callOptions.previousResponseId = currentResponseId;
                            callOptions.store = true;
                        }
                        break;
                    }
                    case 'anthropic': {
                        callOptions.tools = [AnthropicRepoAnalysisActionTool];
                        callOptions.toolChoice = { type: 'tool', name: AnthropicRepoAnalysisActionTool.name };
                        break;
                    }
                    case 'gemini': {
                        callOptions.requestType = 'repoAnalysisAction';
                        callOptions.functionDeclarations = [...GeminiRepoAnalysisFunctionDeclarations];
                        break;
                    }
                    case 'qwen':
                    case 'deepseek': {
                        callOptions.requestType = 'repoAnalysisAction';
                        break;
                    }
                    default: {
                        callOptions.requestType = 'repoAnalysisAction';
                        break;
                    }
                }

                if (provider.toLowerCase() === 'openai' && openaiToolOutput) {
                    callOptions.toolOutputs = [openaiToolOutput];
                }

                let result: any;
                try {
                    result = await utils.callChatCompletion(client, messages, { ...callOptions, repoPath: repoPath });
                } catch (e: any) {
                    const em = String(e?.message || '').toLowerCase();
                    const looksLikeJsonParseErr = em.includes('json') || em.includes('parse') || em.includes('unexpected token') || em.includes('after json');
                    if (looksLikeJsonParseErr && attempt < totalAttempts - 1) {
                        // Nudge the model to return strict JSON matching the schema
                        const jsonSchemaString = JSON.stringify(z.toJSONSchema(validationSchema), null, 2);
                        try { logger.logToolCall('schemaValidation', JSON.stringify({ stage: 'repoAnalysisAction', attempt: attempt + 1, totalAttempts, error: String(e?.message || e) }), 'Schema validation failed (JSON parse)', repoPath); } catch { /* ignore */ }
                        messages = [
                            ...messages,
                            {
                                role: 'user',
                                content: `Your previous response was not valid JSON. Respond with STRICT JSON only matching this schema: ${jsonSchemaString}. Do not include any markdown or explanation.`
                            }
                        ];
                        continue;
                    }
                    throw e;
                }

                // Track response id for OpenAI Responses chaining on next attempt
                currentResponseId = (result as any).responseId || currentResponseId;
                // Collect usage for this attempt if present
                if (Array.isArray(result?.usage)) {
                    for (const u of result.usage) { attemptUsages.push(u); }
                } else if (result?.usage) {
                    attemptUsages.push(result.usage);
                }

                // Validate structured action with zod
                const safe = validationSchema.safeParse(result.parsedResponse);
                if (safe.success) {
                    return {
                        action: safe.data,
                        usage: attemptUsages,
                        responseId: (result as any).responseId,
                        functionCallId: (result as any).functionCallId
                    };
                }

                // If not valid and attempts remain, append feedback and retry
                if (attempt < totalAttempts - 1) {
                    try {
                        const jsonSchemaString = JSON.stringify(z.toJSONSchema(validationSchema), null, 2);
                        const assistantEcho: ChatMessage = (result as any).parsedAssistantResponse || {
                            role: 'assistant',
                            content: result.parsedResponse ? JSON.stringify(result.parsedResponse) : ''
                        };
                        try { logger.logToolCall('schemaValidation', JSON.stringify({ stage: 'repoAnalysisAction', attempt: attempt + 1, totalAttempts, error: String(safe.error) }), 'Schema validation failed', repoPath); } catch { /* ignore */ }
                        messages = [
                            ...messages,
                            assistantEcho,
                            {
                                role: 'user',
                                content: `The previous response did not conform to the required format, the zod error is ${safe.error}. Please try again and ensure the response matches the specified JSON format: ${jsonSchemaString}.`
                            }
                        ];
                        continue;
                    } catch {
                        // If building feedback fails, fall through and throw
                    }
                }

                try { logger.logToolCall('schemaValidation', JSON.stringify({ stage: 'repoAnalysisAction', finalFailure: true, error: String(safe.error) }), 'Schema validation failed', repoPath); } catch { /* ignore */ }
                throw new Error(`${provider} structured result failed local validation for repoAnalysisAction after ${totalAttempts} attempts`);
            }

            // Should be unreachable
            throw new Error('Validation loop terminated unexpectedly');
        } catch (err: any) {
            const provider = this.pickRepoAnalysisService().provider;
            if (err?.statusCode) {
                await this.handleLLMError({ message: err.message, statusCode: err.statusCode }, provider, repoPath);
                return null;
            }
            // For non-status errors, bubble up a generic failure so the caller can handle gracefully
            logger.error('[Genie][RepoAnalysis] LLM analysis failed', err?.message || err);
            throw new Error(err?.message || 'Failed to produce a valid repo analysis action');
        }
    }

    /**
     * Normalize user-provided exclude patterns (no defaults injected).
     */
    private normalizeExcludePatterns(user: string[] = []): string[] {
        const list = Array.isArray(user) ? user : [];
        return Array.from(new Set(list.filter(v => typeof v === 'string' && v.trim().length > 0)));
    }

    /**
     * Execute a single tool call with safety checks.
     *
     * @param repoPath Repository root path
     * @param toolName Tool identifier
     * @param args Tool arguments
     * @param excludePatterns Exclude patterns provided by user settings
     */
    private async runTool(repoPath: string, toolName: string, args: any, excludePatterns: string[]): Promise<ToolResult<any>> {
        try {
            switch (toolName) {
                case 'listDirectory': {
                    const dirPath = this.resolveSafePath(repoPath, String(args.dirPath || repoPath));
                    const depth = typeof args.depth === 'number' ? args.depth : 1;
                    const ex = Array.isArray(args.excludePatterns) ? args.excludePatterns : excludePatterns;
                    logger.info(`[Genie][RepoAnalysis] Running listDirectory: dirPath='${dirPath}', depth=${depth}, excludes=${ex.length}`);
                    return await listDirectory(dirPath, { depth, excludePatterns: ex });
                }
                case 'searchFiles': {
                    const query = String(args.query || '');
                    const searchType = (args.searchType === 'content' ? 'content' : 'name') as 'name' | 'content';
                    const useRegex = !!args.useRegex;
                    const searchPath = args.searchPath ? this.resolveSafePath(repoPath, String(args.searchPath)) : repoPath;
                    const maxResults = typeof args.maxResults === 'number' ? args.maxResults : 50;
                    const caseSensitive = !!args.caseSensitive;
                    const ex = Array.isArray(args.excludePatterns) ? args.excludePatterns : excludePatterns;
                    const maxMatchesPerFile = typeof args.maxMatchesPerFile === 'number' ? args.maxMatchesPerFile : 5;
                    const contextLines = typeof args.contextLines === 'number' ? args.contextLines : 2;
                    if (!query || query.trim().length === 0) {
                        return { success: false, error: 'searchFiles.query must be a non-empty string' };
                    }
                    logger.info(`[Genie][RepoAnalysis] Running searchFiles: type=${searchType}, query='${query}', useRegex=${useRegex}, path='${searchPath}', maxResults=${maxResults}`);
                    return await searchFiles(repoPath, query, { searchType, useRegex, searchPath, maxResults, caseSensitive, excludePatterns: ex, maxMatchesPerFile, contextLines });
                }
                case 'readFileContent': {
                    const filePath = this.resolveSafePath(repoPath, String(args.filePath || ''));
                    const startLine = typeof args.startLine === 'number' ? args.startLine : 1;
                    const maxLines = typeof args.maxLines === 'number' ? args.maxLines : 1000;
                    const encoding = typeof args.encoding === 'string' ? args.encoding : 'utf-8';
                    const reason = typeof args.reason === 'string' ? args.reason : 'Repository analysis';
                    logger.info(`[Genie][RepoAnalysis] Running readFileContent: filePath='${filePath}', start=${startLine}, maxLines=${maxLines}`);
                    return await readFileContent(filePath, { startLine, maxLines, encoding }, reason);
                }
                case 'compressContext': {
                    const content = String(args.content || '');
                    const targetTokens = typeof args.targetTokens === 'number' ? args.targetTokens : Math.floor(getMaxContextByFunction('repoAnalysis') * 0.4);
                    const preserveStructure = !!args.preserveStructure;
                    const language = typeof args.language === 'string' ? args.language : undefined;

                    const chatFn = async (messages: ChatMessage[]): Promise<{ parsedResponse?: any; usage?: any; parsedAssistantResponse?: ChatMessage }> => {
                        const { provider, service } = this.pickRepoAnalysisService();
                        if (!service) {
                            throw new Error(`${provider} service is not available`);
                        }

                        const model = this.getActiveModelForProvider(provider) || '';
                        const client = (service as any).getClient();
                        const utils = (service as any).getUtils();

                        if (!client) {
                            throw new Error(`${provider} client is not initialized`);
                        }

                        const callOpts: any = {
                            model,
                            provider,
                            token: this.currentCancelSource?.token,
                            trackUsage: true,
                            requestType: 'compression'
                        };
                        if (provider.toLowerCase() === 'gemini') {
                            callOpts.responseSchema = compressionResponseSchema;
                        } else if (provider.toLowerCase() === 'anthropic') {
                            callOpts.tools = [AnthropicCompressionTool];
                            callOpts.toolChoice = { type: 'tool', name: AnthropicCompressionTool.name };
                        }
                        const result = await utils.callChatCompletion(client, messages, callOpts);
                        return result;
                    };

                    const maxRetries = typeof (this.pickRepoAnalysisService().service as any)?.getUtils?.()?.getMaxRetries === 'function'
                        ? (this.pickRepoAnalysisService().service as any).getUtils().getMaxRetries()
                        : 2;
                    const compressionResult = await compressContext(content, chatFn, { targetTokens, preserveStructure, language, maxRetries });

                    return compressionResult;
                }
                default:
                    return { success: false, error: `Unknown tool: ${toolName}` };
            }
        } catch (error: any) {
            return { success: false, error: error?.message || 'Tool execution failed' };
        }
    }

    /**
     * Log a compact summary of a tool's output for user visibility.
     */
    private logToolOutcome(toolName: string, result: ToolResult<any>): void {
        try {
            if (!result) { logger.info(`[Genie][RepoAnalysis] Tool '${toolName}' returned no result.`); return; }
            if (result.success === false) { logger.warn(`[Genie][RepoAnalysis] Tool '${toolName}' failed: ${result.error || 'unknown error'}`); return; }
            const data = result.data;
            switch (toolName) {
                case 'listDirectory': {
                    const count = Array.isArray(data?.entries) ? data.entries.length : 0;
                    logger.info(`[Genie][RepoAnalysis] listDirectory -> ${count} entries.`);
                    break;
                }
                case 'searchFiles': {
                    const total = typeof data?.totalMatches === 'number' ? data.totalMatches : 0;
                    const files = Array.isArray(data?.results) ? data.results.length : 0;
                    logger.info(`[Genie][RepoAnalysis] searchFiles -> ${total} matches in ${files} files.`);
                    break;
                }
                case 'readFileContent': {
                    const fp = data?.filePath || '';
                    const start = data?.startLine;
                    const end = data?.endLine;
                    const hasMore = data?.hasMore ? 'yes' : 'no';
                    logger.info(`[Genie][RepoAnalysis] readFileContent -> ${fp} [${start}-${end}], more=${hasMore}.`);
                    break;
                }
                case 'compressContext': {
                    const origSize = typeof data?.originalSize === 'number' ? data.originalSize : 0;
                    const compSize = typeof data?.compressedSize === 'number' ? data.compressedSize : 0;
                    const delta = compSize - origSize;
                    const pct = origSize > 0 ? Math.abs((delta / origSize) * 100).toFixed(1) + '%' : '0%';
                    const direction = delta < 0 ? 'reduction' : (delta > 0 ? 'increase' : 'no change');
                    const summary = data?.summary || 'No summary';
                    logger.info(`[Genie][RepoAnalysis] compressContext -> ${origSize} → ${compSize} chars (${pct} ${direction}). ${summary}`);
                    break;
                }
                default:
                    logger.info(`[Genie][RepoAnalysis] ${toolName} -> success.`);
            }
        } catch { /* ignore logging failures */ }
    }

    /**
     * Resolve a candidate path relative to repo root and ensure it stays inside.
     */
    private resolveSafePath(repoPath: string, candidate: string): string {
        const absRepo = path.resolve(repoPath);
        const abs = path.resolve(candidate.startsWith('/') || candidate.match(/^[a-zA-Z]:\\\\/) ? candidate : path.join(repoPath, candidate));
        if (!abs.startsWith(absRepo)) {
            throw new Error(`Access denied outside repository: ${candidate}`);
        }
        return abs;
    }

    /**
     * Selects the appropriate LLM provider for repository analysis
     * 
     * @returns Object containing the provider name and service instance
     */
    private pickRepoAnalysisService(): { provider: string, service: LLMService | null } {
        try {
            const cfg = vscode.workspace.getConfiguration('gitCommitGenie.repositoryAnalysis');
            const selectedModel = (cfg.get<string>('model', 'general') || 'general').trim();
            if (!selectedModel || selectedModel === 'general') {
                const p = (this.context.globalState.get<string>('gitCommitGenie.provider', 'openai') || 'openai').toLowerCase();
                return { provider: p, service: this.llmService };
            }
            const candidates = getAllProviderKeys();
            for (const p of candidates) {
                const svc = this.resolveLLMService?.(p);
                try {
                    if (svc && svc.listSupportedModels().includes(selectedModel)) {
                        return { provider: p, service: svc };
                    }
                } catch { /* ignore */ }
            }
            const p = (this.context.globalState.get<string>('gitCommitGenie.provider', 'openai') || 'openai').toLowerCase();
            return { provider: p, service: this.llmService };
        } catch {
            const p = (this.context.globalState.get<string>('gitCommitGenie.provider', 'openai') || 'openai').toLowerCase();
            return { provider: p, service: this.llmService };
        }
    }

    /**
     * Retrieves the active model for a specific provider
     * 
     * Checks repository analysis configuration first, then falls back to
     * the provider's default model from global state.
     * 
     * @param provider The LLM provider identifier
     * @returns The model identifier or undefined if not found
     */
    private getActiveModelForProvider(provider: string): string | undefined {
        try {
            const cfg = vscode.workspace.getConfiguration('gitCommitGenie.repositoryAnalysis');
            const selected = (cfg.get<string>('model', 'general') || 'general').trim();
            if (selected && selected !== 'general') { return selected; }
            const modelKey = getProviderModelStateKey(provider);
            return this.context.globalState.get<string>(modelKey, '');
        } catch { return undefined; }
    }

    /**
     * Handles LLM service errors with appropriate user notifications
     * 
     * Provides specific handling for common error scenarios:
     * - 401: Authentication errors (missing/invalid API key)
     * - 400: Bad request errors
     * - 403: Permission errors (API key lacks permissions)
     * - 429: Rate limit errors
     * 
     * @param err The LLM error object
     * @param provider The provider that generated the error
     * @param repositoryPath The repository path being analyzed
     * @returns Always returns null to indicate error was handled
     */
    private async handleLLMError(
        err: LLMError,
        provider: string,
        repositoryPath: string
    ): Promise<null> {
        if (err?.statusCode === 401) {
            this.setupApiKeyWatcher(repositoryPath, provider);
            const providerLabel = getProviderLabel(provider);
            this.promptReplaceKeyOrManage(provider, providerLabel).catch(() => { });
            return null;
        }
        if (err?.statusCode === 400) {
            try {
                await vscode.window.showWarningMessage(
                    `${err.message}`,
                );
                void vscode.commands.executeCommand('git-commit-genie.cancelRepositoryAnalysis');
            } catch { }
            return null;
        }
        if (err?.statusCode === 403) {
            try {
                const providerLabel = getProviderLabel(provider);
                const choice = await vscode.window.showWarningMessage(
                    `${providerLabel} access denied. Check your API key permissions or plan.`,
                    vscode.l10n.t(I18N.actions.manageModels),
                    vscode.l10n.t(I18N.actions.dismiss)
                );
                if (choice === vscode.l10n.t(I18N.actions.manageModels)) {
                    void vscode.commands.executeCommand('git-commit-genie.manageModels');
                }
            } catch { }
            return null;
        }
        if (err?.statusCode === 429) {
            try {
                const model = this.getActiveModelForProvider(provider);
                await vscode.window.showWarningMessage(
                    vscode.l10n.t(
                        I18N.rateLimit.hit,
                        getProviderLabel(provider),
                        model || 'model',
                        vscode.l10n.t(I18N.settings.chainMaxParallelLabel)
                    ),
                    vscode.l10n.t(I18N.actions.openSettings),
                    vscode.l10n.t(I18N.actions.dismiss)
                ).then(choice => {
                    if (choice === vscode.l10n.t(I18N.actions.openSettings)) {
                        void vscode.commands.executeCommand('workbench.action.openSettings', 'gitCommitGenie.chain.maxParallel');
                    }
                });
            } catch { }
            return null;
        }
        const errorMsg = err?.message || 'Failed to generate repository analysis';
        logger.error('[Genie][RepoAnalysis] LLM analysis failed', errorMsg);
        throw new Error(errorMsg);
    }


    private handleAnalysisError(error: any, operationName: string): RepoAnalysisRunResult {
        if (error?.name === 'Canceled' || error?.message?.includes?.('cancel')) {
            logger.warn(`[Genie][RepoAnalysis] ${operationName} cancelled by user.`);
            return 'skipped';
        }
        logger.error(`Failed to ${operationName.toLowerCase()} repository analysis`, error as any);
        throw error;
    }

    /**
     * Sets up a watcher for API key changes to retry analysis
     * 
     * When an API key is missing or invalid, this creates a listener
     * that will automatically retry repository analysis when the key
     * is updated in the secrets storage.
     * 
     * @param repositoryPath The repository path to analyze when key changes
     * @param provider The provider whose key is being watched
     */
    private setupApiKeyWatcher(repositoryPath: string, provider: string): void {
        if (this.apiKeyWaiters.has(repositoryPath)) { return; }
        const selected = this.pickRepoAnalysisService();
        const disp = this.context.secrets.onDidChange(async (e) => {
            try {
                if (!e?.key || !e.key.startsWith('gitCommitGenie.secret.')) { return; }
                try { await selected.service?.refreshFromSettings(); } catch { }
                const d = this.apiKeyWaiters.get(repositoryPath);
                if (d) { try { d.dispose(); } catch { } this.apiKeyWaiters.delete(repositoryPath); }
                await this.initializeRepository(repositoryPath);
            } catch { }
        });
        this.apiKeyWaiters.set(repositoryPath, disp);
        try { this.context.subscriptions.push(disp); } catch { }
    }

    /**
     * Shows a dialog prompting the user to manage API keys
     * 
     * Displays a warning message with options to manage models/keys
     * or dismiss the notification.
     * 
     * @param provider The provider with the missing/invalid key
     * @param providerLabel The display name of the provider
     */
    private async promptReplaceKeyOrManage(provider: string, providerLabel: string): Promise<void> {
        try {
            const action = await vscode.window.showWarningMessage(
                `${providerLabel} API key seems missing or invalid.`,
                vscode.l10n.t(I18N.actions.manageModels),
                vscode.l10n.t(I18N.actions.dismiss)
            );
            if (action === vscode.l10n.t(I18N.actions.manageModels)) {
                void vscode.commands.executeCommand('git-commit-genie.manageModels');
            }
        } catch { }
    }


    /**
     * Truncates a string to a maximum character length
     * 
     * Ensures strings don't exceed a specified character limit by
     * truncating them and adding a truncation indicator.
     * 
     * @param s The string to truncate
     * @param maxChars Maximum number of characters allowed
     * @returns The truncated string with indicator if needed
     */
    private truncateTo(s: string, maxChars: number): string {
        if (!s) { return ''; }
        if (s.length <= maxChars) { return s; }
        return s.slice(0, Math.max(0, maxChars - 8)) + '\n...[truncated]';
    }

    /**
     * Saves repository analysis to extension's global state
     * 
     * @param repositoryPath The repository path as the key
     * @param analysis The analysis data to save
     */
    private async saveAnalysis(repositoryPath: string, analysis: RepositoryAnalysis): Promise<void> {
        const key = this.getAnalysisStateKey(repositoryPath);
        await this.context.globalState.update(key, analysis);
    }

    /**
     * Saves repository analysis as a markdown file in the repository
     * 
     * Creates a markdown summary of the repository analysis and saves it
     * to the .gitgenie directory. Also ensures the directory is added to
     * .gitignore to prevent committing analysis data.
     * 
     * @param repositoryPath The repository path where to save the file
     * @param analysis The analysis data to save as markdown
     * @param opts Options for saving, including whether to overwrite existing files
     * @returns The path to the saved markdown file
     */
    public async saveAnalysisMarkdown(
        repositoryPath: string,
        analysis: RepositoryAnalysis,
        opts?: { overwrite?: boolean }
    ): Promise<string> {
        const mdPath = this.getAnalysisMarkdownFilePath(repositoryPath);
        const mdDir = path.dirname(mdPath);
        if (!fs.existsSync(mdDir)) { fs.mkdirSync(mdDir, { recursive: true }); }
        await this.ensureGitignoreForGitGenie(repositoryPath);
        if (fs.existsSync(mdPath) && opts?.overwrite === false) { return mdPath; }
        const content = [
            '# Repository Analysis Summary',
            '',
            analysis.summary,
            '',
        ].filter(Boolean).join('\n');
        fs.writeFileSync(mdPath, content, 'utf-8');
        return mdPath;
    }

    /**
     * Gets the file path for the analysis markdown file
     * 
     * @param repositoryPath The repository path
     * @returns The absolute path to the analysis markdown file
     */
    public getAnalysisMarkdownFilePath(repositoryPath: string): string {
        return path.join(repositoryPath, '.gitgenie', RepositoryAnalysisService.ANALYSIS_MD_FILE_NAME);
    }

    /**
     * Ensures the .gitgenie directory is added to .gitignore
     * 
     * Adds an entry to the repository's .gitignore file to prevent
     * committing the analysis data stored in the .gitgenie directory.
     * 
     * @param repositoryPath The repository path
     */
    private async ensureGitignoreForGitGenie(repositoryPath: string): Promise<void> {
        try {
            const gitignorePath = path.join(repositoryPath, '.gitignore');
            const ignoreEntry = '.gitgenie/**';
            const ignoreSection = `# Ignore Git Commit Genie data\n${ignoreEntry}\n`;
            let existing = '';
            if (fs.existsSync(gitignorePath)) {
                try { existing = fs.readFileSync(gitignorePath, 'utf-8'); } catch { existing = ''; }
            }
            if (existing.includes(ignoreEntry) || existing.includes('.gitgenie/')) { return; }
            const toAppend = existing.length > 0 && !existing.endsWith('\n') ? `\n${ignoreSection}` : ignoreSection;
            fs.appendFileSync(gitignorePath, toAppend, { encoding: 'utf-8' });
        } catch (error) {
            logger.warn('[Genie][RepoAnalysis] Failed to update .gitignore for .gitgenie', error as any);
        }
    }

    /**
     * Generates a unique state key for storing repository analysis
     * 
     * Creates a consistent key based on the repository path for
     * storing and retrieving analysis data from extension state.
     * 
     * @param repositoryPath The repository path to create a key for
     * @returns The state key for the repository
     */
    private getAnalysisStateKey(repositoryPath: string): string {
        const repoHash = this.hashPath(repositoryPath);
        return `${RepositoryAnalysisService.ANALYSIS_STATE_KEY_PREFIX}${repoHash}`;
    }

    /**
     * Creates a hash of a file path for use in state keys
     * 
     * @param filePath The file path to hash
     * @returns MD5 hash of the file path
     */
    private hashPath(filePath: string): string {
        return crypto.createHash('md5').update(filePath).digest('hex');
    }

    /**
     * Execute a git CLI command in the given repository path.
     */
    private async git(repoPath: string, args: string, timeoutMs: number = 15000): Promise<{ stdout: string; stderr: string }> {
        try {
            return await RepositoryAnalysisService.execPromise(args, { cwd: repoPath, timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024 });
        } catch (err: any) {
            const msg = err?.stderr || err?.stdout || err?.message || 'git command failed';
            throw new Error(String(msg));
        }
    }

    /**
     * Pull recent commits with changed files using a single git log call (no raw diffs).
     * Uses a record separator to delineate commits and parses file lists under each commit.
     */
    private async getRecentCommitsWithFiles(
        repoPath: string,
        n: number
    ): Promise<Array<{ hash: string; shortHash: string; subject: string; files: string[] }>> {
        try {
            if (!n || n <= 0) { return []; }

            try {
                const { stdout } = await this.git(repoPath, 'git rev-parse --is-inside-work-tree');
                if (!stdout.toString().trim().startsWith('true')) { return []; }
            } catch { return []; }

            const logFormat = '%x1e%H%x1f%s%n';
            const { stdout: logStdout } = await this.git(
                repoPath,
                `git log -n ${Math.max(1, n)} --pretty=format:${logFormat} --name-only --no-color`
            );

            const chunks = (logStdout || '').toString().split('\x1e');
            const out: Array<{ hash: string; shortHash: string; subject: string; files: string[] }> = [];

            for (const raw of chunks) {
                const chunk = raw.trim();
                if (!chunk) { continue; }

                const idx = chunk.indexOf('\n');
                const header = idx >= 0 ? chunk.slice(0, idx) : chunk;
                const filesBlock = idx >= 0 ? chunk.slice(idx + 1) : '';

                const [hashRaw, subjectRaw] = header.split('\x1f');
                const hash = (hashRaw || '').trim();
                const subject = (subjectRaw || '').trim();
                if (!hash) { continue; }

                const files = Array.from(new Set(
                    filesBlock
                        .split('\n')
                        .map(s => s.trim())
                        .filter(line => !!line && !line.includes('\x1f') && !line.includes('\x1e'))
                ));

                out.push({
                    hash,
                    shortHash: hash.slice(0, 7),
                    subject,
                    files
                });
            }

            return out;
        } catch (error) {
            logger.warn('[Genie][RepoAnalysis] getRecentCommitsWithFiles failed', error as any);
            return [];
        }
    }

    /**
     * Synchronizes analysis data from markdown file to extension state
     * 
     * Reads the analysis markdown file if it exists and updates the
     * in-memory analysis data with its contents.
     * 
     * @param repositoryPath The repository path to sync
     */
    public async syncAnalysisFromMarkdown(repositoryPath: string): Promise<void> {
        try {
            const mdPath = this.getAnalysisMarkdownFilePath(repositoryPath);
            if (!fs.existsSync(mdPath)) { return; }
            const md = fs.readFileSync(mdPath, 'utf-8');
            let current = await this.getAnalysis(repositoryPath);
            if (current && current.summary) {
                current.summary = md.trim();
                await this.saveAnalysis(repositoryPath, current);
                logger.info('[Genie][RepoAnalysis] Synced analysis JSON from Markdown.');
                return;
            }
            logger.warn('[Genie][RepoAnalysis] No existing analysis JSON to sync from Markdown.');
        } catch (error) {
            logger.warn('[Genie][RepoAnalysis] Failed to sync analysis from Markdown', error as any);
        }
    }

    public async clearAnalysis(repositoryPath: string): Promise<void> {
        try {
            // Clear JSON data from globalState
            const key = this.getAnalysisStateKey(repositoryPath);
            await this.context.globalState.update(key, undefined);

            // Delete the markdown file
            const mdPath = this.getAnalysisMarkdownFilePath(repositoryPath);
            if (fs.existsSync(mdPath)) {
                fs.unlinkSync(mdPath);
                logger.info('[Genie][RepoAnalysis] Deleted analysis markdown file');
            }

        } catch (error) {
            logger.warn('[Genie][RepoAnalysis] Failed to clear analysis data', error as any);
            throw error;
        }
    }

    private async isResetStep(): Promise<boolean> {
        const choice = await vscode.window.showInformationMessage(
            vscode.l10n.t(I18N.repoAnalysis.resetStepNotification),
            vscode.l10n.t(I18N.repoAnalysis.resetAndContinue),
            vscode.l10n.t(I18N.repoAnalysis.cancel)
        );

        if (choice === vscode.l10n.t(I18N.repoAnalysis.resetAndContinue)) {
            logger.info('[Genie][RepoAnalysis] User chose to reset step count and continue');
            return true;
        } else {
            logger.info('[Genie][RepoAnalysis] User cancelled step reset');
            return false;
        }
    }

}
