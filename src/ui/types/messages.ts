/**
 * Message types for webview communication
 */

// Extension -> Webview Messages
export interface UpdateRepoMessage {
    type: 'updateRepo';
    repositories: RepositoryInfo[];
    i18n: I18nTexts;
}

export interface AddLogMessage {
    type: 'addLog';
    log: LogEntry;
}

export interface ClearLogsMessage {
    type: 'clearLogs';
}

export interface CancelPendingLogsMessage {
    type: 'cancelPendingLogs';
}

export interface AnalysisRunningMessage {
    type: 'analysisRunning';
    running: boolean;
    repoLabel?: string;
}

export type ExtensionMessage = UpdateRepoMessage | AddLogMessage | ClearLogsMessage | CancelPendingLogsMessage | AnalysisRunningMessage;

// Webview -> Extension Messages
export interface ReadyMessage {
    type: 'ready';
}

export interface ClearLogsRequestMessage {
    type: 'clearLogs';
}

export interface OpenFileMessage {
    type: 'openFile';
    filePath: string;
}

export interface RefreshAnalysisMessage {
    type: 'refreshAnalysis';
    repoPath: string;
}

export interface OpenGenieMenuMessage {
    type: 'openGenieMenu';
}

export interface CancelAnalysisMessage {
    type: 'cancelAnalysis';
}

export type WebviewMessage = ReadyMessage | ClearLogsRequestMessage | OpenFileMessage | RefreshAnalysisMessage | OpenGenieMenuMessage | CancelAnalysisMessage;

// Data Types
export interface RepositoryInfo {
    name: string;
    path: string;
    cost: number;
    analysisStatus: 'missing' | 'analyzing' | 'idle'; // Repository analysis status
    analysisPath?: string; // Path to analysis markdown file
}

export interface I18nTexts {
    repositoryList: string;
    refreshAnalysis: string;
    cancelAnalysis: string;
    viewAnalysis: string;
    analysisStatusMissing: string;
    analysisStatusAnalyzing: string;
    analysisStatusIdle: string;
    logs: string;
    noLogsYet: string;
    clearLogs: string;
    analyzing: string;
    openSettings: string;
}

// Log Types
export enum LogType {
    FileRead = 'fileRead',
    ApiRequest = 'apiRequest',
    ToolCall = 'toolCall',
    AnalysisStart = 'analysisStart',
    GenerationStart = 'generationStart',
    FinalResult = 'finalResult',
    Reason = 'reason'
}

export interface LogEntry {
    id: string;
    timestamp: number;
    type: LogType;
    title: string;
    reason?: string;
    content?: string; // For API requests (markdown format)
    filePath?: string; // For file reads
    repoPath?: string; // Repository root path for this log
    fileContent?: string; // For file read content preview
    startLine?: number; // For file read start line
    endLine?: number; // For file read end line
    cost?: number; // For API requests
    pending?: boolean; // For API requests waiting for response
    cancelled?: boolean; // Mark as cancelled by user
}
