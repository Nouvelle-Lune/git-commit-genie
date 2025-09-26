import * as vscode from 'vscode';
import { ServiceRegistry } from '../core/ServiceRegistry';
import { L10N_KEYS as I18N } from '../i18n/keys';

/**
 * This class handles the registration of commands related to generating commit messages.
 * It includes commands for generating commit messages and cancelling ongoing generation.
 */
export class GenerateCommands {
    private currentCancelSource: vscode.CancellationTokenSource | undefined;

    constructor(
        private context: vscode.ExtensionContext,
        private serviceRegistry: ServiceRegistry
    ) { }

    async register(): Promise<void> {
        // Generate commit message command
        this.context.subscriptions.push(
            vscode.commands.registerCommand('git-commit-genie.generateCommitMessage', this.generateCommitMessage.bind(this))
        );

        // Cancel generation command
        this.context.subscriptions.push(
            vscode.commands.registerCommand('git-commit-genie.cancelGeneration', this.cancelGeneration.bind(this))
        );
    }

    private async cancelGeneration(): Promise<void> {
        this.currentCancelSource?.cancel();
    }

    private async generateCommitMessage(): Promise<void> {
        // First-time UX: if provider or model not configured, jump to Manage Models instead of erroring
        const provider = this.serviceRegistry.getProvider().toLowerCase();
        const secretKeyName = this.getSecretKeyName(provider);
        const existingKey = await this.context.secrets.get(secretKeyName);

        if (!existingKey) {
            await vscode.commands.executeCommand('git-commit-genie.manageModels');
            return;
        }

        const selectedModel = this.serviceRegistry.getModel(provider);
        if (!selectedModel || !selectedModel.trim()) {
            await vscode.commands.executeCommand('git-commit-genie.manageModels');
            return;
        }

        await vscode.commands.executeCommand('setContext', 'gitCommitGenie.generating', true);

        const cts = new vscode.CancellationTokenSource();
        this.currentCancelSource = cts;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.SourceControl,
            title: vscode.l10n.t(I18N.generation.progressTitle),
            cancellable: true,
        }, async (progress, token) => {
            token.onCancellationRequested(() => cts.cancel());

            try {
                const diffs = await this.serviceRegistry.getDiffService().getDiff();
                if (diffs.length === 0) {
                    vscode.window.showInformationMessage(vscode.l10n.t(I18N.generation.noStagedChanges));
                    return;
                }

                const llmService = this.serviceRegistry.getCurrentLLMService();
                const result = await llmService.generateCommitMessage(diffs, { token: cts.token });

                if ('content' in result) {
                    await this.fillCommitMessage(result.content);
                } else {
                    await this.handleError(result);
                }
            } catch (error: any) {
                if (cts.token.isCancellationRequested) {
                    vscode.window.showInformationMessage(vscode.l10n.t(I18N.generation.cancelled));
                } else {
                    vscode.window.showErrorMessage(vscode.l10n.t(I18N.generation.failedToGenerate, error.message));
                }
            } finally {
                cts.dispose();
                this.currentCancelSource = undefined;
                await vscode.commands.executeCommand('setContext', 'gitCommitGenie.generating', false);
            }
        });
    }

    private getSecretKeyName(provider: string): string {
        switch (provider) {
            case 'deepseek': return 'gitCommitGenie.secret.deepseekApiKey';
            case 'anthropic': return 'gitCommitGenie.secret.anthropicApiKey';
            case 'gemini': return 'gitCommitGenie.secret.geminiApiKey';
            default: return 'gitCommitGenie.secret.openaiApiKey';
        }
    }

    private async fillCommitMessage(content: string): Promise<void> {
        const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
        const api = gitExtension.getAPI(1);
        const repo = api.repositories[0];

        if (repo) {
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
    }

    private async handleError(result: any): Promise<void> {
        if (result.statusCode === 401) {
            await vscode.commands.executeCommand('git-commit-genie.manageModels');
            return;
        }

        if (result.statusCode === 499 || /Cancelled/i.test(result.message)) {
            vscode.window.showInformationMessage(vscode.l10n.t(I18N.generation.cancelled));
        } else {
            vscode.window.showErrorMessage(vscode.l10n.t(I18N.generation.errorGenerating, result.message));
        }
    }
}