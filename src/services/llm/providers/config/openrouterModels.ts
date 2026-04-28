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
    'openai/gpt-5.4': 'gpt-5.4',
    'openai/gpt-5.4-mini': 'gpt-5.4-mini',
    'openai/gpt-5.4-nano': 'gpt-5.4-nano',
    'openai/gpt-5': 'gpt-5',
    'openai/gpt-5.2': 'gpt-5.2',
    'openai/gpt-5-mini': 'gpt-5-mini',
    'openai/gpt-5-nano': 'gpt-5-nano',

    // DeepSeek family
    'deepseek/deepseek-chat': 'deepseek-chat',
    'deepseek/deepseek-r1': 'deepseek-reasoner',

    // Anthropic family
    'anthropic/claude-3.5-haiku': 'claude-3-5-haiku',
    'anthropic/claude-3.5-sonnet': 'claude-3-5-sonnet',
    'anthropic/claude-3.7-sonnet': 'claude-3-7-sonnet',
    'anthropic/claude-sonnet-4': 'claude-sonnet-4',
    'anthropic/claude-opus-4': 'claude-opus-4',
    'anthropic/claude-opus-4.1': 'claude-opus-4-1',
    'anthropic/claude-haiku-4.5': 'claude-haiku-4-5',
    'anthropic/claude-sonnet-4.5': 'claude-sonnet-4-5',
    'anthropic/claude-opus-4.5': 'claude-opus-4-5',

    // Gemini family
    'google/gemini-2.5-flash': 'gemini-2.5-flash',
    'google/gemini-2.5-pro': 'gemini-2.5-pro',
    'google/gemini-3-flash-preview': 'gemini-3-flash-preview',
    'google/gemini-3-pro-preview': 'gemini-3-pro-preview',

    // Qwen family
    'qwen/qwen3-max': 'qwen3-max',
    'qwen/qwen3-235b-a22b': 'qwen3.5-plus',
    'qwen/qwen3.5-flash': 'qwen3.5-flash',
    'qwen/qwen-plus': 'qwen-plus',
    'qwen/qwen3-coder-plus': 'qwen3-coder-plus',
    'qwen/qwen-turbo': 'qwen-flash',
    'qwen/qwen3-coder-30b-a3b-instruct': 'qwen3-coder-flash',

    // GLM family
    'z-ai/glm-5': 'glm-5',
    'z-ai/glm-5-turbo': 'glm-5-turbo',
    'z-ai/glm-4.7': 'glm-4.7',
    'z-ai/glm-4.7-flashx': 'glm-4.7-flashx',
    'z-ai/glm-4.7-flash': 'glm-4.7-flash',
    'z-ai/glm-4.5': 'glm-4.5',
    'z-ai/glm-4.5-air': 'glm-4.5-air',

    // Kimi family
    'moonshotai/kimi-k2.5': 'kimi-k2.5',
    'moonshotai/kimi-k2': 'kimi-k2',
    'moonshotai/kimi-k2-thinking': 'kimi-k2-thinking'
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
