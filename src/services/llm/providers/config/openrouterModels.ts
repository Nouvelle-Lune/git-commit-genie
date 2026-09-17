/**
 * OpenRouter model mapping registry.
 *
 * Key: OpenRouter request model id
 * Value: Canonical model alias used by existing pricing table and analytics.
 *
 * This file is the single source of truth for:
 * - OpenRouter model picker options
 * - OpenRouter -> canonical pricing normalization
 * - Repo-analysis provider/model resolution consistency
 */
export const OPENROUTER_MODEL_ALIAS_MAP: Readonly<Record<string, string>> = Object.freeze({
    // OpenAI family
    'openai/gpt-5.6-sol': 'gpt-5.6-sol',
    'openai/gpt-5.6-terra': 'gpt-5.6-terra',
    'openai/gpt-5.6-luna': 'gpt-5.6-luna',
    'openai/gpt-5.5': 'gpt-5.5',
    'openai/gpt-5.4': 'gpt-5.4',
    'openai/gpt-5.4-mini': 'gpt-5.4-mini',
    'openai/gpt-5.4-nano': 'gpt-5.4-nano',
    'openai/gpt-5': 'gpt-5',
    'openai/gpt-5.2': 'gpt-5.2',
    'openai/gpt-5-mini': 'gpt-5-mini',
    'openai/gpt-5-nano': 'gpt-5-nano',

    // DeepSeek family
    'deepseek/deepseek-v4-flash': 'deepseek-v4-flash',
    'deepseek/deepseek-v4-pro': 'deepseek-v4-pro',

    // Anthropic family
    'anthropic/claude-fable-5': 'claude-fable-5',
    'anthropic/claude-opus-5': 'claude-opus-5',
    'anthropic/claude-sonnet-5': 'claude-sonnet-5',
    'anthropic/claude-opus-4.8': 'claude-opus-4-8',
    'anthropic/claude-opus-4.7': 'claude-opus-4-7',
    'anthropic/claude-sonnet-4.6': 'claude-sonnet-4-6',
    'anthropic/claude-opus-4.6': 'claude-opus-4-6',
    'anthropic/claude-haiku-4.5': 'claude-haiku-4-5',
    'anthropic/claude-sonnet-4.5': 'claude-sonnet-4-5',
    'anthropic/claude-opus-4.5': 'claude-opus-4-5',

    // Gemini family
    'google/gemini-3.6-flash': 'gemini-3.6-flash',
    'google/gemini-3.5-flash': 'gemini-3.5-flash',
    'google/gemini-3.1-pro-preview': 'gemini-3.1-pro-preview',
    'google/gemini-2.5-flash': 'gemini-2.5-flash',
    'google/gemini-2.5-pro': 'gemini-2.5-pro',
    'google/gemini-3-flash-preview': 'gemini-3-flash-preview',

    // Qwen family
    'qwen/qwen3.7-max': 'qwen3.7-max',
    'qwen/qwen3.7-plus': 'qwen3.7-plus',
    'qwen/qwen3.7-flash': 'qwen3.7-flash',
    'qwen/qwen3.6-flash': 'qwen3.6-flash',
    'qwen/qwen3.5-plus-20260420': 'qwen3.5-plus',
    'qwen/qwen3.5-flash-02-23': 'qwen3.5-flash',
    'qwen/qwen-plus': 'qwen-plus',

    // GLM family
    'z-ai/glm-5.2': 'glm-5.2',
    'z-ai/glm-5.1': 'glm-5.1',
    'z-ai/glm-5': 'glm-5',
    'z-ai/glm-5-turbo': 'glm-5-turbo',
    'z-ai/glm-4.7': 'glm-4.7',
    'z-ai/glm-4.7-flash': 'glm-4.7-flash',
    'z-ai/glm-4.5-air': 'glm-4.5-air',

    // Kimi family
    'moonshotai/kimi-k3': 'kimi-k3',
    'moonshotai/kimi-k2.7-code': 'kimi-k2.7-code',
    'moonshotai/kimi-k2.6': 'kimi-k2.6'
});

/**
 * Resolve OpenRouter request model id to canonical pricing alias.
 * Falls back to original model when there is no mapping.
 */
export function normalizeOpenRouterPricingAlias(model: string): string {
    return OPENROUTER_MODEL_ALIAS_MAP[model] || model;
}

/**
 * Return all curated OpenRouter request model ids.
 */
export function getOpenRouterModelIds(): string[] {
    return Object.keys(OPENROUTER_MODEL_ALIAS_MAP);
}

/**
 * Return all mappings in [requestModelId, canonicalAlias] tuple form.
 */
export function getOpenRouterModelMappings(): Array<{ requestModelId: string; canonicalAlias: string }> {
    return Object.entries(OPENROUTER_MODEL_ALIAS_MAP).map(([requestModelId, canonicalAlias]) => ({
        requestModelId,
        canonicalAlias
    }));
}
