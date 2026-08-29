import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import {
    AI_MODELS_KEY,
    GENERATION_MODEL_ID_KEY,
    REPOSITORY_ANALYSIS_MODEL_ID_KEY,
    AIModelConfig,
    AIChatTemplateValue,
    AIThinkingFormat,
    AIThinkingTokenBudgetField,
    NATIVE_SECRET_KEYS,
    PROVIDER_LABELS,
    ProviderKind,
    ThinkingLevel,
    THINKING_LEVELS,
    createAIProvider,
    customSecretKey,
    getModelThinkingMetadata,
    getSupportedThinkingLevels,
    modelSecretKey,
} from '../services/llm/providers';
import { ServiceRegistry } from '../core/ServiceRegistry';
import { StatusBarManager } from '../ui/StatusBarManager';

type ModelPurpose = 'generation' | 'repositoryAnalysis';

const THINKING_FORMAT_OPTIONS: ReadonlyArray<{
    label: string;
    description: string;
    value: AIThinkingFormat;
}> = [
    { label: 'No thinking control', description: 'Do not send native thinking parameters', value: 'off' },
    { label: 'Standard OpenAI-compatible', description: 'reasoning_effort · Default', value: 'openai' },
    { label: 'OpenRouter extension', description: 'reasoning.effort', value: 'openrouter' },
    { label: 'DeepSeek extension', description: 'thinking: { type: enabled | disabled }', value: 'deepseek' },
    { label: 'Together extension', description: 'reasoning.enabled', value: 'together' },
    { label: 'z.ai extension', description: 'thinking: { type: enabled | disabled }', value: 'zai' },
    { label: 'Qwen extension', description: 'enable_thinking', value: 'qwen' },
    { label: 'Qwen local chat template', description: 'chat_template_kwargs.enable_thinking', value: 'qwen-chat-template' },
    { label: 'Chat template', description: 'custom chat_template_kwargs', value: 'chat-template' },
    { label: 'Baseten', description: 'custom chat_template_args', value: 'baseten' },
    { label: 'String thinking', description: 'thinking: string', value: 'string-thinking' },
    { label: 'AntLing', description: 'reasoning.effort', value: 'ant-ling' },
];

