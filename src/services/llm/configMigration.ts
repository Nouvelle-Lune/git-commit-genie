import * as vscode from 'vscode';
import {
    AI_CONFIG_VERSION,
    AI_CONFIG_VERSION_KEY,
    AI_MODELS_KEY,
    GENERATION_MODEL_ID_KEY,
    AIModelConfig,
    NATIVE_SECRET_KEYS,
    ProviderKind,
    customSecretKey,
} from './providers';

interface RemovedCustomModelConfig {
    id: string;
    label: string;
    baseUrl: string;
    model: string;
}

interface RemovedProviderConfig {
    provider: string;
    label: string;
    modelKey: string;
    secretKeys: string[];
    baseUrl: (context: vscode.ExtensionContext) => string;
}

const REMOVED_ACTIVE_PROVIDER_KEY = 'gitCommitGenie.ai.provider';
const REMOVED_ACTIVE_CUSTOM_MODEL_KEY = 'gitCommitGenie.ai.activeCustomModel';
const REMOVED_CUSTOM_MODELS_KEY = 'gitCommitGenie.ai.customModels';
const REMOVED_NATIVE_MODEL_KEYS = {
    openai: 'gitCommitGenie.ai.openaiModel',
    anthropic: 'gitCommitGenie.ai.anthropicModel',
    google: 'gitCommitGenie.ai.googleModel',
} as const;

const LEGACY_NATIVE = {
    openai: { modelKey: 'gitCommitGenie.openaiModel', secretKey: 'gitCommitGenie.secret.openaiApiKey' },
    anthropic: { modelKey: 'gitCommitGenie.anthropicModel', secretKey: 'gitCommitGenie.secret.anthropicApiKey' },
    google: { modelKey: 'gitCommitGenie.geminiModel', secretKey: 'gitCommitGenie.secret.geminiApiKey' },
} as const;

