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
    RepoAnalysisRunResult
} from './analysisTypes';
import { getRepositoryGitMessageLog, getRepositoryCommits } from "../git/diff";
import { RepositoryScanner } from './repositoryScanner';
import { LLMService, LLMError } from '../llm/llmTypes';
import { buildRepositoryAnalysisPromptParts } from './analysisChatPrompts';;
import { logger } from '../logger';
import { L10N_KEYS as I18N } from '../../i18n/keys';

/**
 * Repository analysis service implementation
 */
export class RepositoryAnalysisService implements IRepositoryAnalysisService {
    private static readonly ANALYSIS_MD_FILE_NAME = 'repository-analysis.md';
    // Keys for VS Code Memento storage
    private static readonly ANALYSIS_STATE_KEY_PREFIX = 'gitCommitGenie.analysis.';

    private llmService: LLMService | null;
    private resolveLLMService?: (provider: string) => (LLMService | undefined);
    private context: vscode.ExtensionContext;
    private currentCancelSource?: vscode.CancellationTokenSource;
    private apiKeyWaiters: Map<string, vscode.Disposable> = new Map();

    constructor(context: vscode.ExtensionContext, llmService: LLMService | null) {
        this.context = context;
        this.llmService = llmService;
    }

    public setLLMService(service: LLMService) {
        this.llmService = service;
    }

    // Allow ServiceRegistry to provide a resolver so we can pick provider per analysis
    public setLLMResolver(resolver: (provider: string) => (LLMService | undefined)) {
        this.resolveLLMService = resolver;
    }

    private getConfig(): AnalysisConfig {
        const cfg = vscode.workspace.getConfiguration('gitCommitGenie.repositoryAnalysis');

        return {
            enabled: cfg.get<boolean>('enabled', true),
            excludePatterns: cfg.get<string[]>('excludePatterns', []),
            updateThreshold: cfg.get<number>('updateThreshold', 10)
        };
    }

