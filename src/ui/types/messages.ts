/**
 * Message types for webview communication
 */

// Extension -> Webview Messages
export interface UpdateRepoMessage {
    type: 'updateRepo';
    repositories: RepositoryInfo[];
    i18n: I18nTexts;
}

export type ExtensionMessage = UpdateRepoMessage;

// Webview -> Extension Messages
export interface ReadyMessage {
    type: 'ready';
}

export type WebviewMessage = ReadyMessage;

// Data Types
export interface RepositoryInfo {
    name: string;
    path: string;
    cost: number;
}

export interface I18nTexts {
    repositoryList: string;
}
