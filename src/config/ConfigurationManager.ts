import * as vscode from 'vscode';
import { logger, LogLevel } from '../services/logger';

export class ConfigurationManager {
    constructor(private context: vscode.ExtensionContext) { }

    async initialize(): Promise<void> {
        // Initialize logger based on configuration
        const outputChannel = vscode.window.createOutputChannel('Git Commit Genie');
        const config = vscode.workspace.getConfiguration('gitCommitGenie');
        const logLevel = config.get<string>('logLevel', 'info');
        const level = this.getLogLevel(logLevel);
        logger.initialize(outputChannel, level, this.context);
        await logger.loadPersistedLogs();
        this.context.subscriptions.push(outputChannel);

        // Set initial context values
        await this.updateContextKeys();

        // Listen to configuration changes
        this.context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(this.onConfigurationChanged.bind(this))
        );
    }

    async dispose(): Promise<void> {
        // Cleanup if needed
    }

    readChainEnabled(): boolean {
        const cfg = vscode.workspace.getConfiguration();
        // New key
        const newVal = cfg.get<boolean>('gitCommitGenie.chain.enabled');
        if (typeof newVal === 'boolean') {
            this.context.globalState.update('gitCommitGenie.useChainPrompts', newVal);
            return newVal;
        } else {
            // newVal is undefined
            return false;
        }
    }

    isRepoAnalysisEnabled(): boolean {
        try {
            return vscode.workspace.getConfiguration('gitCommitGenie.repositoryAnalysis').get<boolean>('enabled', true);
        } catch {
            return true;
        }
    }

    private getLogLevel(logLevel: string): LogLevel {
        switch (logLevel.toLowerCase()) {
            case 'debug': return LogLevel.Debug;
            case 'warn': return LogLevel.Warning;
            case 'error': return LogLevel.Error;
            default: return LogLevel.Info;
        }
    }

    private async updateContextKeys(): Promise<void> {
        await vscode.commands.executeCommand('setContext', 'gitCommitGenie.repositoryAnalysisEnabled', this.isRepoAnalysisEnabled());
    }

    private async onConfigurationChanged(e: vscode.ConfigurationChangeEvent): Promise<void> {
        const chainChanged = e.affectsConfiguration('gitCommitGenie.useChainPrompts') ||
            e.affectsConfiguration('gitCommitGenie.chain.enabled');
        const repoAnalysisChanged = e.affectsConfiguration('gitCommitGenie.repositoryAnalysis.enabled');
        const logLevelChanged = e.affectsConfiguration('gitCommitGenie.logLevel');

        if (logLevelChanged) {
            try {
                const cfg = vscode.workspace.getConfiguration('gitCommitGenie');
                const logLevel = (cfg.get<string>('logLevel', 'info') || 'info').toLowerCase();
                const level = this.getLogLevel(logLevel);
                logger.setLogLevel(level);
                logger.info(`Log level changed to ${logLevel}`);
            } catch { }
        }

        if (repoAnalysisChanged) {
            await this.updateContextKeys();
        }

        // Notify other components about config changes
        if (chainChanged || repoAnalysisChanged) {
            vscode.commands.executeCommand('git-commit-genie.updateStatusBar');
        }
    }
}