    async initializeRepository(repositoryPath: string): Promise<RepoAnalysisRunResult> {
        // Always use latest config
        const cfg = this.getConfig();
        this.currentCancelSource = new vscode.CancellationTokenSource();


        if (!cfg.enabled) {
            return 'skipped';
        }

        try {
            const existingAnalysis = await this.getAnalysis(repositoryPath);
            if (existingAnalysis) {
                logger.info('[Genie][RepoAnalysis] Analysis exists, skip init.');
                return 'skipped';
            }

            logger.info(`[Genie][RepoAnalysis] Initializing for: ${repositoryPath}`);

            // Scan repository with latest config
            const scanner = new RepositoryScanner(cfg);
            const scanResult = await scanner.scanRepository(repositoryPath);

            const commitMessageLog = await getRepositoryGitMessageLog(repositoryPath);

            // Generate analysis using LLM
            const analysisRequest: LLMAnalysisRequest = {
                scanResult,
                repositoryPath,
                recentCommits: commitMessageLog.slice(0, cfg.updateThreshold) || []
            };

            const messages = buildRepositoryAnalysisPromptParts(analysisRequest);
            const selected = this.pickRepoAnalysisService();
            try { await selected.service?.refreshFromSettings(); } catch { }
            const llmResponse = await selected.service?.generateRepoAnalysis(messages, { token: this.currentCancelSource.token });
            if (!llmResponse || (llmResponse as LLMError).statusCode) {
                // If missing API key (401), attach a one-time listener to secrets change
                const err = (llmResponse as LLMError);
                if (err?.statusCode === 401) {
                    if (!this.apiKeyWaiters.has(repositoryPath)) {
                        const disp = this.context.secrets.onDidChange(async (e) => {
                            try {
                                // Only react to our extension's secrets
                                if (!e?.key || !e.key.startsWith('gitCommitGenie.secret.')) { return; }
                                // Refresh provider from settings and retry init once
                                try { await selected.service?.refreshFromSettings(); } catch { /* ignore */ }
                                const d = this.apiKeyWaiters.get(repositoryPath);
                                if (d) { try { d.dispose(); } catch { } this.apiKeyWaiters.delete(repositoryPath); }
                                await this.initializeRepository(repositoryPath);
                            } catch { /* ignore retry errors */ }
                        });
                        this.apiKeyWaiters.set(repositoryPath, disp);
                        try { this.context.subscriptions.push(disp); } catch { /* best-effort */ }
                    }
                    // Prompt user to fix API key (detached from this task to end progress quickly)
                    const providerLabel = this.getProviderLabel(selected.provider);
                    this.promptReplaceKeyOrManage(selected.provider, providerLabel).catch(() => { /* ignore UI errors */ });
                    return 'skipped';
                }
                // If model not selected (400), prompt to configure
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
                    } catch { /* ignore UI errors */ }
                    return 'skipped';
                }
                // Forbidden (403) – likely key revoked or plan restriction
                if (err?.statusCode === 403) {
                    try {
                        const providerLabel = this.getProviderLabel(selected.provider);
                        const choice = await vscode.window.showWarningMessage(
                            `${providerLabel} access denied. Check your API key permissions or plan.`,
                            vscode.l10n.t(I18N.actions.manageModels),
                            vscode.l10n.t(I18N.actions.dismiss)
                        );
                        if (choice === vscode.l10n.t(I18N.actions.manageModels)) {
                            void vscode.commands.executeCommand('git-commit-genie.manageModels');
                        }
                    } catch { /* ignore UI errors */ }
                    return 'skipped';
                }
                // Rate limited (429) – surface helpful guidance
                if (err?.statusCode === 429) {
                    try {
                        const provider = selected.provider;
                        const model = this.getActiveModelForProvider(provider);
                        // Reuse centralized rate-limit hint copy
                        await vscode.window.showWarningMessage(
                            vscode.l10n.t(I18N.rateLimit.hit, this.getProviderLabel(provider), model || 'model', vscode.l10n.t(I18N.settings.chainMaxParallelLabel)),
                            vscode.l10n.t(I18N.actions.openSettings),
                            vscode.l10n.t(I18N.actions.dismiss)
                        ).then(choice => {
                            if (choice === vscode.l10n.t(I18N.actions.openSettings)) {
                                void vscode.commands.executeCommand('workbench.action.openSettings', 'gitCommitGenie.chain.maxParallel');
                            }
                        });
                    } catch { /* ignore UI errors */ }
                    return 'skipped';
                }
                const errorMsg = err?.message || 'Failed to generate repository analysis';
                logger.error('[Genie][RepoAnalysis] LLM analysis failed', errorMsg);
                throw new Error(errorMsg);
            }

            if (this.currentCancelSource?.token.isCancellationRequested) {
                logger.warn('[Genie][RepoAnalysis] Initialization cancelled after LLM response; aborting save.');
                return 'skipped';
            }

            // Type assertion to ensure llmResponse is LLMAnalysisResponse
            const analysisResponse = llmResponse as LLMAnalysisResponse;

            // Create analysis object
            const historyAtInit = await this.getCommitHistory(repositoryPath);
            const lastHashAtInit = historyAtInit.length > 0 ? historyAtInit[0].stateHash : undefined;
            const analysis: RepositoryAnalysis = {
                repositoryPath,
                timestamp: new Date().toISOString(),
                lastAnalyzedStateHash: lastHashAtInit,
                summary: analysisResponse.summary,
                insights: analysisResponse.insights,
                projectType: analysisResponse.projectType,
                technologies: analysisResponse.technologies,
                keyDirectories: scanResult.keyDirectories,
                importantFiles: scanResult.importantFiles.map(f => f.path),
                readmeContent: scanResult.readmeContent,
                configFiles: scanResult.configFiles
            };

            // Save analysis
            await this.saveAnalysis(repositoryPath, analysis);

            await this.saveAnalysisMarkdown(repositoryPath, analysis);

