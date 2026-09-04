import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import {
    assertValidFlatModelPricing,
    computeUsageCostUsd,
    normalizeProviderUsage,
    parseFlatModelPricingInput,
    resolveModelPricing,
} from '../../services/cost/costAccounting';
import { CostTrackingService } from '../../services/cost/costTrackingService';
import { FlatModelPricing, NormalizedTokenUsage } from '../../services/cost/costTypes';
import { PRICING_TABLE } from '../../services/cost/pricing';
import type { AIUsage } from '../../services/llm/providers/types';

function flatOverride(input: number, output: number, cachedInput: number): FlatModelPricing {
    return { unit: 'USD_PER_1M_TOKENS', input, output, cachedInput };
}

describe('FlatModelPricing validation', () => {
    it('accepts a valid override with USD_PER_1M_TOKENS unit', () => {
        const pricing = flatOverride(1.25, 10, 0.125);
        assert.doesNotThrow(() => assertValidFlatModelPricing(pricing));
        assertValidFlatModelPricing(pricing);
    });

    it('accepts three zeros as explicit free pricing', () => {
        const pricing = flatOverride(0, 0, 0);
        assert.doesNotThrow(() => assertValidFlatModelPricing(pricing));
    });

    it('rejects non-object values', () => {
        assert.throws(() => assertValidFlatModelPricing(null), /must be an object/);
        assert.throws(() => assertValidFlatModelPricing(undefined), /must be an object/);
        assert.throws(() => assertValidFlatModelPricing('1'), /must be an object/);
    });

    it('rejects wrong pricing unit', () => {
        assert.throws(
            () => assertValidFlatModelPricing({ unit: 'EUR', input: 1, output: 1, cachedInput: 0 }),
            /USD_PER_1M_TOKENS/,
        );
    });

    it('rejects negative, NaN, and Infinity rates', () => {
        for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
            assert.throws(() => assertValidFlatModelPricing(flatOverride(bad, 1, 0)), /input/);
            assert.throws(() => assertValidFlatModelPricing(flatOverride(1, bad, 0)), /output/);
            assert.throws(() => assertValidFlatModelPricing(flatOverride(1, 1, bad)), /cachedInput/);
        }
    });

    it('parseFlatModelPricingInput parses trimmed numeric strings', () => {
        const parsed = parseFlatModelPricingInput(' 1.25 ', '10', '0.125');
        assert.deepEqual(parsed, flatOverride(1.25, 10, 0.125));
    });

    it('parseFlatModelPricingInput rejects empty and invalid text', () => {
        assert.throws(() => parseFlatModelPricingInput('', '1', '0'), /Input price is required/);
        assert.throws(() => parseFlatModelPricingInput('1', '', '0'), /Output price is required/);
        assert.throws(() => parseFlatModelPricingInput('1', '1', ''), /Cached input price is required/);
        assert.throws(() => parseFlatModelPricingInput('-1', '1', '0'), /Input price must be a finite non-negative number/);
        assert.throws(() => parseFlatModelPricingInput('NaN', '1', '0'), /Input price must be a finite non-negative number/);
    });
});

