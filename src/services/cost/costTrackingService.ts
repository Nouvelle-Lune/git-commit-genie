import * as vscode from 'vscode';
import { logger } from "../logger";
/**
 * Cost tracking service for AI API usage
 * Handles repository-based cost accumulation and storage
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
     * Add cost to repository total
     */
    public async addToRepositoryCost(cost: number, repoPath: string): Promise<void> {
        if (!this.context) {
            logger.warn('[CostTrackingService] Context not available for cost tracking');
            return;
        }

        try {

            const costKey = `gitCommitGenie.repositoryCost.${Buffer.from(repoPath).toString('base64')}`;

            // Get existing cost and add new cost
            const existingCost = this.context.globalState.get<number>(costKey, 0);
            const newTotalCost = existingCost + cost;

            // Save updated cost
            await this.context.globalState.update(costKey, newTotalCost);

            logger.debug(`[CostTrackingService] Repository cost updated: +$${cost.toFixed(6)} | Total: $${newTotalCost.toFixed(6)}`);
            // Notify listeners so UI can refresh immediately
            this._onCostChanged.fire();
        } catch (error) {
            logger.warn(`[CostTrackingService] Failed to update repository cost: ${error}`);
        }
    }

    /**
     * Get total cost for current repository
     */
    public async getRepositoryCost(repoPath: string): Promise<number> {
        if (!this.context) {
            return 0;
        }

        try {
            const costKey = `gitCommitGenie.repositoryCost.${Buffer.from(repoPath).toString('base64')}`;

            return this.context.globalState.get<number>(costKey, 0);
        } catch (error) {
            logger.warn(`[CostTrackingService] Failed to get repository cost: ${error}`);
            return 0;
        }
    }

    /**
     * Reset repository cost to zero
     */
    public async resetRepositoryCost(repoPath: string): Promise<void> {
        if (!this.context) {
            return;
        }

        try {

            const costKey = `gitCommitGenie.repositoryCost.${Buffer.from(repoPath).toString('base64')}`;

            await this.context.globalState.update(costKey, 0);
            // Notify listeners so UI can refresh immediately
            this._onCostChanged.fire();
        } catch (error) {
            logger.warn(`[CostTrackingService] Failed to reset repository cost: ${error}`);
        }
    }

    /**
     * Get all repository costs
     */
    public async getAllRepositoryCosts(): Promise<Map<string, number>> {
        const costs = new Map<string, number>();

        if (!this.context) {
            return costs;
        }

        try {
            const keys = this.context.globalState.keys();
            const costKeys = keys.filter(key => key.startsWith('gitCommitGenie.repositoryCost.'));

            for (const key of costKeys) {
                const cost = this.context.globalState.get<number>(key, 0);
                // Decode the repository path from base64
                const base64Path = key.replace('gitCommitGenie.repositoryCost.', '');
                const repositoryPath = Buffer.from(base64Path, 'base64').toString('utf-8');
                costs.set(repositoryPath, cost);
            }
        } catch (error) {
            logger.warn(`[CostTrackingService] Failed to get all repository costs: ${error}`);
        }

        return costs;
    }
}
