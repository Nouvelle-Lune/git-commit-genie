/**
 * Message types for webview communication
 */

import type { PipelineTextCatalog } from '../pipelineDisplay';
import type { CostDisplay } from '../../services/cost/costTypes';

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

export type ExtensionMessage = UpdateRepoMessage | AddLogMessage | ClearLogsMessage | CancelPendingLogsMessage;

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

export interface OpenGenieMenuMessage {
    type: 'openGenieMenu';
}

export interface RepairRagEmbeddingsMessage {
    type: 'repairRagEmbeddings';
    repoPath: string;
}

export type WebviewMessage = ReadyMessage | ClearLogsRequestMessage | OpenFileMessage | OpenGenieMenuMessage | RepairRagEmbeddingsMessage;

// Data Types
export interface RepositoryInfo {
    name: string;
    path: string;
    /** Structured cost status — replaces bare numeric totals. */
    cost: CostDisplay;
    ragStatus?: {
        kind: 'disabled' | 'idle' | 'preparing' | 'importing' | 'embedding' | 'ready' | 'error';
        text: string;
        detail?: string;
        repairNeeded?: boolean;
    };
}

export interface I18nTexts {
    repositoryList: string;
    logs: string;
    noLogsYet: string;
    clearLogs: string;
    analyzing: string;
    openSettings: string;
    repairRagEmbeddings: string;
    pipeline: PipelineTextCatalog;
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
    generationMode?: 'default' | 'thinking';
    fileContent?: string; // For file read content preview
    startLine?: number; // For file read start line
    endLine?: number; // For file read end line
    /** Structured cost from CostTrackingService — legacy numeric `cost` is rejected by persistence validation. */
    costDisplay?: CostDisplay;
    pending?: boolean; // For API requests waiting for response
    requestType?: string;
    cancelled?: boolean; // Mark as cancelled by user
}
