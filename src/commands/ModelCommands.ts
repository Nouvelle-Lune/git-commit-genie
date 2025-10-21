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
        // Get current repo analysis model for display
        const config = vscode.workspace.getConfiguration('gitCommitGenie.repositoryAnalysis');
        const currentRepoModel = config.get<string>('model', 'general') || 'general';
        const repoModelDesc = currentRepoModel === 'general'
            ? undefined
            : `${vscode.l10n.t(I18N.manageModels.currentLabel)}: ${currentRepoModel}`;

        const items: Array<vscode.QuickPickItem & { value: string }> = [
            { label: 'OpenAI', value: 'openai' },
            { label: 'DeepSeek', value: 'deepseek' },
            { label: 'Anthropic', value: 'anthropic' },
            { label: 'Gemini', value: 'gemini' },
            { label: '', kind: vscode.QuickPickItemKind.Separator, value: '' },
            {
                label: vscode.l10n.t(I18N.manageModels.configureRepoAnalysisModel),
                description: repoModelDesc,
                value: 'repoAnalysis'
            },
        ];

        const providerPick = await vscode.window.showQuickPick(items, {
            placeHolder: vscode.l10n.t(I18N.manageModels.selectProvider)
        });

        if (!providerPick) {
            return;
        }

        // Handle repository analysis model configuration
        if (providerPick.value === 'repoAnalysis') {
            await this.manageRepoAnalysisModel();
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
        const sameKey = !!existingKey && apiKeyToUse === existingKey;
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: sameKey
                    ? vscode.l10n.t(I18N.manageModels.listingModels, providerPick.label)
                    : vscode.l10n.t(I18N.manageModels.validatingKey, providerPick.label),
            }, async () => {
                const service = this.serviceRegistry.getLLMService(providerPick.value);
                if (!service) { return; }

                if (sameKey) {
                    // Avoid token-wasting pings when API key is unchanged
                    models = service.listSupportedModels();
                } else {
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

        // Notify status bar that general provider/model changed so 'general' analysis selection follows
        this.statusBarManager.onProviderModelChanged(providerPick.value);
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
                this.statusBarManager.setRepoAnalysisRunning(true, repositoryPath);
                analysisService.initializeRepository(repositoryPath).finally(() => this.statusBarManager.setRepoAnalysisRunning(false));
            }
        } catch {
            // best-effort only
        }
    }

    /**
     * Manage repository analysis model configuration
     */
    private async manageRepoAnalysisModel(): Promise<void> {
        const config = vscode.workspace.getConfiguration('gitCommitGenie.repositoryAnalysis');
        const currentRepoModel = config.get<string>('model', 'general') || 'general';

        // Collect all available models from all providers
        const allModels: Array<{ label: string, value: string, provider: string, description?: string }> = [];

        // Add "Use default model" option at the top
        const generalProvider = this.context.globalState.get<string>('gitCommitGenie.provider', 'openai') || 'openai';
        const generalModelKey = this.getModelStateKey(generalProvider);
        const generalModel = this.context.globalState.get<string>(generalModelKey, '');
        const useDefaultDesc = currentRepoModel === 'general' && generalModel
            ? `${vscode.l10n.t(I18N.manageModels.currentLabel)}: ${generalModel}`
            : vscode.l10n.t(I18N.manageModels.useDefaultModelDesc);

        allModels.push({
            label: vscode.l10n.t(I18N.manageModels.useDefaultModel),
            value: 'general',
            provider: 'general',
            description: useDefaultDesc
        });

        // Collect models from all providers
        const providers = [
            { name: 'OpenAI', value: 'openai' },
            { name: 'DeepSeek', value: 'deepseek' },
            { name: 'Anthropic', value: 'anthropic' },
            { name: 'Gemini', value: 'gemini' }
        ];

        for (const provider of providers) {
            try {
                const service = this.serviceRegistry.getLLMService(provider.value);
                if (service) {
                    const models = service.listSupportedModels();
                    for (const model of models) {
                        allModels.push({
                            label: model,
                            value: model,
                            provider: provider.name,
                            description: currentRepoModel === model ? vscode.l10n.t(I18N.manageModels.currentLabel) : provider.name
                        });
                    }
                }
            } catch {
                // Ignore provider errors
            }
        }

        // Show model picker
        const modelPick = await vscode.window.showQuickPick(allModels, {
            placeHolder: vscode.l10n.t(I18N.manageModels.selectRepoAnalysisModel),
            matchOnDescription: true
        });

        if (!modelPick) {
            return;
        }

        // Update the setting
        await config.update('model', modelPick.value, vscode.ConfigurationTarget.Global);

        // Show confirmation
        if (modelPick.value === 'general') {
            vscode.window.showInformationMessage(
                vscode.l10n.t(I18N.manageModels.configured,
                    vscode.l10n.t(I18N.manageModels.useDefaultModel),
                    vscode.l10n.t(I18N.manageModels.useDefaultModelDesc))
            );
        } else {
            vscode.window.showInformationMessage(
                vscode.l10n.t(I18N.manageModels.repoAnalysisConfigured, modelPick.provider, modelPick.value)
            );
        }

        // Update status bar
        this.statusBarManager.updateStatusBar();
    }


}
