import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import {
    NATIVE_SECRET_KEYS,
    PRESET_TRANSPORT_PROVIDERS,
    VENDOR_PRESETS,
    customSecretKey,
    modelSecretKey,
    pricingKeyForModel,
    presetContextTokens,
    vendorSecretKey,
    type AIModelConfig,
    type PresetTransport,
} from '../../../services/llm/providers';
import { PRICING_TABLE, isTieredPricing } from '../../../services/cost/pricing';

/**
 * Cross-table contract for the preset catalog.
 *
 * The catalog is what makes "paste one key per vendor" work, so it has to stay
 * wired to the rate card it prices against and to the secret slots the registry
 * listens on. These assertions never pin individual model ids, so a vendor
 * refresh only has to keep the tables in sync.
 */

const GATEWAY_PREFIX = 'opencode-';
const NATIVE_TRANSPORTS: readonly PresetTransport[] = ['responses', 'messages', 'gemini'];

function configured(vendor: string, model: string): AIModelConfig {
    return { id: `${vendor}:${model}`, label: model, provider: 'custom', model, vendor };
}

describe('Preset model catalog', () => {
    it('registers every vendor exactly once with a usable endpoint set', () => {
        const ids = VENDOR_PRESETS.map(vendor => vendor.id);
        assert.equal(new Set(ids).size, ids.length, `duplicate vendor ids: ${ids.join(', ')}`);
        assert.ok(VENDOR_PRESETS.length >= 10, 'the catalog must cover the shipped vendors');

        for (const vendor of VENDOR_PRESETS) {
            assert.ok(vendor.label.trim(), `${vendor.id} has no label`);
            assert.ok(vendor.models.length > 0, `${vendor.id} lists no models`);

            const endpoints = vendor.endpoints ?? {};
            for (const [transport, url] of Object.entries(endpoints) as Array<[PresetTransport, string]>) {
                assert.ok(/^https:\/\/\S+$/.test(url), `${vendor.id}.${transport} is not an HTTPS endpoint: ${url}`);
            }
        }
    });

    it('prices every preset model through its vendor rate card key', () => {
        for (const vendor of VENDOR_PRESETS) {
            for (const entry of vendor.models) {
                const key = pricingKeyForModel({ vendor: vendor.id, model: entry.model });
                const pricing = PRICING_TABLE[key];
                assert.ok(pricing, `${vendor.id}/${entry.model} has no PRICING_TABLE entry for key '${key}'`);
                assertRatesAreSane(`${vendor.id}/${entry.model}`, pricing);
            }
        }
    });

    it('files gateway models under a vendor-prefixed card and keeps them reachable', () => {
        for (const vendor of VENDOR_PRESETS.filter(candidate => candidate.id.startsWith(GATEWAY_PREFIX))) {
            for (const entry of vendor.models) {
                assert.equal(
                    entry.pricingKey,
                    `${vendor.id}:${entry.model}`,
                    `${vendor.id}/${entry.model} must keep its own gateway rate card`,
                );
            }
        }
    });

    it('carries regional rate cards for the Qwen presets', () => {
        for (const vendor of VENDOR_PRESETS.filter(candidate => candidate.id.startsWith('qwen-'))) {
            const suffix = vendor.id === 'qwen-intl' ? ':intl' : ':china';
            for (const entry of vendor.models) {
                assert.equal(entry.pricingKey, `${entry.model}${suffix}`);
                assert.ok(PRICING_TABLE[entry.pricingKey!], `${entry.pricingKey} is missing from PRICING_TABLE`);
            }
        }
    });

    it('routes each model over a transport the vendor actually exposes', () => {
        for (const vendor of VENDOR_PRESETS) {
            const endpoints = vendor.endpoints;
            for (const entry of vendor.models) {
                assert.equal(
                    PRESET_TRANSPORT_PROVIDERS[entry.transport] !== undefined,
                    true,
                    `${vendor.id}/${entry.model} uses an unmapped transport`,
                );
                if (endpoints === undefined) {
                    assert.ok(
                        NATIVE_TRANSPORTS.includes(entry.transport),
                        `${vendor.id}/${entry.model} must use a native transport when the vendor defines no endpoint`,
                    );
                    continue;
                }
                assert.ok(
                    endpoints[entry.transport],
                    `${vendor.id}/${entry.model} uses ${entry.transport} but the vendor defines no such endpoint`,
                );
                if (entry.transport === 'chat') {
                    assert.equal(
                        PRESET_TRANSPORT_PROVIDERS.chat,
                        'custom',
                        'chat-completions models must run through the custom adapter',
                    );
                }
            }
        }
    });

    it('records a positive context window for every preset model', () => {
        for (const vendor of VENDOR_PRESETS) {
            for (const entry of vendor.models) {
                assert.ok(
                    Number.isInteger(entry.contextTokens) && entry.contextTokens > 0,
                    `${vendor.id}/${entry.model} has an invalid context window`,
                );
                assert.equal(presetContextTokens({ vendor: vendor.id, model: entry.model }), entry.contextTokens);
            }
        }
    });

    it('only declares thinking transports the vendor documents', () => {
        for (const vendor of VENDOR_PRESETS) {
            for (const entry of vendor.models) {
                if (entry.thinking === undefined) {
                    continue;
                }
                if (entry.thinking.reasoning) {
                    assert.ok(
                        entry.thinking.thinkingFormat !== undefined && entry.thinking.thinkingFormat !== 'off',
                        `${vendor.id}/${entry.model} declares reasoning without a format`,
                    );
                    assert.equal(vendor.endpoints?.chat !== undefined, true,
                        `${vendor.id}/${entry.model} toggles thinking off a chat-completions endpoint only`);
                    continue;
                }
                // Unverified vendors must never emit a reasoning field.
                assert.equal(entry.thinking.thinkingFormat, 'off');
                assert.equal(entry.thinking.thinkingLevelMap, undefined);
            }
        }
    });

    it('shares one secret slot per vendor and keeps instance slots for manual models', () => {
        assert.equal(vendorSecretKey('deepseek'), 'gitCommitGenie.secret.ai.vendor.deepseek');
        assert.equal(vendorSecretKey('opencode-go'), 'gitCommitGenie.secret.ai.vendor.opencode-go');
        for (const native of ['openai', 'anthropic', 'google'] as const) {
            assert.equal(vendorSecretKey(native), NATIVE_SECRET_KEYS[native]);
        }

        assert.equal(
            modelSecretKey(configured('opencode-zen', 'glm-5.3')),
            vendorSecretKey('opencode-zen'),
        );
        assert.equal(
            modelSecretKey({ id: 'manual', label: 'Manual', provider: 'custom', model: 'llama-3.2' }),
            customSecretKey('manual'),
        );
        assert.equal(
            modelSecretKey({ id: 'native', label: 'Claude', provider: 'anthropic', model: 'claude-opus-5-5' }),
            NATIVE_SECRET_KEYS.anthropic,
        );
    });

    it('falls back to the bare model id when a model is outside the catalog', () => {
        assert.equal(pricingKeyForModel({ vendor: 'deepseek', model: 'deepseek-v4-legacy' }), 'deepseek-v4-legacy');
        assert.equal(pricingKeyForModel({ model: 'llama-3.2' }), 'llama-3.2');
        assert.equal(presetContextTokens({ vendor: 'deepseek', model: 'deepseek-v4-legacy' }), undefined);
        assert.equal(presetContextTokens({ vendor: 'not-a-vendor', model: 'deepseek-flash' }), undefined);
    });
});

function assertRatesAreSane(label: string, pricing: typeof PRICING_TABLE[string]): void {
    if (!isTieredPricing(pricing)) {
        assertFiniteRates(label, pricing);
        return;
    }
    let previous = 0;
    for (const tier of pricing.tiers) {
        assert.ok(
            tier.maxInputTokens > previous,
            `${label} tiers must ascend; ${tier.maxInputTokens} follows ${previous}`,
        );
        assertFiniteRates(label, { input: tier.input, output: tier.output, cached: tier.cached });
        previous = tier.maxInputTokens;
    }
    assert.equal(previous, Infinity, `${label} tiers must terminate with Infinity`);
}

function assertFiniteRates(label: string, rates: { input: number; output: number; cached: number }): void {
    for (const [name, value] of Object.entries(rates)) {
        assert.ok(
            typeof value === 'number' && Number.isFinite(value) && value >= 0,
            `${label}.${name} is not a finite non-negative rate: ${String(value)}`,
        );
    }
}
