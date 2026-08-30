import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as util from 'util';
import { exec } from 'child_process';
import { z } from 'zod';

import {
    IRepositoryAnalysisService,
    RepositoryAnalysis,
    CommitHistoryEntry,
    AnalysisConfig,
    LLMAnalysisResponse,
    RepoAnalysisRunResult
} from './repositoryAnalysisTypes';

import { LLMError, LLMService } from '../../llm/llmTypes';
import { RepoService } from '../../repo/repo';
import { logger } from '../../logger';
import { L10N_KEYS as I18N } from '../../../i18n/keys';
import {
    AI_MODELS_KEY,
    REPOSITORY_ANALYSIS_MODEL_ID_KEY,
    AIModelConfig,
    PROVIDER_LABELS,
    AIMessage,
} from '../../llm/providers';
import { repoAnalysisResponseSchema } from '../../llm/providers/schemas/common';
import { AgentTool, runAgentLoop } from '../../../agent';

// Tools
import { listDirectory } from '../tools/directory';
import { searchFiles } from '../tools/search';
import { readFileContent } from '../tools/file';
import { compactToolResultForConversation } from '../tools/formatting';
import { DirectoryEntry, SearchFilesResult, ToolResult } from '../tools/types';
import { buildGitGenieIgnoreAppend } from '../../../utils/gitignore';
import { ChangeAnalysisAgentParams, runChangeAnalysisAgent } from '../change/investigation/agent';
import { RepositoryEvidence } from '../change/types';
import {
    logRepositoryAnalysisToolCall,
    wrapSessionWithWebviewLogging,
} from '../../llm/chatWebviewLogging';

const REPOSITORY_ANALYSIS_MARKDOWN_TITLE = '# Repository Analysis Summary';

const REPOSITORY_TOOL_PARAMETERS: Record<string, unknown> = {
    type: 'object',
    properties: {
        reason: { type: 'string' },
        dirPath: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        depth: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
        excludePatterns: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
        query: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        searchType: { anyOf: [{ enum: ['name', 'content'] }, { type: 'null' }] },
        useRegex: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
        searchPath: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        maxResults: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
        caseSensitive: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
        maxMatchesPerFile: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
        contextLines: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
        filePath: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        startLine: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
        maxLines: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
        encoding: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    },
    required: [
        'reason', 'dirPath', 'depth', 'excludePatterns', 'query', 'searchType', 'useRegex',
        'searchPath', 'maxResults', 'caseSensitive', 'maxMatchesPerFile', 'contextLines',
        'filePath', 'startLine', 'maxLines', 'encoding',
    ],
    additionalProperties: false,
};

/**
 * Removes the file-level title from the beginning of an analysis summary.
 *
 * The Markdown file owns this title, while the stored summary owns only the
 * body. Keeping that boundary explicit prevents a synced or model-generated
 * title from being prepended again on the next write.
 */
function stripRepositoryAnalysisMarkdownTitle(summary: string): string {
    const lines = summary.split(/\r?\n/);
    let bodyStart = 0;
    let removedTitle = false;

    while (bodyStart < lines.length) {
        while (bodyStart < lines.length && lines[bodyStart].trim() === '') {
            bodyStart += 1;
        }
        if (lines[bodyStart]?.trim() !== REPOSITORY_ANALYSIS_MARKDOWN_TITLE) {
            break;
        }
        removedTitle = true;
        bodyStart += 1;
    }

    return removedTitle ? lines.slice(bodyStart).join('\n') : summary;
}

/**
 * Tool-driven repository analysis service
 * 
 * This module provides an LLM-driven repository analysis flow
 * where the model decides how to explore the repository by calling tools
 * (listDirectory, searchFiles, readFileContent).
 */
export class RepositoryAnalysisService implements IRepositoryAnalysisService {
    private static readonly ANALYSIS_MD_FILE_NAME = 'repository-analysis.md';
    private static readonly ANALYSIS_STATE_KEY_PREFIX = 'gitCommitGenie.analysis.';

    private resolveLLMService?: (modelId: string) => (LLMService | undefined);

    private repoService: RepoService;
    private context: vscode.ExtensionContext;
    private activeCancelSources: Map<string, vscode.CancellationTokenSource> = new Map();
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

    // Event emitter for analysis changes
    private readonly _onAnalysisChanged = new vscode.EventEmitter<string>();
    public readonly onAnalysisChanged = this._onAnalysisChanged.event;

    constructor(context: vscode.ExtensionContext, repoService: RepoService) {
        this.context = context;
        this.repoService = repoService;
    }

    /**
     * Runs the same repository-analysis subsystem in a change-conditioned mode.
     * The commit pipeline owns the diff-specific prompt and execution context;
     * this service owns repository-agent execution and tools.
     */
    public async runChangeAnalysis(params: ChangeAnalysisAgentParams): Promise<RepositoryEvidence> {
        return runChangeAnalysisAgent(params);
    }

