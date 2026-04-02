/**
 * Centralized provider configuration
 * Single source of truth for all provider-related metadata
 */

export type ProviderApiStyle = 'openai-responses' | 'openai-chat' | 'anthropic' | 'gemini';

export type ProviderKey =
    | 'openai'
    | 'deepseek'
    | 'anthropic'
    | 'gemini'
    | 'qwen'
    | 'glm'
    | 'kimi'
    | 'openrouter';

export interface ProviderMetadata {
    /** Provider key (internal identifier) */
    key: ProviderKey;
    /** Display label for UI */
    label: string;
    /** Secret storage key for API key */
    secretKey: string;
    /** Global state key for model selection */
    modelStateKey: string;
    /** Whether this provider has regional variants */
    hasRegionalVariants?: boolean;
    /** API protocol family used by provider */
    apiStyle: ProviderApiStyle;
    /** Optional base URL used by OpenAI-compatible SDK clients */
    baseUrl?: string;
}

/**
 * Qwen regional configuration
 */
export interface QwenRegionConfig {
    /** Region identifier */
    region: 'intl' | 'china';
    /** Display label */
    label: string;
    /** Secret storage key for this region */
    secretKey: string;
}

export const QWEN_REGIONS: Record<string, QwenRegionConfig> = {
    intl: {
        region: 'intl',
        label: 'International',
        secretKey: 'gitCommitGenie.secret.qwenApiKeyIntl'
    },
    china: {
        region: 'china',
        label: 'China',
        secretKey: 'gitCommitGenie.secret.qwenApiKeyChina'
    }
};

/**
 * Provider configuration registry
 * Add new providers here to automatically support them throughout the extension
 */
export const PROVIDER_CONFIGS: Record<ProviderKey, ProviderMetadata> = {
    openai: {
        key: 'openai',
        label: 'OpenAI',
        secretKey: 'gitCommitGenie.secret.openaiApiKey',
        modelStateKey: 'gitCommitGenie.openaiModel',
        apiStyle: 'openai-responses'
    },
    deepseek: {
        key: 'deepseek',
        label: 'DeepSeek',
        secretKey: 'gitCommitGenie.secret.deepseekApiKey',
        modelStateKey: 'gitCommitGenie.deepseekModel',
        apiStyle: 'openai-chat',
        baseUrl: 'https://api.deepseek.com'
    },
    anthropic: {
        key: 'anthropic',
        label: 'Anthropic',
        secretKey: 'gitCommitGenie.secret.anthropicApiKey',
        modelStateKey: 'gitCommitGenie.anthropicModel',
        apiStyle: 'anthropic'
    },
    gemini: {
        key: 'gemini',
        label: 'Gemini',
        secretKey: 'gitCommitGenie.secret.geminiApiKey',
        modelStateKey: 'gitCommitGenie.geminiModel',
        apiStyle: 'gemini'
    },
    qwen: {
        key: 'qwen',
        label: 'Qwen',
        secretKey: 'gitCommitGenie.secret.qwenApiKey', // Default key (fallback)
        modelStateKey: 'gitCommitGenie.qwenModel',
        hasRegionalVariants: true,
        apiStyle: 'openai-chat'
    },
    glm: {
        key: 'glm',
        label: 'GLM',
        secretKey: 'gitCommitGenie.secret.glmApiKey',
        modelStateKey: 'gitCommitGenie.glmModel',
        apiStyle: 'openai-chat',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        hasRegionalVariants: true
    },
    kimi: {
        key: 'kimi',
        label: 'Kimi',
        secretKey: 'gitCommitGenie.secret.kimiApiKey',
        modelStateKey: 'gitCommitGenie.kimiModel',
        apiStyle: 'openai-chat',
        baseUrl: 'https://api.moonshot.ai/v1',
        hasRegionalVariants: true
    },
    openrouter: {
        key: 'openrouter',
        label: 'OpenRouter',
        secretKey: 'gitCommitGenie.secret.openrouterApiKey',
        modelStateKey: 'gitCommitGenie.openrouterModel',
        apiStyle: 'openai-chat',
        baseUrl: 'https://openrouter.ai/api/v1'
    }
};

/**
 * Get provider metadata by key
 */
export function getProviderConfig(provider: string): ProviderMetadata {
    const normalized = provider.toLowerCase() as ProviderKey;
    return PROVIDER_CONFIGS[normalized] || PROVIDER_CONFIGS.openai;
}

/**
 * Get all supported provider keys
 */
export function getAllProviderKeys(): ProviderKey[] {
    return Object.keys(PROVIDER_CONFIGS) as ProviderKey[];
}

/**
 * Get provider label for display
 */
export function getProviderLabel(provider: string): string {
    return getProviderConfig(provider).label;
}

/**
 * Get secret key for provider
 * For Qwen, returns the region-specific key if region is provided
 */
export function getProviderSecretKey(provider: string, region?: string): string {
    if (provider === 'qwen' && region) {
        return QWEN_REGIONS[region]?.secretKey || PROVIDER_CONFIGS.qwen.secretKey;
    }
    return getProviderConfig(provider).secretKey;
}

/**
 * Get model state key for provider
 */
export function getProviderModelStateKey(provider: string): string {
    return getProviderConfig(provider).modelStateKey;
}

/**
 * Get provider API style family
 */
export function getProviderApiStyle(provider: string): ProviderApiStyle {
    return getProviderConfig(provider).apiStyle;
}

/**
 * Get provider base URL for OpenAI-compatible SDK clients
 */
export function getProviderBaseUrl(provider: string): string | undefined {
    return getProviderConfig(provider).baseUrl;
}

/**
 * Whether provider should use OpenAI-compatible chat/completions style
 */
export function isOpenAIChatProvider(provider: string): boolean {
    return getProviderApiStyle(provider) === 'openai-chat';
}

/**
 * Whether provider should use OpenAI Responses API style
 */
export function isOpenAIResponsesProvider(provider: string): boolean {
    return getProviderApiStyle(provider) === 'openai-responses';
}

/**
 * Check if provider is supported
 */
export function isProviderSupported(provider: string): boolean {
    return provider.toLowerCase() in PROVIDER_CONFIGS;
}

/**
 * Check if provider has regional variants
 */
export function hasRegionalVariants(provider: string): boolean {
    return getProviderConfig(provider).hasRegionalVariants || false;
}

/**
 * Get Qwen region configuration
 */
export function getQwenRegionConfig(region: string): QwenRegionConfig | null {
    return QWEN_REGIONS[region] || null;
}

/**
 * Resolve provider from secret key
 * Handles both standard keys and Qwen regional keys
 */
export function getProviderFromSecretKey(secretKey: string): string | null {
    // Check Qwen regional keys first
    for (const regionConfig of Object.values(QWEN_REGIONS)) {
        if (secretKey === regionConfig.secretKey) {
            return 'qwen';
        }
    }

    // Check standard provider keys
    for (const config of Object.values(PROVIDER_CONFIGS)) {
        if (secretKey === config.secretKey) {
            return config.key;
        }
    }

    return null;
}
