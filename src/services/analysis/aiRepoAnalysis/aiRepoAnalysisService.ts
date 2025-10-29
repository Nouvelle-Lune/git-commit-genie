import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import {
	IRepositoryAnalysisService,
	RepositoryAnalysis,
	CommitHistoryEntry,
	AnalysisConfig,
	LLMAnalysisRequest,
	LLMAnalysisResponse,
	RepoAnalysisRunResult,
	AnalysisPromptParts,
	RepositoryScanResult
} from '../analysisTypes';
import { LLMService, LLMError, ChatMessage } from '../../llm/llmTypes';
import { RepoService } from '../../repo/repo';
import { logger } from '../../logger';
import { L10N_KEYS as I18N } from '../../../i18n/keys';
import { getProviderLabel, getProviderModelStateKey, getAllProviderKeys } from '../../llm/providers/config/providerConfig';

// Tools
import { listDirectory } from '../tools/directoryTools';
import { searchFiles } from '../tools/searchTools';
import { readFileContent } from '../tools/fileTools';
import { compressContext } from '../tools/compressionTools';
import { DirectoryEntry, SearchFilesResult, ToolResult } from '../tools/toolTypes';
import { getMaxContextByFunction, estimateCharBudget } from '../tools/modelContext';

/**
 * Tool-driven repository analysis service
 * 
 * This module provides an experimental, LLM-driven repository analysis flow
 * where the model decides how to explore the repository by calling tools
 * (listDirectory, searchFiles, readFileContent, compressContext). It avoids
 * fixed scanning logic and stores results in the same structure as the
 * existing analysis, but under a separate storage key and markdown file.
 */
export class AIRepositoryAnalysisService implements IRepositoryAnalysisService {
	private static readonly ANALYSIS_MD_FILE_NAME = 'repository-analysis.ai.md';
	private static readonly ANALYSIS_STATE_KEY_PREFIX = 'gitCommitGenie.aiAnalysis.';

	private llmService: LLMService | null;
	private resolveLLMService?: (provider: string) => (LLMService | undefined);

	private repoService: RepoService;
	private context: vscode.ExtensionContext;
	private currentCancelSource?: vscode.CancellationTokenSource;
	private apiKeyWaiters: Map<string, vscode.Disposable> = new Map();

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
		const cfg = this.getConfig();
		this.currentCancelSource = new vscode.CancellationTokenSource();

		if (!cfg.enabled) {
			return 'skipped';
		}