    /**
     * Sets a resolver function to dynamically obtain LLM services by model id.
     * 
     * @param resolver Function that resolves model ids to LLM service instances.
     */
    public setLLMResolver(resolver: (modelId: string) => (LLMService | undefined)) {
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
            if (!cfg.enabled) {
                return 'skipped';
            }
            const cancelSource = new vscode.CancellationTokenSource();
            this.activeCancelSources.set(repositoryPath, cancelSource);

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

                if (cancelSource.token.isCancellationRequested) {
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
            } finally {
                this.activeCancelSources.delete(repositoryPath);
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
            const cancelSource = new vscode.CancellationTokenSource();
            this.activeCancelSources.set(repositoryPath, cancelSource);

            try {
                const existing = await this.getAnalysis(repositoryPath);
                if (!existing) {
                    return await this.initializeRepository(repositoryPath);
                }

                // Emit a divider log entry and info when starting an update run
                logger.info(`[Genie][RepoAnalysis] Updating for: ${repositoryPath}`);
                logger.logAnalysisStart(repositoryPath);

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

                if (cancelSource.token.isCancellationRequested) {
                    logger.warn('[Genie][RepoAnalysis] Update cancelled after LLM response; aborting save.');
                    return 'skipped';
                }

                await this.saveAnalysis(repositoryPath, updated);
                await this.saveAnalysisMarkdown(repositoryPath, updated);
                logger.info('[Genie][RepoAnalysis] Update completed.');
                return 'success';
            } catch (error: any) {
                return this.handleAnalysisError(error, 'Update');
            } finally {
                this.activeCancelSources.delete(repositoryPath);
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
        for (const source of this.activeCancelSources.values()) {
            try { source.cancel(); } catch { /* ignore */ }
        }
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
                desc: 'Search by file name or content; for content searches, results include 1-based match line numbers; paths must be inside repository.'
            },
            {
                name: 'readFileContent',
                args: '{ filePath: string; startLine?: number; maxLines?: number; encoding?: string }',
                desc: 'Read a file segment; use startLine to jump near lines returned by content search; filePath must be inside repository.'
            }
        ];

        const userExcludes = this.normalizeExcludePatterns(input.excludePatterns);
        const isIncremental = !!input.previousAnalysis;
        const commitWindowSize = Array.isArray(input.recentCommits) ? input.recentCommits.length : 0;
        const system = [
            'You are an autonomous repository analysis agent. You can call tools to explore the repository and then produce a final structured analysis.',
            'Call the provided functions directly when repository evidence is needed.',
            'For every tool call, include a concise English reason describing what you will do next.',
            'When exploration is complete, stop calling tools and return the requested final JSON object.',
            'Efficiency tip: When using searchFiles with searchType="content", results include 1-based line numbers for each match. If you then read the file, prefer calling readFileContent with startLine set near that match (e.g., max(1, line-40)) and a modest maxLines window (e.g., 100–150) to inspect local context instead of reading from the file start.',
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

        let msgs: AIMessage[] = [
            { role: 'system', content: system },
            {
                role: 'user', content: [
                    `Repository root: ${repoPath}`,
                    userExcludes.length ? `Exclude patterns (from settings, optional): ${JSON.stringify(userExcludes)}` : undefined,
                    input.previousAnalysis ? `Previous summary: ${input.previousAnalysis.summary || ''}` : undefined,
                    input.previousAnalysis ? `Previous technologies: ${(input.previousAnalysis.technologies || []).join(', ')}` : undefined,
                    input.previousAnalysis ? `Previous insights: ${(input.previousAnalysis.insights || []).join('; ')}` : undefined,
                    isIncremental ? `Analysis mode: incremental (review at most ${commitWindowSize} commits; update only if material change).` : 'Analysis mode: initial',
                    recentCommitsBlock || undefined,
                    isIncremental ? 'Use commit messages above to hypothesize impacted areas. Prefer targeted searchFiles and a few readFileContent calls to verify. Avoid full scans.' : undefined,
                    rootDirContext, // Include pre-fetched root directory structure
                    includeRecentChangesSection ? recentChangesContext : undefined, // Avoid duplication
                    '',
                    'Goal: Provide global context strictly for commit message generation. In incremental mode, focus on whether the latest commits change repository functionality or architecture, and finalize early if not. Include an insights line starting with "Incremental:" that states whether a repo-level update is needed and why.'
                ].filter(Boolean).join('\n')
            }
        ];

        const { service } = this.pickRepoAnalysisService();
        const sessionId = `repository-analysis:${repoPath}`;
        const execution = service.createExecution(repoPath, { token: this.activeCancelSources.get(repoPath)?.token });
        let maxSteps = vscode.workspace.getConfiguration('gitCommitGenie').get<number>('repositoryAnalysis.MaxCount', 99999);
        if (maxSteps === -1) {
            maxSteps = 99999;
        }
        let agentStep = 0;
        const tools: AgentTool[] = toolsSpec.map(spec => ({
            name: spec.name,
            description: `${spec.desc} Set unused arguments to null.`,
            parameters: REPOSITORY_TOOL_PARAMETERS,
            execute: async argumentsValue => {
                const reason = String(argumentsValue.reason || '').trim();
                agentStep += 1;
                logger.info(`[Genie][RepoAnalysis] Model chose tool '${spec.name}'. Reason: ${reason.slice(0, 500)}`);
                // readFileContent already logs through logger.logFileRead inside the tool.
                if (spec.name !== 'readFileContent') {
                    logRepositoryAnalysisToolCall(
                        repoPath,
                        spec.name,
                        argumentsValue,
                        reason,
                        agentStep,
                        maxSteps,
                    );
                }
                const toolResult = await this.runTool(repoPath, spec.name, argumentsValue, userExcludes);
                this.logToolOutcome(spec.name, toolResult);
                return compactToolResultForConversation(repoPath, spec.name, toolResult).compactText;
            },
        }));
        const session = wrapSessionWithWebviewLogging(
            execution.createSession(msgs, sessionId),
            repoPath,
            'investigation',
        );
        const result = await runAgentLoop(session, msgs, tools, {
            maxSteps,
            responseFormat: {
                name: 'repositoryAnalysisFinal',
                schema: z.toJSONSchema(repoAnalysisResponseSchema) as Record<string, unknown>,
            },
            schema: repoAnalysisResponseSchema,
            maxRetries: execution.maxRetries,
            temperature: execution.temperature,
            maxOutputTokens: execution.maxOutputTokens,
            thinking: execution.thinkingFor('investigation'),
            tokenBudget: execution.tokenBudget,
            requestType: 'investigation',
            signal: execution.signal,
        });
        const final = repoAnalysisResponseSchema.parse(result.structured);
        logger.info(`[Genie][RepoAnalysis] Final: projectType=${final.projectType}; technologies=${final.technologies.slice(0, 5).join(', ')}; insights=${final.insights.length}`);
        logger.logAnalysisComplete(repoPath, final);
        return final;

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
                default:
                    logger.info(`[Genie][RepoAnalysis] ${toolName} -> success.`);
            }
        } catch { /* ignore logging failures */ }
    }

    // Compacting helpers live in tools/formatting.ts.

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
    private pickRepoAnalysisService(): { provider: string, service: LLMService } {
        const modelId = this.context.globalState.get<string>(REPOSITORY_ANALYSIS_MODEL_ID_KEY, '');
        const model = this.getConfiguredModel(modelId);
        const service = this.resolveLLMService?.(model.id);
        if (!service) {
            throw new Error(`Repository analysis model '${model.label}' has no service.`);
        }
        return { provider: model.provider, service };
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
        const modelId = this.context.globalState.get<string>(REPOSITORY_ANALYSIS_MODEL_ID_KEY, '');
        const model = this.getConfiguredModel(modelId);
        if (model.provider !== provider) {
            throw new Error(`Repository analysis provider '${provider}' does not match '${model.provider}'.`);
        }
        return model.model;
    }

    private getProviderDisplayLabel(provider: string): string {
        const modelId = this.context.globalState.get<string>(REPOSITORY_ANALYSIS_MODEL_ID_KEY, '');
        const model = this.getConfiguredModel(modelId);
        if (model.provider !== provider) {
            throw new Error(`Repository analysis provider '${provider}' does not match '${model.provider}'.`);
        }
        return `${PROVIDER_LABELS[model.provider]} · ${model.label}`;
    }

    private getConfiguredModel(modelId: string): AIModelConfig {
        const models = this.context.globalState.get<AIModelConfig[]>(AI_MODELS_KEY, []);
        if (!Array.isArray(models)) {
            throw new Error('AI model configuration is not an array.');
        }
        const model = models.find(candidate => candidate.id === modelId);
        if (!model) {
            throw new Error(`Repository analysis model '${modelId}' is not configured.`);
        }
        return model;
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
            const providerLabel = this.getProviderDisplayLabel(provider);
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
                const providerLabel = this.getProviderDisplayLabel(provider);
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
                        this.getProviderDisplayLabel(provider),
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
        const summaryBody = stripRepositoryAnalysisMarkdownTitle(analysis.summary);
        const content = [
            REPOSITORY_ANALYSIS_MARKDOWN_TITLE,
            '',
            summaryBody,
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
            let existing = '';
            if (fs.existsSync(gitignorePath)) {
                try { existing = fs.readFileSync(gitignorePath, 'utf-8'); } catch { existing = ''; }
            }
            const toAppend = buildGitGenieIgnoreAppend(existing, 'Ignore Git Commit Genie data');
            if (!toAppend) { return; }
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
                current.summary = stripRepositoryAnalysisMarkdownTitle(md).trim();
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

            // Fire analysis changed event
            this._onAnalysisChanged.fire(repositoryPath);

        } catch (error) {
            logger.warn('[Genie][RepoAnalysis] Failed to clear analysis data', error as any);
            throw error;
        }
    }

}
