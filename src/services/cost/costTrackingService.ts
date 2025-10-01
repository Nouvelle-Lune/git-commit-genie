import * as vscode from 'vscode';

/**
 * Cost tracking service for AI API usage
 * Handles repository-based cost accumulation and storage
 */
export class CostTrackingService {
    private static instance: CostTrackingService;
    private context: vscode.ExtensionContext | null = null;
    private readonly _onCostChanged = new vscode.EventEmitter<void>();
    public readonly onCostChanged = this._onCostChanged.event;

    private constructor() { }

    public static getInstance(): CostTrackingService {
        if (!CostTrackingService.instance) {
            CostTrackingService.instance = new CostTrackingService();
        }
        return CostTrackingService.instance;
    }

    public initialize(context: vscode.ExtensionContext): void {
        this.context = context;
    }

    /**
     * Add cost to repository total
     */
    public async addToRepositoryCost(cost: number): Promise<void> {
        if (!this.context) {
            console.warn('[CostTrackingService] Context not available for cost tracking');
            return;
        }

        try {
            // Get current workspace folder path as repository identifier
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                console.warn('[CostTrackingService] No workspace folder found for cost tracking');
                return;
            }

            const repositoryPath = workspaceFolders[0].uri.fsPath;
            const costKey = `gitCommitGenie.repositoryCost.${Buffer.from(repositoryPath).toString('base64')}`;

            // Get existing cost and add new cost
            const existingCost = this.context.globalState.get<number>(costKey, 0);
            const newTotalCost = existingCost + cost;

            // Save updated cost
            await this.context.globalState.update(costKey, newTotalCost);

            console.debug(`[CostTrackingService] Repository cost updated: +$${cost.toFixed(6)} | Total: $${newTotalCost.toFixed(6)}`);
            // Notify listeners so UI can refresh immediately
            this._onCostChanged.fire();
        } catch (error) {
            console.warn(`[CostTrackingService] Failed to update repository cost: ${error}`);
        }
    }

    /**
     * Get total cost for current repository
     */
    public async getRepositoryCost(): Promise<number> {
        if (!this.context) {
            return 0;
        }

        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                return 0;
            }

            const repositoryPath = workspaceFolders[0].uri.fsPath;
            const costKey = `gitCommitGenie.repositoryCost.${Buffer.from(repositoryPath).toString('base64')}`;

            return this.context.globalState.get<number>(costKey, 0);
        } catch (error) {
            console.warn(`[CostTrackingService] Failed to get repository cost: ${error}`);
            return 0;
        }
    }

    /**
     * Reset repository cost to zero
     */
    public async resetRepositoryCost(): Promise<void> {
        if (!this.context) {
            return;
        }

        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                return;
            }

            const repositoryPath = workspaceFolders[0].uri.fsPath;
            const costKey = `gitCommitGenie.repositoryCost.${Buffer.from(repositoryPath).toString('base64')}`;

            await this.context.globalState.update(costKey, 0);
            // Notify listeners so UI can refresh immediately
            this._onCostChanged.fire();
        } catch (error) {
            console.warn(`[CostTrackingService] Failed to reset repository cost: ${error}`);
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
            console.warn(`[CostTrackingService] Failed to get all repository costs: ${error}`);
        }

        return costs;
    }
}

// Export a global instance
export const costTracker = CostTrackingService.getInstance();
