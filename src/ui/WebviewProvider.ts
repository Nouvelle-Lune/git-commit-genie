import * as vscode from 'vscode';

/**
 * WebviewViewProvider for Git Commit Genie panel
 * Provides a custom webview panel in a dedicated view container
 */
export class WebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'gitCommitGenie.panel';

    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
    ) {
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
                this._extensionUri
            ]
        };

        const html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.html = html;

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(data => {
            switch (data.type) {
                case 'colorSelected':
                    {
                        vscode.window.showInformationMessage(`选择了颜色: ${data.value}`);
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

    private _getHtmlForWebview(webview: vscode.Webview) {
        // Use a nonce to only allow a specific script to be run.
        const nonce = getNonce();

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <!--
                    Use a content security policy to only allow loading inline styles and scripts.
                -->
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Git Commit Genie</title>
            </head>
            <body>
                <div class="container">
                    <h2>🧞 Git Commit Genie</h2>
                    <p>Welcome to Git Commit Genie!</p>
                    
                    <div class="section">
                        <h3>Quick Actions</h3>
                        <button id="generateBtn" class="action-button">
                            Generate Commit Message
                        </button>
                        <button id="analyzeBtn" class="action-button">
                            Analyze Repository
                        </button>
                    </div>

                    <div class="section">
                        <h3>Statistics</h3>
                        <div class="stats">
                            <div class="stat-item">
                                <span class="stat-label">Today:</span>
                                <span class="stat-value" id="todayCount">0</span>
                            </div>
                            <div class="stat-item">
                                <span class="stat-label">Total:</span>
                                <span class="stat-value" id="totalCount">0</span>
                            </div>
                        </div>
                    </div>

                    <div class="section">
                        <h3>Theme Color</h3>
                        <div class="color-picker">
                            <button class="color-btn" data-color="#007acc" style="background: #007acc;"></button>
                            <button class="color-btn" data-color="#68217a" style="background: #68217a;"></button>
                            <button class="color-btn" data-color="#0e7c86" style="background: #0e7c86;"></button>
                            <button class="color-btn" data-color="#dd5144" style="background: #dd5144;"></button>
                        </div>
                    </div>
                </div>

                <script nonce="${nonce}">
                    const vscode = acquireVsCodeApi();

                    // Handle button clicks
                    document.getElementById('generateBtn').addEventListener('click', () => {
                        vscode.postMessage({
                            type: 'generateCommit'
                        });
                    });

                    document.getElementById('analyzeBtn').addEventListener('click', () => {
                        vscode.postMessage({
                            type: 'analyzeRepo'
                        });
                    });

                    // Handle color selection
                    document.querySelectorAll('.color-btn').forEach(btn => {
                        btn.addEventListener('click', (e) => {
                            const color = e.target.dataset.color;
                            vscode.postMessage({
                                type: 'colorSelected',
                                value: color
                            });
                            // Highlight selected
                            document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'));
                            e.target.classList.add('selected');
                        });
                    });

                    // Handle messages from the extension
                    window.addEventListener('message', event => {
                        const message = event.data;
                        switch (message.type) {
                            case 'updateStats':
                                document.getElementById('todayCount').textContent = message.todayCount;
                                document.getElementById('totalCount').textContent = message.totalCount;
                                break;
                        }
                    });
                </script>

                <style>
                    body {
                        padding: 10px;
                        color: var(--vscode-foreground);
                        font-size: var(--vscode-font-size);
                        font-family: var(--vscode-font-family);
                    }

                    .container {
                        max-width: 100%;
                    }

                    h2 {
                        margin-top: 0;
                        margin-bottom: 16px;
                        font-size: 18px;
                        font-weight: 600;
                    }

                    h3 {
                        margin-top: 16px;
                        margin-bottom: 8px;
                        font-size: 14px;
                        font-weight: 600;
                        color: var(--vscode-descriptionForeground);
                    }

                    .section {
                        margin-bottom: 20px;
                        padding-bottom: 16px;
                        border-bottom: 1px solid var(--vscode-widget-border);
                    }

                    .section:last-child {
                        border-bottom: none;
                    }

                    .action-button {
                        display: block;
                        width: 100%;
                        padding: 8px 12px;
                        margin-bottom: 8px;
                        background-color: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        border-radius: 2px;
                        cursor: pointer;
                        font-size: 13px;
                        text-align: left;
                    }

                    .action-button:hover {
                        background-color: var(--vscode-button-hoverBackground);
                    }

                    .action-button:active {
                        opacity: 0.8;
                    }

                    .stats {
                        display: flex;
                        flex-direction: column;
                        gap: 8px;
                    }

                    .stat-item {
                        display: flex;
                        justify-content: space-between;
                        padding: 6px 0;
                    }

                    .stat-label {
                        color: var(--vscode-descriptionForeground);
                        font-size: 12px;
                    }

                    .stat-value {
                        font-weight: 600;
                        color: var(--vscode-charts-blue);
                        font-size: 13px;
                    }

                    .color-picker {
                        display: flex;
                        gap: 8px;
                        margin-top: 8px;
                    }

                    .color-btn {
                        width: 32px;
                        height: 32px;
                        border-radius: 4px;
                        border: 2px solid transparent;
                        cursor: pointer;
                        transition: all 0.2s;
                    }

                    .color-btn:hover {
                        transform: scale(1.1);
                        border-color: var(--vscode-focusBorder);
                    }

                    .color-btn.selected {
                        border-color: var(--vscode-focusBorder);
                        box-shadow: 0 0 0 2px var(--vscode-focusBorder);
                    }
                </style>
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
