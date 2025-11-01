import { WebviewMessage } from '../types/messages';

/**
 * VS Code API wrapper for type safety
 */
export class VSCodeAPI {
    private vscode: any;

    constructor() {
        // Acquire VS Code API
        this.vscode = (window as any).acquireVsCodeApi();
    }

    /**
     * Send message to extension
     */
    public postMessage(message: WebviewMessage): void {
        this.vscode.postMessage(message);
    }

    /**
     * Get state
     */
    public getState<T = any>(): T | undefined {
        return this.vscode.getState();
    }

    /**
     * Set state
     */
    public setState<T = any>(state: T): void {
        this.vscode.setState(state);
    }
}

// Export singleton instance
export const vscodeApi = new VSCodeAPI();
