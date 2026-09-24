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

export function isTieredPricing(pricing: ModelPricing): pricing is TieredPricing {
    return 'tiers' in pricing;
}

export const PRICING_TABLE: Record<string, ModelPricing> = {
    // Local OpenAI-compatible deployments (no pricing by default)
    'local': { input: 0, output: 0, cached: 0 },

    // OpenAI (USD)
    // GPT-6 is the current flagship family. Prompts above 272K input tokens are
    // repriced at 2x input and 1.5x output for the entire request.
    'gpt-6-astra': {
        tiers: [
            { maxInputTokens: 272000, input: 10.0, output: 50.0, cached: 1.0 },
            { maxInputTokens: Infinity, input: 20.0, output: 75.0, cached: 2.0 }
        ]
    },
    'gpt-6-sol': {
        tiers: [
            { maxInputTokens: 272000, input: 2.0, output: 10.0, cached: 0.2 },
            { maxInputTokens: Infinity, input: 4.0, output: 15.0, cached: 0.4 }
        ]
    },
    'gpt-6-luna': {
        tiers: [
            { maxInputTokens: 272000, input: 0.10, output: 0.50, cached: 0.01 },
            { maxInputTokens: Infinity, input: 0.20, output: 0.75, cached: 0.02 }
        ]
    },
    'gpt-5.6-sol': {
        tiers: [
            { maxInputTokens: 272000, input: 5.0, output: 30.0, cached: 0.5 },
            { maxInputTokens: Infinity, input: 10.0, output: 45.0, cached: 1.0 }
        ]
    },
    'gpt-5.6-terra': {
        tiers: [
            { maxInputTokens: 272000, input: 2.5, output: 15.0, cached: 0.25 },
            { maxInputTokens: Infinity, input: 5.0, output: 22.5, cached: 0.5 }
        ]
    },
    'gpt-5.6-luna': {
        tiers: [
            { maxInputTokens: 272000, input: 1.0, output: 6.0, cached: 0.1 },
            { maxInputTokens: Infinity, input: 2.0, output: 9.0, cached: 0.2 }
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
    // Fable 5.1 and Opus 5.5 are the current line; both bill cache reads below the
    // usual 0.1x multiplier (Fable 5.1 at 0.025x, Opus 5.5 at 0.05x).
    'claude-fable-5-1': { input: 10.0, output: 50.0, cached: 0.25 },
    'claude-opus-5-5': { input: 4.0, output: 20.0, cached: 0.20 },
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
    // The 3.6-3.8 Flash generation shares a $0.75/$3.75 card that doubles on 2027-01-01;
    // the discounted rate is recorded while it is in force.
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
    // Gemini 3 Flash preview pricing for text/image/video.
    'gemini-3-flash-preview': { input: 0.50, output: 3.00, cached: 0.05 },

    // lite variants removed

    // DeepSeek (USD). Peak/off-peak billing started on 2026-08-16; the off-peak floor
    // is recorded because it is a permanent published schedule and never overstates a
    // request. V4.1 Flash renamed the Flash line to `deepseek-flash` and retired the
    // legacy `deepseek-v4-flash` name.
    'deepseek-flash': { input: 0.15, output: 0.60, cached: 0.003 },
    'deepseek-v4-pro': { input: 0.66, output: 1.98, cached: 0.022 },

    // GLM (USD)
    'glm-5.3': { input: cny(8), output: cny(28), cached: cny(2) },
    'glm-5.3-flash': { input: cny(0.8), output: cny(2.8), cached: cny(0.23) },
    'glm-5.3-flashx': { input: cny(2), output: cny(7), cached: cny(0.57) },
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
    // The highspeed tier bills at 2x the standard coding rate.
    'kimi-k2.7-code-highspeed': { input: 1.90, output: 8.0, cached: 0.38 },
    'kimi-k2.6': { input: 0.95, output: 4.0, cached: 0.16 },

    // Qwen International (Singapore), converted from the dashboard's
    // CNY-localized display with the fixed project exchange rate.
    // The 3.8 generation is published in USD on the international site, so it is recorded
    // as USD instead of going through the CNY helper.
    'qwen3.8-max:intl': { input: 2.0, output: 6.0, cached: 0.25 },
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
    'qwen3.6-flash:intl': {
        tiers: [
            { maxInputTokens: 256000, input: cny(1.87355), output: cny(11.2413), cached: cny(0.37471) },
            { maxInputTokens: Infinity, input: cny(7.4942), output: cny(29.9758), cached: cny(1.49884) }
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
    'qwen3.6-flash:china': {
        tiers: [
            { maxInputTokens: 256000, input: cny(1.2), output: cny(7.2), cached: cny(0.24) },
            { maxInputTokens: Infinity, input: cny(4.8), output: cny(28.8), cached: cny(0.96) }
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

    // OpenCode Zen gateway rate card (USD), filed per vendor because a gateway price
    // is independent from the same model sold by its own vendor.
    'opencode-zen:claude-fable-5': { input: 10, output: 50, cached: 1 },
    'opencode-zen:claude-fable-5-1': { input: 10, output: 50, cached: 0.25 },
    'opencode-zen:claude-haiku-4-5': { input: 1, output: 5, cached: 0.1 },
    'opencode-zen:claude-opus-4-5': { input: 5, output: 25, cached: 0.5 },
    'opencode-zen:claude-opus-4-6': { input: 5, output: 25, cached: 0.5 },
    'opencode-zen:claude-opus-4-7': { input: 5, output: 25, cached: 0.5 },
    'opencode-zen:claude-opus-4-8': { input: 5, output: 25, cached: 0.5 },
    'opencode-zen:claude-opus-5': { input: 5, output: 25, cached: 0.5 },
    'opencode-zen:claude-opus-5-5': { input: 4, output: 20, cached: 0.2 },
    'opencode-zen:claude-sonnet-4-5': {
        tiers: [
            { maxInputTokens: 200000, input: 3, output: 15, cached: 0.3 },
            { maxInputTokens: Infinity, input: 6, output: 22.5, cached: 0.6 }
        ]
    },
    'opencode-zen:claude-sonnet-4-6': { input: 3, output: 15, cached: 0.3 },
    'opencode-zen:claude-sonnet-5': { input: 2, output: 10, cached: 0.2 },
    'opencode-zen:deepseek-v4-flash': { input: 0.14, output: 0.28, cached: 0.028 },
    'opencode-zen:deepseek-v4-flash-vision-exp': { input: 0.14, output: 0.28, cached: 0.028 },
    'opencode-zen:deepseek-v4-pro': { input: 1.74, output: 3.48, cached: 0.145 },
    'opencode-zen:deepseek-v4.1-flash': { input: 0.3, output: 1.2, cached: 0.006 },
    'opencode-zen:glm-5.1': { input: 1.4, output: 4.4, cached: 0.26 },
    'opencode-zen:glm-5.2': { input: 1.4, output: 4.4, cached: 0.26 },
    'opencode-zen:glm-5.3': { input: 1.4, output: 4.4, cached: 0.26 },
    'opencode-zen:glm-5.3-flash': { input: 0.15, output: 0.5, cached: 0.03 },
    'opencode-zen:gpt-5': { input: 1.07, output: 8.5, cached: 0.107 },
    'opencode-zen:gpt-5-nano': { input: 0.05, output: 0.4, cached: 0.005 },
    'opencode-zen:gpt-5.1': { input: 1.07, output: 8.5, cached: 0.107 },
    'opencode-zen:gpt-5.2': { input: 1.75, output: 14, cached: 0.175 },
    'opencode-zen:gpt-5.3-codex': { input: 1.75, output: 14, cached: 0.175 },
    'opencode-zen:gpt-5.3-codex-spark': { input: 1.75, output: 14, cached: 0.175 },
    'opencode-zen:gpt-5.4': {
        tiers: [
            { maxInputTokens: 272000, input: 2.5, output: 15, cached: 0.25 },
            { maxInputTokens: Infinity, input: 5, output: 22.5, cached: 0.5 }
        ]
    },
    'opencode-zen:gpt-5.4-mini': { input: 0.75, output: 4.5, cached: 0.075 },
    'opencode-zen:gpt-5.4-nano': { input: 0.2, output: 1.25, cached: 0.02 },
    'opencode-zen:gpt-5.4-pro': { input: 30, output: 180, cached: 30 },
    'opencode-zen:gpt-5.5': {
        tiers: [
            { maxInputTokens: 272000, input: 5, output: 30, cached: 0.5 },
            { maxInputTokens: Infinity, input: 10, output: 45, cached: 1 }
        ]
    },
    'opencode-zen:gpt-5.5-pro': { input: 30, output: 180, cached: 30 },
    'opencode-zen:gpt-5.6-luna': {
        tiers: [
            { maxInputTokens: 272000, input: 0.2, output: 1.2, cached: 0.02 },
            { maxInputTokens: Infinity, input: 0.4, output: 1.8, cached: 0.04 }
        ]
    },
    'opencode-zen:gpt-5.6-sol': {
        tiers: [
            { maxInputTokens: 272000, input: 4, output: 20, cached: 0.4 },
            { maxInputTokens: Infinity, input: 8, output: 30, cached: 0.8 }
        ]
    },
    'opencode-zen:gpt-5.6-terra': {
        tiers: [
            { maxInputTokens: 272000, input: 2, output: 12, cached: 0.2 },
            { maxInputTokens: Infinity, input: 4, output: 18, cached: 0.4 }
        ]
    },
    'opencode-zen:gpt-6-astra': {
        tiers: [
            { maxInputTokens: 272000, input: 10, output: 50, cached: 1 },
            { maxInputTokens: Infinity, input: 20, output: 75, cached: 2 }
        ]
    },
    'opencode-zen:gpt-6-luna': {
        tiers: [
            { maxInputTokens: 272000, input: 0.1, output: 0.5, cached: 0.01 },
            { maxInputTokens: Infinity, input: 0.2, output: 0.75, cached: 0.02 }
        ]
    },
    'opencode-zen:gpt-6-sol': {
        tiers: [
            { maxInputTokens: 272000, input: 2, output: 10, cached: 0.2 },
            { maxInputTokens: Infinity, input: 4, output: 15, cached: 0.4 }
        ]
    },
    'opencode-zen:grok-4.5': {
        tiers: [
            { maxInputTokens: 200000, input: 2, output: 6, cached: 0.3 },
            { maxInputTokens: Infinity, input: 4, output: 12, cached: 0.6 }
        ]
    },
    'opencode-zen:grok-4.6': {
        tiers: [
            { maxInputTokens: 200000, input: 2, output: 6, cached: 0.5 },
            { maxInputTokens: Infinity, input: 4, output: 12, cached: 1 }
        ]
    },
    'opencode-zen:grok-4.7': {
        tiers: [
            { maxInputTokens: 200000, input: 2, output: 6, cached: 0.5 },
            { maxInputTokens: Infinity, input: 4, output: 12, cached: 1 }
        ]
    },
    'opencode-zen:grok-build-0.1': { input: 1, output: 2, cached: 0.2 },
    'opencode-zen:kimi-k2.6': { input: 0.95, output: 4, cached: 0.16 },
    'opencode-zen:kimi-k2.7-code': { input: 0.95, output: 4, cached: 0.19 },
    'opencode-zen:kimi-k3': { input: 3, output: 15, cached: 0.3 },
    'opencode-zen:minimax-m2.7': { input: 0.3, output: 1.2, cached: 0.06 },
    'opencode-zen:minimax-m3': { input: 0.3, output: 1.2, cached: 0.06 },
    'opencode-zen:muse-spark-1.2': { input: 1.25, output: 4.25, cached: 0.15 },
    'opencode-zen:muse-spark-1.3': { input: 1.25, output: 4.25, cached: 0.15 },
    'opencode-zen:qwen3.5-plus': { input: 0.2, output: 1.2, cached: 0.02 },
    'opencode-zen:qwen3.6-plus': { input: 0.5, output: 3, cached: 0.05 },
    'opencode-zen:qwen3.8-flash': { input: 0.15, output: 0.47, cached: 0.016 },

    // OpenCode Go gateway rate card (USD), filed per vendor because a gateway price
    // is independent from the same model sold by its own vendor.
    'opencode-go:deepseek-v4-flash': { input: 0.15, output: 0.6, cached: 0.003 },
    'opencode-go:deepseek-v4-flash-vision-exp': { input: 0.15, output: 0.6, cached: 0.003 },
    'opencode-go:deepseek-v4-pro': { input: 0.66, output: 1.98, cached: 0.022 },
    'opencode-go:deepseek-v4.1-flash': { input: 0.15, output: 0.6, cached: 0.003 },
    'opencode-go:glm-5.1': { input: 1.4, output: 4.4, cached: 0.26 },
    'opencode-go:glm-5.2': { input: 1.4, output: 4.4, cached: 0.26 },
    'opencode-go:glm-5.3': { input: 1.4, output: 4.4, cached: 0.26 },
    'opencode-go:glm-5.3-flash': { input: 0.15, output: 0.5, cached: 0.03 },
    'opencode-go:gpt-5.6-luna': {
        tiers: [
            { maxInputTokens: 272000, input: 0.2, output: 1.2, cached: 0.02 },
            { maxInputTokens: Infinity, input: 0.4, output: 1.8, cached: 0.04 }
        ]
    },
    'opencode-go:gpt-6-luna': {
        tiers: [
            { maxInputTokens: 272000, input: 0.1, output: 0.5, cached: 0.01 },
            { maxInputTokens: Infinity, input: 0.2, output: 0.75, cached: 0.02 }
        ]
    },
    'opencode-go:grok-4.6': {
        tiers: [
            { maxInputTokens: 200000, input: 2, output: 6, cached: 0.5 },
            { maxInputTokens: Infinity, input: 4, output: 12, cached: 1 }
        ]
    },
    'opencode-go:grok-4.7': {
        tiers: [
            { maxInputTokens: 200000, input: 2, output: 6, cached: 0.5 },
            { maxInputTokens: Infinity, input: 4, output: 12, cached: 1 }
        ]
    },
    'opencode-go:hy3': { input: 0.14, output: 0.58, cached: 0.035 },
    'opencode-go:hy4-preview': { input: 0.834, output: 2.501, cached: 0.042 },
    'opencode-go:kimi-k2.6': { input: 0.95, output: 4, cached: 0.16 },
    'opencode-go:kimi-k2.7-code': { input: 0.95, output: 4, cached: 0.19 },
    'opencode-go:kimi-k3': { input: 3, output: 15, cached: 0.3 },
    'opencode-go:longcat-2.0': { input: 0.3, output: 1.2, cached: 0.006 },
    'opencode-go:mimo-v2.5': { input: 0.14, output: 0.28, cached: 0.0028 },
    'opencode-go:mimo-v2.5-pro': { input: 0.435, output: 0.87, cached: 0.003625 },
    'opencode-go:mimo-v2.6-flash': { input: 0.14, output: 0.28, cached: 0.0028 },
    'opencode-go:mimo-v2.6-pro': { input: 0.435, output: 0.87, cached: 0.003625 },
    'opencode-go:minimax-m2.5': { input: 0.3, output: 1.2, cached: 0.06 },
    'opencode-go:minimax-m2.7': { input: 0.3, output: 1.2, cached: 0.06 },
    'opencode-go:minimax-m3': { input: 0.3, output: 1.2, cached: 0.06 },
    'opencode-go:muse-spark-1.2-contributor': { input: 0.1, output: 0.2, cached: 0.002 },
    'opencode-go:muse-spark-1.3-contributor': { input: 0.1, output: 0.2, cached: 0.002 },
    'opencode-go:qwen3.6-plus': {
        tiers: [
            { maxInputTokens: 256000, input: 0.5, output: 3, cached: 0.05 },
            { maxInputTokens: Infinity, input: 2, output: 6, cached: 0.2 }
        ]
    },
    'opencode-go:qwen3.7-max': { input: 2.5, output: 7.5, cached: 0.5 },
    'opencode-go:qwen3.7-plus': {
        tiers: [
            { maxInputTokens: 256000, input: 0.4, output: 1.6, cached: 0.04 },
            { maxInputTokens: Infinity, input: 1.2, output: 4.8, cached: 0.12 }
        ]
    },
    'opencode-go:qwen3.8-flash': { input: 0.15, output: 0.47, cached: 0.016 },
    'opencode-go:qwen3.8-max': { input: 2, output: 6, cached: 0.25 },
};
