import * as vscode from 'vscode';
import { RepoService } from '../services/repo';
import { Repository } from '../services/git/git';
import { L10N_KEYS as I18N } from '../i18n/keys';
import * as path from 'path';

/**
 * WebviewViewProvider for Git Commit Genie panel
 * Provides a custom webview panel in a dedicated view container with React UI
 */
export class WebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'gitCommitGenie.panel';

    private _view?: vscode.WebviewView;
    private _repoService: RepoService;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        repoService: RepoService,
    ) {
        this._repoService = repoService;
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

        // Send initial data to webview
        this._sendRepoData();

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async data => {
            switch (data.type) {
                case 'ready':
                    // Webview is ready, send initial data
                    this._sendRepoData();
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
                case 'switchRepo':
                    {
                        await this._handleSwitchRepository();
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
    private _sendRepoData(): void {
        const repoName = this._getCurrentRepoName();
        const repositories = this._repoService.getRepositories();
        const showSwitchButton = repositories.length > 1;

        this.sendMessage({
            type: 'updateRepo',
            repoName,
            showSwitchButton
        });
    }

    /**
     * Handle repository switch request
     */
    private async _handleSwitchRepository(): Promise<void> {
        const repositories = this._repoService.getRepositories();

        if (repositories.length === 0) {
            vscode.window.showInformationMessage(vscode.l10n.t(I18N.common.noGitRepository));
            return;
        }

        if (repositories.length === 1) {
            vscode.window.showInformationMessage(vscode.l10n.t(I18N.common.onlyOneRepository));
            return;
        }

        const items = repositories.map(repo => {
            const repoPath = repo.rootUri.fsPath;
            const repoName = path.basename(repoPath);
            const activeRepo = this._repoService.getActiveRepository();
            const isActive = activeRepo?.rootUri.fsPath === repoPath;

            return {
                label: isActive ? `$(check) ${repoName}` : repoName,
                description: repoPath,
                repo: repo
            };
        });

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: vscode.l10n.t(I18N.repoAnalysis.selectRepository)
        });

        if (selected) {
            // Switch to the selected repository by opening a file in that repo
            const files = await vscode.workspace.findFiles(
                new vscode.RelativePattern(selected.repo.rootUri, '**/*'),
                '**/node_modules/**',
                1
            );

            if (files.length > 0) {
                await vscode.window.showTextDocument(files[0], { preview: false });
            }

            // Update the webview content to reflect the new repository
            this._sendRepoData();
        }
    }

    /**
     * Get current repository display name
     */
    private _getCurrentRepoName(): string {
        const activeRepo = this._repoService.getActiveRepository();
        if (!activeRepo) {
            return vscode.l10n.t(I18N.dashboard.noRepo);
        }
        return path.basename(activeRepo.rootUri.fsPath);
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

