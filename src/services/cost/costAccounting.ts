import { PRICING_TABLE, ModelPricing, FlatPricing, isTieredPricing } from './pricing';
import {
    FlatModelPricing,
    NormalizedTokenUsage,
    ResolvedModelPricing,
} from './costTypes';
import type { AIUsage, ProviderKind } from '../llm/providers/types';

/**
 * Validates a user-supplied flat pricing override.
 * All three rates must be finite non-negative numbers; three zeros means explicitly free.
 */
export function assertValidFlatModelPricing(value: unknown): asserts value is FlatModelPricing {
    if (!value || typeof value !== 'object') {
        throw new Error('Pricing override must be an object.');
    }
    const candidate = value as Record<string, unknown>;
    if (candidate.unit !== 'USD_PER_1M_TOKENS') {
        throw new Error('Pricing unit must be USD_PER_1M_TOKENS.');
    }
    for (const field of ['input', 'output', 'cachedInput'] as const) {
        const rate = candidate[field];
        if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) {
            throw new Error(`Pricing ${field} must be a finite non-negative number.`);
        }
    }
}

export function parseFlatModelPricingInput(
    inputText: string,
    outputText: string,
    cachedInputText: string,
): FlatModelPricing {
    const parseRate = (label: string, text: string): number => {
        const trimmed = text.trim();
        if (!trimmed) {
            throw new Error(`${label} price is required.`);
        }
        const value = Number(trimmed);
        if (!Number.isFinite(value) || value < 0) {
            throw new Error(`${label} price must be a finite non-negative number.`);
        }
        return value;
    };
    const pricing: FlatModelPricing = {
        unit: 'USD_PER_1M_TOKENS',
        input: parseRate('Input', inputText),
        output: parseRate('Output', outputText),
        cachedInput: parseRate('Cached input', cachedInputText),
    };
    assertValidFlatModelPricing(pricing);
    return pricing;
}

/** Convert override shape (cachedInput) to built-in flat shape (cached). */
export function flatOverrideToRates(override: FlatModelPricing): FlatPricing {
    assertValidFlatModelPricing(override);
    return {
        input: override.input,
        output: override.output,
        cached: override.cachedInput,
    };
}

/**
 * Resolve rates for a model instance.
 * Order is fixed: pricingOverride → exact PRICING_TABLE[model] → unpriced.
 * No aliases, fuzzy matching, or default zero price.
 */
export function resolveModelPricing(
    modelName: string,
    pricingOverride?: FlatModelPricing,
): ResolvedModelPricing {
    if (pricingOverride !== undefined) {
        assertValidFlatModelPricing(pricingOverride);
        return {
            status: 'priced',
            source: 'override',
            rates: flatOverrideToRates(pricingOverride),
        };
    }
    const builtIn = PRICING_TABLE[modelName];
    if (!builtIn) {
        return { status: 'unpriced', source: 'unpriced' };
    }
    return { status: 'priced', source: 'built-in', rates: builtIn };
}

