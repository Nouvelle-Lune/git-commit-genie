import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ServiceRegistry } from '../core/ServiceRegistry';
import { StatusBarManager } from '../ui/StatusBarManager';
import { L10N_KEYS as I18N } from '../i18n/keys';

export class ModelCommands {
    constructor(
        private context: vscode.ExtensionContext,
        private serviceRegistry: ServiceRegistry,
        private statusBarManager: StatusBarManager
    ) { }

    async register(): Promise<void> {
        // Manage Models: provider -> API key -> model selection
        this.context.subscriptions.push(
            vscode.commands.registerCommand('git-commit-genie.manageModels', this.manageModels.bind(this))
        );
    }

    private async manageModels(): Promise<void> {
        const providerPick = await vscode.window.showQuickPick([
            { label: 'OpenAI', value: 'openai' },
            { label: 'DeepSeek', value: 'deepseek' },
            { label: 'Anthropic', value: 'anthropic' },
            { label: 'Gemini', value: 'gemini' },
        ], { placeHolder: vscode.l10n.t(I18N.manageModels.selectProvider) });

        if (!providerPick) {
            return;
        }

        const secretName = this.getSecretName(providerPick.value);
        const modelStateKey = this.getModelStateKey(providerPick.value);

        let existingKey = await this.context.secrets.get(secretName);
        let apiKeyToUse: string | undefined = existingKey || undefined;

        if (existingKey) {
            apiKeyToUse = await this.handleExistingApiKey(existingKey, providerPick.label, secretName);
            if (!apiKeyToUse) {
                return;
            }
        }

        if (!apiKeyToUse) {
            // First time input
            const entered = await this.promptForApiKey(providerPick.label);
            if (!entered) {
                return;
            }
            apiKeyToUse = entered;
        }

        let models: string[] = [];
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: existingKey && apiKeyToUse === existingKey
                    ? vscode.l10n.t(I18N.manageModels.listingModels, providerPick.label)
                    : vscode.l10n.t(I18N.manageModels.validatingKey, providerPick.label),
            }, async () => {
                const service = this.serviceRegistry.getLLMService(providerPick.value);
                if (service) {
                    models = await service.validateApiKeyAndListModels(apiKeyToUse!);
                }
            });
        } catch (err: any) {
            vscode.window.showErrorMessage(err?.message || vscode.l10n.t(I18N.manageModels.validatingKey, providerPick.label));
            return;
        }

        if (!models.length) {
            vscode.window.showErrorMessage(vscode.l10n.t(I18N.manageModels.noModels));
            return;
        }

        const modelPick = await this.selectModel(models, providerPick, modelStateKey);
        if (!modelPick) {
            return;
        }

        // Update provider and model
        await this.updateProviderAndModel(providerPick, modelPick, modelStateKey, apiKeyToUse!, existingKey);

        this.statusBarManager.updateStatusBar();
        vscode.window.showInformationMessage(
            vscode.l10n.t(I18N.manageModels.configured, providerPick.label, modelPick.value)
        );
    }

    private getSecretName(provider: string): string {
        switch (provider) {
            case 'deepseek': return 'gitCommitGenie.secret.deepseekApiKey';
            case 'anthropic': return 'gitCommitGenie.secret.anthropicApiKey';
            case 'gemini': return 'gitCommitGenie.secret.geminiApiKey';
            default: return 'gitCommitGenie.secret.openaiApiKey';
        }
    }

    private getModelStateKey(provider: string): string {
        switch (provider) {
            case 'deepseek': return 'gitCommitGenie.deepseekModel';
            case 'anthropic': return 'gitCommitGenie.anthropicModel';
            case 'gemini': return 'gitCommitGenie.geminiModel';
            default: return 'gitCommitGenie.openaiModel';
        }
    }

    private async handleExistingApiKey(existingKey: string, providerLabel: string, secretName: string): Promise<string | undefined> {
        const masked = existingKey.length > 8
            ? existingKey.slice(0, 4) + '…' + existingKey.slice(-4)
            : 'hidden';

        const action = await vscode.window.showQuickPick([
            { label: vscode.l10n.t(I18N.manageModels.reuseSavedKey, masked), value: 'reuse' },
            { label: vscode.l10n.t(I18N.manageModels.replaceKey), value: 'replace' },
            { label: vscode.l10n.t(I18N.manageModels.clearReenter), value: 'clear' },
            { label: vscode.l10n.t(I18N.manageModels.cancel), value: 'cancel' }
        ], { placeHolder: vscode.l10n.t(I18N.manageModels.savedKeyDetected, providerLabel) });

        if (!action || action.value === 'cancel') {
            return undefined;
        }

        if (action.value === 'clear') {
            await this.context.secrets.delete(secretName);
            const newKey = await this.promptForApiKey(providerLabel);
            return newKey;
        }

        if (action.value === 'replace') {
            const newKey = await vscode.window.showInputBox({
                title: vscode.l10n.t(I18N.manageModels.enterNewKeyTitle, providerLabel),
                prompt: `${providerLabel} API Key`,
                placeHolder: `${providerLabel} API Key`,
                password: true,
                ignoreFocusOut: true,
            });
            return newKey;
        }

        return existingKey; // reuse
    }

    private async promptForApiKey(providerLabel: string): Promise<string | undefined> {
        return await vscode.window.showInputBox({
            title: vscode.l10n.t(I18N.manageModels.enterKeyTitle, providerLabel),
            prompt: `${providerLabel} API Key`,
            placeHolder: `${providerLabel} API Key`,
            password: true,
            ignoreFocusOut: true,
        });
    }

    private async selectModel(models: string[], providerPick: any, modelStateKey: string): Promise<any> {
        const currentModel = this.context.globalState.get<string>(modelStateKey, '');
        const activeProvider = this.serviceRegistry.getProvider().toLowerCase();
        const isActiveProvider = providerPick.value.toLowerCase() === activeProvider;

        const secretName = this.getSecretName(providerPick.value);
        const hasKey = !!(await this.context.secrets.get(secretName));
        const showCurrent = isActiveProvider && hasKey;

        const modelItems: Array<vscode.QuickPickItem & { value: string }> = models.map(m => ({
            label: m,
            value: m,
            description: showCurrent && m === currentModel ? vscode.l10n.t(I18N.manageModels.currentLabel) : undefined,
            picked: showCurrent && m === currentModel
        }));

        return await vscode.window.showQuickPick(
            modelItems,
            { placeHolder: vscode.l10n.t(I18N.manageModels.selectModel, providerPick.label) }
        );
    }

    private async updateProviderAndModel(providerPick: any, modelPick: any, modelStateKey: string, apiKey: string, existingKey: string | undefined): Promise<void> {
        await this.context.globalState.update('gitCommitGenie.provider', providerPick.value);

        // Only store the key if it actually changed (avoid unnecessary SecretStorage writes)
        if (!existingKey || apiKey !== existingKey) {
            const service = this.serviceRegistry.getLLMService(providerPick.value);
            if (service) {
                await service.setApiKey(apiKey);
            }
        }

        // Update current LLM service
        this.serviceRegistry.updateCurrentLLMService();

        await this.context.globalState.update(modelStateKey, modelPick.value);

        // If repository analysis is enabled and missing, try initializing now
        try {
            const enabled = vscode.workspace.getConfiguration('gitCommitGenie.repositoryAnalysis').get<boolean>('enabled', true);
            if (!enabled) { return; }
            const wf = vscode.workspace.workspaceFolders;
            if (!wf || wf.length === 0) { return; }
            const repositoryPath = wf[0].uri.fsPath;
            if (!fs.existsSync(path.join(repositoryPath, '.git'))) { return; }
            const analysisService = this.serviceRegistry.getAnalysisService();
            const existing = await analysisService.getAnalysis(repositoryPath);
            if (!existing) {
                this.statusBarManager.setRepoAnalysisRunning(true);
                analysisService.initializeRepository(repositoryPath).finally(() => this.statusBarManager.setRepoAnalysisRunning(false));
            }
        } catch {
            // best-effort only
        }
    }
}
