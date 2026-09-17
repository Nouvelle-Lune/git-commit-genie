/**
 * LLM API Pricing Configuration
 * All prices are in USD per 1M tokens.
 *
 * For flat pricing models, use: { input, output, cached }
 * For tiered pricing models, use: { tiers: [{ maxInputTokens, input, output, cached }] }
 *
 * For Qwen Plus models with thinking mode support:
 * - Use model name with `:thinking` suffix (e.g., 'qwen-plus:intl:thinking')
 * - Thinking mode has higher output costs
 *
 * CNY-priced providers and regional price tables (GLM and Qwen) are converted to USD
 * using a fixed exchange rate of 1 CNY = 0.145 USD. The rate is captured
 * as `CNY_TO_USD` below and is intentionally fixed so that historical cost
 * estimates do not shift when the FX rate moves.
 *
 * Time-of-day rates (DeepSeek peak/off-peak billing, active since 2026-08-16) are
 * deliberately recorded at the OFF-PEAK rate. Off-peak is the price floor the API
 * publishes for a permanent schedule, so estimates stay stable and never overstate
 * a request that lands outside peak windows.
 */

/** Fixed conversion rate for CNY → USD pricing entries. */
const CNY_TO_USD = 0.145;
/** Helper for declaring CNY-denominated rates inline. */
const cny = (amount: number): number => Number((amount * CNY_TO_USD).toFixed(4));

export interface FlatPricing {
    input: number;
    output: number;
    cached: number;
}

export interface TieredPricingTier {
    maxInputTokens: number;
    input: number;
    output: number;
    cached: number;
}

export interface TieredPricing {
    tiers: TieredPricingTier[];
}

export type ModelPricing = FlatPricing | TieredPricing;

