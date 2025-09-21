import * as vscode from 'vscode';
import { DiffService } from '../services/git/diff';

import { OpenAIService } from '../providers/openai';
import { DeepSeekService } from "../providers/deepseek";


export class SidebarView implements vscode.WebviewViewProvider {
    public static readonly viewType = 'git-commit-genie.sidebar';

    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _diffService: DiffService,
        private readonly _llmService: OpenAIService | DeepSeekService
    ) {}

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

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.command) {
                case 'submit':
                    {
                        const diffs = await this._diffService.getDiff();
                        if (diffs.length === 0) {
                            vscode.window.showInformationMessage("No staged changes found.");
                            return;
                        }

                        const combinedRawDiff = diffs.map(d => d.rawDiff).join('\n');

                        const result = await (this._llmService as any).generateCommitMessage([
                            {
                                fileName: 'combined',
                                status: 'modified',
                                diffHunks: [],
                                rawDiff: combinedRawDiff,
                                userPrompt: data.prompt
                            }
                        ]);

                        if ('content' in result) {
                            this._view?.webview.postMessage({
                                command: 'response',
                                content: result.content
                            });
                        } else {
                            vscode.window.showErrorMessage(`Error generating commit message: ${result.message}`);
                        }

                        break;
                    }
                case 'execute':
                    {
                        const terminal = vscode.window.createTerminal({ name: 'Git Commit Genie' });
                        terminal.sendText(data.gitCommand);
                        terminal.show();
                        break;
                    }
                
            }
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        // Get the local path to main script run in the webview, then convert it to a uri we can use in the webview.
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'src', 'webviews', 'sidebar', 'main.js'));

        // Do the same for the stylesheet.
        const styleResetUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'reset.css'));
        const styleVSCodeUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'vscode.css'));
        const styleMainUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'src', 'webviews', 'sidebar', 'main.css'));

        // Use a nonce to only allow a specific script to be run.
        const nonce = getNonce();

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="${styleResetUri}" rel="stylesheet">
                <link href="${styleVSCodeUri}" rel="stylesheet">
                <link href="${styleMainUri}" rel="stylesheet">
                <title>Chat</title>
            </head>
            <body>
                <div id="header"></div>
                <div id="chat-container">
                    <div id="response-area"></div>
                    <div id="input-area">
                        <textarea id="prompt-input" placeholder="Enter your prompt..."></textarea>
                        <button id="submit-button">Submit</button>
                    </div>
                </div>
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