/** Describe the effective pricing source for the model management UI. */
export function describePricingSource(
    modelName: string,
    pricingOverride?: FlatModelPricing,
): { source: 'Custom' | 'Built-in' | 'Unpriced'; rates?: FlatPricing | ModelPricing } {
    const resolved = resolveModelPricing(modelName, pricingOverride);
    if (resolved.status === 'unpriced') {
        return { source: 'Unpriced' };
    }
    if (resolved.source === 'override') {
        return { source: 'Custom', rates: resolved.rates };
    }
    return { source: 'Built-in', rates: resolved.rates };
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Normalize provider usage into billable token counts.
 * Prefer raw provider payloads when present so Anthropic cache tokens are included in input.
 */
export function normalizeProviderUsage(
    provider: ProviderKind | string,
    usage: AIUsage | undefined,
): { ok: true; usage: NormalizedTokenUsage } | { ok: false; reason: 'missing' | 'invalid' } {
    if (!usage) {
        return { ok: false, reason: 'missing' };
    }

    const fromRaw = normalizeFromRaw(provider, usage.raw);
    if (fromRaw) {
        return fromRaw;
    }

    // Fall back to already-normalized AIUsage fields when raw is absent.
    if (!isFiniteNonNegativeNumber(usage.inputTokens) || !isFiniteNonNegativeNumber(usage.outputTokens)) {
        return { ok: false, reason: 'invalid' };
    }
    const cached = usage.cachedInputTokens ?? 0;
    const cacheWrite = usage.cacheWriteInputTokens ?? 0;
    if (!isFiniteNonNegativeNumber(cached) || !isFiniteNonNegativeNumber(cacheWrite)) {
        return { ok: false, reason: 'invalid' };
    }

    const providerLower = String(provider).toLowerCase();
    // Anthropic reports input_tokens excluding cache; billable input must include both.
    const inputTokens = providerLower === 'anthropic'
        ? usage.inputTokens + cached + cacheWrite
        : usage.inputTokens;
    if (cached > inputTokens) {
        return { ok: false, reason: 'invalid' };
    }
    const totalTokens = isFiniteNonNegativeNumber(usage.totalTokens)
        ? usage.totalTokens
        : inputTokens + usage.outputTokens;
    return {
        ok: true,
        usage: {
            inputTokens,
            outputTokens: usage.outputTokens,
            cachedInputTokens: cached,
            totalTokens,
        },
    };
}

function normalizeFromRaw(
    provider: ProviderKind | string,
    raw: unknown,
): { ok: true; usage: NormalizedTokenUsage } | { ok: false; reason: 'invalid' } | undefined {
    if (raw === undefined || raw === null) {
        return undefined;
    }
    if (typeof raw !== 'object') {
        return { ok: false, reason: 'invalid' };
    }
    const usage = raw as Record<string, any>;
    const providerLower = String(provider).toLowerCase();

    try {
        if (providerLower === 'openai') {
            const inputTokens = usage.input_tokens;
            const outputTokens = usage.output_tokens;
            const cachedTokens = usage.input_tokens_details?.cached_tokens ?? 0;
            return finishNormalized(inputTokens, outputTokens, cachedTokens, usage.total_tokens);
        }
        if (providerLower === 'custom') {
            const inputTokens = usage.prompt_tokens ?? usage.input_tokens;
            const outputTokens = usage.completion_tokens ?? usage.output_tokens;
            const cachedTokens = usage.prompt_tokens_details?.cached_tokens
                ?? usage.prompt_cache_hit_tokens
                ?? 0;
            return finishNormalized(inputTokens, outputTokens, cachedTokens, usage.total_tokens);
        }
        if (providerLower === 'anthropic') {
            const rawInput = usage.input_tokens;
            const outputTokens = usage.output_tokens;
            const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
            const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
            if (!isFiniteNonNegativeNumber(rawInput)
                || !isFiniteNonNegativeNumber(outputTokens)
                || !isFiniteNonNegativeNumber(cacheReadTokens)
                || !isFiniteNonNegativeNumber(cacheCreationTokens)) {
                return { ok: false, reason: 'invalid' };
            }
            const inputTokens = rawInput + cacheReadTokens + cacheCreationTokens;
            return finishNormalized(inputTokens, outputTokens, cacheReadTokens, inputTokens + outputTokens);
        }
        if (providerLower === 'google') {
            return finishNormalized(
                usage.total_input_tokens,
                usage.total_output_tokens,
                usage.total_cached_tokens ?? 0,
                usage.total_tokens,
            );
        }
        return { ok: false, reason: 'invalid' };
    } catch {
        return { ok: false, reason: 'invalid' };
    }
}

function finishNormalized(
    inputTokens: unknown,
    outputTokens: unknown,
    cachedInputTokens: unknown,
    totalTokens: unknown,
): { ok: true; usage: NormalizedTokenUsage } | { ok: false; reason: 'invalid' } {
    if (!isFiniteNonNegativeNumber(inputTokens)
        || !isFiniteNonNegativeNumber(outputTokens)
        || !isFiniteNonNegativeNumber(cachedInputTokens)) {
        return { ok: false, reason: 'invalid' };
    }
    if (cachedInputTokens > inputTokens) {
        return { ok: false, reason: 'invalid' };
    }
    const total = isFiniteNonNegativeNumber(totalTokens)
        ? totalTokens
        : inputTokens + outputTokens;
    return {
        ok: true,
        usage: {
            inputTokens,
            outputTokens,
            cachedInputTokens,
            totalTokens: total,
        },
    };
}

/**
 * Compute USD cost from resolved rates and normalized usage.
 * Cached tokens are billed at the cached rate; the remainder at the input rate.
 */
export function computeUsageCostUsd(
    rates: ModelPricing,
    usage: NormalizedTokenUsage,
): number {
    const flat = resolveFlatRatesForUsage(rates, usage.inputTokens);
    const nonCachedInputTokens = usage.inputTokens - usage.cachedInputTokens;
    const inputCost = (nonCachedInputTokens / 1_000_000) * flat.input;
    const outputCost = (usage.outputTokens / 1_000_000) * flat.output;
    const cachedCost = (usage.cachedInputTokens / 1_000_000) * flat.cached;
    return inputCost + outputCost + cachedCost;
}

function resolveFlatRatesForUsage(rates: ModelPricing, inputTokens: number): FlatPricing {
    if (isTieredPricing(rates)) {
        const tier = rates.tiers.find(candidate => inputTokens <= candidate.maxInputTokens);
        if (!tier) {
            throw new Error(`No pricing tier found for ${inputTokens} input tokens.`);
        }
        return { input: tier.input, output: tier.output, cached: tier.cached };
    }
    return rates;
}
