import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import {
    costQuoteToDisplay,
    formatCostDisplayShort,
    formatCostQuoteLabel,
    repositoryCostToDisplay,
    summarizeTaskCostQuotes,
} from '../../services/cost/costDisplay';
import { CostQuote } from '../../services/cost/costTypes';

describe('formatCostQuoteLabel', () => {
    it('formats priced non-zero amounts with six decimal places', () => {
        const label = formatCostQuoteLabel({
            status: 'priced',
            amountUsd: 0.001234,
        });
        assert.equal(label, '$0.001234');
    });

    it('labels explicit free priced quotes as Free', () => {
        const label = formatCostQuoteLabel({
            status: 'priced',
            amountUsd: 0,
        });
        assert.equal(label, 'Free');
    });

    it('labels unconfigured pricing as Unpriced', () => {
        const label = formatCostQuoteLabel({ status: 'pricing-not-configured' });
        assert.equal(label, 'Unpriced');
    });

    it('labels missing or invalid usage as Cost unavailable', () => {
        assert.equal(formatCostQuoteLabel({ status: 'usage-not-reported' }), 'Cost unavailable');
        assert.equal(formatCostQuoteLabel({ status: 'invalid-usage' }), 'Cost unavailable');
    });
});

describe('costQuoteToDisplay', () => {
    it('maps priced quotes to amount or free display', () => {
        assert.deepEqual(
            costQuoteToDisplay({ status: 'priced', amountUsd: 0.001 }),
            { status: 'amount', amountUsd: 0.001 },
        );
        assert.deepEqual(
            costQuoteToDisplay({ status: 'priced', amountUsd: 0 }),
            { status: 'free', amountUsd: 0 },
        );
    });

    it('maps unconfigured pricing and unavailable usage to distinct display statuses', () => {
        assert.deepEqual(costQuoteToDisplay({ status: 'pricing-not-configured' }), { status: 'unpriced' });
        assert.deepEqual(costQuoteToDisplay({ status: 'usage-not-reported' }), { status: 'unavailable' });
        assert.deepEqual(costQuoteToDisplay({ status: 'invalid-usage' }), { status: 'unavailable' });
    });
});

describe('formatCostDisplayShort', () => {
    it('formats repository and per-call display chips consistently', () => {
        assert.equal(formatCostDisplayShort({ status: 'none' }, 4), '$0.00');
        assert.equal(formatCostDisplayShort({ status: 'free' }, 4), 'Free');
        assert.equal(formatCostDisplayShort({ status: 'unpriced' }, 4), 'Unpriced');
        assert.equal(formatCostDisplayShort({ status: 'unavailable' }, 4), 'Cost unavailable');
        assert.equal(formatCostDisplayShort({ status: 'amount', amountUsd: 0.1234 }, 4), '$0.1234');
        assert.equal(formatCostDisplayShort({ status: 'partial', amountUsd: 0.5 }, 4), '$0.5000*');
    });
});

describe('repositoryCostToDisplay', () => {
    it('returns none when no calls were recorded', () => {
        assert.deepEqual(
            repositoryCostToDisplay({ totalUsd: 0, pricedCallCount: 0, unaccountedCallCount: 0 }),
            { status: 'none' },
        );
    });

    it('returns free when priced total is zero', () => {
        assert.deepEqual(
            repositoryCostToDisplay({ totalUsd: 0, pricedCallCount: 2, unaccountedCallCount: 0 }),
            { status: 'free', amountUsd: 0 },
        );
    });

    it('returns amount when all calls were priced with non-zero total', () => {
        assert.deepEqual(
            repositoryCostToDisplay({ totalUsd: 0.42, pricedCallCount: 3, unaccountedCallCount: 0 }),
            { status: 'amount', amountUsd: 0.42 },
        );
    });

    it('returns partial when some calls were unaccounted', () => {
        assert.deepEqual(
            repositoryCostToDisplay({ totalUsd: 0.15, pricedCallCount: 1, unaccountedCallCount: 2 }),
            { status: 'partial', amountUsd: 0.15 },
        );
    });
});

describe('summarizeTaskCostQuotes', () => {
    const pricedUsage = {
        inputTokens: 1_000,
        outputTokens: 100,
        cachedInputTokens: 250,
        totalTokens: 1_100,
    };

    it('returns undefined when no priced quotes exist', () => {
        const summary = summarizeTaskCostQuotes([
            { status: 'pricing-not-configured' },
            { status: 'usage-not-reported' },
        ]);
        assert.equal(summary, undefined);
    });

    it('aggregates only priced quotes with usage', () => {
        const quotes: CostQuote[] = [
            {
                status: 'priced',
                amountUsd: 0.01,
                usage: pricedUsage,
            },
            {
                status: 'priced',
                amountUsd: 0.02,
                usage: {
                    inputTokens: 500,
                    outputTokens: 50,
                    cachedInputTokens: 100,
                    totalTokens: 550,
                },
            },
            { status: 'invalid-usage' },
        ];
        const summary = summarizeTaskCostQuotes(quotes);
        assert.ok(summary);
        assert.equal(summary.totalUsd, 0.03);
        assert.equal(summary.pricedCallCount, 2);
        assert.equal(summary.cacheHitPercent, 23.333333333333332);
    });
});
