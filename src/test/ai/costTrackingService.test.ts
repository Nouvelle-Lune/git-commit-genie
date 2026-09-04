import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { CostTrackingService } from '../../services/cost/costTrackingService';
import { resolveModelPricing } from '../../services/cost/costAccounting';
import { FlatModelPricing } from '../../services/cost/costTypes';

function flatOverride(input: number, output: number, cachedInput: number): FlatModelPricing {
    return { unit: 'USD_PER_1M_TOKENS', input, output, cachedInput };
}

function createMockContext() {
    const store = new Map<string, unknown>();
    return {
        globalState: {
            get<T>(key: string, defaultValue: T): T {
                return store.has(key) ? store.get(key) as T : defaultValue;
            },
            async update(key: string, value: unknown): Promise<void> {
                store.set(key, value);
            },
            keys(): string[] {
                return [...store.keys()];
            },
        },
        store,
    };
}

describe('CostTrackingService.recordCall', () => {
    it('accumulates priced calls and increments pricedCallCount only', async () => {
        const { globalState, store } = createMockContext();
        const service = new CostTrackingService({ globalState } as never);
        const repoPath = '/tmp/repo-a';
        const pricing = resolveModelPricing('gpt-5');
        const usage = {
            raw: {
                input_tokens: 1_000_000,
                output_tokens: 0,
                input_tokens_details: { cached_tokens: 0 },
            },
        };

        const first = await service.recordCall({ repoPath, provider: 'openai', pricing, usage });
        const second = await service.recordCall({ repoPath, provider: 'openai', pricing, usage });

        assert.equal(first.status, 'priced');
        assert.equal(second.status, 'priced');
        const snapshot = await service.getRepositoryCostSnapshot(repoPath);
        assert.equal(snapshot.totalUsd, 2.5);
        assert.equal(snapshot.pricedCallCount, 2);
        assert.equal(snapshot.unaccountedCallCount, 0);
        assert.ok(store.size >= 2);
    });

    it('tracks unaccounted calls without mutating totalUsd', async () => {
        const { globalState } = createMockContext();
        const service = new CostTrackingService({ globalState } as never);
        const repoPath = '/tmp/repo-b';
        const pricing = resolveModelPricing('unknown-model');

        const quote = await service.recordCall({
            repoPath,
            provider: 'openai',
            pricing,
            usage: { raw: { input_tokens: 100, output_tokens: 20 } },
        });

        assert.equal(quote.status, 'pricing-not-configured');
        assert.equal(quote.amountUsd, undefined);
        const snapshot = await service.getRepositoryCostSnapshot(repoPath);
        assert.equal(snapshot.totalUsd, 0);
        assert.equal(snapshot.pricedCallCount, 0);
        assert.equal(snapshot.unaccountedCallCount, 1);
    });

    it('returns quote without persisting when repoPath is empty', async () => {
        const { globalState, store } = createMockContext();
        const service = new CostTrackingService({ globalState } as never);
        const pricing = resolveModelPricing('gpt-5');

        const quote = await service.recordCall({
            repoPath: '',
            provider: 'openai',
            pricing,
            usage: {
                raw: {
                    input_tokens: 1_000_000,
                    output_tokens: 0,
                },
            },
        });

        assert.equal(quote.status, 'priced');
        assert.equal(quote.amountUsd, 1.25);
        assert.equal(store.size, 0);
    });

    it('records explicit free overrides as priced zero without silent unpriced status', async () => {
        const { globalState } = createMockContext();
        const service = new CostTrackingService({ globalState } as never);
        const repoPath = '/tmp/repo-free';
        const pricing = resolveModelPricing('unknown-model', flatOverride(0, 0, 0));

        const quote = await service.recordCall({
            repoPath,
            provider: 'openai',
            pricing,
            usage: { raw: { input_tokens: 50_000, output_tokens: 10_000 } },
        });

        assert.equal(quote.status, 'priced');
        assert.equal(quote.amountUsd, 0);
        const snapshot = await service.getRepositoryCostSnapshot(repoPath);
        assert.equal(snapshot.totalUsd, 0);
        assert.equal(snapshot.pricedCallCount, 1);
        assert.equal(snapshot.unaccountedCallCount, 0);
    });
});
