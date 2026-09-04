/**
 * Shared cost-accounting types.
 *
 * Call sites must consume CostQuote instead of inventing $0 for unknown pricing:
 * priced (including explicit free zeros), pricing-not-configured, usage-not-reported,
 * and invalid-usage are distinct outcomes.
 */

/** User-facing and override unit — first version only supports USD per 1M tokens. */
export type PricingUnit = 'USD_PER_1M_TOKENS';

/**
 * Optional per-model flat override stored on AIModelConfig.
 * All three rates are required; three zeros mean explicitly free.
 */
export interface FlatModelPricing {
    unit: PricingUnit;
    input: number;
    output: number;
    cachedInput: number;
}

/** Where the effective rates for a call came from. */
export type PricingSource = 'override' | 'built-in' | 'unpriced';

/** Snapshot bound when an LLMExecution is created so mid-task edits do not affect in-flight calls. */
export type ResolvedModelPricing =
    | {
        status: 'priced';
        source: 'override' | 'built-in';
        /** Flat override rates, or built-in flat/tiered table entry. */
        rates: import('./pricing').ModelPricing;
    }
    | {
        status: 'unpriced';
        source: 'unpriced';
    };

export type CostQuoteStatus =
    | 'priced'
    | 'pricing-not-configured'
    | 'usage-not-reported'
    | 'invalid-usage';

export interface NormalizedTokenUsage {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    totalTokens: number;
}

/**
 * Single source of truth for one successful API response's cost.
 * amountUsd is only present when status === 'priced' (0 means Free).
 */
export interface CostQuote {
    status: CostQuoteStatus;
    amountUsd?: number;
    usage?: NormalizedTokenUsage;
    pricingSource?: 'override' | 'built-in';
}

/**
 * Structured display payload for webview / status bar / notifications.
 * Replaces bare numeric fields so Free / Unpriced / unavailable / partial are expressible.
 */
export type CostDisplayStatus =
    | 'amount'
    | 'free'
    | 'unpriced'
    | 'unavailable'
    | 'none'
    | 'partial';

export interface CostDisplay {
    status: CostDisplayStatus;
    /** Present for amount, free (0), and partial. */
    amountUsd?: number;
}

export interface RepositoryCostSnapshot {
    totalUsd: number;
    pricedCallCount: number;
    unaccountedCallCount: number;
}