describe('resolveModelPricing', () => {
    it('resolves built-in table entries by exact model name', () => {
        const resolved = resolveModelPricing('gpt-5');
        assert.equal(resolved.status, 'priced');
        if (resolved.status !== 'priced') {
            throw new Error('expected priced resolution');
        }
        assert.equal(resolved.source, 'built-in');
        assert.deepEqual(resolved.rates, PRICING_TABLE['gpt-5']);
    });

    it('returns unpriced for unknown models without override', () => {
        const resolved = resolveModelPricing('totally-unknown-model');
        assert.deepEqual(resolved, { status: 'unpriced', source: 'unpriced' });
    });

    it('does not fuzzy-match dated model variants', () => {
        const resolved = resolveModelPricing('gpt-5-2025-08-07');
        assert.deepEqual(resolved, { status: 'unpriced', source: 'unpriced' });
    });

    it('prefers override over built-in table pricing', () => {
        const override = flatOverride(99, 99, 99);
        const resolved = resolveModelPricing('gpt-5', override);
        assert.equal(resolved.status, 'priced');
        if (resolved.status !== 'priced') {
            throw new Error('expected priced resolution');
        }
        assert.equal(resolved.source, 'override');
        assert.deepEqual(resolved.rates, { input: 99, output: 99, cached: 99 });
    });

    it('allows two same-named models to carry different overrides', () => {
        const overrideA = flatOverride(1, 2, 3);
        const overrideB = flatOverride(4, 5, 6);
        const resolvedA = resolveModelPricing('gpt-5', overrideA);
        const resolvedB = resolveModelPricing('gpt-5', overrideB);
        assert.notDeepEqual(resolvedA, resolvedB);
        if (resolvedA.status !== 'priced' || resolvedB.status !== 'priced') {
            throw new Error('expected both overrides to resolve as priced');
        }
        assert.deepEqual(resolvedA.rates, { input: 1, output: 2, cached: 3 });
        assert.deepEqual(resolvedB.rates, { input: 4, output: 5, cached: 6 });
    });
});

describe('normalizeProviderUsage', () => {
    it('normalizes OpenAI raw usage with cached input details', () => {
        const result = normalizeProviderUsage('openai', {
            raw: {
                input_tokens: 1_000,
                output_tokens: 200,
                input_tokens_details: { cached_tokens: 400 },
                total_tokens: 1_200,
            },
        });
        assert.equal(result.ok, true);
        if (!result.ok) {
            throw new Error('expected OpenAI usage to normalize');
        }
        assert.deepEqual(result.usage, {
            inputTokens: 1_000,
            outputTokens: 200,
            cachedInputTokens: 400,
            totalTokens: 1_200,
        });
    });

    it('normalizes Anthropic raw usage by billing cache read and creation into input', () => {
        const result = normalizeProviderUsage('anthropic', {
            raw: {
                input_tokens: 500,
                output_tokens: 100,
                cache_read_input_tokens: 300,
                cache_creation_input_tokens: 200,
            },
        });
        assert.equal(result.ok, true);
        if (!result.ok) {
            throw new Error('expected Anthropic usage to normalize');
        }
        assert.deepEqual(result.usage, {
            inputTokens: 1_000,
            outputTokens: 100,
            cachedInputTokens: 300,
            totalTokens: 1_100,
        });
    });

    it('normalizes Google raw usage fields', () => {
        const result = normalizeProviderUsage('google', {
            raw: {
                total_input_tokens: 800,
                total_output_tokens: 150,
                total_cached_tokens: 250,
                total_tokens: 950,
            },
        });
        assert.equal(result.ok, true);
        if (!result.ok) {
            throw new Error('expected Google usage to normalize');
        }
        assert.deepEqual(result.usage, {
            inputTokens: 800,
            outputTokens: 150,
            cachedInputTokens: 250,
            totalTokens: 950,
        });
    });

    it('normalizes custom raw usage from prompt/completion token fields', () => {
        const result = normalizeProviderUsage('custom', {
            raw: {
                prompt_tokens: 900,
                completion_tokens: 120,
                prompt_tokens_details: { cached_tokens: 100 },
            },
        });
        assert.equal(result.ok, true);
        if (!result.ok) {
            throw new Error('expected custom usage to normalize');
        }
        assert.deepEqual(result.usage, {
            inputTokens: 900,
            outputTokens: 120,
            cachedInputTokens: 100,
            totalTokens: 1_020,
        });
    });

    it('normalizes custom raw usage from prompt_cache_hit_tokens fallback', () => {
        const result = normalizeProviderUsage('custom', {
            raw: {
                prompt_tokens: 900,
                completion_tokens: 120,
                prompt_cache_hit_tokens: 150,
            },
        });
        assert.equal(result.ok, true);
        if (!result.ok) {
            throw new Error('expected custom cache-hit usage to normalize');
        }
        assert.equal(result.usage.cachedInputTokens, 150);
    });

    it('reports missing usage', () => {
        const result = normalizeProviderUsage('openai', undefined);
        assert.deepEqual(result, { ok: false, reason: 'missing' });
    });

    it('reports invalid usage when cached tokens exceed input tokens', () => {
        const result = normalizeProviderUsage('openai', {
            raw: {
                input_tokens: 100,
                output_tokens: 10,
                input_tokens_details: { cached_tokens: 150 },
            },
        });
        assert.deepEqual(result, { ok: false, reason: 'invalid' });
    });

    it('reports invalid usage for non-finite token counts', () => {
        const result = normalizeProviderUsage('openai', {
            raw: {
                input_tokens: Number.NaN,
                output_tokens: 10,
            },
        });
        assert.deepEqual(result, { ok: false, reason: 'invalid' });
    });

    it('normalizes Anthropic AIUsage fallback by including cache tokens in billable input', () => {
        const result = normalizeProviderUsage('anthropic', {
            inputTokens: 500,
            outputTokens: 100,
            cachedInputTokens: 300,
            cacheWriteInputTokens: 200,
        });
        assert.equal(result.ok, true);
        if (!result.ok) {
            throw new Error('expected Anthropic fallback usage to normalize');
        }
        assert.deepEqual(result.usage, {
            inputTokens: 1_000,
            outputTokens: 100,
            cachedInputTokens: 300,
            totalTokens: 1_100,
        });
    });
});

