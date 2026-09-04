import * as vscode from 'vscode';
import { logger } from '../logger';
import {
    CostQuote,
    RepositoryCostSnapshot,
    ResolvedModelPricing,
} from './costTypes';
import {
    computeUsageCostUsd,
    normalizeProviderUsage,
} from './costAccounting';
import type { AIUsage, ProviderKind } from '../llm/providers/types';

interface RepositoryCostMeta {
    pricedCallCount: number;
    unaccountedCallCount: number;
}

/**
 * Unique cost-accounting entry point.
 * Every successful LLM response (normal, structured retry, agent) must go through recordCall once.
 */
export class CostTrackingService {
    private context: vscode.ExtensionContext | null = null;
    private readonly _onCostChanged = new vscode.EventEmitter<void>();
    public readonly onCostChanged = this._onCostChanged.event;

    constructor(context: vscode.ExtensionContext) {
        this.initialize(context);
    }

    public initialize(context: vscode.ExtensionContext): void {
        this.context = context;
    }

    /**
     * Standardize usage, compute cost from the execution-bound pricing snapshot,
     * update repository totals, and return the shared CostQuote.
     */
    public async recordCall(params: {
        repoPath: string;
        provider: ProviderKind | string;
        pricing: ResolvedModelPricing;
        usage: AIUsage | undefined;
    }): Promise<CostQuote> {
        const quote = this.quoteCall(params.provider, params.pricing, params.usage);
        if (params.repoPath) {
            await this.applyQuoteToRepository(params.repoPath, quote);
        }
        return quote;
    }

    /**
     * Pure quote computation without mutating repository totals.
     * Useful for tests and for callers that already applied accumulation.
     */
    public quoteCall(
        provider: ProviderKind | string,
        pricing: ResolvedModelPricing,
        usage: AIUsage | undefined,
    ): CostQuote {
        if (pricing.status === 'unpriced') {
            const normalized = normalizeProviderUsage(provider, usage);
            if (!normalized.ok) {
                return {
                    status: normalized.reason === 'missing' ? 'usage-not-reported' : 'invalid-usage',
                };
            }
            return {
                status: 'pricing-not-configured',
                usage: normalized.usage,
            };
        }

        const normalized = normalizeProviderUsage(provider, usage);
        if (!normalized.ok) {
            return {
                status: normalized.reason === 'missing' ? 'usage-not-reported' : 'invalid-usage',
            };
        }

        const amountUsd = computeUsageCostUsd(pricing.rates, normalized.usage);
        return {
            status: 'priced',
            amountUsd,
            usage: normalized.usage,
            pricingSource: pricing.source,
        };
    }

    public async getRepositoryCostSnapshot(repoPath: string): Promise<RepositoryCostSnapshot> {
        const context = this.requireContext();
        const totalUsd = context.globalState.get<number>(this.costKey(repoPath), 0);
        const meta = context.globalState.get<RepositoryCostMeta>(this.metaKey(repoPath), {
            pricedCallCount: 0,
            unaccountedCallCount: 0,
        });
        return {
            totalUsd,
            pricedCallCount: meta.pricedCallCount,
            unaccountedCallCount: meta.unaccountedCallCount,
        };
    }

    /** @deprecated Prefer getRepositoryCostSnapshot — kept for transitional call sites. */
    public async getRepositoryCost(repoPath: string): Promise<number> {
        const snapshot = await this.getRepositoryCostSnapshot(repoPath);
        return snapshot.totalUsd;
    }

    public async resetRepositoryCost(repoPath: string): Promise<void> {
        const context = this.requireContext();
        await context.globalState.update(this.costKey(repoPath), 0);
        await context.globalState.update(this.metaKey(repoPath), {
            pricedCallCount: 0,
            unaccountedCallCount: 0,
        });
        this._onCostChanged.fire();
    }

    public async getAllRepositoryCosts(): Promise<Map<string, number>> {
        const context = this.requireContext();
        const costs = new Map<string, number>();
        const keys = context.globalState.keys().filter(key => key.startsWith('gitCommitGenie.repositoryCost.'));
        for (const key of keys) {
            // Skip meta keys if any share the prefix pattern historically — cost keys only.
            if (key.startsWith('gitCommitGenie.repositoryCostMeta.')) {
                continue;
            }
            const cost = context.globalState.get<number>(key, 0);
            const base64Path = key.replace('gitCommitGenie.repositoryCost.', '');
            const repositoryPath = Buffer.from(base64Path, 'base64').toString('utf-8');
            costs.set(repositoryPath, cost);
        }
        return costs;
    }

    private async applyQuoteToRepository(repoPath: string, quote: CostQuote): Promise<void> {
        const context = this.requireContext();
        const costKey = this.costKey(repoPath);
        const metaKey = this.metaKey(repoPath);
        const existingCost = context.globalState.get<number>(costKey, 0);
        const meta = context.globalState.get<RepositoryCostMeta>(metaKey, {
            pricedCallCount: 0,
            unaccountedCallCount: 0,
        });

        if (quote.status === 'priced') {
            const amount = quote.amountUsd ?? 0;
            const newTotal = existingCost + amount;
            await context.globalState.update(costKey, newTotal);
            await context.globalState.update(metaKey, {
                pricedCallCount: meta.pricedCallCount + 1,
                unaccountedCallCount: meta.unaccountedCallCount,
            });
            logger.debug(
                `[CostTrackingService] Repository cost updated: +$${amount.toFixed(6)} | Total: $${newTotal.toFixed(6)}`,
            );
        } else {
            await context.globalState.update(metaKey, {
                pricedCallCount: meta.pricedCallCount,
                unaccountedCallCount: meta.unaccountedCallCount + 1,
            });
            logger.debug(
                `[CostTrackingService] Unaccounted call recorded (${quote.status}) for ${repoPath}`,
            );
        }
        this._onCostChanged.fire();
    }

    private costKey(repoPath: string): string {
        return `gitCommitGenie.repositoryCost.${Buffer.from(repoPath).toString('base64')}`;
    }

    private metaKey(repoPath: string): string {
        return `gitCommitGenie.repositoryCostMeta.${Buffer.from(repoPath).toString('base64')}`;
    }

    private requireContext(): vscode.ExtensionContext {
        if (!this.context) {
            throw new Error('CostTrackingService context is not initialized.');
        }
        return this.context;
    }
}
