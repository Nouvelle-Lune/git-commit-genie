import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import {
    AI_MODELS_KEY,
    GENERATION_MODEL_ID_KEY,
    REPOSITORY_ANALYSIS_MODEL_ID_KEY,
    AIModelConfig,
    NATIVE_SECRET_KEYS,
    PROVIDER_LABELS,
    ProviderKind,
    createAIProvider,
    customSecretKey,
    modelSecretKey,
} from '../services/llm/providers';
import { ServiceRegistry } from '../core/ServiceRegistry';
import { StatusBarManager } from '../ui/StatusBarManager';

type ModelPurpose = 'generation' | 'repositoryAnalysis';

export class ModelCommands {
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly serviceRegistry: ServiceRegistry,
        private readonly statusBarManager: StatusBarManager,
    ) {}

    async register(): Promise<void> {
        this.context.subscriptions.push(
            vscode.commands.registerCommand('git-commit-genie.manageModels', () => this.manageModels())
        );
    }

    private async manageModels(): Promise<void> {
        const generation = this.modelDescription(this.context.globalState.get<string>(GENERATION_MODEL_ID_KEY, ''));
        const analysis = this.modelDescription(this.context.globalState.get<string>(REPOSITORY_ANALYSIS_MODEL_ID_KEY, ''));
        const items: Array<vscode.QuickPickItem & { value: ModelPurpose | ProviderKind }> = [
            { label: '$(sparkle) Commit message model', description: generation, value: 'generation' },
            { label: '$(repo) Repository analysis model', description: analysis, value: 'repositoryAnalysis' },
            { label: '', kind: vscode.QuickPickItemKind.Separator, value: 'generation' },
            ...(['openai', 'anthropic', 'google', 'custom'] as const).map(value => ({
                label: PROVIDER_LABELS[value],
                description: `${this.serviceRegistry.getModels().filter(model => model.provider === value).length} configured`,
                value,
            })),
        ];
        const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Manage models or select a workflow model' });
        if (!picked) { return; }
        if (picked.value === 'generation' || picked.value === 'repositoryAnalysis') {
            await this.selectWorkflowModel(picked.value);
            return;
        }
        await this.manageProvider(picked.value);
    }

    private async manageProvider(provider: ProviderKind): Promise<void> {
        const models = this.serviceRegistry.getModels().filter(model => model.provider === provider);
        const picked = await vscode.window.showQuickPick([
            { label: '$(add) Add model', value: '__add__' },
            ...models.map(model => ({
                label: model.label,
                description: this.usageDescription(model.id),
                detail: provider === 'custom' ? `${model.model} · ${model.baseUrl}` : model.model,
                value: model.id,
            })),
        ], { placeHolder: `${PROVIDER_LABELS[provider]} models` });
        if (!picked) { return; }
        if (picked.value === '__add__') {
            await this.addModel(provider);
            return;
        }
        const model = this.requireModel(picked.value);
        await this.manageConfiguredModel(model);
    }

    private async manageConfiguredModel(model: AIModelConfig): Promise<void> {
        const picked = await vscode.window.showQuickPick([
            { label: 'Use for commit messages', value: 'generation' },
            { label: 'Use for repository analysis', value: 'repositoryAnalysis' },
            { label: 'Edit model', value: 'edit' },
            { label: 'Replace API key', value: 'key' },
            { label: 'Delete model', value: 'delete' },
        ], { placeHolder: model.label });
        if (!picked) { return; }
        if (picked.value === 'generation' || picked.value === 'repositoryAnalysis') {
            await this.assignModel(picked.value, model.id);
        } else if (picked.value === 'edit') {
            await this.editModel(model);
        } else if (picked.value === 'key') {
            await this.replaceApiKey(model);
        } else {
            await this.deleteModel(model);
        }
    }

    private async addModel(provider: ProviderKind): Promise<void> {
        const nativeApiKey = provider === 'custom'
            ? undefined
            : await this.resolveNativeApiKey(provider);
        if (provider !== 'custom' && !nativeApiKey) { return; }
        const model = provider === 'custom'
            ? await this.promptCustomModel({ id: randomUUID(), label: '', provider, model: '', baseUrl: '' })
            : await this.promptNativeModel(provider, nativeApiKey!);
        if (!model) { return; }
        const apiKey = nativeApiKey ?? await this.resolveApiKeyForNewModel(model);
        if (!apiKey) { return; }
        await this.validateModel(model, apiKey);
        await this.context.globalState.update(AI_MODELS_KEY, [...this.serviceRegistry.getModels(), model]);
        await this.serviceRegistry.reloadProviderServices();
        const service = this.serviceRegistry.getLLMService(model.id);
        if (!service) {
            throw new Error(`AI model service '${model.id}' was not created.`);
        }
        await service.setApiKey(apiKey);
        await this.statusBarManager.refreshModelStates();
        await this.manageConfiguredModel(model);
    }

    private async promptNativeModel(
        provider: Exclude<ProviderKind, 'custom'>,
        apiKey: string,
    ): Promise<AIModelConfig | undefined> {
        const available = await createAIProvider({ kind: provider, apiKey }).listModels();
        if (!available.length) {
            throw new Error(`${PROVIDER_LABELS[provider]} returned no available models.`);
        }
        const model = await vscode.window.showQuickPick(available, { placeHolder: `Select a ${PROVIDER_LABELS[provider]} model` });
        if (!model) { return undefined; }
        const label = await vscode.window.showInputBox({ title: 'Model display name', value: model, ignoreFocusOut: true });
        if (!label?.trim()) { return undefined; }
        return { id: randomUUID(), label: label.trim(), provider, model };
    }

    private async editModel(current: AIModelConfig): Promise<void> {
        const apiKey = await this.context.secrets.get(modelSecretKey(current));
        if (!apiKey) {
            throw new Error(`${current.label} has no API key.`);
        }
        const updated = current.provider === 'custom'
            ? await this.promptCustomModel(current)
            : await this.promptNativeModel(current.provider, apiKey);
        if (!updated) { return; }
        const model = { ...updated, id: current.id };
        await this.validateModel(model, apiKey);
        await this.context.globalState.update(
            AI_MODELS_KEY,
            this.serviceRegistry.getModels().map(candidate => candidate.id === current.id ? model : candidate),
        );
        await this.serviceRegistry.reloadProviderServices();
        this.serviceRegistry.updateCurrentLLMService();
        await this.statusBarManager.refreshModelStates();
    }

    private async replaceApiKey(model: AIModelConfig): Promise<void> {
        const apiKey = await this.promptApiKey(PROVIDER_LABELS[model.provider]);
        if (!apiKey) { return; }
        await this.validateModel(model, apiKey);
        const service = this.serviceRegistry.getLLMService(model.id);
        if (!service) {
            throw new Error(`AI model service '${model.id}' does not exist.`);
        }
        await service.setApiKey(apiKey);
        await this.statusBarManager.refreshModelStates();
    }

    private async deleteModel(model: AIModelConfig): Promise<void> {
        if (this.context.globalState.get<string>(GENERATION_MODEL_ID_KEY, '') === model.id) {
            throw new Error('Select another commit message model before deleting this model.');
        }
        if (this.context.globalState.get<string>(REPOSITORY_ANALYSIS_MODEL_ID_KEY, '') === model.id) {
            throw new Error('Select another repository analysis model before deleting this model.');
        }
        const confirmation = await vscode.window.showWarningMessage(
            `Delete model '${model.label}'?`,
            { modal: true },
            'Delete',
        );
        if (confirmation !== 'Delete') { return; }
        const remaining = this.serviceRegistry.getModels().filter(candidate => candidate.id !== model.id);
        await this.context.globalState.update(AI_MODELS_KEY, remaining);
        if (model.provider === 'custom') {
            await this.context.secrets.delete(customSecretKey(model.id));
        }
        await this.serviceRegistry.reloadProviderServices();
        await this.statusBarManager.refreshModelStates();
    }

    private async selectWorkflowModel(purpose: ModelPurpose): Promise<void> {
        const models = this.serviceRegistry.getModels();
        const picked = await vscode.window.showQuickPick(models.map(model => ({
            label: model.label,
            description: PROVIDER_LABELS[model.provider],
            detail: model.provider === 'custom' ? `${model.model} · ${model.baseUrl}` : model.model,
            value: model.id,
        })), { placeHolder: purpose === 'generation' ? 'Select commit message model' : 'Select repository analysis model' });
        if (!picked) { return; }
        await this.assignModel(purpose, picked.value);
    }

    private async assignModel(purpose: ModelPurpose, modelId: string): Promise<void> {
        this.requireModel(modelId);
        const key = purpose === 'generation' ? GENERATION_MODEL_ID_KEY : REPOSITORY_ANALYSIS_MODEL_ID_KEY;
        await this.context.globalState.update(key, modelId);
        if (purpose === 'generation') {
            this.serviceRegistry.updateCurrentLLMService();
        }
        await this.statusBarManager.refreshModelStates();
    }

    private async resolveApiKeyForNewModel(model: AIModelConfig): Promise<string | undefined> {
        const existing = await this.context.secrets.get(modelSecretKey(model));
        return existing ?? this.promptApiKey(PROVIDER_LABELS[model.provider]);
    }

    private async resolveNativeApiKey(provider: Exclude<ProviderKind, 'custom'>): Promise<string | undefined> {
        return await this.context.secrets.get(NATIVE_SECRET_KEYS[provider])
            ?? this.promptApiKey(PROVIDER_LABELS[provider]);
    }

    private async validateModel(model: AIModelConfig, apiKey: string): Promise<void> {
        const provider = createAIProvider({ kind: model.provider, apiKey, baseUrl: model.baseUrl });
        const available = await provider.listModels();
        if (!available.includes(model.model)) {
            throw new Error(`Model '${model.model}' was not returned by ${PROVIDER_LABELS[model.provider]}.`);
        }
    }

    private async promptCustomModel(initial: AIModelConfig): Promise<AIModelConfig | undefined> {
        const label = await vscode.window.showInputBox({ title: 'Custom model name', value: initial.label, ignoreFocusOut: true });
        if (!label?.trim()) { return undefined; }
        const baseUrl = await vscode.window.showInputBox({ title: 'OpenAI-compatible base URL', value: initial.baseUrl, ignoreFocusOut: true });
        if (!baseUrl?.trim()) { return undefined; }
        const parsed = new URL(baseUrl.trim());
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('Custom model base URL must use HTTP or HTTPS.');
        }
        const model = await vscode.window.showInputBox({ title: 'Model name', value: initial.model, ignoreFocusOut: true });
        if (!model?.trim()) { return undefined; }
        return { id: initial.id, label: label.trim(), provider: 'custom', baseUrl: baseUrl.trim(), model: model.trim() };
    }

    private promptApiKey(label: string): Thenable<string | undefined> {
        return vscode.window.showInputBox({
            title: `${label} API key`,
            password: true,
            ignoreFocusOut: true,
            validateInput: value => value.trim() ? undefined : 'API key is required.',
        });
    }

    private requireModel(id: string): AIModelConfig {
        const model = this.serviceRegistry.getModel(id);
        if (!model) {
            throw new Error(`AI model '${id}' is not configured.`);
        }
        return model;
    }

    private modelDescription(id: string): string {
        const model = this.serviceRegistry.getModel(id);
        return model ? `${model.label} · ${PROVIDER_LABELS[model.provider]}` : 'Not selected';
    }

    private usageDescription(id: string): string | undefined {
        const purposes: string[] = [];
        if (this.context.globalState.get<string>(GENERATION_MODEL_ID_KEY, '') === id) {
            purposes.push('Commit messages');
        }
        if (this.context.globalState.get<string>(REPOSITORY_ANALYSIS_MODEL_ID_KEY, '') === id) {
            purposes.push('Repository analysis');
        }
        return purposes.length ? purposes.join(' · ') : undefined;
    }
}