describe('computeUsageCostUsd', () => {
    const usage: NormalizedTokenUsage = {
        inputTokens: 1_000,
        outputTokens: 200,
        cachedInputTokens: 400,
        totalTokens: 1_200,
    };

    it('applies cached input discount against the input rate', () => {
        const amount = computeUsageCostUsd(
            { input: 1, output: 2, cached: 0.5 },
            usage,
        );
        assert.ok(Math.abs(amount - 0.0012) < 1e-12);
    });

    it('returns zero for explicit free flat pricing', () => {
        const amount = computeUsageCostUsd(
            { input: 0, output: 0, cached: 0 },
            usage,
        );
        assert.equal(amount, 0);
    });
});

describe('CostTrackingService.quoteCall', () => {
    const service = new CostTrackingService({ globalState: {} } as never);

    it('returns priced quotes with computed amountUsd', () => {
        const pricing = resolveModelPricing('gpt-5');
        const quote = service.quoteCall('openai', pricing, {
            raw: {
                input_tokens: 1_000_000,
                output_tokens: 0,
                input_tokens_details: { cached_tokens: 0 },
            },
        });
        assert.equal(quote.status, 'priced');
        assert.equal(quote.amountUsd, 1.25);
        assert.equal(quote.pricingSource, 'built-in');
    });

    it('returns priced zero amount for explicit free overrides', () => {
        const pricing = resolveModelPricing('unknown-model', flatOverride(0, 0, 0));
        const quote = service.quoteCall('openai', pricing, {
            raw: {
                input_tokens: 10_000,
                output_tokens: 5_000,
            },
        });
        assert.equal(quote.status, 'priced');
        assert.equal(quote.amountUsd, 0);
    });

    it('returns pricing-not-configured for unpriced models with valid usage', () => {
        const pricing = resolveModelPricing('unknown-model');
        const quote = service.quoteCall('openai', pricing, {
            raw: {
                input_tokens: 100,
                output_tokens: 20,
            },
        });
        assert.equal(quote.status, 'pricing-not-configured');
        assert.equal(quote.amountUsd, undefined);
        assert.ok(quote.usage);
    });

    it('returns usage-not-reported when usage is missing', () => {
        const pricing = resolveModelPricing('gpt-5');
        const quote = service.quoteCall('openai', pricing, undefined);
        assert.equal(quote.status, 'usage-not-reported');
        assert.equal(quote.amountUsd, undefined);
    });

    it('returns invalid-usage for malformed token accounting', () => {
        const pricing = resolveModelPricing('gpt-5');
        const usage: AIUsage = {
            raw: {
                input_tokens: 50,
                output_tokens: 10,
                input_tokens_details: { cached_tokens: 100 },
            },
        };
        const quote = service.quoteCall('openai', pricing, usage);
        assert.equal(quote.status, 'invalid-usage');
        assert.equal(quote.amountUsd, undefined);
    });
});