            logger.info('[Genie][RepoAnalysis] Initialization completed.');
            return 'success';
        } catch (error: any) {
            const msg = String(error?.message || error || '');
            const cancelled = /abort|cancel/i.test(msg);
            if (cancelled) {
                logger.warn('[Genie][RepoAnalysis] Initialization cancelled by user.');
                return 'skipped'; // swallow cancellation as non-error
            }
            logger.error('Failed to initialize repository analysis', error as any);
            throw error;
        }
    }

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

    async updateAnalysis(repositoryPath: string, commitMessage?: string): Promise<RepoAnalysisRunResult> {
        // Always use latest config
        const cfg = this.getConfig();
        if (!cfg.enabled) {
            return 'skipped';
        }

        this.currentCancelSource = new vscode.CancellationTokenSource();

        try {
            const existingAnalysis = await this.getAnalysis(repositoryPath);
            if (!existingAnalysis) {
                // Initialize if no analysis exists
                return await this.initializeRepository(repositoryPath);
            }

            // Get recent commit history
            const commitHistory = await this.getCommitHistory(repositoryPath);
            const recentCommits = commitHistory
                .slice(0, cfg.updateThreshold) // Last `updateThreshold` commits
                .map(entry => entry.message);

            // Re-scan repository with latest config
            const scanner = new RepositoryScanner(cfg);
            const scanResult = await scanner.scanRepository(repositoryPath);

            // Generate updated analysis using LLM
            const analysisRequest: LLMAnalysisRequest = {
                scanResult,
                previousAnalysis: existingAnalysis,
                recentCommits,
                repositoryPath
            };

            const messages = buildRepositoryAnalysisPromptParts(analysisRequest);
            const selected = this.pickRepoAnalysisService();
            try { await selected.service?.refreshFromSettings(); } catch { }
            const llmResponse = await selected.service?.generateRepoAnalysis(messages, { token: this.currentCancelSource?.token });
            if (!llmResponse || (llmResponse as LLMError).statusCode) {
                const err = (llmResponse as LLMError);
                if (err?.statusCode === 401) {
                    if (!this.apiKeyWaiters.has(repositoryPath)) {
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
                    const providerLabel = this.getProviderLabel(selected.provider);
                    this.promptReplaceKeyOrManage(selected.provider, providerLabel).catch(() => { /* ignore UI errors */ });
                    return 'skipped';
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
                    return 'skipped';
                }
                if (err?.statusCode === 403) {
                    try {
                        const providerLabel = this.getProviderLabel(selected.provider);
                        const choice = await vscode.window.showWarningMessage(
                            `${providerLabel} access denied. Check your API key permissions or plan.`,
                            vscode.l10n.t(I18N.actions.manageModels),
                            vscode.l10n.t(I18N.actions.dismiss)
                        );
                        if (choice === vscode.l10n.t(I18N.actions.manageModels)) {
                            void vscode.commands.executeCommand('git-commit-genie.manageModels');
                        }
                    } catch { }
                    return 'skipped';
                }
                if (err?.statusCode === 429) {
                    try {
                        const provider = selected.provider;
                        const model = this.getActiveModelForProvider(provider);
                        await vscode.window.showWarningMessage(
                            vscode.l10n.t(I18N.rateLimit.hit, this.getProviderLabel(provider), model || 'model', vscode.l10n.t(I18N.settings.chainMaxParallelLabel)),
                            vscode.l10n.t(I18N.actions.openSettings),
                            vscode.l10n.t(I18N.actions.dismiss)
                        ).then(choice => {
                            if (choice === vscode.l10n.t(I18N.actions.openSettings)) {
                                void vscode.commands.executeCommand('workbench.action.openSettings', 'gitCommitGenie.chain.maxParallel');
                            }
                        });
                    } catch { }
                    return 'skipped';
                }
                const errorMsg = err?.message || 'Failed to update repository analysis';
                logger.error('[Genie][RepoAnalysis] LLM analysis update failed', errorMsg);
                throw new Error(errorMsg);
            }

            // Type assertion to ensure llmResponse is LLMAnalysisResponse
            const analysisResponse = llmResponse as LLMAnalysisResponse;

            // Create updated analysis
            const lastHashNow = commitHistory.length > 0 ? commitHistory[0].stateHash : existingAnalysis.lastAnalyzedStateHash;
            const updatedAnalysis: RepositoryAnalysis = {
                ...existingAnalysis,
                timestamp: new Date().toISOString(),
                lastAnalyzedStateHash: lastHashNow,
                summary: analysisResponse.summary,
                insights: analysisResponse.insights,
                projectType: analysisResponse.projectType,
                technologies: analysisResponse.technologies,
                keyDirectories: scanResult.keyDirectories,
                importantFiles: scanResult.importantFiles.map(f => f.path),
                readmeContent: scanResult.readmeContent,
                configFiles: scanResult.configFiles
            };

            if (this.currentCancelSource?.token.isCancellationRequested) {
                logger.warn('[Genie][RepoAnalysis] Update cancelled after LLM response; aborting save.');
                return 'skipped';
            }

            // Save updated analysis
            await this.saveAnalysis(repositoryPath, updatedAnalysis);

            await this.saveAnalysisMarkdown(repositoryPath, updatedAnalysis);

            logger.info('[Genie][RepoAnalysis] Update completed.');
            return 'success';
        } catch (error: any) {
            const msg = String(error?.message || error || '');
            const cancelled = /abort|cancel/i.test(msg);
            if (cancelled) {
                logger.warn('[Genie][RepoAnalysis] Update cancelled by user.');
                return 'skipped'; // swallow cancellation as non-error
            }
            logger.error('[Genie][RepoAnalysis] Failed to update repository analysis', error as any);
            throw error;
        }
    }

    async getCommitHistory(repositoryPath: string): Promise<CommitHistoryEntry[]> {
        try {
            const commits = await getRepositoryCommits({}, repositoryPath);
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

    // recordCommitMessage removed; history is derived from Git

    async shouldUpdateAnalysis(repositoryPath: string): Promise<boolean> {
        // Strictly follow updateThreshold: trigger only when the count of
        // new history entries since last analysis reaches the threshold.
        const history = await this.getCommitHistory(repositoryPath);
        if (!Array.isArray(history)) { return false; }

        const cfg = this.getConfig();
        const threshold = Math.max(1, cfg.updateThreshold || 1);
        const analysis = await this.getAnalysis(repositoryPath);

        if (!analysis) {
            return true;
        }

        const anchor = (analysis as any).lastAnalyzedStateHash as string | undefined;
        if (!anchor || anchor.length === 0) {
            return true;
        }

        const idx = history.findIndex(e => e.stateHash === anchor); // get index of last analyzed state
        if (idx === -1) {
            return true;
        }
        return idx >= threshold;
    }

    async getAnalysisForPrompt(repositoryPath: string): Promise<string> {
        try {
            // Respect feature toggle: when disabled, return empty context
            const cfg = this.getConfig();
            if (!cfg.enabled) { return ''; }

            // Prefer the stored JSON analysis as the source of truth
            const analysis = await this.getAnalysis(repositoryPath);
            if (!analysis) { return ''; }

            // Build a compact JSON payload for LLM context
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

    public cancelCurrentAnalysis(): void {
        try { this.currentCancelSource?.cancel(); } catch { }
        // Do not clear here; let the active request detect cancellation and clean up.
    }

    private async saveAnalysis(repositoryPath: string, analysis: RepositoryAnalysis): Promise<void> {
        const key = this.getAnalysisStateKey(repositoryPath);
        await this.context.globalState.update(key, analysis);
    }

    /**
     * Save or create a Markdown copy of the repository analysis in the repo under `.gitgenie/`.
     * Returns the path to the Markdown file.
     */
    public async saveAnalysisMarkdown(
        repositoryPath: string,
        analysis: RepositoryAnalysis,
        opts?: { overwrite?: boolean }
    ): Promise<string> {
        const mdPath = this.getAnalysisMarkdownFilePath(repositoryPath);
        const mdDir = path.dirname(mdPath);
        if (!fs.existsSync(mdDir)) {
            fs.mkdirSync(mdDir, { recursive: true });
        }
        // Make sure .gitignore is updated to ignore the .gitgenie folder, aligned with template logic
        await this.ensureGitignoreForGitGenie(repositoryPath);
        if (fs.existsSync(mdPath) && opts?.overwrite === false) {
            return mdPath;
        }
        const content = [
            '# Repository Analysis Summary',
            '',
            analysis.summary,
            '',
        ].filter(Boolean).join('\n');
        fs.writeFileSync(mdPath, content, 'utf-8');
        return mdPath;
    }

    // Analysis JSON is stored in VS Code globalState; Markdown remains on-repo

    /**
     * Get the on-repo Markdown analysis path: <repo>/.gitgenie/ANALYSIS_MD_FILE_NAME.md
     */
    public getAnalysisMarkdownFilePath(repositoryPath: string): string {
        return path.join(repositoryPath, '.gitgenie', RepositoryAnalysisService.ANALYSIS_MD_FILE_NAME);
    }

    private async ensureGitignoreForGitGenie(repositoryPath: string): Promise<void> {
        try {
            const gitignorePath = path.join(repositoryPath, '.gitignore');
            const ignoreEntry = '.gitgenie/**';
            const ignoreSection = `# Ignore Git Commit Genie data\n${ignoreEntry}\n`;

            let existing = '';
            if (fs.existsSync(gitignorePath)) {
                try { existing = fs.readFileSync(gitignorePath, 'utf-8'); } catch { existing = ''; }
            }
            // Avoid duplicates; also consider existing '.gitgenie/' entries
            if (existing.includes(ignoreEntry) || existing.includes('.gitgenie/')) {
                return;
            }
            const toAppend = existing.length > 0 && !existing.endsWith('\n') ? `\n${ignoreSection}` : ignoreSection;
            fs.appendFileSync(gitignorePath, toAppend, { encoding: 'utf-8' });
        } catch (error) {
            // Non-fatal
            logger.warn('Failed to update .gitignore for .gitgenie', error as any);
        }
    }

    // Commit history is derived directly from Git log

    private getProviderLabel(provider: string): string {
        switch (provider) {
            case 'deepseek': return 'DeepSeek';
            case 'anthropic': return 'Anthropic';
            case 'gemini': return 'Gemini';
            default: return 'OpenAI';
        }
    }

    // Choose provider for repository analysis based on the configured model
    private pickRepoAnalysisService(): { provider: string, service: LLMService | null } {
        try {
            const cfg = vscode.workspace.getConfiguration('gitCommitGenie.repositoryAnalysis');
            const selectedModel = (cfg.get<string>('model', 'general') || 'general').trim();
            if (!selectedModel || selectedModel === 'general') {
                const p = (this.context.globalState.get<string>('gitCommitGenie.provider', 'openai') || 'openai').toLowerCase();
                return { provider: p, service: this.llmService };
            }

            const candidates = ['openai', 'deepseek', 'anthropic', 'gemini'];
            for (const p of candidates) {
                const svc = this.resolveLLMService?.(p);
                try {
                    if (svc && svc.listSupportedModels().includes(selectedModel)) {
                        return { provider: p, service: svc };
                    }
                } catch { /* ignore */ }
            }

            // Fallback to current
            const p = (this.context.globalState.get<string>('gitCommitGenie.provider', 'openai') || 'openai').toLowerCase();
            return { provider: p, service: this.llmService };
        } catch {
            const p = (this.context.globalState.get<string>('gitCommitGenie.provider', 'openai') || 'openai').toLowerCase();
            return { provider: p, service: this.llmService };
        }
    }

    // Resolve the active model string, respecting repository-analysis selection when set
    private getActiveModelForProvider(provider: string): string | undefined {
        try {
            const cfg = vscode.workspace.getConfiguration('gitCommitGenie.repositoryAnalysis');
            const selected = (cfg.get<string>('model', 'general') || 'general').trim();
            if (selected && selected !== 'general') { return selected; }
            switch (provider) {
                case 'deepseek': return this.context.globalState.get<string>('gitCommitGenie.deepseekModel', '');
                case 'anthropic': return this.context.globalState.get<string>('gitCommitGenie.anthropicModel', '');
                case 'gemini': return this.context.globalState.get<string>('gitCommitGenie.geminiModel', '');
                default: return this.context.globalState.get<string>('gitCommitGenie.openaiModel', '');
            }
        } catch {
            return undefined;
        }
    }

    // Fire-and-forget UI to let user replace key or open Manage Models
    private async promptReplaceKeyOrManage(provider: string, providerLabel: string): Promise<void> {
        const picked = await vscode.window.showWarningMessage(
            vscode.l10n.t(I18N.errors.invalidApiKey, providerLabel),
            vscode.l10n.t(I18N.actions.replaceKey),
            vscode.l10n.t(I18N.actions.manageModels),
            vscode.l10n.t(I18N.actions.dismiss)
        );
        if (picked === vscode.l10n.t(I18N.actions.replaceKey)) {
            const newKey = await vscode.window.showInputBox({
                title: vscode.l10n.t(I18N.manageModels.enterNewKeyTitle, providerLabel),
                prompt: `${providerLabel} API Key`,
                placeHolder: `${providerLabel} API Key`,
                password: true,
                ignoreFocusOut: true,
            });
            if (newKey && newKey.trim()) {
                const service = this.resolveLLMService?.(provider) || this.llmService;
                await service?.setApiKey(newKey.trim());
                try { await service?.refreshFromSettings(); } catch { }
                try { await vscode.commands.executeCommand('git-commit-genie.updateStatusBar'); } catch { }
            }
        } else if (picked === vscode.l10n.t(I18N.actions.manageModels)) {
            void vscode.commands.executeCommand('git-commit-genie.manageModels');
        }
    }

    private hashPath(filePath: string): string {
        return crypto.createHash('md5').update(filePath).digest('hex');
    }
    private getAnalysisStateKey(repositoryPath: string): string {
        const repoHash = this.hashPath(repositoryPath);
        return `${RepositoryAnalysisService.ANALYSIS_STATE_KEY_PREFIX}${repoHash}`;
    }

    // Public: sync global JSON from the on-repo Markdown (user edited))
    public async syncAnalysisFromMarkdown(repositoryPath: string): Promise<void> {
        try {
            const mdPath = this.getAnalysisMarkdownFilePath(repositoryPath);
            if (!fs.existsSync(mdPath)) { return; }
            const md = fs.readFileSync(mdPath, 'utf-8');
            let currentAnalysis = await this.getAnalysis(repositoryPath);

            if (currentAnalysis && currentAnalysis.summary) {
                currentAnalysis.summary = md.trim();
                await this.saveAnalysis(repositoryPath, currentAnalysis);
                logger.info('[Genie][RepoAnalysis] Synced analysis JSON from Markdown.');
                return;
            }
            logger.warn('[Genie][RepoAnalysis] No existing analysis JSON to sync from Markdown.');
        } catch (error) {
            logger.warn('[Genie][RepoAnalysis] Failed to sync analysis from Markdown', error as any);
        }
    }

    // Public: clear/delete the stored JSON analysis for the repo
    public async clearAnalysis(repositoryPath: string): Promise<void> {
        try {
            const key = this.getAnalysisStateKey(repositoryPath);
            await this.context.globalState.update(key, undefined);
        } catch (error) {
            logger.warn('[Genie][RepoAnalysis] Failed to clear analysis data', error as any);
        }
    }
}
