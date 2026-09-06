import * as vscode from 'vscode';
import { ServiceRegistry } from '../core/ServiceRegistry';
import { logger } from '../services/logger';
import { L10N_KEYS as I18N } from '../i18n/keys';
import { Repository } from "../services/git/git";
import { DiffData } from '../services/git/gitTypes';
import { PROVIDER_LABELS, modelSecretKey } from '../services/llm/providers';
import { StatusBarManager } from '../ui/StatusBarManager';
import { resolveInvestigationSettings } from '../services/analysis/change/investigation/config';

/**
 * This class handles the registration of commands related to generating commit messages.
 * It includes commands for generating commit messages and cancelling ongoing generation.
 */
export class GenerateCommands {
    // Track generation per-repository to avoid cross-repo coupling
    private inFlight: Map<string, vscode.CancellationTokenSource> = new Map();

    constructor(
        private context: vscode.ExtensionContext,
        private serviceRegistry: ServiceRegistry,
        private statusBarManager: StatusBarManager
    ) { }

    async register(): Promise<void> {
        // Generate commit message command
        this.context.subscriptions.push(
            // Accept optional repository arg when invoked from SCM menus
            vscode.commands.registerCommand('git-commit-genie.generateCommitMessage', (arg?: any) => this.generateCommitMessage(arg))
        );

        // Cancel generation command
        this.context.subscriptions.push(
            vscode.commands.registerCommand('git-commit-genie.cancelGeneration', (arg?: any) => this.cancelGeneration(arg))
        );
    }

    private async cancelGeneration(arg?: any): Promise<void> {
        // Cancel for the repository where the command was invoked
        const repoService = this.serviceRegistry.getRepoService();
        const repo = arg?.rootUri
            ? (repoService.getRepositoryByUri(arg.rootUri) || undefined)
            : (repoService.getActiveRepository() || undefined);
        const key = repo?.rootUri?.fsPath;
        if (!key) { return; }
        const cts = this.inFlight.get(key);
        cts?.cancel();
        // Also stop any pending spinners in the Webview log list
        try { logger.cancelPendingLogs(); } catch { /* ignore */ }
    }

