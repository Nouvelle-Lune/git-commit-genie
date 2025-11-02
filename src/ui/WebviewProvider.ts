import * as vscode from 'vscode';
import * as path from 'path';
import { ServiceRegistry } from '../core/ServiceRegistry';
import { L10N_KEYS as I18N } from '../i18n/keys';
import { WebviewMessage, ExtensionMessage, RepositoryInfo, I18nTexts } from './types/messages';
import { logger } from '../services/logger';
import { StatusBarManager } from './StatusBarManager';

/**
 * WebviewViewProvider for Git Commit Genie panel
 * Displays repository list with costs
 */
export class WebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'gitCommitGenie.panel';

    private _view?: vscode.WebviewView;
    private _serviceRegistry: ServiceRegistry;
    private _statusBar?: StatusBarManager;
    private _disposables: vscode.Disposable[] = [];

    constructor(
        private readonly _extensionUri: vscode.Uri,
        serviceRegistry: ServiceRegistry,
        statusBar?: StatusBarManager,
    ) {
        this._serviceRegistry = serviceRegistry;
        this._statusBar = statusBar;
        this._setupEventListeners();
        // Ensure Git listeners are registered even if Git API isn't ready at construction time
        // Fire and forget; internal method handles waiting.
        void this._setupGitListenersWhenReady();
    }

    /**
     * Setup event listeners for repository changes
     */
    private _setupEventListeners(): void {
        // Non-Git listeners

        // Listen to cost changes
        const costService = this._serviceRegistry.getCostTrackingService();
        this._disposables.push(
            costService.onCostChanged(() => {
                this._handleRepositoryChange();
            })
        );

        // Listen to analysis running state changes
        if (this._statusBar) {
            this._disposables.push(
                this._statusBar.onAnalysisRunningChanged(() => {
                    this._handleRepositoryChange();
                })
            );
        }

        // Listen to analysis data changes (e.g., clearAnalysis)
        const analysisService = this._serviceRegistry.getAnalysisService();
        this._disposables.push(
            analysisService.onAnalysisChanged(() => {
                this._handleRepositoryChange();
            })
        );
    }

    /**
     * Register Git listeners once the Git API is available. If Git isn't ready yet,
     * waits for RepoService initialization first to avoid missing repository events.
     */
    private async _setupGitListenersWhenReady(): Promise<void> {
        const repoService = this._serviceRegistry.getRepoService();

        // Try immediate registration first
        let gitApi = repoService.getGitApi();
        if (!gitApi) {
            // Await Git initialization (with internal timeout) and retry
            await (repoService as any).whenReady?.();
            gitApi = repoService.getGitApi();
        }

        if (!gitApi) {
            // As a last resort, poll briefly to catch late initialization
            const start = Date.now();
            while (!gitApi && Date.now() - start < 3000) {
                await new Promise(r => setTimeout(r, 150));
                gitApi = repoService.getGitApi();
            }
        }

        if (gitApi) {
            this._disposables.push(
                gitApi.onDidOpenRepository(() => {
                    this._handleRepositoryChange();
                })
            );

            this._disposables.push(
                gitApi.onDidCloseRepository(() => {
                    this._handleRepositoryChange();
                })
            );

            // After listeners are in place, push initial data in case repos became available
            this._handleRepositoryChange();
        }
    }

    /**
     * Handle repository changes
     */
    private _handleRepositoryChange(): void {
        if (this._view) {
            this.sendRepositoryData().catch(err =>
                logger.error('[WebviewProvider] Failed to send repository data:', err)
            );
        }
    }

    /**
     * Dispose resources
     */
    public dispose(): void {
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'dist'),
                // Allow loading codicon.css and fonts
                vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode', 'codicons', 'dist')
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Handle messages from the webview
        this._disposables.push(
            webviewView.webview.onDidReceiveMessage(async (data: WebviewMessage) => {
                if (data.type === 'ready') {
                    // Delay initial data send until Git is likely ready to avoid empty repos/logs
                    await this._sendRepositoryDataWithDelay();
                    // Send current running state
                    try {
                        const running = !!this._statusBar?.isRepoAnalysisRunning();
                        const label = (this._statusBar as any)?.['analysisState']?.runningRepoLabel || undefined;
                        this.sendMessage({ type: 'analysisRunning', running, repoLabel: label } as any);
                    } catch { /* ignore */ }
                } else if (data.type === 'clearLogs') {
                    this.clearLogsAndStorage();
                } else if (data.type === 'openFile') {
                    // Open file in editor
                    try {
                        const uri = vscode.Uri.file(data.filePath);
                        // Check if file exists before opening
                        try {
                            await vscode.workspace.fs.stat(uri);
                            await vscode.window.showTextDocument(uri, { preview: false });
                        } catch (statError) {
                            // File doesn't exist
                            logger.warn(`File does not exist: ${data.filePath}`);
                            vscode.window.showWarningMessage(
                                vscode.l10n.t(I18N.repoAnalysis.mdNotFound)
                            );
                        }
                    } catch (error) {
                        logger.error('Failed to open file:', error);
                    }
                } else if ((data as any).type === 'requestFlushLogs') {
                    try { logger.flushLogsToWebview(); } catch { /* ignore */ }
                } else if (data.type === 'refreshAnalysis') {
                    // Trigger refresh analysis command for specific repo
                    vscode.commands.executeCommand('git-commit-genie.refreshRepositoryAnalysis', data.repoPath);
                } else if (data.type === 'openGenieMenu') {
                    // Open Genie menu
                    vscode.commands.executeCommand('git-commit-genie.genieMenu');
                } else if (data.type === 'cancelAnalysis') {
                    // Cancel repository analysis
                    vscode.commands.executeCommand('git-commit-genie.cancelRepositoryAnalysis');
                }
            })
        );
    }

    /**
     * Attempt to wait for Git to be ready and repositories to be discovered before sending data.
     * Falls back to sending immediately if waiting times out.
     */
    private async _sendRepositoryDataWithDelay(): Promise<void> {
        try {
            const repoService = this._serviceRegistry.getRepoService();

            // If no repositories yet, wait for initialization and a short grace period
            const hasRepos = () => (repoService.getRepositories() || []).length > 0;
            if (!hasRepos()) {
                await (repoService as any).whenReady?.();

                const start = Date.now();
                while (!hasRepos() && Date.now() - start < 2000) {
                    await new Promise(r => setTimeout(r, 150));
                }
            }
        } catch {
            // ignore waiting errors
        }

        await this.sendRepositoryData();
    }

    /**
     * Clear logs from the UI only
     */
    public clearLogs(): void {
        if (this._view) {
            this._view.webview.postMessage({ type: 'clearLogs' });
        }
    }

    /**
     * Clear logs for current workspace repos from storage and UI
     */
    public clearLogsAndStorage(): void {
        try {
            const repos = this._serviceRegistry.getRepoService().getRepositories() || [];
            const repoPaths = repos.map(r => r.rootUri.fsPath).filter(Boolean);
            if (repoPaths.length > 0) {
                logger.clearLogBufferForRepositories(repoPaths);
            } else {
                logger.clearLogBuffer();
            }
        } catch { /* ignore */ }
        this.clearLogs();
    }

    /**
     * Mark all pending logs in the webview as cancelled
     */
    public cancelPendingLogs(): void {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'cancelPendingLogs'
            });
        }
    }

    /**
     * Send message to webview
     */
    public sendMessage(message: ExtensionMessage): void {
        if (this._view) {
            this._view.webview.postMessage(message);
        }
    }

    /**
     * Send analysis running state to webview
     */
    public sendAnalysisRunning(running: boolean, repoLabel?: string): void {
        this.sendMessage({ type: 'analysisRunning', running, repoLabel } as any);
    }

    /**
     * Update webview content
     */
    public updateContent(): void {
        this.sendRepositoryData();
    }

    /**
     * Get repository data
     */
    private async getRepositoryData(): Promise<{
        repositories: RepositoryInfo[];
        i18n: I18nTexts;
    }> {
        const repoService = this._serviceRegistry.getRepoService();
        const costService = this._serviceRegistry.getCostTrackingService();
        const analysisService = this._serviceRegistry.getAnalysisService();
        const repositories = repoService.getRepositories();

        const isRepoAnalysisEnabled = vscode.workspace.getConfiguration('gitCommitGenie.repositoryAnalysis').get<boolean>('enabled', true);
        const runningRepoPath = this._statusBar?.isRepoAnalysisRunning() ? (this._statusBar as any)?.['analysisState']?.runningRepoPath : null;

        const repoCosts: RepositoryInfo[] = [];
        for (const repo of repositories) {
            const repoPath = repo.rootUri.fsPath;
            const repoName = path.basename(repoPath);
            const cost = await costService.getRepositoryCost(repoPath);

            // Determine analysis status
            let analysisStatus: 'missing' | 'analyzing' | 'idle' = 'missing';
            let analysisPath: string | undefined;

            if (isRepoAnalysisEnabled) {
                if (runningRepoPath === repoPath) {
                    analysisStatus = 'analyzing';
                } else {
                    try {
                        const analysis = await analysisService.getAnalysis(repoPath);
                        if (analysis) {
                            analysisStatus = 'idle';
                            analysisPath = path.join(repoPath, '.gitgenie', 'repository-analysis.md');
                        }
                    } catch {
                        analysisStatus = 'missing';
                    }
                }
            } else {
                analysisStatus = 'idle'; // If disabled, show as idle
            }

            repoCosts.push({
                name: repoName,
                path: repoPath,
                cost,
                analysisStatus,
                analysisPath
            });
        }

        return {
            repositories: repoCosts,
            i18n: {
                repositoryList: vscode.l10n.t(I18N.dashboard.repositoryList),
                logs: vscode.l10n.t(I18N.dashboard.logs),
                noLogsYet: vscode.l10n.t(I18N.dashboard.noLogsYet),
                clearLogs: vscode.l10n.t(I18N.dashboard.clearLogs),
                analyzing: vscode.l10n.t(I18N.dashboard.analyzing),
                refreshAnalysis: vscode.l10n.t(I18N.dashboard.refreshAnalysis),
                cancelAnalysis: vscode.l10n.t(I18N.dashboard.cancelAnalysis),
                viewAnalysis: vscode.l10n.t(I18N.dashboard.viewAnalysis),
                analysisStatusMissing: vscode.l10n.t(I18N.dashboard.analysisStatusMissing),
                analysisStatusAnalyzing: vscode.l10n.t(I18N.dashboard.analysisStatusAnalyzing),
                analysisStatusIdle: vscode.l10n.t(I18N.dashboard.analysisStatusIdle),
                openSettings: vscode.l10n.t(I18N.actions.openSettings)
            }
        };
    }

    /**
     * Send repository data to webview
     */
    public async sendRepositoryData(): Promise<void> {
        const data = await this.getRepositoryData();
        this.sendMessage({
            type: 'updateRepo',
            ...data
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        // Get URIs for the bundled webview code
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview.js')
        );

        // Get codicon font URI
        const codiconsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css')
        );

        // Use a nonce to only allow specific scripts to be run
        const nonce = getNonce();

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="${codiconsUri}" rel="stylesheet" />
                <title>Git Commit Genie</title>
            </head>
            <body>
                <div id="root"></div>
                <script nonce="${nonce}" src="${scriptUri}"></script>
            </body>
            </html>`;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
