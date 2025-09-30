import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../../logger';
import { L10N_KEYS as I18N } from '../../../../i18n/keys';

/**
 * Common utility functions for LLM providers
 */
export class BaseProviderUtils {
    protected context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;

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
