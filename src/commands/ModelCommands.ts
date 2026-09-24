import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import {
    AI_MODELS_KEY,
    GENERATION_MODEL_ID_KEY,
    AIModelConfig,
    AIChatTemplateValue,
    AIThinkingFormat,
    AIThinkingTokenBudgetField,
    PRESET_TRANSPORT_LABELS,
    PRESET_TRANSPORT_PROVIDERS,
    PROVIDER_LABELS,
    PresetModel,
    ProviderKind,
    ThinkingLevel,
    THINKING_LEVELS,
    VENDOR_PRESETS,
    VendorPreset,
    createAIProvider,
    customSecretKey,
    getModelThinkingMetadata,
    getSupportedThinkingLevels,
    getVendorPreset,
    modelSecretKey,
    pricingKeyForModel,
    vendorSecretKey,
} from '../services/llm/providers';
import { ServiceRegistry } from '../core/ServiceRegistry';
import { StatusBarManager } from '../ui/StatusBarManager';
import {
    describePricingSource,
    isTieredPricing,
    parseFlatModelPricingInput,
} from '../services/cost';
import type { FlatModelPricing } from '../services/cost/costTypes';
import type { FlatPricing, ModelPricing } from '../services/cost/pricing';
import { logger } from '../services/logger';

type ModelPurpose = 'generation';
type MenuExit = 'back' | 'done';

