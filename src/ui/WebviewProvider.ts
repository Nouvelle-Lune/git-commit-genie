import * as vscode from 'vscode';
import { ServiceRegistry } from '../core/ServiceRegistry';
import { L10N_KEYS as I18N } from '../i18n/keys';
import * as path from 'path';

/**
 * WebviewViewProvider for Git Commit Genie panel
 * Provides a custom webview panel in a dedicated view container with React UI
 */
export class WebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'gitCommitGenie.panel';

    private _view?: vscode.WebviewView;
    private _serviceRegistry: ServiceRegistry;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        serviceRegistry: ServiceRegistry,
    ) {
        this._serviceRegistry = serviceRegistry;

        // Listen for repository changes
        const gitApi = this._serviceRegistry.getRepoService().getGitApi();
        if (gitApi) {
            gitApi.onDidOpenRepository(() => {
                // Update webview when new repositories are opened
                if (this._view) {
                    this._sendRepoData().catch(err => console.error('Failed to send repo data on repo open:', err));
                }
            });

            gitApi.onDidCloseRepository(() => {
                // Update webview when repositories are closed
                if (this._view) {
                    this._sendRepoData().catch(err => console.error('Failed to send repo data on repo close:', err));
                }
            });
        }
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            // Allow scripts in the webview
            enableScripts: true,

            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'dist')
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Send initial data to webview (async)
        this._sendRepoData().catch(err => console.error('Failed to send repo data:', err));

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async data => {
            switch (data.type) {
                case 'ready':
                    // Webview is ready, send initial data
                    await this._sendRepoData();
                    break;
                case 'colorSelected':
                    {
                        vscode.window.showInformationMessage(`选择了颜色: ${data.value}`);
                        break;
                    }
                case 'generateCommit':
                    {
                        vscode.commands.executeCommand('gitCommitGenie.generate');
                        break;
                    }
                case 'analyzeRepo':
                    {
                        vscode.commands.executeCommand('gitCommitGenie.repoAnalysis.refresh');
                        break;
                    }
            }
        });
    }

    /**
     * Send message to webview
     */
    public sendMessage(message: any) {
        if (this._view) {
            this._view.webview.postMessage(message);
        }
    }

    /**
     * Update webview content
     */
    public updateContent() {
        this._sendRepoData();
    }

    /**
     * Send repository data to webview
     */
    private async _sendRepoData(): Promise<void> {
        const repoService = this._serviceRegistry.getRepoService();
        const costService = this._serviceRegistry.getCostTrackingService();
        const repositories = repoService.getRepositories();

        // Get all repository costs
        const repoCosts: Array<{ name: string; path: string; cost: number }> = [];
        for (const repo of repositories) {
            const repoPath = repo.rootUri.fsPath;
            const repoName = path.basename(repoPath);
            const cost = await costService.getRepositoryCost(repoPath);
            repoCosts.push({ name: repoName, path: repoPath, cost });
        }

        this.sendMessage({
            type: 'updateRepo',
            repositories: repoCosts,
            i18n: {
                repositoryList: vscode.l10n.t(I18N.dashboard.repositoryList),
                switchRepo: vscode.l10n.t(I18N.dashboard.switchRepo),
                quickActions: vscode.l10n.t(I18N.dashboard.quickActions),
                generateCommit: vscode.l10n.t(I18N.dashboard.generateCommit),
                analyzeRepo: vscode.l10n.t(I18N.dashboard.analyzeRepo),
                statistics: vscode.l10n.t(I18N.dashboard.statistics),
                todayLabel: vscode.l10n.t(I18N.dashboard.todayLabel),
                totalLabel: vscode.l10n.t(I18N.dashboard.totalLabel),
                themeColor: vscode.l10n.t(I18N.dashboard.themeColor)
            }
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

