import {
    CostDisplay,
    CostQuote,
    RepositoryCostSnapshot,
} from './costTypes';

/** Format a single-call quote for logs, notifications, and output channel. */
export function formatCostQuoteLabel(quote: CostQuote): string {
    switch (quote.status) {
        case 'priced':
            if (quote.amountUsd === undefined) {
                throw new Error('Priced CostQuote is missing amountUsd.');
            }
            return quote.amountUsd === 0 ? 'Free' : `$${quote.amountUsd.toFixed(6)}`;
        case 'pricing-not-configured':
            return 'Unpriced';
        case 'usage-not-reported':
        case 'invalid-usage':
            return 'Cost unavailable';
        default: {
            const _exhaustive: never = quote.status;
            return _exhaustive;
        }
    }
}

/** Map a per-call quote into the structured webview cost field. */
export function costQuoteToDisplay(quote: CostQuote): CostDisplay {
    switch (quote.status) {
        case 'priced':
            if (quote.amountUsd === undefined) {
                throw new Error('Priced CostQuote is missing amountUsd.');
            }
            return quote.amountUsd === 0
                ? { status: 'free', amountUsd: 0 }
                : { status: 'amount', amountUsd: quote.amountUsd };
        case 'pricing-not-configured':
            return { status: 'unpriced' };
        case 'usage-not-reported':
        case 'invalid-usage':
            return { status: 'unavailable' };
        default: {
            const _exhaustive: never = quote.status;
            return _exhaustive;
        }
    }
}

/** Map repository accumulation into structured display (including partial totals). */
export function repositoryCostToDisplay(snapshot: RepositoryCostSnapshot): CostDisplay {
    const { totalUsd, pricedCallCount, unaccountedCallCount } = snapshot;
    if (pricedCallCount === 0 && unaccountedCallCount === 0) {
        return { status: 'none' };
    }
    if (unaccountedCallCount > 0) {
        return { status: 'partial', amountUsd: totalUsd };
    }
    if (totalUsd === 0) {
        return { status: 'free', amountUsd: 0 };
    }
    return { status: 'amount', amountUsd: totalUsd };
}

/** Human-readable repository cost for status bar / commands. */
export function formatRepositoryCostLabel(snapshot: RepositoryCostSnapshot): string {
    const display = repositoryCostToDisplay(snapshot);
    switch (display.status) {
        case 'none':
            return 'No Genie usage cost recorded for this repository yet.';
        case 'free':
            return 'Total Genie usage cost for this repository: Free';
        case 'amount':
            return `Total Genie usage cost for this repository: $${(display.amountUsd ?? 0).toFixed(6)}`;
        case 'partial':
            return `Total Genie usage cost for this repository: $${(display.amountUsd ?? 0).toFixed(6)} (incomplete)`;
        default:
            return `Total Genie usage cost for this repository: $${totalUsdFallback(snapshot)}`;
    }
}

function totalUsdFallback(snapshot: RepositoryCostSnapshot): string {
    return snapshot.totalUsd.toFixed(6);
}

/**
 * Aggregate quotes already recorded for one task.
 * Returns undefined when no priced calls occurred (notification should stay silent).
 */
export function summarizeTaskCostQuotes(quotes: readonly CostQuote[]): {
    totalUsd: number;
    cacheHitPercent: number;
    pricedCallCount: number;
} | undefined {
    const priced = quotes.filter(quote => quote.status === 'priced' && quote.usage);
    if (priced.length === 0) {
        return undefined;
    }
    let totalUsd = 0;
    let inputTokens = 0;
    let cachedInputTokens = 0;
    for (const quote of priced) {
        totalUsd += quote.amountUsd ?? 0;
        inputTokens += quote.usage!.inputTokens;
        cachedInputTokens += quote.usage!.cachedInputTokens;
    }
    const cacheHitPercent = inputTokens > 0 ? (cachedInputTokens / inputTokens) * 100 : 0;
    return { totalUsd, cacheHitPercent, pricedCallCount: priced.length };
}

/** Format CostDisplay for the webview list / log chips. */
export function formatCostDisplayShort(display: CostDisplay, fractionDigits: number): string {
    switch (display.status) {
        case 'none':
            return '$0.00';
        case 'free':
            return 'Free';
        case 'unpriced':
            return 'Unpriced';
        case 'unavailable':
            return 'Cost unavailable';
        case 'amount':
            return `$${(display.amountUsd ?? 0).toFixed(fractionDigits)}`;
        case 'partial':
            return `$${(display.amountUsd ?? 0).toFixed(fractionDigits)}*`;
        default: {
            const _exhaustive: never = display.status;
            return _exhaustive;
        }
    }
}
