import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../../logger';
import { L10N_KEYS as I18N } from '../../../../i18n/keys';
import { ChatMessage } from '../../llmTypes';
import { ProviderError } from '../errors/providerError';

/**
 * Common utility functions for LLM providers
 */
export abstract class BaseProviderUtils {
    protected context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;

    }

    /**
     * Validate that a client is initialized
     * @throws ProviderError if client is null/undefined
     */
    protected validateClient(client: any, providerName: string): void {
        if (!client) {
            throw ProviderError.clientNotInitialized(providerName);
        }
    }

    /**
     * Validate that a model is selected
     * @throws ProviderError if model is empty
     */
    protected validateModel(model: string | undefined, providerName: string): void {
        if (!model || model.trim().length === 0) {
            throw ProviderError.modelNotSelected(providerName);
        }
    }

    /**
 * Get unified provider configuration combining common settings with provider-specific model
 * @param providerKey The provider's configuration key prefix (e.g., 'gitCommitGenie')
 * @param modelStateKey The global state key for the model (e.g., 'openaiModel')
 * @returns Configuration object with model, useChain, chainMaxParallel, maxRetries
 */
    /**
     * Get unified provider configuration combining common settings with provider-specific model
     * @param providerKey The provider's configuration key prefix (e.g., 'gitCommitGenie')
     * @param modelStateKey The global state key for the model (e.g., 'openaiModel')
     * @returns Configuration object with model, useChain, chainMaxParallel, maxRetries
     */
    public getProviderConfig(providerKey: string, modelStateKey: string): {
        model: string;
        useChain: boolean;
        chainMaxParallel: number;
        maxRetries: number;
    } {
        const commonConfig = this.getCommonConfig();
        return {
            ...commonConfig,
            model: this.context.globalState.get<string>(`${providerKey}.${modelStateKey}`, '')
        };
    }

    /**
     * Get repository analysis model override if configured for this provider
     * @param supportedModels List of models supported by this provider
     * @returns Override model string or null if using general setting
     */
    public getRepoAnalysisOverrideModel(supportedModels: string[]): string | null {
        try {
            const cfg = vscode.workspace.getConfiguration('gitCommitGenie.repositoryAnalysis');
            const value = (cfg.get<string>('model', 'general') || 'general').trim();
            if (!value || value === 'general') {
                return null;
            }
            // Only apply override if the selected model belongs to this provider
            return supportedModels.includes(value) ? value : null;
        } catch {
            return null;
        }
    }

    /**
     * Sleep for specified milliseconds
     */
    public async sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Extract retry delay from error message
     */
    public getRetryDelayMs(err: any): number {
        const defaultDelay = 2000;
        const msg: string = err?.message || '';
        const match = msg.match(/retry in\s+([0-9.]+)s/i);
        if (match) {
            const seconds = parseFloat(match[1]);
            if (!isNaN(seconds)) {
                return Math.max(1000, Math.floor(seconds * 1000));
            }
        }
        return defaultDelay;
    }

    /**
     * Show rate limit warning (with throttling to avoid spam)
     */
    public async maybeWarnRateLimit(provider: string, model: string): Promise<void> {
        const key = `gitCommitGenie.${provider.toLowerCase()}RateLimitWarned`;
        const lastWarned = this.context.globalState.get<number>(key, 0) ?? 0;
        const now = Date.now();

        // Only show warning once per minute
        if (now - lastWarned < 60_000) {
            return;
        }

        await this.context.globalState.update(key, now);

        const choice = await vscode.window.showWarningMessage(
            vscode.l10n.t(I18N.rateLimit.hit, provider, model, vscode.l10n.t(I18N.settings.chainMaxParallelLabel)),
            vscode.l10n.t(I18N.actions.openSettings),
            vscode.l10n.t(I18N.actions.dismiss)
        );

        if (choice === vscode.l10n.t(I18N.actions.openSettings)) {
            vscode.commands.executeCommand('workbench.action.openSettings', 'gitCommitGenie.chain.maxParallel');
        }
    }

    /**
     * Get common configuration values
     */
    public getCommonConfig() {
        const cfg = vscode.workspace.getConfiguration();
        return {
            useChain: ((): boolean => {
                const v = cfg.get<boolean>('gitCommitGenie.chain.enabled');
                if (typeof v === 'boolean') { return v; }
                return cfg.get<boolean>('gitCommitGenie.useChainPrompts', false);
            })(),
            chainMaxParallel: Math.max(1, ((): number => {
                const v = cfg.get<number>('gitCommitGenie.chain.maxParallel');
                if (typeof v === 'number' && !isNaN(v)) { return v; }
                return cfg.get<number>('gitCommitGenie.chainMaxParallel', 4);
            })()),
            maxRetries: Math.max(1, ((): number => {
                const v = cfg.get<number>('gitCommitGenie.llm.maxRetries');
                if (typeof v === 'number' && !isNaN(v)) { return v; }
                return 2;
            })())
        };
    }

    /**
     * Read global max retries for provider calls
     */
    public getMaxRetries(): number {
        const cfg = vscode.workspace.getConfiguration();
        const v = cfg.get<number>('gitCommitGenie.llm.maxRetries');
        if (typeof v === 'number' && !isNaN(v) && v >= 1) { return v; }
        return 2;
    }

    /**
     * Read global temperature for provider calls
     */
    public getTemperature(): number {
        const cfg = vscode.workspace.getConfiguration();
        const v = cfg.get<number>('gitCommitGenie.llm.temperature');
        if (typeof v === 'number' && !isNaN(v)) {
            return v;
        }
        return 0.2;
    }

    /**
     * Get rules file content
     */
    public getRules() {
        const rulesPath = this.context.asAbsolutePath(path.join('resources', 'agentRules', 'baseRules.md'));
        const checklistPath = this.context.asAbsolutePath(path.join('resources', 'agentRules', 'validationChecklist.md'));

        return {
            baseRule: fs.readFileSync(rulesPath, 'utf-8'),
            checklistText: fs.existsSync(checklistPath) ? fs.readFileSync(checklistPath, 'utf-8') : ''
        };
    }

    /**
     * Handle cancellation check
     */
    protected checkCancellation(token?: vscode.CancellationToken): void {
        if (token?.isCancellationRequested) {
            throw new Error('Cancelled');
        }
    }

    /**
     * Create abort controller with token support
     */
    protected createAbortController(token?: vscode.CancellationToken): AbortController {
        const controller = new AbortController();
        token?.onCancellationRequested(() => controller.abort());
        return controller;
    }
}