		try {
			const existing = await this.getAnalysis(repositoryPath);
			if (existing) {
				logger.info('[Genie][AIRepoAnalysis] Analysis exists, skip init.');
				return 'skipped';
			}

			logger.info(`[Genie][AIRepoAnalysis] Initializing for: ${repositoryPath}`);
			const commitMessageLog = await this.repoService.getRepositoryGitMessageLog(repositoryPath);

			const llmResp = await this.runAgenticAnalysis({
				repositoryPath,
				recentCommits: (commitMessageLog || []).slice(0, cfg.updateThreshold) || [],
				excludePatterns: cfg.excludePatterns || []
			});
			if (!llmResp) { return 'skipped'; }

			if (this.currentCancelSource?.token.isCancellationRequested) {
				logger.warn('[Genie][AIRepoAnalysis] Initialization cancelled after LLM response; aborting save.');
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

			logger.info('[Genie][AIRepoAnalysis] Initialization completed.');
			return 'success';
		} catch (error: any) {
			return this.handleAnalysisError(error, 'Initialization');
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
				logger.warn('[Genie][AIRepoAnalysis] Update cancelled after LLM response; aborting save.');
				return 'skipped';
			}

			await this.saveAnalysis(repositoryPath, updated);
			await this.saveAnalysisMarkdown(repositoryPath, updated);
			logger.info('[Genie][AIRepoAnalysis] Update completed.');
			return 'success';
		} catch (error: any) {
			return this.handleAnalysisError(error, 'Update');
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
			logger.error('[Genie][AIRepoAnalysis] Failed to read repository analysis', error as any);
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
			logger.warn('[Genie][AIRepoAnalysis] Failed to retrieve commit history from Git', error as any);
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
			logger.error('[Genie][AIRepoAnalysis] Failed to get analysis for prompt', error as any);
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
		logger.info(`[Genie][AIRepoAnalysis] Begin analysis for: ${repoPath}`);

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
		const system = [
			'You are an autonomous repository analysis agent. You can call tools to explore the repository and then produce a final structured analysis.',
			'Respond with STRICT JSON only, no markdown code fences.',
			'For every tool action, include a concise English "reason" describing what you will do next (e.g., "I will use searchFiles to look for framework imports").',
			'',
			'Action schema:',
			'{',
			'  "action": "tool" | "final",',
			'  "toolName"?: "listDirectory" | "searchFiles" | "readFileContent" | "compressContext",',
			'  "args"?: object,',
			'  "reason"?: string,',
			'  "final"?: {',
			'     "summary": string,',
			'     "projectType": string,',
			'     "technologies": string[],',
			'     "insights": string[]',
			'  }',
			'}',
			'',
			'Tool catalog:'
		].concat(toolsSpec.map(t => `- ${t.name} ${t.args}: ${t.desc}`)).join('\n');

		const msgs: ChatMessage[] = [
			{ role: 'system', content: system },
			{
				role: 'user', content: [
					`Repository root: ${repoPath}`,
					userExcludes.length ? `Exclude patterns (from settings, optional): ${JSON.stringify(userExcludes)}` : undefined,
					input.previousAnalysis ? `Previous summary: ${this.truncateTo(input.previousAnalysis.summary || '', 800)}` : undefined,
					input.previousAnalysis ? `Previous technologies: ${(input.previousAnalysis.technologies || []).join(', ')}` : undefined,
					input.recentCommits?.length ? `Recent commits: ${input.recentCommits.slice(0, 5).map(c => `- ${c}`).join('\n')}` : undefined,
					'',
					'Goal: Explore just enough to confidently infer project type, tech stack and 3-8 key insights. Minimize tool calls. When done, return action="final".'
				].filter(Boolean).join('\n')
			}
		];

		// Limit total thinking/acting steps to prevent runaway loops
		const maxSteps = 12;
		for (let step = 0; step < maxSteps; step++) {
			const action = await this.safeJsonCall(msgs, repoPath);
			if (!action) { return null; }

			if (action.action === 'final') {
				logger.info('[Genie][AIRepoAnalysis] Model produced final analysis.');
				const f = action.final || {};
				if (typeof f.summary === 'string' && Array.isArray(f.technologies) && Array.isArray(f.insights) && typeof f.projectType === 'string') {
					logger.info(`[Genie][AIRepoAnalysis] Final: projectType=${f.projectType}; technologies=${(f.technologies || []).slice(0, 5).join(', ')}; insights=${(f.insights || []).length}`);
					return {
						summary: f.summary,
						technologies: f.technologies,
						insights: f.insights,
						projectType: f.projectType
					};
				}
				// invalid final
				logger.warn('[Genie][AIRepoAnalysis] Final action missing required fields; abort.');
				return null;
			}

			if (action.action === 'tool') {
				const toolName = String(action.toolName || '');
				const args = (action.args || {}) as any;
				logger.info(`[Genie][AIRepoAnalysis] Step ${step + 1}: Model chose tool '${toolName}'. Reason: ${String(action.reason || '').slice(0, 500)}`);
				const result = await this.runTool(repoPath, toolName, args, userExcludes);
				this.logToolOutcome(toolName, result);
				// Record assistant intent and tool result for next reasoning turn
				msgs.push({ role: 'assistant', content: JSON.stringify(action) });
				msgs.push({ role: 'user', content: `TOOL_RESULT(${toolName}): ${JSON.stringify(result)}` });
				continue;
			}

			// Unknown action -> continue a bit, or abort
			msgs.push({ role: 'assistant', content: JSON.stringify({ error: 'Unknown action; please correct' }) });
		}

		return null;
	}

