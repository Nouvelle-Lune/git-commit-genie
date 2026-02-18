/**
 * LLM API Pricing Configuration
 * All prices are in USD per 1M tokens
 * 
 * For flat pricing models, use: { input, output, cached }
 * For tiered pricing models, use: { tiers: [{ maxInputTokens, input, output, cached }] }
 * 
 * For Qwen Plus models with thinking mode support:
 * - Use model name with `:thinking` suffix (e.g., 'qwen-plus:intl:thinking')
 * - Thinking mode has higher output costs
 */

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
    // OpenAI (USD)
    'gpt-5': { input: 1.25, output: 10.0, cached: 0.125 },
    'gpt-5.2': { input: 1.75, output: 14.0, cached: 0.175 },
    // OpenAI pricing currently lists no cached-input rate for gpt-5.2-pro.
    'gpt-5.2-pro': { input: 21.0, output: 168.0, cached: 0 },
    'gpt-5-mini': { input: 0.25, output: 2.0, cached: 0.025 },
    'gpt-5-nano': { input: 0.05, output: 0.4, cached: 0.005 },

    // Anthropic Claude (USD)
    'claude-opus-4-1-20250805': { input: 15.0, output: 75.0, cached: 1.5 },
    'claude-opus-4-20250514': { input: 15.0, output: 75.0, cached: 1.5 },
    'claude-sonnet-4-20250514': { input: 3.0, output: 15.0, cached: 0.3 },
    'claude-3-7-sonnet-20250219': { input: 3.0, output: 15.0, cached: 0.3 },
    'claude-3-5-sonnet-20241022': { input: 3.0, output: 15.0, cached: 0.3 },
    'claude-3-5-sonnet-20240620': { input: 3.0, output: 15.0, cached: 0.3 },
    'claude-3-5-haiku-20241022': { input: 0.8, output: 4.0, cached: 0.08 },

    'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0, cached: 0.10 },
    'claude-sonnet-4-5-20250929': { input: 3.0, output: 15.0, cached: 0.3 },
    'claude-opus-4-5-20251101': { input: 5.0, output: 25.0, cached: 0.5 },

    // Google Gemini (USD)
    'gemini-2.5-pro': {
        tiers: [
            { maxInputTokens: 200000, input: 1.25, output: 10.0, cached: 0.125 },   // prompts <= 200k
            { maxInputTokens: Infinity, input: 2.50, output: 15.0, cached: 0.25 }   // prompts > 200k
        ]
    },
    'gemini-2.5-flash': { input: 0.30, output: 2.50, cached: 0.075 },
    'gemini-2.5-flash-preview-09-2025': { input: 0.30, output: 2.50, cached: 0.075 },
    // Gemini 3 Flash preview pricing for text/image/video.
    'gemini-3-flash-preview': { input: 0.50, output: 3.00, cached: 0.05 },

    'gemini-3-pro-preview': {
        tiers: [
            { maxInputTokens: 200000, input: 2.0, output: 12.0, cached: 0.2 },     // prompts <= 200k
            { maxInputTokens: Infinity, input: 4.0, output: 18.0, cached: 0.4 }     // prompts > 200k
        ]
    },

    // lite variants removed

    // DeepSeek (USD)
    'deepseek-chat': { input: 0.274, output: 0.411, cached: 0.027 },
    'deepseek-reasoner': { input: 0.274, output: 0.411, cached: 0.027 },

    // Qwen International (Singapore) - USD
    // Cache price is 20% of input price for all Qwen models
    'qwen3-max:intl': {
        tiers: [
            { maxInputTokens: 32000, input: 1.2, output: 6.0, cached: 0.24 },      // 0-32K
            { maxInputTokens: 128000, input: 2.4, output: 12.0, cached: 0.48 },    // 32K-128K
            { maxInputTokens: 252000, input: 3.0, output: 15.0, cached: 0.6 },     // 128K-252K
            { maxInputTokens: Infinity, input: 3.0, output: 15.0, cached: 0.6 }    // >252K (same as tier 3)
        ]
    },
    'qwen3-max-preview:intl': {
        tiers: [
            { maxInputTokens: 32000, input: 1.2, output: 6.0, cached: 0.24 },
            { maxInputTokens: 128000, input: 2.4, output: 12.0, cached: 0.48 },
            { maxInputTokens: 252000, input: 3.0, output: 15.0, cached: 0.6 },
            { maxInputTokens: Infinity, input: 3.0, output: 15.0, cached: 0.6 }
        ]
    },
    'qwen-plus:intl': {
        tiers: [
            { maxInputTokens: 256000, input: 0.4, output: 1.2, cached: 0.08 },      // 0-256K (non-reasoning mode)
            { maxInputTokens: 1000000, input: 1.2, output: 3.6, cached: 0.24 },     // 256K-1M (non-reasoning mode)
            { maxInputTokens: Infinity, input: 1.2, output: 3.6, cached: 0.24 }     // >1M
        ]
    },
    'qwen-plus-latest:intl': {
        tiers: [
            { maxInputTokens: 256000, input: 0.4, output: 1.2, cached: 0.08 },
            { maxInputTokens: 1000000, input: 1.2, output: 3.6, cached: 0.24 },
            { maxInputTokens: Infinity, input: 1.2, output: 3.6, cached: 0.24 }
        ]
    },
    // Qwen Plus International - Thinking Mode (higher output costs)
    'qwen-plus:intl:thinking': {
        tiers: [
            { maxInputTokens: 256000, input: 0.4, output: 4.0, cached: 0.08 },      // 0-256K (reasoning mode)
            { maxInputTokens: 1000000, input: 1.2, output: 12.0, cached: 0.24 },    // 256K-1M (reasoning mode)
            { maxInputTokens: Infinity, input: 1.2, output: 12.0, cached: 0.24 }    // >1M
        ]
    },
    'qwen-plus-latest:intl:thinking': {
        tiers: [
            { maxInputTokens: 256000, input: 0.4, output: 4.0, cached: 0.08 },
            { maxInputTokens: 1000000, input: 1.2, output: 12.0, cached: 0.24 },
            { maxInputTokens: Infinity, input: 1.2, output: 12.0, cached: 0.24 }
        ]
    },

    'qwen-flash:intl': {
        tiers: [
            { maxInputTokens: 256000, input: 0.05, output: 0.4, cached: 0.01 },  // 0-256K
            { maxInputTokens: Infinity, input: 0.25, output: 2.0, cached: 0.05 } // >256K
        ]
    },

    'qwen3-coder-plus:intl': {
        tiers: [
            { maxInputTokens: 32000, input: 1.0, output: 5.0, cached: 0.2 },       // 0-32K
            { maxInputTokens: 128000, input: 1.8, output: 9.0, cached: 0.36 },     // 32K-128K
            { maxInputTokens: 256000, input: 3.0, output: 15.0, cached: 0.6 },     // 128K-256K
            { maxInputTokens: Infinity, input: 6.0, output: 60.0, cached: 1.2 }    // >256K
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

    // Qwen China (Beijing) - USD
    // Cache price is 20% of input price for all Qwen models
    'qwen3-max:china': {
        tiers: [
            { maxInputTokens: 32000, input: 0.861, output: 3.441, cached: 0.1722 },   // 0-32K
            { maxInputTokens: 128000, input: 1.434, output: 5.735, cached: 0.2868 },  // 32K-128K
            { maxInputTokens: 252000, input: 2.151, output: 8.602, cached: 0.4302 },  // 128K-252K
            { maxInputTokens: Infinity, input: 2.151, output: 8.602, cached: 0.4302 } // >252K
        ]
    },
    'qwen3-max-preview:china': {
        tiers: [
            { maxInputTokens: 32000, input: 0.861, output: 3.441, cached: 0.1722 },
            { maxInputTokens: 128000, input: 1.434, output: 5.735, cached: 0.2868 },
            { maxInputTokens: 252000, input: 2.151, output: 8.602, cached: 0.4302 },
            { maxInputTokens: Infinity, input: 2.151, output: 8.602, cached: 0.4302 }
        ]
    },
    'qwen-plus:china': {
        tiers: [
            { maxInputTokens: 128000, input: 0.115, output: 0.287, cached: 0.023 },   // 0-128K (non-reasoning: $0.287)
            { maxInputTokens: 256000, input: 0.345, output: 2.868, cached: 0.069 },   // 128K-256K (non-reasoning: $2.868)
            { maxInputTokens: 1000000, input: 0.689, output: 6.881, cached: 0.1378 }  // 256K-1M (non-reasoning: $6.881)
        ]
    },
    'qwen-plus-latest:china': {
        tiers: [
            { maxInputTokens: 128000, input: 0.115, output: 0.287, cached: 0.023 },
            { maxInputTokens: 256000, input: 0.345, output: 2.868, cached: 0.069 },
            { maxInputTokens: 1000000, input: 0.689, output: 6.881, cached: 0.1378 }
        ]
    },
    // Qwen Plus China - Reasoning/Thinking Mode (higher output costs)
    'qwen-plus:china:thinking': {
        tiers: [
            { maxInputTokens: 128000, input: 0.115, output: 1.147, cached: 0.023 },   // 0-128K (reasoning: $1.147)
            { maxInputTokens: 256000, input: 0.345, output: 3.441, cached: 0.069 },   // 128K-256K (reasoning: $3.441)
            { maxInputTokens: 1000000, input: 0.689, output: 9.175, cached: 0.1378 }  // 256K-1M (reasoning: $9.175)
        ]
    },
    'qwen-plus-latest:china:thinking': {
        tiers: [
            { maxInputTokens: 128000, input: 0.115, output: 1.147, cached: 0.023 },
            { maxInputTokens: 256000, input: 0.345, output: 3.441, cached: 0.069 },
            { maxInputTokens: 1000000, input: 0.689, output: 9.175, cached: 0.1378 }
        ]
    },
    'qwen-flash:china': {
        tiers: [
            { maxInputTokens: 128000, input: 0.022, output: 0.216, cached: 0.0044 },  // 0-128K
            { maxInputTokens: 256000, input: 0.087, output: 0.861, cached: 0.0174 },  // 128K-256K
            { maxInputTokens: Infinity, input: 0.173, output: 1.721, cached: 0.0346 } // >256K
        ]
    },
    'qwen3-coder-plus:china': {
        tiers: [
            { maxInputTokens: 32000, input: 0.574, output: 2.294, cached: 0.1148 },   // 0-32K
            { maxInputTokens: 128000, input: 0.861, output: 3.441, cached: 0.1722 },  // 32K-128K
            { maxInputTokens: 256000, input: 1.434, output: 5.735, cached: 0.2868 },  // 128K-256K
            { maxInputTokens: Infinity, input: 2.868, output: 28.671, cached: 0.5736 }// >256K
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
