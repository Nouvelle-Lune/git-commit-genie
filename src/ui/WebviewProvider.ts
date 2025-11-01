import * as vscode from 'vscode';
import * as path from 'path';
import { ServiceRegistry } from '../core/ServiceRegistry';
import { L10N_KEYS as I18N } from '../i18n/keys';
import { WebviewMessage, ExtensionMessage, RepositoryInfo } from './types/messages';
import { logger } from '../services/logger';

/**
 * WebviewViewProvider for Git Commit Genie panel
 * Displays repository list with costs
 */
export class WebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'gitCommitGenie.panel';

    private _view?: vscode.WebviewView;
    private _serviceRegistry: ServiceRegistry;
    private _disposables: vscode.Disposable[] = [];

    constructor(
        private readonly _extensionUri: vscode.Uri,
        serviceRegistry: ServiceRegistry,
    ) {
        this._serviceRegistry = serviceRegistry;
        this._setupEventListeners();
    }

    /**
     * Setup event listeners for repository changes
     */
    private _setupEventListeners(): void {
        const gitApi = this._serviceRegistry.getRepoService().getGitApi();
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
        }

        // Listen to cost changes
        const costService = this._serviceRegistry.getCostTrackingService();
        this._disposables.push(
            costService.onCostChanged(() => {
                this._handleRepositoryChange();
            })
        );
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
                vscode.Uri.joinPath(this._extensionUri, 'dist')
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Handle messages from the webview
        this._disposables.push(
            webviewView.webview.onDidReceiveMessage(async (data: WebviewMessage) => {
                if (data.type === 'ready') {
                    await this.sendRepositoryData();
                }
            })
        );
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
        i18n: { repositoryList: string };
    }> {
        const repoService = this._serviceRegistry.getRepoService();
        const costService = this._serviceRegistry.getCostTrackingService();
        const repositories = repoService.getRepositories();

        const repoCosts: RepositoryInfo[] = [];
        for (const repo of repositories) {
            const repoPath = repo.rootUri.fsPath;
            const repoName = path.basename(repoPath);
            const cost = await costService.getRepositoryCost(repoPath);
            repoCosts.push({ name: repoName, path: repoPath, cost });
        }

        return {
            repositories: repoCosts,
            i18n: {
                repositoryList: vscode.l10n.t(I18N.dashboard.repositoryList)
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

        // Use a nonce to only allow specific scripts to be run
        const nonce = getNonce();

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline' https://cdn.jsdelivr.net; font-src ${webview.cspSource} https://cdn.jsdelivr.net; script-src 'nonce-${nonce}';">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
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

