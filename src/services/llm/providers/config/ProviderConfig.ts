/**
 * Centralized provider configuration
 * Single source of truth for all provider-related metadata
 */

export type ProviderKey = 'openai' | 'deepseek' | 'anthropic' | 'gemini' | 'qwen';

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
        modelStateKey: 'gitCommitGenie.openaiModel'
    },
    deepseek: {
        key: 'deepseek',
        label: 'DeepSeek',
        secretKey: 'gitCommitGenie.secret.deepseekApiKey',
        modelStateKey: 'gitCommitGenie.deepseekModel'
    },
    anthropic: {
        key: 'anthropic',
        label: 'Anthropic',
        secretKey: 'gitCommitGenie.secret.anthropicApiKey',
        modelStateKey: 'gitCommitGenie.anthropicModel'
    },
    gemini: {
        key: 'gemini',
        label: 'Gemini',
        secretKey: 'gitCommitGenie.secret.geminiApiKey',
        modelStateKey: 'gitCommitGenie.geminiModel'
    },
    qwen: {
        key: 'qwen',
        label: 'Qwen',
        secretKey: 'gitCommitGenie.secret.qwenApiKey', // Default key (fallback)
        modelStateKey: 'gitCommitGenie.qwenModel',
        hasRegionalVariants: true
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