const THINKING_BUDGET_OPTIONS: ReadonlyArray<{
    label: string;
    description: string;
    value: AIThinkingTokenBudgetField | undefined;
}> = [
    { label: 'None', description: 'Do not send a thinking budget field', value: undefined },
    { label: 'Local vLLM extension', description: 'thinking_token_budget', value: 'thinking_token_budget' },
    { label: 'Local Qwen / SGLang extension', description: 'thinking_budget', value: 'thinking_budget' },
    { label: 'Local llama.cpp extension', description: 'thinking_budget_tokens', value: 'thinking_budget_tokens' },
];

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
        const items: Array<vscode.QuickPickItem & { value: string }> = [
            { label: 'Use for commit messages', value: 'generation' },
            { label: 'Use for repository analysis', value: 'repositoryAnalysis' },
            { label: 'Set thinking level override', value: 'thinking' },
            ...(model.provider === 'custom' ? [{
                label: 'Advanced thinking compatibility',
                description: 'Only for endpoints with non-standard Chat Completions parameters',
                value: 'thinkingCompatibility',
            }] : []),
            { label: 'Edit model', value: 'edit' },
            { label: 'Replace API key', value: 'key' },
            { label: 'Delete model', value: 'delete' },
        ];
        const picked = await vscode.window.showQuickPick(items, { placeHolder: model.label });
        if (!picked) { return; }
        if (picked.value === 'generation' || picked.value === 'repositoryAnalysis') {
            await this.assignModel(picked.value as ModelPurpose, model.id);
        } else if (picked.value === 'thinking') {
            await this.configureThinkingLevel(model);
        } else if (picked.value === 'thinkingCompatibility') {
            await this.configureCustomThinkingCompatibility(model);
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

    private async configureThinkingLevel(model: AIModelConfig): Promise<void> {
        const configuration = vscode.workspace.getConfiguration('gitCommitGenie');
        const metadata = getModelThinkingMetadata(model);
        const supported = getSupportedThinkingLevels(metadata);
        const defaultLevel = configuration.get<unknown>('defaultThinkingLevel', 'off');
        if (typeof defaultLevel !== 'string' || !THINKING_LEVELS.includes(defaultLevel as ThinkingLevel)) {
            throw new Error(`Invalid default thinking level '${String(defaultLevel)}'.`);
        }
        const configured = configuration.get<unknown>('modelThinkingLevels', {});
        if (configured === null || typeof configured !== 'object' || Array.isArray(configured)) {
            throw new Error('gitCommitGenie.modelThinkingLevels must be an object.');
        }
        const modelLevels = { ...(configured as Record<string, unknown>) };
        const modelKey = `${model.provider}/${model.model}`;
        const hasOverride = Object.prototype.hasOwnProperty.call(modelLevels, modelKey);
        const currentOverride = hasOverride ? modelLevels[modelKey] : undefined;
        const picked = await vscode.window.showQuickPick([
            {
                label: 'Inherit global setting',
                description: `${defaultLevel}${hasOverride ? '' : ' · Current'}`,
                value: '__inherit__',
            },
            ...supported.map(level => ({
                label: level,
                description: currentOverride === level ? 'Current override' : undefined,
                value: level,
            })),
            ...(model.provider === 'custom' ? [{
                label: 'Custom native value…',
                description: typeof currentOverride === 'string'
                    && !THINKING_LEVELS.includes(currentOverride as ThinkingLevel)
                    ? `${currentOverride} · Current override`
                    : 'Send a provider-specific effort value verbatim',
                value: '__custom__',
            }] : []),
        ],
            { placeHolder: `Thinking level for ${model.label}` },
        );
        if (!picked) { return; }

        if (picked.value === '__inherit__') {
            delete modelLevels[modelKey];
        } else if (picked.value === '__custom__') {
            const nativeValue = await vscode.window.showInputBox({
                title: `Native thinking value for ${model.label}`,
                value: typeof currentOverride === 'string'
                    && !THINKING_LEVELS.includes(currentOverride as ThinkingLevel)
                    ? currentOverride
                    : '',
                prompt: 'This value is sent verbatim by the configured endpoint thinking profile.',
                ignoreFocusOut: true,
                validateInput: value => value.trim() ? undefined : 'A native thinking value is required.',
            });
            if (nativeValue === undefined) { return; }
            modelLevels[modelKey] = nativeValue.trim();
        } else {
            modelLevels[modelKey] = picked.value;
        }
        await configuration.update(
            'modelThinkingLevels',
            modelLevels,
            vscode.ConfigurationTarget.Global,
        );
    }

    private async configureCustomThinkingCompatibility(model: AIModelConfig): Promise<void> {
        if (model.provider !== 'custom') {
            throw new Error('Thinking compatibility profiles are only available for custom OpenAI-compatible models.');
        }

        const currentFormat = model.thinkingFormat ?? 'openai';
        const formatChoice = await vscode.window.showQuickPick(
            THINKING_FORMAT_OPTIONS.map(option => ({
                ...option,
                description: option.value === currentFormat
                    ? `${option.description} · Current`
                    : option.description,
            })),
            { placeHolder: 'Advanced: select the endpoint thinking request profile' },
        );
        if (!formatChoice) { return; }

        const budgetChoice = await vscode.window.showQuickPick(
            THINKING_BUDGET_OPTIONS.map(option => ({
                ...option,
                description: option.value === model.thinkingTokenBudgetField
                    ? `${option.description} · Current`
                    : option.description,
            })),
            { placeHolder: 'Advanced: select an optional local-engine budget field' },
        );
        if (!budgetChoice) { return; }

        const chatTemplateKwargs = formatChoice.value === 'chat-template'
            ? await this.promptChatTemplateValues(
                'chat_template_kwargs JSON',
                model.chatTemplateKwargs,
                '{\n  "enable_thinking": { "$var": "thinking.enabled" },\n  "thinking_budget": { "$var": "thinking.budget", "omitWhenOff": true }\n}',
            )
            : undefined;
        if (chatTemplateKwargs === null) { return; }
        const chatTemplateArgs = formatChoice.value === 'baseten'
            ? await this.promptChatTemplateValues(
                'chat_template_args JSON',
                model.chatTemplateArgs,
                '{\n  "enable_thinking": { "$var": "thinking.enabled" },\n  "thinking_budget": { "$var": "thinking.budget", "omitWhenOff": true }\n}',
            )
            : undefined;
        if (chatTemplateArgs === null) { return; }

        const updated: AIModelConfig = { ...model };
        delete updated.thinkingFormat;
        delete updated.thinkingTokenBudgetField;
        delete updated.chatTemplateKwargs;
        delete updated.chatTemplateArgs;
        if (formatChoice.value !== 'openai') {
            updated.thinkingFormat = formatChoice.value;
        }
        if (budgetChoice.value !== undefined) {
            updated.thinkingTokenBudgetField = budgetChoice.value;
        }
        if (chatTemplateKwargs !== undefined) {
            updated.chatTemplateKwargs = chatTemplateKwargs;
        }
        if (chatTemplateArgs !== undefined) {
            updated.chatTemplateArgs = chatTemplateArgs;
        }
        await this.updateConfiguredModel(updated);
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
        return {
            ...initial,
            label: label.trim(),
            provider: 'custom',
            baseUrl: baseUrl.trim(),
            model: model.trim(),
        };
    }

    private async updateConfiguredModel(model: AIModelConfig): Promise<void> {
        await this.context.globalState.update(
            AI_MODELS_KEY,
            this.serviceRegistry.getModels().map(candidate => candidate.id === model.id ? model : candidate),
        );
        await this.serviceRegistry.reloadProviderServices();
        this.serviceRegistry.updateCurrentLLMService();
        await this.statusBarManager.refreshModelStates();
    }

    private async promptChatTemplateValues(
        title: string,
        initial: Record<string, AIChatTemplateValue> | undefined,
        placeholder: string,
    ): Promise<Record<string, AIChatTemplateValue> | null> {
        const value = await vscode.window.showInputBox({
            title,
            value: JSON.stringify(initial ?? JSON.parse(placeholder), null, 2),
            prompt: 'Use scalar values or {$var: thinking.enabled|thinking.effort|thinking.budget}.',
            ignoreFocusOut: true,
        });
        if (value === undefined) { return null; }
        return parseChatTemplateValues(JSON.parse(value), title);
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

function parseChatTemplateValues(value: unknown, title: string): Record<string, AIChatTemplateValue> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${title} must be a JSON object.`);
    }

    const result: Record<string, AIChatTemplateValue> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (entry === null || typeof entry === 'string' || typeof entry === 'boolean'
            || (typeof entry === 'number' && Number.isFinite(entry))) {
            result[key] = entry;
            continue;
        }
        if (typeof entry !== 'object' || Array.isArray(entry)) {
            throw new Error(`${title}.${key} must be a scalar or a thinking variable.`);
        }

        const variable = (entry as { $var?: unknown }).$var;
        if (variable !== 'thinking.enabled' && variable !== 'thinking.effort' && variable !== 'thinking.budget') {
            throw new Error(`${title}.${key} has an unsupported $var.`);
        }
        const entryKeys = Object.keys(entry);
        if (entryKeys.some(entryKey => entryKey !== '$var' && entryKey !== 'omitWhenOff')) {
            throw new Error(`${title}.${key} contains an unsupported property.`);
        }
        const omitWhenOff = (entry as { omitWhenOff?: unknown }).omitWhenOff;
        if (omitWhenOff !== undefined && typeof omitWhenOff !== 'boolean') {
            throw new Error(`${title}.${key}.omitWhenOff must be a boolean.`);
        }
        result[key] = {
            $var: variable,
            ...(omitWhenOff !== undefined ? { omitWhenOff } : {}),
        };
    }
    return result;
}