export const PRICING_TABLE: Record<string, ModelPricing> = {
    // Local OpenAI-compatible deployments (no pricing by default)
    'local': { input: 0, output: 0, cached: 0 },

    // OpenAI (USD)
    // Prompts above 272K input tokens are repriced at 2x input and 1.5x output for the
    // entire request, which is what the Infinity tier below encodes.
    'gpt-6-astra': {
        tiers: [
            { maxInputTokens: 272000, input: 10.0, output: 50.0, cached: 1.0 },
            { maxInputTokens: Infinity, input: 20.0, output: 75.0, cached: 2.0 }
        ]
    },
    // Sol has billed at a promotional $4/$20 since 2026-08-21 (stated to last at least
    // through 2026-11-21); the permanent list rate is $5/$30. The rate currently in
    // force is recorded here, matching how the other discounted rate cards in this
    // table are handled.
    'gpt-5.6-sol': {
        tiers: [
            { maxInputTokens: 272000, input: 4.0, output: 20.0, cached: 0.4 },
            { maxInputTokens: Infinity, input: 8.0, output: 30.0, cached: 0.8 }
        ]
    },
    'gpt-5.6-terra': {
        tiers: [
            { maxInputTokens: 272000, input: 2.0, output: 12.0, cached: 0.2 },
            { maxInputTokens: Infinity, input: 4.0, output: 18.0, cached: 0.4 }
        ]
    },
    'gpt-5.6-luna': {
        tiers: [
            { maxInputTokens: 272000, input: 0.2, output: 1.2, cached: 0.02 },
            { maxInputTokens: Infinity, input: 0.4, output: 1.8, cached: 0.04 }
        ]
    },
    'gpt-5.5': {
        tiers: [
            { maxInputTokens: 272000, input: 5.0, output: 30.0, cached: 0.5 },
            { maxInputTokens: Infinity, input: 10.0, output: 45.0, cached: 1.0 }
        ]
    },
    'gpt-5.4': {
        tiers: [
            { maxInputTokens: 272000, input: 2.5, output: 15.0, cached: 0.25 },
            { maxInputTokens: Infinity, input: 5.0, output: 22.5, cached: 0.5 }
        ]
    },
    'gpt-5.4-mini': { input: 0.75, output: 4.5, cached: 0.075 },
    'gpt-5.4-nano': { input: 0.2, output: 1.25, cached: 0.02 },
    'gpt-5': { input: 1.25, output: 10.0, cached: 0.125 },
    'gpt-5.2': { input: 1.75, output: 14.0, cached: 0.175 },
    // OpenAI pricing currently lists no cached-input rate for gpt-5.2-pro.
    'gpt-5.2-pro': { input: 21.0, output: 168.0, cached: 0 },
    'gpt-5-mini': { input: 0.25, output: 2.0, cached: 0.025 },
    'gpt-5-nano': { input: 0.05, output: 0.4, cached: 0.005 },

    // Anthropic Claude (USD)
    // Fable 5.1 is the only model outside the standard 0.1x cache-read multiplier:
    // Anthropic bills its cache reads at 0.025x base input ($0.25 per 1M tokens).
    'claude-fable-5-1': { input: 10.0, output: 50.0, cached: 0.25 },
    'claude-fable-5': { input: 10.0, output: 50.0, cached: 1.0 },
    'claude-opus-5': { input: 5.0, output: 25.0, cached: 0.5 },
    'claude-sonnet-5': { input: 2.0, output: 10.0, cached: 0.2 },
    'claude-opus-4-8': { input: 5.0, output: 25.0, cached: 0.5 },
    'claude-opus-4-7': { input: 5.0, output: 25.0, cached: 0.5 },
    'claude-sonnet-4-6': { input: 3.0, output: 15.0, cached: 0.3 },
    'claude-opus-4-6': { input: 5.0, output: 25.0, cached: 0.5 },
    'claude-opus-4-5': { input: 5.0, output: 25.0, cached: 0.5 },
    'claude-sonnet-4-5': { input: 3.0, output: 15.0, cached: 0.3 },
    'claude-haiku-4-5': { input: 1.0, output: 5.0, cached: 0.10 },

    // Google Gemini (USD)
    // The 3.6-3.8 Flash generation was cut to a shared $0.75/$3.75 rate card that is
    // labelled introductory and doubles on 2027-01-01. The discounted rate is recorded
    // while it is in force.
    'gemini-3.8-flash': { input: 0.75, output: 3.75, cached: 0.075 },
    'gemini-3.7-flash': { input: 0.75, output: 3.75, cached: 0.075 },
    'gemini-3.6-flash': { input: 0.75, output: 3.75, cached: 0.075 },
    'gemini-3.5-flash': { input: 1.50, output: 9.00, cached: 0.15 },
    'gemini-3.1-pro-preview': {
        tiers: [
            { maxInputTokens: 200000, input: 2.0, output: 12.0, cached: 0.2 },
            { maxInputTokens: Infinity, input: 4.0, output: 18.0, cached: 0.4 }
        ]
    },
    'gemini-2.5-pro': {
        tiers: [
            { maxInputTokens: 200000, input: 1.25, output: 10.0, cached: 0.125 },   // prompts <= 200k
            { maxInputTokens: Infinity, input: 2.50, output: 15.0, cached: 0.25 }   // prompts > 200k
        ]
    },
    'gemini-2.5-flash': { input: 0.30, output: 2.50, cached: 0.075 },

    // lite variants removed

    // DeepSeek (USD). DeepSeek switched to peak/off-peak billing on 2026-08-16 and
    // re-priced the Flash line on 2026-09-10 with V4.1 Flash (`deepseek-flash`),
    // which replaced `deepseek-v4-flash`. Off-peak rates are recorded; peak doubles them.
    'deepseek-flash': { input: 0.15, output: 0.60, cached: 0.003 },
    'deepseek-v4-pro': { input: 0.66, output: 1.98, cached: 0.022 },

    // GLM (USD)
    'glm-5.3': { input: cny(8), output: cny(28), cached: cny(2) },
    // GLM-5.3-Flash is the multimodal Flash tier (native image/video/file input).
    'glm-5.3-flash': { input: cny(0.8), output: cny(2.8), cached: cny(0.23) },
    'glm-5.2': { input: cny(8), output: cny(28), cached: cny(2) },
    'glm-5.1': {
        tiers: [
            { maxInputTokens: 32000, input: cny(6), output: cny(24), cached: cny(1.3) },
            { maxInputTokens: Infinity, input: cny(8), output: cny(28), cached: cny(2) }
        ]
    },
    'glm-5-turbo': {
        tiers: [
            { maxInputTokens: 32000, input: 0.725, output: 3.19, cached: 0.174 },     // CNY: 5 / 22 / 1.2
            { maxInputTokens: Infinity, input: 1.015, output: 3.77, cached: 0.261 }   // CNY: 7 / 26 / 1.8
        ]
    },
    'glm-5': {
        tiers: [
            { maxInputTokens: 32000, input: 0.58, output: 2.61, cached: 0.145 },      // CNY: 4 / 18 / 1.0
            { maxInputTokens: Infinity, input: 0.87, output: 3.19, cached: 0.218 }    // CNY: 6 / 22 / 1.5
        ]
    },
    // Official table for glm-4.7 also has output-length sub-tiers; we use the higher output tier
    // for <=32K input to keep cost estimates conservative.
    'glm-4.7': {
        tiers: [
            { maxInputTokens: 32000, input: 0.435, output: 2.03, cached: 0.087 },     // CNY: 3 / 14 / 0.6
            { maxInputTokens: 200000, input: 0.58, output: 2.32, cached: 0.116 },     // CNY: 4 / 16 / 0.8
            { maxInputTokens: Infinity, input: 0.58, output: 2.32, cached: 0.116 }
        ]
    },
    'glm-4.7-flashx': { input: 0.073, output: 0.435, cached: 0.015 },                 // CNY: 0.5 / 3 / 0.1
    'glm-4.7-flash': { input: 0, output: 0, cached: 0 },                               // Officially free
    // For glm-4.5-air, <=32K has two output-length tiers (2 / 6 CNY output). Use higher tier conservatively.
    'glm-4.5-air': {
        tiers: [
            { maxInputTokens: 32000, input: 0.116, output: 0.87, cached: 0.023 },     // CNY: 0.8 / 6 / 0.16
            { maxInputTokens: 128000, input: 0.174, output: 1.16, cached: 0.035 },    // CNY: 1.2 / 8 / 0.24
            { maxInputTokens: Infinity, input: 0.174, output: 1.16, cached: 0.035 }
        ]
    },

    // Kimi (USD)
    'kimi-k3': { input: 3.0, output: 15.0, cached: 0.30 },
    'kimi-k2.7-code': { input: 0.95, output: 4.0, cached: 0.19 },
    'kimi-k2.7-code-highspeed': { input: 1.90, output: 8.0, cached: 0.38 },
    'kimi-k2.6': { input: 0.95, output: 4.0, cached: 0.16 },

    // Qwen International (Singapore), converted from the dashboard's
    // CNY-localized display with the fixed project exchange rate.
    // The 3.8 generation is published in USD on the international site, so those two
    // entries are recorded as USD rather than routed through the CNY helper.
    'qwen3.8-max:intl': { input: 2.0, output: 6.0, cached: 0.2 },
    'qwen3.8-flash:intl': { input: 0.15, output: 0.47, cached: 0.016 },
    'qwen3.7-max:intl': { input: cny(18.736), output: cny(56.207), cached: cny(3.7472) },
    'qwen3.7-plus:intl': {
        tiers: [
            { maxInputTokens: 256000, input: cny(2.998), output: cny(11.991), cached: cny(0.5996) },
            { maxInputTokens: Infinity, input: cny(8.993), output: cny(35.972), cached: cny(1.7986) }
        ]
    },
    'qwen3.7-flash:intl': {
        tiers: [
            { maxInputTokens: 32000, input: cny(0.225), output: cny(0.974), cached: cny(0.045) },
            { maxInputTokens: 256000, input: cny(0.749), output: cny(2.998), cached: cny(0.1498) },
            { maxInputTokens: Infinity, input: cny(1.499), output: cny(5.995), cached: cny(0.2998) }
        ]
    },
    'qwen3.5-plus:intl': {
        tiers: [
            { maxInputTokens: 256000, input: cny(2.936), output: cny(17.614), cached: cny(0.5872) },
            { maxInputTokens: Infinity, input: cny(3.67), output: cny(22.018), cached: cny(0.734) }
        ]
    },
    'qwen3.5-flash:intl': { input: cny(0.734), output: cny(2.936), cached: cny(0.1468) },
    'qwen-plus:intl': {
        tiers: [
            { maxInputTokens: 256000, input: cny(2.936), output: cny(8.807), cached: cny(0.5872) },
            { maxInputTokens: Infinity, input: cny(8.807), output: cny(26.421), cached: cny(1.7614) }
        ]
    },
    'qwen-plus-latest:intl': {
        tiers: [
            { maxInputTokens: 256000, input: cny(2.936), output: cny(8.807), cached: cny(0.5872) },
            { maxInputTokens: Infinity, input: cny(8.807), output: cny(26.421), cached: cny(1.7614) }
        ]
    },
    'qwen-plus:intl:thinking': {
        tiers: [
            { maxInputTokens: 256000, input: cny(2.936), output: cny(29.357), cached: cny(0.5872) },
            { maxInputTokens: Infinity, input: cny(8.807), output: cny(88.071), cached: cny(1.7614) }
        ]
    },
    'qwen-plus-latest:intl:thinking': {
        tiers: [
            { maxInputTokens: 256000, input: cny(2.936), output: cny(29.357), cached: cny(0.5872) },
            { maxInputTokens: Infinity, input: cny(8.807), output: cny(88.071), cached: cny(1.7614) }
        ]
    },
    'qwen-flash:intl': {
        tiers: [
            { maxInputTokens: 256000, input: cny(0.367), output: cny(2.936), cached: cny(0.0734) },
            { maxInputTokens: Infinity, input: cny(1.835), output: cny(14.678), cached: cny(0.367) }
        ]
    },
    'qwen3-coder-flash:intl': {
        tiers: [
            { maxInputTokens: 32000, input: 0.3, output: 1.5, cached: 0.06 },      // 0-32K
            { maxInputTokens: 128000, input: 0.5, output: 2.5, cached: 0.1 },      // 32K-128K
            { maxInputTokens: 256000, input: 0.8, output: 4.0, cached: 0.16 },     // 128K-256K
            { maxInputTokens: Infinity, input: 1.6, output: 9.6, cached: 0.32 }    // >256K
        ]
    },

    // Qwen China (Beijing), converted from CNY with the fixed project rate.
    'qwen3.8-max:china': { input: cny(12), output: cny(36), cached: cny(1.5) },
    'qwen3.8-flash:china': { input: cny(0.8), output: cny(2.7), cached: cny(0.1) },
    'qwen3.7-max:china': { input: cny(12), output: cny(36), cached: cny(2.4) },
    'qwen3.7-plus:china': {
        tiers: [
            { maxInputTokens: 256000, input: cny(2), output: cny(8), cached: cny(0.4) },
            { maxInputTokens: Infinity, input: cny(6), output: cny(24), cached: cny(1.2) }
        ]
    },
    'qwen3.7-flash:china': {
        tiers: [
            { maxInputTokens: 32000, input: cny(0.2), output: cny(0.8), cached: cny(0.04) },
            { maxInputTokens: 256000, input: cny(0.6), output: cny(2.4), cached: cny(0.12) },
            { maxInputTokens: Infinity, input: cny(1.2), output: cny(4.8), cached: cny(0.24) }
        ]
    },
    'qwen3.5-plus:china': {
        tiers: [
            { maxInputTokens: 128000, input: cny(0.8), output: cny(4.8), cached: cny(0.16) },
            { maxInputTokens: 256000, input: cny(2), output: cny(12), cached: cny(0.4) },
            { maxInputTokens: Infinity, input: cny(4), output: cny(24), cached: cny(0.8) }
        ]
    },
    'qwen3.5-flash:china': {
        tiers: [
            { maxInputTokens: 128000, input: cny(0.2), output: cny(2), cached: cny(0.04) },
            { maxInputTokens: 256000, input: cny(0.8), output: cny(8), cached: cny(0.16) },
            { maxInputTokens: Infinity, input: cny(1.2), output: cny(12), cached: cny(0.24) }
        ]
    },
    'qwen-plus:china': {
        tiers: [
            { maxInputTokens: 128000, input: cny(0.8), output: cny(2), cached: cny(0.16) },
            { maxInputTokens: 256000, input: cny(2.4), output: cny(20), cached: cny(0.48) },
            { maxInputTokens: Infinity, input: cny(4.8), output: cny(48), cached: cny(0.96) }
        ]
    },
    'qwen-plus-latest:china': {
        tiers: [
            { maxInputTokens: 128000, input: cny(0.8), output: cny(2), cached: cny(0.16) },
            { maxInputTokens: 256000, input: cny(2.4), output: cny(20), cached: cny(0.48) },
            { maxInputTokens: Infinity, input: cny(4.8), output: cny(48), cached: cny(0.96) }
        ]
    },
    'qwen-plus:china:thinking': {
        tiers: [
            { maxInputTokens: 128000, input: cny(0.8), output: cny(8), cached: cny(0.16) },
            { maxInputTokens: 256000, input: cny(2.4), output: cny(24), cached: cny(0.48) },
            { maxInputTokens: Infinity, input: cny(4.8), output: cny(64), cached: cny(0.96) }
        ]
    },
    'qwen-plus-latest:china:thinking': {
        tiers: [
            { maxInputTokens: 128000, input: cny(0.8), output: cny(8), cached: cny(0.16) },
            { maxInputTokens: 256000, input: cny(2.4), output: cny(24), cached: cny(0.48) },
            { maxInputTokens: Infinity, input: cny(4.8), output: cny(64), cached: cny(0.96) }
        ]
    },
    'qwen-flash:china': {
        tiers: [
            { maxInputTokens: 128000, input: cny(0.15), output: cny(1.5), cached: cny(0.03) },
            { maxInputTokens: 256000, input: cny(0.6), output: cny(6), cached: cny(0.12) },
            { maxInputTokens: Infinity, input: cny(1.2), output: cny(12), cached: cny(0.24) }
        ]
    },
    'qwen3-coder-flash:china': {
        tiers: [
            { maxInputTokens: 32000, input: 0.144, output: 0.574, cached: 0.0288 },   // 0-32K
            { maxInputTokens: 128000, input: 0.216, output: 0.861, cached: 0.0432 },  // 32K-128K
            { maxInputTokens: 256000, input: 0.359, output: 1.434, cached: 0.0718 },  // 128K-256K
            { maxInputTokens: Infinity, input: 0.717, output: 3.584, cached: 0.1434 } // >256K
        ]
    },
};