    private async generateCommitMessage(arg?: any): Promise<void> {
        // First-time UX: if provider or model not configured, jump to Manage Models instead of erroring
        const selectedModel = this.serviceRegistry.getGenerationModel();
        if (!selectedModel) {
            await vscode.commands.executeCommand('git-commit-genie.manageModels');
            return;
        }
        const existingKey = await this.context.secrets.get(modelSecretKey(selectedModel));

        if (!existingKey) {
            await vscode.commands.executeCommand('git-commit-genie.manageModels');
            return;
        }

        const cts = new vscode.CancellationTokenSource();
        const controller = new AbortController();
        const cancellation = cts.token.onCancellationRequested(() => controller.abort());
        const memoryService = this.serviceRegistry.getMemoryService();
        let foregroundStarted = false;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.SourceControl,
            title: vscode.l10n.t(I18N.generation.progressTitle),
            cancellable: true,
        }, async (progress, token) => {
            token.onCancellationRequested(() => cts.cancel());

            try {
                // Determine target repository explicitly from invocation context or UI selection
                const repoService = this.serviceRegistry.getRepoService();
                let targetRepo: Repository | null = null;
                if (arg?.rootUri) {
                    targetRepo = repoService.getRepositoryByUri(arg.rootUri);
                }
                if (!targetRepo) {
                    targetRepo = repoService.getActiveRepository();
                }
                const targetRepoPath = targetRepo?.rootUri?.fsPath;
                if (!targetRepo || !targetRepoPath) {
                    vscode.window.showErrorMessage(vscode.l10n.t(I18N.common.noGitRepository));
                    return;
                }

                // Prevent duplicate runs for same repo
                if (this.inFlight.has(targetRepoPath)) {
                    vscode.window.showInformationMessage(vscode.l10n.t(I18N.common.generationRunning));
                    return;
                }
                this.inFlight.set(targetRepoPath, cts);
                memoryService.beginForeground(); foregroundStarted = true;

                // Indicate generating state for UI (global visibility)
                await vscode.commands.executeCommand('setContext', 'gitCommitGenie.generating', true);

                const snapshot = await this.serviceRegistry.getDiffService().captureSnapshot(targetRepo, controller.signal);
                const diffs = await this.serviceRegistry.getDiffService().getDiff(targetRepo, snapshot);

                if (diffs.length === 0) {
                    vscode.window.showInformationMessage(vscode.l10n.t(I18N.generation.noStagedChanges));
                    return;
                }

                const llmService = this.serviceRegistry.getCurrentLLMService();
                const memoryRun = vscode.workspace.getConfiguration('gitCommitGenie.chain').get<boolean>('enabled', true)
                    ? await memoryService.prepare(snapshot, selectedModel.model, resolveInvestigationSettings().excludePatterns) : undefined;
                const result = await llmService.generateCommitMessage(diffs, {
                    snapshot,
                    memoryRun,
                    token: cts.token,
                    targetRepo,
                    ragRetrievalService: this.serviceRegistry.getRagRetrievalService(),
                });

                if ('content' in result) {
                    if (memoryRun && result.episode) { memoryService.publish(memoryRun, result.episode, llmService); }
                    if (!await snapshot.isCurrent()) {
                        const document = await vscode.workspace.openTextDocument({ content: result.content, language: 'git-commit' });
                        await vscode.window.showTextDocument(document);
                        throw new Error(vscode.l10n.t('Repository inputs changed during generation. The draft was preserved separately; regenerate before filling SCM.'));
                    }
                    await this.fillCommitMessage(result.content, targetRepo);
                    await this.maybeCachePendingRagDocument(targetRepo, diffs, result);
                } else {
                    if (memoryRun) {
                        const episode = memoryRun.seal({ changedPaths: diffs.map(diff => diff.fileName), changedSymbols: [], questions: [], claims: [],
                            status: cts.token.isCancellationRequested ? 'cancelled' : 'error' });
                        if (episode) { memoryService.publish(memoryRun, episode, llmService); }
                    }
                    await this.handleError(result);
                }
            } catch (error: any) {
                if (cts.token.isCancellationRequested) {
                    vscode.window.showInformationMessage(vscode.l10n.t(I18N.generation.cancelled));
                } else {
                    vscode.window.showErrorMessage(vscode.l10n.t(I18N.generation.failedToGenerate, error.message));
                }
            } finally {
                try {
                    // Remove from inflight map
                    this.inFlight.forEach((value, key) => {
                        if (value === cts) { this.inFlight.delete(key); }
                    });
                } catch { /* ignore */ }
                cts.dispose();
                cancellation.dispose();
                if (foregroundStarted) { memoryService.endForeground(); }
                // Reset UI context only when no other repo is running
                await vscode.commands.executeCommand('setContext', 'gitCommitGenie.generating', this.inFlight.size > 0);
            }
        });
    }

    private async fillCommitMessage(content: string, repo: Repository): Promise<void> {

        // Simulate typing effect
        let typingSpeed: number = vscode.workspace.getConfiguration('gitCommitGenie').get<number>('typingAnimationSpeed', -1);
        typingSpeed = Math.min(typingSpeed, 100);

        if (typingSpeed <= 0) {
            // Instant fill
            repo.inputBox.value = content;
            return;
        } else {
            // Animated typing
            const fullText = content;
            repo.inputBox.value = '';
            let i = 0;
            const interval = setInterval(() => {
                if (i <= fullText.length) {
                    repo.inputBox.value = fullText.slice(0, i);
                    i++;
                } else {
                    clearInterval(interval);
                }
            }, typingSpeed);
        }

    }

    private async maybeCachePendingRagDocument(repo: Repository, diffs: DiffData[], result: any): Promise<void> {
        try {
            const ragEnabled = vscode.workspace.getConfiguration('gitCommitGenie.rag').get<boolean>('enabled', false);
            if (!ragEnabled || !result?.ragMetadata?.changeSetSummary || !result?.ragMetadata?.retrievalFeatures) {
                return;
            }

            await this.serviceRegistry.getRagHistoricalIndexService().recordPendingGeneratedCommit(
                repo,
                result.content,
                diffs,
                result.ragMetadata
            );
        } catch (error) {
            logger.warn('[Genie][RAG] Failed to cache pending generated commit context', error as any);
        }
    }

    private async handleError(result: any): Promise<void> {
        if (result.statusCode === 401) {
            const model = this.serviceRegistry.requireGenerationModel();
            const providerLabel = PROVIDER_LABELS[model.provider];

            // Detach UI prompts so the withProgress can end immediately
            void (async () => {
                const choice = await vscode.window.showWarningMessage(
                    vscode.l10n.t(I18N.errors.invalidApiKey, providerLabel),
                    vscode.l10n.t(I18N.actions.replaceKey),
                    vscode.l10n.t(I18N.actions.manageModels),
                    vscode.l10n.t(I18N.actions.dismiss)
                );
                if (choice === vscode.l10n.t(I18N.actions.replaceKey)) {
                    const newKey = await vscode.window.showInputBox({
                        title: vscode.l10n.t(I18N.manageModels.enterNewKeyTitle, providerLabel),
                        prompt: `${providerLabel} API Key`,
                        placeHolder: `${providerLabel} API Key`,
                        password: true,
                        ignoreFocusOut: true,
                    });
                    if (newKey && newKey.trim()) {
                        const service = this.serviceRegistry.getLLMService(model.id);
                        if (!service) {
                            throw new Error(`AI model service '${model.id}' is not configured.`);
                        }
                        await service.setApiKey(newKey.trim());
                        await vscode.commands.executeCommand('git-commit-genie.updateStatusBar');
                    }
                } else if (choice === vscode.l10n.t(I18N.actions.manageModels)) {
                    await vscode.commands.executeCommand('git-commit-genie.manageModels');
                }
            })();
            return;
        }

        if (result.statusCode === 499 || /Cancelled/i.test(result.message)) {
            vscode.window.showInformationMessage(vscode.l10n.t(I18N.generation.cancelled));
        } else {
            vscode.window.showErrorMessage(vscode.l10n.t(I18N.generation.errorGenerating, result.message));
        }
    }

}