	/**
	 * Make a JSON-only LLM call via the provider service.
	 * Ensures temperature and token limits come from settings.
	 */
	private async safeJsonCall(history: ChatMessage[], repoPath: string): Promise<any | null> {
		try {
			const { provider, service } = this.pickRepoAnalysisService();
			if (!service) {
				throw Object.assign(new Error(`${provider} service is not available`), { statusCode: 400 });
			}

			const model = this.getActiveModelForProvider(provider) || '';

			// Type assertion to access chatJson method that all providers now have
			const chatJsonMethod = (service as any).chatJson;
			if (typeof chatJsonMethod !== 'function') {
				throw new Error('Provider does not support chatJson method');
			}

			const action = await chatJsonMethod.call(service, history, {
				model,
				token: this.currentCancelSource?.token
			});
			return action;
		} catch (err: any) {
			const provider = (this.context.globalState.get<string>('gitCommitGenie.provider', 'openai') || 'openai');
			if (err?.statusCode) {
				await this.handleLLMError({ message: err.message, statusCode: err.statusCode }, provider, repoPath);
				return null;
			}
			// try to recover by asking again to return valid JSON
			history.push({ role: 'assistant', content: JSON.stringify({ error: 'Invalid JSON returned. Return a valid action JSON.' }) });
			return null;
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
					logger.info(`[Genie][AIRepoAnalysis] Running listDirectory: dirPath='${dirPath}', depth=${depth}, excludes=${ex.length}`);
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
					logger.info(`[Genie][AIRepoAnalysis] Running searchFiles: type=${searchType}, query='${query}', useRegex=${useRegex}, path='${searchPath}', maxResults=${maxResults}`);
					return await searchFiles(repoPath, query, { searchType, useRegex, searchPath, maxResults, caseSensitive, excludePatterns: ex, maxMatchesPerFile, contextLines });
				}
				case 'readFileContent': {
					const filePath = this.resolveSafePath(repoPath, String(args.filePath || ''));
					const startLine = typeof args.startLine === 'number' ? args.startLine : 1;
					const maxLines = typeof args.maxLines === 'number' ? args.maxLines : 1000;
					const encoding = typeof args.encoding === 'string' ? args.encoding : 'utf-8';
					logger.info(`[Genie][AIRepoAnalysis] Running readFileContent: filePath='${filePath}', start=${startLine}, maxLines=${maxLines}`);
					return await readFileContent(filePath, { startLine, maxLines, encoding });
				}
				case 'compressContext': {
					const content = String(args.content || '');
					const targetTokens = typeof args.targetTokens === 'number' ? args.targetTokens : Math.floor(getMaxContextByFunction('repoAnalysis') * 0.4);
					const preserveStructure = !!args.preserveStructure;
					const language = typeof args.language === 'string' ? args.language : undefined;
					const chatFn = async (messages: ChatMessage[]): Promise<string> => {
						const { provider, service } = this.pickRepoAnalysisService();
						if (!service) {
							throw new Error(`${provider} service is not available`);
						}

						const model = this.getActiveModelForProvider(provider) || '';

						// Type assertion to access chatText method that all providers now have
						const chatTextMethod = (service as any).chatText;
						if (typeof chatTextMethod !== 'function') {
							throw new Error('Provider does not support chatText method');
						}

						return await chatTextMethod.call(service, messages, {
							model,
							token: this.currentCancelSource?.token
						});
					};
					logger.info(`[Genie][AIRepoAnalysis] Running compressContext: targetTokens=${targetTokens}, preserveStructure=${preserveStructure}, language=${language || 'n/a'}`);
					return await compressContext(content, chatFn, { targetTokens, preserveStructure, language });
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
			if (!result) { logger.info(`[Genie][AIRepoAnalysis] Tool '${toolName}' returned no result.`); return; }
			if (result.success === false) { logger.warn(`[Genie][AIRepoAnalysis] Tool '${toolName}' failed: ${result.error || 'unknown error'}`); return; }
			const data = result.data;
			switch (toolName) {
				case 'listDirectory': {
					const count = Array.isArray(data?.entries) ? data.entries.length : 0;
					logger.info(`[Genie][AIRepoAnalysis] listDirectory -> ${count} entries.`);
					break;
				}
				case 'searchFiles': {
					const total = typeof data?.totalMatches === 'number' ? data.totalMatches : 0;
					const files = Array.isArray(data?.results) ? data.results.length : 0;
					logger.info(`[Genie][AIRepoAnalysis] searchFiles -> ${total} matches in ${files} files.`);
					break;
				}
				case 'readFileContent': {
					const fp = data?.filePath || '';
					const start = data?.startLine;
					const end = data?.endLine;
					const hasMore = data?.hasMore ? 'yes' : 'no';
					logger.info(`[Genie][AIRepoAnalysis] readFileContent -> ${fp} [${start}-${end}], more=${hasMore}.`);
					break;
				}
				case 'compressContext': {
					const ratio = typeof data?.compressionRatio === 'number' ? (data.compressionRatio * 100).toFixed(1) + '%' : 'n/a';
					logger.info(`[Genie][AIRepoAnalysis] compressContext -> ratio=${ratio}.`);
					break;
				}
				default:
					logger.info(`[Genie][AIRepoAnalysis] ${toolName} -> success.`);
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
	 * - 400: Bad request errors (often missing model)
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
				const picked = await vscode.window.showWarningMessage(
					vscode.l10n.t(I18N.repoAnalysis.missingModel),
					vscode.l10n.t(I18N.actions.manageModels),
					vscode.l10n.t(I18N.actions.dismiss)
				);
				if (picked === vscode.l10n.t(I18N.actions.manageModels)) {
					void vscode.commands.executeCommand('git-commit-genie.manageModels');
				}
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
		logger.error('[Genie][AIRepoAnalysis] LLM analysis failed', errorMsg);
		throw new Error(errorMsg);
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
	 * Builds enhanced prompt parts for LLM repository analysis
	 * 
	 * Constructs a structured prompt with system instructions and user content
	 * containing repository information, scan results, and additional signals.
	 * The prompt is optimized for the selected LLM model's context window.
	 * 
	 * @param request The LLM analysis request containing repository data
	 * @param extra Additional signals gathered about the repository
	 * @returns Structured prompt parts for LLM consumption
	 */
	private buildEnhancedPromptParts(
		request: LLMAnalysisRequest,
		extra: AugmentedSignals
	): AnalysisPromptParts {
		const scan = this.normalizeScanResult(request.scanResult);
		const previous = request.previousAnalysis;
		const recentCommits = request.recentCommits || [];
		const repositoryPath = request.repositoryPath;

		// Determine a conservative char budget based on model
		const provider = this.pickRepoAnalysisService().provider;
		const model = this.getActiveModelForProvider(provider);
		const maxTokens = getMaxContextByFunction('repoAnalysis', model);
		const charBudget = estimateCharBudget(maxTokens, 0.6);

		const system = [
			'<role>',
			'You are an expert software engineer analyzing a code repository.',
			'</role>',
			'',
			'<critical>',
			'Return STRICT JSON only; do not include markdown or code fences.',
			'The final assistant message MUST be a single JSON object matching the schema.',
			'</critical>',
			'',
			'<instructions>',
			'Use the provided scan data and signals to infer project purpose, technology stack, and key insights.',
			'Be concise, focus on details that improve commit message context quality.',
			'</instructions>',
			'',
			'<schema>',
			'{',
			'  "summary": "Brief but comprehensive summary of the repository purpose and architecture",',
			'  "projectType": "Main project type (e.g., Web App, Library, CLI Tool, etc.)",',
			'  "technologies": ["array", "of", "main", "technologies", "used"],',
			'  "insights": ["key", "architectural", "insights", "about", "the", "project"]',
			'}',
			'</schema>'
		].join('\n');

		const parts: string[] = [
			'<input>',
			`Repository: ${repositoryPath}`,
			'',
			'## Scan Summary',
			`- Key Directories: ${scan.keyDirectories.join(', ')}`,
			`- Important Files: ${scan.importantFiles.map(f => f.path).join(', ')}`,
			`- Scanned Files: ${scan.scannedFileCount}`,
		];

		if (scan.readmeContent) {
			parts.push('', '## README (truncated)', '```', this.truncateTo(scan.readmeContent, Math.floor(charBudget * 0.15)), '```');
		}

		const cfgEntries = Object.entries(scan.configFiles);
		if (cfgEntries.length > 0) {
			parts.push('', '## Key Configuration Files (truncated)');
			for (const [filename, content] of cfgEntries.slice(0, 6)) {
				parts.push(`### ${filename}`, '```', this.truncateTo(content || '', 1200), '```');
			}
		}

		// Additional signals
		if (extra.rootEntries?.length) {
			parts.push('', '## Root Directory Entries', extra.rootEntries.map(e => `- ${e.type}: ${e.name}`).join('\n'));
		}
		if (extra.entryFiles?.length) {
			parts.push('', '## Potential Entry Files', ...extra.entryFiles.slice(0, 20).map(f => `- ${f}`));
		}
		if (extra.languageCounts && Object.keys(extra.languageCounts).length) {
			const langStr = Object.entries(extra.languageCounts)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 10)
				.map(([ext, count]) => `${ext}: ${count}`).join(', ');
			parts.push('', `## Language Signals: ${langStr}`);
		}
		if (extra.frameworkMatches?.results?.length) {
			parts.push('', '## Framework Signals (top matches)');
			for (const res of extra.frameworkMatches.results.slice(0, 12)) {
				parts.push(`- ${res.filePath}${res.matches && res.matches.length ? ` (lines: ${res.matches.slice(0, 2).map(m => m.line).join(', ')})` : ''}`);
			}
		}

		if (previous) {
			parts.push(
				'',
				'## Previous Analysis Snapshot',
				`Project Type: ${previous.projectType}`,
				`Technologies: ${previous.technologies.join(', ')}`,
				`Summary: ${this.truncateTo(previous.summary, 1200)}`,
				`Insights: ${(previous.insights || []).slice(0, 10).join('; ')}`
			);
		}

		if (recentCommits && recentCommits.length > 0) {
			parts.push('', '## Recent Commit Messages', ...recentCommits.slice(0, 5).map(m => `- ${m}`));
		}

		parts.push('', '</input>', '', '<output>', 'Respond with the JSON object per schema only.', '</output>');

		return {
			system: { role: 'system', content: system },
			user: { role: 'user', content: this.truncateTo(parts.join('\n'), charBudget) }
		};
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
	 * Normalizes repository scan results to ensure consistent structure
	 * 
	 * Handles potentially undefined or malformed scan results by
	 * providing default values and ensuring all expected properties exist.
	 * 
	 * @param raw The raw scan result to normalize
	 * @returns A normalized repository scan result
	 */
	private normalizeScanResult(raw: RepositoryScanResult | undefined): RepositoryScanResult {
		if (!raw) {
			return {
				keyDirectories: [],
				importantFiles: [],
				configFiles: {},
				scannedFileCount: 0,
				scanDuration: 0,
			} as RepositoryScanResult;
		}
		const keyDirectories = Array.isArray(raw.keyDirectories) ? raw.keyDirectories : [];
		const importantFiles = Array.isArray(raw.importantFiles) ? raw.importantFiles : [] as any;
		const configFiles = raw.configFiles || {};
		const scannedFileCount = typeof raw.scannedFileCount === 'number' ? raw.scannedFileCount : 0;
		const scanDuration = typeof raw.scanDuration === 'number' ? raw.scanDuration : 0;
		const readmeContent = typeof raw.readmeContent === 'string' ? raw.readmeContent : undefined;
		return { keyDirectories, importantFiles, configFiles, scannedFileCount, scanDuration, readmeContent } as RepositoryScanResult;
	}

	/**
	 * Gathers additional repository signals to enhance analysis
	 * 
	 * Collects supplementary information about the repository structure,
	 * including root directory entries, potential entry files, language
	 * distribution, and framework signals.
	 * 
	 * @param repositoryPath The path to the repository
	 * @param excludePatterns Patterns to exclude from analysis
	 * @returns Object containing gathered signals
	 */
	private async gatherAdditionalSignals(repositoryPath: string, excludePatterns: string[]): Promise<AugmentedSignals> {
		const out: AugmentedSignals = {};
		try {
			// Root directory entries (depth=1)
			const rootList = await listDirectory(repositoryPath, { depth: 1, excludePatterns });
			if (rootList.success && rootList.data) {
				out.rootEntries = rootList.data.entries;
			}
		} catch { /* ignore */ }

		try {
			// Potential entry files by common names
			const entryRegex = '(?:^|/)(index|main|app|server)\.(ts|tsx|js|jsx|py|go|rb|php|java)$';
			const entrySearch = await searchFiles(repositoryPath, entryRegex, {
				searchType: 'name', useRegex: true, caseSensitive: false, maxResults: 200, excludePatterns
			});
			if (entrySearch.success && entrySearch.data) {
				out.entryFiles = entrySearch.data.results.map(r => r.filePath);
			}
		} catch { /* ignore */ }

		try {
			// Language distribution signals from file extensions (sampled by name search)
			const langRegex = '\\.(ts|tsx|js|jsx|py|rb|php|java|go|rs|cs|cpp|c|kt|swift)$';
			const langSearch = await searchFiles(repositoryPath, langRegex, {
				searchType: 'name', useRegex: true, caseSensitive: false, maxResults: 1000, excludePatterns
			});
			if (langSearch.success && langSearch.data) {
				const counts: Record<string, number> = {};
				for (const r of langSearch.data.results) {
					const ext = this.extOf(r.filePath);
					if (!ext) { continue; }
					counts[ext] = (counts[ext] || 0) + 1;
				}
				out.languageCounts = counts;
			}
		} catch { /* ignore */ }

		try {
			// Framework signals by content regex
			const fwRegex = 'express\\(|fastify\\(|koa\\(|nestjs|next\\.|nuxt|react|vue|svelte|flask|django|spring|rails|laravel|gin\\.|beego|fiber|rocket|actix|asp\\.net|angular\\.module';
			const frameworkSearch = await searchFiles(repositoryPath, fwRegex, {
				searchType: 'content', useRegex: true, caseSensitive: false, maxResults: 200, excludePatterns, maxMatchesPerFile: 2, contextLines: 1
			});
			if (frameworkSearch.success) {
				out.frameworkMatches = frameworkSearch.data as SearchFilesResult;
			}
		} catch { /* ignore */ }

		return out;
	}

	/**
	 * Extracts the file extension from a path
	 * 
	 * @param relPath The file path to extract extension from
	 * @returns The lowercase file extension or null if not found
	 */
	private extOf(relPath: string): string | null {
		const m = relPath.match(/\.([a-zA-Z0-9]+)$/);
		return m ? m[1].toLowerCase() : null;
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
			'# Repository Analysis Summary (AI)',
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
		return path.join(repositoryPath, '.gitgenie', AIRepositoryAnalysisService.ANALYSIS_MD_FILE_NAME);
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
			logger.warn('[Genie][AIRepoAnalysis] Failed to update .gitignore for .gitgenie', error as any);
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
		return `${AIRepositoryAnalysisService.ANALYSIS_STATE_KEY_PREFIX}${repoHash}`;
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
				logger.info('[Genie][AIRepoAnalysis] Synced analysis JSON from Markdown.');
				return;
			}
			logger.warn('[Genie][AIRepoAnalysis] No existing analysis JSON to sync from Markdown.');
		} catch (error) {
			logger.warn('[Genie][AIRepoAnalysis] Failed to sync analysis from Markdown', error as any);
		}
	}

	public async clearAnalysis(repositoryPath: string): Promise<void> {
		try {
			const key = this.getAnalysisStateKey(repositoryPath);
			await this.context.globalState.update(key, undefined);
		} catch (error) {
			logger.warn('[Genie][AIRepoAnalysis] Failed to clear analysis data', error as any);
		}
	}



	private handleAnalysisError(error: any, operationName: string): RepoAnalysisRunResult {
		if (error?.name === 'Canceled' || error?.message?.includes?.('cancel')) {
			logger.warn(`[Genie][AIRepoAnalysis] ${operationName} cancelled by user.`);
			return 'skipped';
		}
		logger.error(`Failed to ${operationName.toLowerCase()} AI repository analysis`, error as any);
		throw error;
	}
}

// Internal data structure for gathered signals
interface AugmentedSignals {
	rootEntries?: DirectoryEntry[];
	entryFiles?: string[];
	languageCounts?: Record<string, number>;
	frameworkMatches?: SearchFilesResult;
}