const LEGACY_CUSTOM: readonly RemovedProviderConfig[] = [
    { provider: 'deepseek', label: 'DeepSeek', modelKey: 'gitCommitGenie.deepseekModel', secretKeys: ['gitCommitGenie.secret.deepseekApiKey'], baseUrl: () => 'https://api.deepseek.com' },
    { provider: 'qwen-intl', label: 'Qwen International', modelKey: 'gitCommitGenie.qwenModel', secretKeys: ['gitCommitGenie.secret.qwenApiKeyIntl', 'gitCommitGenie.secret.qwenApiKey'], baseUrl: () => 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
    { provider: 'qwen-china', label: 'Qwen China', modelKey: 'gitCommitGenie.qwenModel', secretKeys: ['gitCommitGenie.secret.qwenApiKeyChina'], baseUrl: () => 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    { provider: 'glm', label: 'GLM', modelKey: 'gitCommitGenie.glmModel', secretKeys: ['gitCommitGenie.secret.glmApiKey'], baseUrl: () => 'https://open.bigmodel.cn/api/paas/v4' },
    { provider: 'kimi', label: 'Kimi', modelKey: 'gitCommitGenie.kimiModel', secretKeys: ['gitCommitGenie.secret.kimiApiKey'], baseUrl: () => 'https://api.moonshot.cn/v1' },
    { provider: 'openrouter', label: 'OpenRouter', modelKey: 'gitCommitGenie.openrouterModel', secretKeys: ['gitCommitGenie.secret.openrouterApiKey'], baseUrl: () => 'https://openrouter.ai/api/v1' },
    {
        provider: 'local', label: 'Local', modelKey: 'gitCommitGenie.localModel', secretKeys: ['gitCommitGenie.secret.localApiKey'],
        baseUrl: () => {
            const value = vscode.workspace.getConfiguration('gitCommitGenie').get<string>(
                'local.baseUrl',
                'http://127.0.0.1:11434/v1',
            );
            if (!value?.trim()) {
                throw new Error('Cannot migrate Local provider because gitCommitGenie.local.baseUrl is empty.');
            }
            return value.trim();
        },
    },
];

/**
 * Converts removed configuration layouts into the model-instance registry.
 * Runtime code reads only the v2 keys after this transaction completes.
 */
export async function migrateAIConfiguration(context: vscode.ExtensionContext): Promise<void> {
    const currentVersion = context.globalState.get<number>(AI_CONFIG_VERSION_KEY, 0);
    if (currentVersion === AI_CONFIG_VERSION) {
        return;
    }
    if (currentVersion !== 0 && currentVersion !== 1) {
        throw new Error(`Unsupported AI configuration version '${currentVersion}'.`);
    }

    const migration = currentVersion === 1
        ? await readRemovedV1Configuration(context)
        : await readLegacyConfiguration(context);
    await context.globalState.update(AI_MODELS_KEY, migration.models);
    await context.globalState.update(GENERATION_MODEL_ID_KEY, migration.generationModelId);
    await context.globalState.update(AI_CONFIG_VERSION_KEY, AI_CONFIG_VERSION);

    for (const key of removedStateKeys()) {
        await context.globalState.update(key, undefined);
    }
    for (const key of removedSecretKeys()) {
        await context.secrets.delete(key);
    }
}

async function readRemovedV1Configuration(
    context: vscode.ExtensionContext,
): Promise<{ models: AIModelConfig[]; generationModelId: string }> {
    const models: AIModelConfig[] = [];
    for (const provider of ['openai', 'anthropic', 'google'] as const) {
        const model = context.globalState.get<string>(REMOVED_NATIVE_MODEL_KEYS[provider], '').trim();
        if (model) {
            models.push({ id: `migrated-${provider}`, label: model, provider, model });
        }
    }
    for (const model of context.globalState.get<RemovedCustomModelConfig[]>(REMOVED_CUSTOM_MODELS_KEY, [])) {
        models.push({ ...model, provider: 'custom' });
    }

    const activeProvider = context.globalState.get<string>(REMOVED_ACTIVE_PROVIDER_KEY, '').trim();
    const generationModelId = activeProvider === 'custom'
        ? context.globalState.get<string>(REMOVED_ACTIVE_CUSTOM_MODEL_KEY, '')
        : models.find(model => model.provider === activeProvider)?.id ?? '';
    return { models, generationModelId };
}

async function readLegacyConfiguration(
    context: vscode.ExtensionContext,
): Promise<{ models: AIModelConfig[]; generationModelId: string }> {
    const models: AIModelConfig[] = [];
    for (const [provider, legacy] of Object.entries(LEGACY_NATIVE) as Array<[
        Exclude<ProviderKind, 'custom'>,
        typeof LEGACY_NATIVE[keyof typeof LEGACY_NATIVE],
    ]>) {
        const model = context.globalState.get<string>(legacy.modelKey, '').trim();
        const apiKey = await context.secrets.get(legacy.secretKey);
        if (model) {
            models.push({ id: `migrated-${provider}`, label: model, provider, model });
        }
        if (apiKey) {
            await context.secrets.store(NATIVE_SECRET_KEYS[provider], apiKey);
        }
    }

    for (const legacy of LEGACY_CUSTOM) {
        const model = context.globalState.get<string>(legacy.modelKey, '').trim();
        let apiKey: string | undefined;
        for (const secretKey of legacy.secretKeys) {
            apiKey = await context.secrets.get(secretKey);
            if (apiKey) { break; }
        }
        if (legacy.provider.startsWith('qwen-') && !apiKey) { continue; }
        if (!model && !apiKey) { continue; }
        if (!model) {
            throw new Error(`Cannot migrate ${legacy.label}: an API key exists but no model is selected.`);
        }
        const id = `migrated-${legacy.provider}`;
        models.push({ id, label: legacy.label, provider: 'custom', baseUrl: legacy.baseUrl(context), model });
        if (apiKey) {
            await context.secrets.store(customSecretKey(id), apiKey);
        }
    }

    const oldProvider = context.globalState.get<string>('gitCommitGenie.provider', 'openai').toLowerCase();
    const nativeProvider = oldProvider === 'gemini' ? 'google'
        : oldProvider === 'openai' || oldProvider === 'anthropic' ? oldProvider : undefined;
    if (nativeProvider) {
        return { models, generationModelId: models.find(model => model.provider === nativeProvider)?.id ?? '' };
    }
    const region = context.globalState.get<string>('gitCommitGenie.qwenRegion', 'intl');
    const customProvider = oldProvider === 'qwen' ? `qwen-${region}` : oldProvider;
    const customId = `migrated-${customProvider}`;
    if (models.some(model => model.id === customId)) {
        return { models, generationModelId: customId };
    }
    if (oldProvider === 'qwen') {
        const configuredRegions = models.filter(model => model.id.startsWith('migrated-qwen-'));
        if (configuredRegions.length === 1) {
            return { models, generationModelId: configuredRegions[0].id };
        }
    }
    return { models, generationModelId: '' };
}

function removedStateKeys(): Set<string> {
    return new Set([
        REMOVED_ACTIVE_PROVIDER_KEY,
        REMOVED_ACTIVE_CUSTOM_MODEL_KEY,
        REMOVED_CUSTOM_MODELS_KEY,
        ...Object.values(REMOVED_NATIVE_MODEL_KEYS),
        'gitCommitGenie.provider',
        'gitCommitGenie.qwenRegion',
        'gitCommitGenie.localModelsCache',
        ...Object.values(LEGACY_NATIVE).map(value => value.modelKey),
        ...LEGACY_CUSTOM.map(value => value.modelKey),
    ]);
}

function removedSecretKeys(): Set<string> {
    return new Set([
        ...Object.values(LEGACY_NATIVE).map(value => value.secretKey),
        ...LEGACY_CUSTOM.flatMap(value => value.secretKeys),
    ]);
}