const BACK_VALUE = '__back__';
const CUSTOM_VENDOR_VALUE = 'custom';
const ADD_PRESET_VALUE = '__preset__';
const BROWSE_MODELS_VALUE = '__browse__';
const MANUAL_MODEL_VALUE = '__manual__';
const ADD_CUSTOM_VALUE = '__add__';

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
            vscode.commands.registerCommand('git-commit-genie.manageModels', async () => {
                try {
                    await this.manageModels();
                } catch (error) {
                    // Surface every failure: callers like genieMenu use executeCommand and must not
                    // silently drop rejections, otherwise QuickPick appears to vanish with no feedback.
                    const message = error instanceof Error ? error.message : String(error);
                    logger.error('Manage Models failed:', error);
                    await vscode.window.showErrorMessage(`Manage Models failed: ${message}`);
                }
            })
        );
    }

    private async manageModels(): Promise<void> {
        for (;;) {
            const generation = this.modelDescription(this.context.globalState.get<string>(GENERATION_MODEL_ID_KEY, ''));
            const customCount = this.serviceRegistry.getModels()
                .filter(model => model.vendor === undefined && model.provider === 'custom').length;
            const items: Array<vscode.QuickPickItem & { value: string }> = [
                { label: '$(sparkle) Commit message model', description: generation, value: 'generation' },
                { label: '', kind: vscode.QuickPickItemKind.Separator, value: 'generation' },
                ...VENDOR_PRESETS.map(vendor => {
                    const configured = this.serviceRegistry.getModels().filter(model => model.vendor === vendor.id).length;
                    return {
                        label: vendor.label,
                        description: `${configured} configured · ${vendor.description}`,
                        value: vendor.id,
                    };
                }),
                {
                    label: 'Custom OpenAI-compatible',
                    description: `${customCount} configured · your own endpoint and model id`,
                    value: CUSTOM_VENDOR_VALUE,
                },
            ];
            const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Manage models or select a workflow model' });
            if (!picked) { return; }
            if (picked.value === 'generation') {
                const exit = await this.selectWorkflowModel(picked.value as ModelPurpose);
                if (exit === 'back') { continue; }
                return;
            }
            const vendor = getVendorPreset(picked.value);
            const exit = vendor ? await this.manageVendor(vendor) : await this.manageCustomModels();
            if (exit === 'back') { continue; }
            return;
        }
    }

    /**
     * Preset vendors list their curated models first and keep a manual escape hatch:
     * native providers can browse the live model list, gateways accept any model id the
     * vendor serves under the same key.
     */
    private async manageVendor(vendor: VendorPreset): Promise<MenuExit> {
        for (;;) {
            const models = this.serviceRegistry.getModels().filter(model => model.vendor === vendor.id);
            const picked = await vscode.window.showQuickPick([
                this.backItem(),
                {
                    label: '$(add) Add preset model',
                    description: `${vendor.models.length} presets · one ${vendor.label} API key`,
                    value: ADD_PRESET_VALUE,
                },
                ...(vendor.endpoints === undefined
                    ? [{
                        label: '$(list-unordered) Browse available models',
                        description: `Query the ${vendor.label} model list with your API key`,
                        value: BROWSE_MODELS_VALUE,
                    }]
                    : [{
                        label: '$(edit) Enter a model id manually',
                        description: `Use another ${vendor.label} model id with the same API key`,
                        value: MANUAL_MODEL_VALUE,
                    }]),
                ...models.map(model => ({
                    label: model.label,
                    description: this.usageDescription(model.id),
                    detail: this.modelDetail(model),
                    value: model.id,
                })),
            ], { placeHolder: `${vendor.label} models` });
            if (!picked || picked.value === BACK_VALUE) { return 'back'; }
            if (picked.value === ADD_PRESET_VALUE) {
                const exit = await this.addPresetModel(vendor);
                if (exit === 'back') { continue; }
                return 'done';
            }
            if (picked.value === BROWSE_MODELS_VALUE) {
                const exit = await this.addBrowsedModel(vendor);
                if (exit === 'back') { continue; }
                return 'done';
            }
            if (picked.value === MANUAL_MODEL_VALUE) {
                const exit = await this.addManualVendorModel(vendor);
                if (exit === 'back') { continue; }
                return 'done';
            }
            const exit = await this.manageConfiguredModel(this.requireModel(picked.value));
            if (exit === 'back') { continue; }
            return 'done';
        }
    }

    /** Custom endpoints keep the original per-instance flow, including its own secret slot. */
    private async manageCustomModels(): Promise<MenuExit> {
        for (;;) {
            const models = this.serviceRegistry.getModels()
                .filter(model => model.vendor === undefined && model.provider === 'custom');
            const picked = await vscode.window.showQuickPick([
                this.backItem(),
                { label: '$(add) Add model', value: ADD_CUSTOM_VALUE },
                ...models.map(model => ({
                    label: model.label,
                    description: this.usageDescription(model.id),
                    detail: this.modelDetail(model),
                    value: model.id,
                })),
            ], { placeHolder: 'Custom OpenAI-compatible models' });
            if (!picked || picked.value === BACK_VALUE) { return 'back'; }
            if (picked.value === ADD_CUSTOM_VALUE) {
                const exit = await this.addCustomModel();
                if (exit === 'back') { continue; }
                return 'done';
            }
            const exit = await this.manageConfiguredModel(this.requireModel(picked.value));
            if (exit === 'back') { continue; }
            return 'done';
        }
    }

    private async manageConfiguredModel(initial: AIModelConfig): Promise<MenuExit> {
        let model = initial;
        for (;;) {
            const items: Array<vscode.QuickPickItem & { value: string }> = [
                this.backItem(),
                { label: 'Use for commit messages', value: 'generation' },
                { label: 'Set thinking level override', value: 'thinking' },
                ...(model.provider === 'custom' ? [{
                    label: 'Advanced thinking compatibility',
                    description: 'Only for endpoints with non-standard Chat Completions parameters',
                    value: 'thinkingCompatibility',
                }] : []),
                { label: 'Pricing', description: this.pricingDescription(model), value: 'pricing' },
                { label: 'Edit model', value: 'edit' },
                { label: 'Replace API key', value: 'key' },
                { label: 'Delete model', value: 'delete' },
            ];
            const picked = await vscode.window.showQuickPick(items, { placeHolder: model.label });
            if (!picked || picked.value === BACK_VALUE) { return 'back'; }
            if (picked.value === 'generation') {
                await this.assignModel(picked.value as ModelPurpose, model.id);
                return 'done';
            }
            if (picked.value === 'thinking') {
                const exit = await this.configureThinkingLevel(model);
                if (exit === 'back') { continue; }
                continue;
            }
            if (picked.value === 'thinkingCompatibility') {
                const exit = await this.configureCustomThinkingCompatibility(model);
                if (exit === 'back') { continue; }
                continue;
            }
            if (picked.value === 'pricing') {
                const exit = await this.manageModelPricing(model);
                if (exit === 'back') { continue; }
                // Reload model after pricing changes so subsequent menu items see fresh config.
                model = this.requireModel(model.id);
                continue;
            }
            if (picked.value === 'edit') {
                await this.editModel(model);
                model = this.requireModel(model.id);
                continue;
            }
            if (picked.value === 'key') {
                await this.replaceApiKey(model);
                continue;
            }
            await this.deleteModel(model);
            return 'back';
        }
    }

    /** Adds one curated preset model after resolving the vendor's shared API key. */
    private async addPresetModel(vendor: VendorPreset): Promise<MenuExit> {
        const apiKey = await this.resolveVendorApiKey(vendor);
        if (!apiKey) { return 'back'; }
        const picked = await vscode.window.showQuickPick(vendor.models.map(entry => ({
            label: entry.label,
            description: `${entry.model} · ${this.formatContext(entry.contextTokens)}`,
            detail: this.presetDetail(vendor, entry),
            value: entry.model,
        })), { placeHolder: `Select a ${vendor.label} model` });
        if (!picked) { return 'back'; }
        const preset = vendor.models.find(entry => entry.model === picked.value);
        if (!preset) { return 'back'; }
        const model = this.presetModelConfig(vendor, preset);
        await this.persistNewModel(model, apiKey);
        return this.manageConfiguredModel(model);
    }

    /** Native providers keep the live `/models` flow as a fallback to the preset list. */
    private async addBrowsedModel(vendor: VendorPreset): Promise<MenuExit> {
        const apiKey = await this.resolveVendorApiKey(vendor);
        if (!apiKey) { return 'back'; }
        const provider = this.nativeProviderKind(vendor);
        const available = await createAIProvider({ kind: provider, apiKey }).listModels();
        if (!available.length) {
            throw new Error(`${vendor.label} returned no available models.`);
        }
        const modelId = await vscode.window.showQuickPick(available, { placeHolder: `Select a ${vendor.label} model` });
        if (!modelId) { return 'back'; }
        const preset = vendor.models.find(entry => entry.model === modelId);
        if (preset) {
            const model = this.presetModelConfig(vendor, preset);
            await this.persistNewModel(model, apiKey);
            return this.manageConfiguredModel(model);
        }
        const label = await vscode.window.showInputBox({ title: 'Model display name', value: modelId, ignoreFocusOut: true });
        if (!label?.trim()) { return 'back'; }
        const model: AIModelConfig = {
            id: randomUUID(),
            label: label.trim(),
            provider,
            model: modelId,
            vendor: vendor.id,
        };
        await this.persistNewModel(model, apiKey);
        return this.manageConfiguredModel(model);
    }

    /** Manual OpenAI-compatible endpoint; the API key stays per model instance. */
    private async addCustomModel(): Promise<MenuExit> {
        const model = await this.promptCustomModel({ id: randomUUID(), label: '', provider: 'custom', model: '', baseUrl: '' });
        if (!model) { return 'back'; }
        const apiKey = await this.resolveApiKeyForNewModel(model);
        if (!apiKey) { return 'back'; }
        // Persist immediately: OpenAI-compatible /models membership checks reject many valid
        // custom endpoints (missing catalog, alias ids, pagination). Endpoint/model validity
        // surfaces when the model is actually used for generation.
        await this.persistNewModel(model, apiKey);
        return this.manageConfiguredModel(model);
    }

    /** Chat model of a gateway that is not in the curated list, under the same vendor key. */
    private async addManualVendorModel(vendor: VendorPreset): Promise<MenuExit> {
        const endpoints = vendor.endpoints ?? {};
        const transports = (Object.keys(endpoints) as PresetModel['transport'][]);
        if (!transports.length) {
            throw new Error(`${vendor.label} has no configurable endpoint.`);
        }
        const apiKey = await this.resolveVendorApiKey(vendor);
        if (!apiKey) { return 'back'; }
        let transport = transports[0];
        if (transports.length > 1) {
            const picked = await vscode.window.showQuickPick(transports.map(value => ({
                label: PRESET_TRANSPORT_LABELS[value],
                description: endpoints[value],
                value,
            })), { placeHolder: `Select how ${vendor.label} serves this model` });
            if (!picked) { return 'back'; }
            transport = picked.value;
        }
        const modelId = await vscode.window.showInputBox({
            title: 'Model id',
            placeHolder: 'exact id the endpoint expects',
            ignoreFocusOut: true,
            validateInput: value => value.trim() ? undefined : 'A model id is required.',
        });
        if (!modelId?.trim()) { return 'back'; }
        const model: AIModelConfig = {
            id: randomUUID(),
            label: modelId.trim(),
            provider: PRESET_TRANSPORT_PROVIDERS[transport],
            model: modelId.trim(),
            vendor: vendor.id,
            baseUrl: endpoints[transport],
        };
        await this.persistNewModel(model, apiKey);
        return this.manageConfiguredModel(model);
    }

    private async persistNewModel(model: AIModelConfig, apiKey: string): Promise<void> {
        await this.context.globalState.update(AI_MODELS_KEY, [...this.serviceRegistry.getModels(), model]);
        await this.serviceRegistry.reloadProviderServices();
        const service = this.serviceRegistry.getLLMService(model.id);
        if (!service) {
            throw new Error(`AI model service '${model.id}' was not created.`);
        }
        await service.setApiKey(apiKey);
        await this.statusBarManager.refreshModelStates();
    }

    private presetModelConfig(vendor: VendorPreset, preset: PresetModel): AIModelConfig {
        const baseUrl = vendor.endpoints?.[preset.transport];
        return {
            id: randomUUID(),
            label: preset.label,
            provider: PRESET_TRANSPORT_PROVIDERS[preset.transport],
            model: preset.model,
            vendor: vendor.id,
            ...(baseUrl !== undefined ? { baseUrl } : {}),
        };
    }

    private nativeProviderKind(vendor: VendorPreset): Exclude<ProviderKind, 'custom'> {
        const transport = vendor.models[0]?.transport;
        const provider = transport ? PRESET_TRANSPORT_PROVIDERS[transport] : 'custom';
        if (provider === 'custom') {
            throw new Error(`${vendor.label} has no browsable provider model list.`);
        }
        return provider;
    }

    private presetDetail(vendor: VendorPreset, preset: PresetModel): string {
        const endpoint = vendor.endpoints?.[preset.transport]
            ?? PROVIDER_LABELS[PRESET_TRANSPORT_PROVIDERS[preset.transport]];
        const described = describePricingSource(pricingKeyForModel({ vendor: vendor.id, model: preset.model }));
        const pricing = described.source === 'Unpriced' ? 'Unpriced' : this.formatRatesForMenu(described.rates!);
        return `${PRESET_TRANSPORT_LABELS[preset.transport]} · ${endpoint} · ${pricing}`;
    }

    private modelDetail(model: AIModelConfig): string {
        const parts = [model.model];
        const vendor = getVendorPreset(model.vendor);
        if (vendor) {
            parts.push(vendor.label);
        }
        if (model.baseUrl) {
            parts.push(model.baseUrl);
        }
        return parts.join(' · ');
    }

    private formatContext(contextTokens: number): string {
        return `${Math.round(contextTokens / 1000)}K context`;
    }

    private async editModel(current: AIModelConfig): Promise<void> {
        const vendor = getVendorPreset(current.vendor);
        let updated: AIModelConfig | undefined;
        if (vendor) {
            updated = await this.pickVendorModel(vendor, current);
        } else if (current.provider === 'custom') {
            updated = await this.promptCustomModel(current);
        } else {
            updated = await this.promptNativeModel(current.provider, await this.requireStoredApiKey(current));
        }
        if (!updated) { return; }
        // Preserve pricing override and thinking metadata across label/model/endpoint edits.
        const model: AIModelConfig = {
            ...current,
            label: updated.label,
            model: updated.model,
            baseUrl: updated.baseUrl,
            id: current.id,
            provider: current.provider,
            vendor: updated.vendor ?? current.vendor,
        };
        if (model.baseUrl === undefined) {
            delete model.baseUrl;
        }
        await this.updateConfiguredModel(model);
    }

    private async pickVendorModel(vendor: VendorPreset, current: AIModelConfig): Promise<AIModelConfig | undefined> {
        const picked = await vscode.window.showQuickPick(vendor.models.map(entry => ({
            label: entry.label,
            description: entry.model === current.model ? 'Current' : entry.model,
            detail: this.presetDetail(vendor, entry),
            value: entry.model,
        })), { placeHolder: `Select a ${vendor.label} model` });
        if (!picked) { return undefined; }
        const preset = vendor.models.find(entry => entry.model === picked.value);
        if (!preset) { return undefined; }
        return this.presetModelConfig(vendor, preset);
    }

    private async requireStoredApiKey(model: AIModelConfig): Promise<string> {
        const apiKey = await this.context.secrets.get(modelSecretKey(model));
        if (!apiKey) {
            throw new Error(`${model.label} has no API key.`);
        }
        return apiKey;
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

    private async replaceApiKey(model: AIModelConfig): Promise<void> {
        const apiKey = await this.promptApiKey(PROVIDER_LABELS[model.provider]);
        if (!apiKey) { return; }
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
        const sharedKey = model.vendor !== undefined && getVendorPreset(model.vendor) !== undefined;
        const confirmation = await vscode.window.showWarningMessage(
            sharedKey
                ? `Delete model '${model.label}'? The shared ${getVendorPreset(model.vendor)!.label} API key is kept for the other models of this vendor.`
                : `Delete model '${model.label}'?`,
            { modal: true },
            'Delete',
        );
        if (confirmation !== 'Delete') { return; }
        // Delete an instance secret while the model still owns it; vendor keys are shared
        // by every model of that vendor and outlive any single instance.
        // ServiceRegistry.secrets.onDidChange requires an owner in getModels(); reversing
        // the order throws a silent rejection.
        if (model.provider === 'custom' && !sharedKey) {
            await this.context.secrets.delete(customSecretKey(model.id));
        }
        const remaining = this.serviceRegistry.getModels().filter(candidate => candidate.id !== model.id);
        await this.context.globalState.update(AI_MODELS_KEY, remaining);
        await this.serviceRegistry.reloadProviderServices();
        await this.statusBarManager.refreshModelStates();
    }

    private async selectWorkflowModel(purpose: ModelPurpose): Promise<MenuExit> {
        for (;;) {
            const models = this.serviceRegistry.getModels();
            const purposeKey = GENERATION_MODEL_ID_KEY;
            const picked = await vscode.window.showQuickPick([
                this.backItem(),
                ...models.map(model => ({
                    label: model.label,
                    description: this.context.globalState.get<string>(purposeKey, '') === model.id
                        ? `Current · ${PROVIDER_LABELS[model.provider]}`
                        : PROVIDER_LABELS[model.provider],
                    detail: this.modelDetail(model),
                    value: model.id,
                })),
            ], { placeHolder: 'Select commit message model' });
            if (!picked || picked.value === BACK_VALUE) { return 'back'; }
            const exit = await this.manageConfiguredModel(this.requireModel(picked.value));
            if (exit === 'back') { continue; }
            return 'done';
        }
    }

    private async assignModel(purpose: ModelPurpose, modelId: string): Promise<void> {
        this.requireModel(modelId);
        const key = GENERATION_MODEL_ID_KEY;
        await this.context.globalState.update(key, modelId);
        if (purpose === 'generation') {
            this.serviceRegistry.updateCurrentLLMService();
        }
        await this.statusBarManager.refreshModelStates();
    }

    private async configureThinkingLevel(model: AIModelConfig): Promise<MenuExit> {
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
            this.backItem(),
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
        if (!picked || picked.value === BACK_VALUE) { return 'back'; }

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
            if (nativeValue === undefined) { return 'back'; }
            modelLevels[modelKey] = nativeValue.trim();
        } else {
            modelLevels[modelKey] = picked.value;
        }
        await configuration.update(
            'modelThinkingLevels',
            modelLevels,
            vscode.ConfigurationTarget.Global,
        );
        return 'done';
    }

    private async configureCustomThinkingCompatibility(model: AIModelConfig): Promise<MenuExit> {
        if (model.provider !== 'custom') {
            throw new Error('Thinking compatibility profiles are only available for custom OpenAI-compatible models.');
        }

        const currentFormat = getModelThinkingMetadata(model).thinkingFormat ?? 'openai';
        const formatChoice = await vscode.window.showQuickPick(
            [
                this.backItem(),
                ...THINKING_FORMAT_OPTIONS.map(option => ({
                    ...option,
                    description: option.value === currentFormat
                        ? `${option.description} · Current`
                        : option.description,
                })),
            ],
            { placeHolder: 'Advanced: select the endpoint thinking request profile' },
        );
        if (!formatChoice || formatChoice.value === BACK_VALUE) { return 'back'; }
        const selectedFormat = formatChoice as (typeof THINKING_FORMAT_OPTIONS)[number];

        const budgetChoice = await vscode.window.showQuickPick(
            [
                this.backItem(),
                ...THINKING_BUDGET_OPTIONS.map(option => ({
                    ...option,
                    description: option.value === model.thinkingTokenBudgetField
                        ? `${option.description} · Current`
                        : option.description,
                })),
            ],
            { placeHolder: 'Advanced: select an optional local-engine budget field' },
        );
        if (!budgetChoice || budgetChoice.value === BACK_VALUE) { return 'back'; }
        const selectedBudget = budgetChoice as (typeof THINKING_BUDGET_OPTIONS)[number];

        const chatTemplateKwargs = selectedFormat.value === 'chat-template'
            ? await this.promptChatTemplateValues(
                'chat_template_kwargs JSON',
                model.chatTemplateKwargs,
                '{\n  "enable_thinking": { "$var": "thinking.enabled" },\n  "thinking_budget": { "$var": "thinking.budget", "omitWhenOff": true }\n}',
            )
            : undefined;
        if (chatTemplateKwargs === null) { return 'back'; }
        const chatTemplateArgs = selectedFormat.value === 'baseten'
            ? await this.promptChatTemplateValues(
                'chat_template_args JSON',
                model.chatTemplateArgs,
                '{\n  "enable_thinking": { "$var": "thinking.enabled" },\n  "thinking_budget": { "$var": "thinking.budget", "omitWhenOff": true }\n}',
            )
            : undefined;
        if (chatTemplateArgs === null) { return 'back'; }

        const updated: AIModelConfig = { ...model };
        delete updated.thinkingFormat;
        delete updated.thinkingTokenBudgetField;
        delete updated.chatTemplateKwargs;
        delete updated.chatTemplateArgs;
        if (selectedFormat.value !== 'openai') {
            updated.thinkingFormat = selectedFormat.value;
        }
        if (selectedBudget.value !== undefined) {
            updated.thinkingTokenBudgetField = selectedBudget.value;
        }
        if (chatTemplateKwargs !== undefined) {
            updated.chatTemplateKwargs = chatTemplateKwargs;
        }
        if (chatTemplateArgs !== undefined) {
            updated.chatTemplateArgs = chatTemplateArgs;
        }
        await this.updateConfiguredModel(updated);
        return 'done';
    }

    private async resolveApiKeyForNewModel(model: AIModelConfig): Promise<string | undefined> {
        const existing = await this.context.secrets.get(modelSecretKey(model));
        return existing ?? this.promptApiKey(PROVIDER_LABELS[model.provider]);
    }

    /**
     * One key per vendor, reused by every model the user adds from that vendor.
     * Native vendors keep their historical provider-wide secret slot.
     */
    private async resolveVendorApiKey(vendor: VendorPreset): Promise<string | undefined> {
        const secretKey = vendorSecretKey(vendor.id);
        return await this.context.secrets.get(secretKey)
            ?? this.promptApiKey(vendor.label);
    }

    private async promptCustomModel(initial: AIModelConfig): Promise<AIModelConfig | undefined> {
        const label = await vscode.window.showInputBox({ title: 'Custom model name', value: initial.label, ignoreFocusOut: true });
        if (!label?.trim()) { return undefined; }
        const baseUrl = await vscode.window.showInputBox({
            title: 'OpenAI-compatible base URL',
            value: initial.baseUrl,
            ignoreFocusOut: true,
            validateInput: value => {
                if (!value.trim()) {
                    return 'Base URL is required.';
                }
                try {
                    const parsed = new URL(value.trim());
                    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                        return 'Custom model base URL must use HTTP or HTTPS.';
                    }
                    return undefined;
                } catch {
                    return 'Enter a valid HTTP or HTTPS URL.';
                }
            },
        });
        if (!baseUrl?.trim()) { return undefined; }
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

    private pricingDescription(model: AIModelConfig): string {
        const described = describePricingSource(pricingKeyForModel(model), model.pricingOverride);
        if (described.source === 'Unpriced') {
            return 'Unpriced';
        }
        const ratesLabel = this.formatRatesForMenu(described.rates!);
        return `${described.source} · ${ratesLabel}`;
    }

    private formatRatesForMenu(rates: ModelPricing): string {
        if (isTieredPricing(rates)) {
            const first = rates.tiers[0];
            return `tiered in $${first.input}/out $${first.output}/cache $${first.cached} (per 1M)`;
        }
        const flat = rates as FlatPricing;
        return `in $${flat.input}/out $${flat.output}/cache $${flat.cached} (per 1M)`;
    }

    private async manageModelPricing(initial: AIModelConfig): Promise<MenuExit> {
        let model = initial;
        for (;;) {
            const described = describePricingSource(pricingKeyForModel(model), model.pricingOverride);
            const detail = described.source === 'Unpriced'
                ? 'No built-in or custom price configured'
                : this.formatRatesForMenu(described.rates!);
            const picked = await vscode.window.showQuickPick([
                this.backItem(),
                {
                    label: `Current: ${described.source}`,
                    description: detail,
                    value: '__info__',
                },
                { label: 'Set custom pricing', description: 'USD per 1M tokens · input / output / cached input', value: 'set' },
                {
                    label: 'Use built-in pricing',
                    description: described.source === 'Custom'
                        ? 'Remove override and fall back to the built-in table'
                        : 'Already using built-in or unpriced',
                    value: 'builtin',
                },
            ], { placeHolder: `${model.label} pricing` });
            if (!picked || picked.value === BACK_VALUE) { return 'back'; }
            if (picked.value === '__info__') { continue; }
            if (picked.value === 'set') {
                const pricing = await this.promptCustomPricing(model.pricingOverride);
                if (!pricing) { continue; }
                await this.updateConfiguredModel({ ...model, pricingOverride: pricing });
                model = this.requireModel(model.id);
                vscode.window.showInformationMessage(`Custom pricing saved for ${model.label}.`);
                continue;
            }
            if (picked.value === 'builtin') {
                if (!model.pricingOverride) {
                    continue;
                }
                const { pricingOverride: _removed, ...rest } = model;
                await this.updateConfiguredModel(rest);
                model = this.requireModel(model.id);
                const after = describePricingSource(pricingKeyForModel(model), model.pricingOverride);
                vscode.window.showInformationMessage(
                    after.source === 'Unpriced'
                        ? `${model.label} has no built-in price (Unpriced).`
                        : `${model.label} restored to built-in pricing.`,
                );
                continue;
            }
        }
    }

    /**
     * Prompt for input / output / cached-input rates.
     * Cancelling any step leaves the existing override unchanged.
     */
    private async promptCustomPricing(current?: FlatModelPricing): Promise<FlatModelPricing | undefined> {
        const input = await vscode.window.showInputBox({
            title: 'Input price (USD per 1M tokens)',
            value: current ? String(current.input) : '',
            prompt: 'All three rates are required. Use 0 for free. Without a cache discount, set cached input equal to input.',
            ignoreFocusOut: true,
            validateInput: value => {
                try {
                    parseFlatModelPricingInput(value, '0', '0');
                    return undefined;
                } catch (error) {
                    return String((error as Error).message);
                }
            },
        });
        if (input === undefined) { return undefined; }

        const output = await vscode.window.showInputBox({
            title: 'Output price (USD per 1M tokens)',
            value: current ? String(current.output) : '',
            ignoreFocusOut: true,
            validateInput: value => {
                try {
                    parseFlatModelPricingInput(input, value, '0');
                    return undefined;
                } catch (error) {
                    return String((error as Error).message);
                }
            },
        });
        if (output === undefined) { return undefined; }

        const cachedInput = await vscode.window.showInputBox({
            title: 'Cached input price (USD per 1M tokens)',
            value: current ? String(current.cachedInput) : '',
            prompt: 'If the provider has no cache discount, enter the same value as input.',
            ignoreFocusOut: true,
            validateInput: value => {
                try {
                    parseFlatModelPricingInput(input, output, value);
                    return undefined;
                } catch (error) {
                    return String((error as Error).message);
                }
            },
        });
        if (cachedInput === undefined) { return undefined; }

        return parseFlatModelPricingInput(input, output, cachedInput);
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

    private backItem(): vscode.QuickPickItem & { value: string } {
        return { label: '$(chevron-left) Back', value: BACK_VALUE };
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
