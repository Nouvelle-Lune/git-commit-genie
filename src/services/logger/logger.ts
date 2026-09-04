import * as vscode from 'vscode';
import { WebviewProvider } from '../../ui/WebviewProvider';
import { LogType, LogEntry } from '../../ui/types/messages';
import { isCurrentPersistedLogEntry } from '../../ui/persistedLogSchema';
import { getRequestTypeLabel } from '../llm/providers/utils/requestTypeMaps';
import type { CostQuote } from '../cost/costTypes';
import { costQuoteToDisplay, formatCostQuoteLabel } from '../cost/costDisplay';

export enum LogLevel {
    Debug = 0,
    Info = 1,
    Warning = 2,
    Error = 3
}

export class Logger {
    private readonly prefix = '[Git Commit Genie]';

    private static instance: Logger;

    private outputChannel: vscode.OutputChannel | null = null;
    private logLevel: LogLevel = LogLevel.Info;
    private lastCallType: string = '';

    private webviewProvider: WebviewProvider | null = null;
    private context: vscode.ExtensionContext | null = null;
    private static readonly LOGS_STATE_KEY = 'gitCommitGenie.webview.logs';
    private logBuffer: LogEntry[] = [];
    private readonly maxLogBuffer = 99;

    private constructor() { }

    // Get singleton instance
    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    public initialize(outputChannel: vscode.OutputChannel, logLevel: LogLevel = LogLevel.Info, context?: vscode.ExtensionContext): void {
        this.outputChannel = outputChannel;
        this.logLevel = logLevel;
        if (context) {
            this.context = context;
        }

        this.info('Logger initialized');
    }

    public setLogLevel(level: LogLevel): void {
        this.logLevel = level;
    }

    /**
     * setWebviewProvider - for sending logs to webview
     */
    public setWebviewProvider(webviewProvider: WebviewProvider): void {
        this.webviewProvider = webviewProvider;
    }

    /**
     * Notify webview to mark all pending logs as cancelled
     */
    public cancelPendingLogs(): void {
        // Update in-memory and persisted buffer so future flushes don't revert UI state
        try {
            if (Array.isArray(this.logBuffer) && this.logBuffer.length) {
                this.logBuffer = this.logBuffer.map(l => (l as any)?.pending ? { ...l, pending: false, cancelled: true } : l);
                this.persistLogBuffer().catch(() => { });
            }
        } catch { /* ignore */ }
        // Notify active webview
        try { this.webviewProvider?.cancelPendingLogs(); } catch { /* ignore */ }
    }

    /**
     * Send log entry to webview
     */
    private sendLogToWebview(log: LogEntry): void {
        // Always buffer
        try {
            this.logBuffer.push(log);
            if (this.logBuffer.length > this.maxLogBuffer) {
                this.logBuffer = this.logBuffer.slice(this.logBuffer.length - this.maxLogBuffer);
            }
            this.persistLogBuffer().catch(() => { });
        } catch { /* ignore */ }

        // Send to active webview if available
        try {
            if (this.webviewProvider) {
                this.webviewProvider.sendMessage({ type: 'addLog', log });
            }
        } catch { /* ignore */ }
    }

    /**
     * Flush buffered logs to webview (clears current webview list first)
     */
    public flushLogsToWebview(): void {
        if (!this.webviewProvider) { return; }
        try {
            this.webviewProvider.clearLogs();
            for (const entry of this.logBuffer) {
                this.webviewProvider.sendMessage({ type: 'addLog', log: entry });
            }
        } catch { /* ignore */ }
    }

    /**
     * Clear internal log buffer (used when user clears logs)
     */
    public clearLogBuffer(): void {
        this.logBuffer = [];
        this.persistLogBuffer().catch(() => { });
    }

    /**
     * Clear logs that belong to the specified repository paths only.
     * Supports multi-root workspaces by accepting multiple repo paths.
     */
    public clearLogBufferForRepositories(repoPaths: string[]): void {
        try {
            if (!Array.isArray(repoPaths) || repoPaths.length === 0) {
                return;
            }
            const norm = (s: string) => (s || '').replace(/\\/g, '/');
            const repoSet = new Set(repoPaths.map(p => norm(p)));

            const deriveRepoPathForLog = (log: LogEntry): string | null => {
                try {
                    const rp = (log as any).repoPath as string | undefined;
                    if (rp) { return norm(rp); }
                    if (log.filePath) {
                        const fp = norm(log.filePath);
                        // pick the longest matching repo path
                        let best: string | null = null;
                        for (const r of repoSet) {
                            if (fp === r || fp.startsWith(r + '/')) {
                                if (!best || r.length > best.length) { best = r; }
                            }
                        }
                        return best;
                    }
                } catch { /* ignore */ }
                return null;
            };

            this.logBuffer = (this.logBuffer || []).filter(log => {
                const rp = deriveRepoPathForLog(log);
                if (!rp) { return true; }
                return !repoSet.has(rp);
            });

            this.persistLogBuffer().catch(() => { });
        } catch { /* ignore */ }
    }

    public async loadPersistedLogs(): Promise<void> {
        try {
            // Prefer globalState (shared across all workspaces)
            let arr = await this.context?.globalState.get<LogEntry[]>(Logger.LOGS_STATE_KEY);
            // Migration: fallback from old workspaceState if global is empty
            if ((!arr || !Array.isArray(arr) || arr.length === 0) && this.context) {
                const legacy = await this.context.workspaceState.get<LogEntry[]>(Logger.LOGS_STATE_KEY);
                if (Array.isArray(legacy) && legacy.length) {
                    arr = legacy;
                    // Write once to global for future use
                    try { await this.context.globalState.update(Logger.LOGS_STATE_KEY, arr); } catch { /* ignore */ }
                }
            }
            if (Array.isArray(arr)) {
                const recentLogs = arr.slice(-this.maxLogBuffer);
                this.logBuffer = recentLogs.filter(isCurrentPersistedLogEntry);
                const discardedCount = recentLogs.length - this.logBuffer.length;
                if (discardedCount > 0) {
                    await this.context?.globalState.update(Logger.LOGS_STATE_KEY, this.logBuffer);
                    this.warn(`Discarded ${discardedCount} incompatible persisted Webview log entries.`);
                }
            }
        } catch { /* ignore */ }
    }

    private async persistLogBuffer(): Promise<void> {
        try { await this.context?.globalState.update(Logger.LOGS_STATE_KEY, this.logBuffer); } catch { /* ignore */ }
    }

    /**
     * Log analysis start event
     */
    public logAnalysisStart(repositoryPath: string): void {
        // Extract repository name from path
        const repoName = repositoryPath.split('/').filter(Boolean).pop() || repositoryPath;

        const log: LogEntry = {
            id: `analysis-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            timestamp: Date.now(),
            type: LogType.AnalysisStart,
            title: `Analysis Started: ${repoName}`
        };
        (log as any).repoPath = repositoryPath;
        this.sendLogToWebview(log);
        this.info(`[AnalysisStart] ${repositoryPath}`);
    }

    /**
     * Log repository analysis completion with the structured agent result.
     */
    public logAnalysisComplete(
        repositoryPath: string,
        result: { projectType: string; technologies: string[]; insights: string[]; summary: string },
    ): void {
        const log: LogEntry = {
            id: `analysis-done-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            timestamp: Date.now(),
            type: LogType.FinalResult,
            title: 'Repository analysis complete',
            content: JSON.stringify({
                projectType: result.projectType,
                technologies: result.technologies,
                insights: result.insights,
                summary: result.summary,
            }, null, 2),
        };
        (log as any).repoPath = repositoryPath;
        this.sendLogToWebview(log);
    }

    /**
     * Log commit message generation start event
     */
    public logGenerationStart(repositoryPath: string, mode: 'default' | 'thinking'): void {
        try {
            const repoName = repositoryPath.split('/').filter(Boolean).pop() || repositoryPath;
            const modeLabel = mode === 'thinking' ? 'Thinking' : 'Default';

            const log: LogEntry = {
                id: `generation-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                timestamp: Date.now(),
                type: LogType.GenerationStart,
                title: `Generation Started: ${repoName} — ${modeLabel}`,
                generationMode: mode,
            };
            (log as any).repoPath = repositoryPath;
            this.sendLogToWebview(log);
            this.info(`[GenerationStart:${modeLabel}] ${repositoryPath}`);
        } catch { /* ignore */ }
    }

    /**
     * Log file read operation
     */
    public logFileRead(filePath: string, reason: string, startLine?: number, endLine?: number, content?: string): void {
        const fileName = filePath.split('/').pop() || filePath;
        const lineRange = startLine && endLine ? ` (lines ${startLine}-${endLine})` : '';

        const log: LogEntry = {
            id: `file-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            timestamp: Date.now(),
            type: LogType.FileRead,
            title: `Genie wants to read: ${fileName}${lineRange}`,
            reason,
            filePath,
            fileContent: content,
            startLine,
            endLine
        };
        try {
            // Derive repoPath from workspace folders to enable filtering/badge in webview
            const folders = vscode.workspace.workspaceFolders || [];
            const norm = (s: string) => s.replace(/\\/g, '/');
            const fp = norm(filePath);
            for (const f of folders) {
                const rp = norm(f.uri.fsPath);
                if (fp === rp || fp.startsWith(rp + '/')) {
                    (log as any).repoPath = f.uri.fsPath;
                    break;
                }
            }
        } catch { /* ignore */ }
        this.sendLogToWebview(log);
        this.debug(`[FileRead] ${filePath} - ${reason}`);
    }

    /**
     * Log tool call operation
     */
    public logToolCall(toolName: string, args: string, reason?: string, repoPath?: string): void {
        // Create a friendly title based on the tool name
        const friendlyTitle = this.getFriendlyToolTitle(toolName, args);

        const log: LogEntry = {
            id: `tool-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            timestamp: Date.now(),
            type: LogType.ToolCall,
            title: friendlyTitle,
            reason: reason || '',
            content: args
        };
        if (repoPath) { (log as any).repoPath = repoPath; }
        this.sendLogToWebview(log);
        this.debug(`[ToolCall] ${toolName} - ${args}`);
    }

    /**
     * Get friendly title for tool calls
     */
    private getFriendlyToolTitle(toolName: string, args: string): string {
        try {
            const parsedArgs = JSON.parse(args);

            switch (toolName) {
                case 'readFileContent': {
                    const filePath = parsedArgs.filePath ?? parsedArgs.path;
                    return `Genie wants to read: ${typeof filePath === 'string' ? filePath.split('/').pop() || 'file' : 'file'}`;
                }
                case 'searchFiles': {
                    const query = parsedArgs.query ?? parsedArgs.pattern;
                    return `Genie wants to search for: ${typeof query === 'string' && query.trim() ? query : 'files'}`;
                }
                case 'listDirectory': {
                    const dirPath = parsedArgs.dirPath ?? parsedArgs.path;
                    return `Genie wants to explore: ${typeof dirPath === 'string' ? dirPath.split('/').pop() || 'directory' : 'directory'}`;
                }
                case 'searchInFiles':
                    return `Genie wants to search in files: ${parsedArgs.searchTerm || ''}`;
                case 'getChangedSymbols':
                    return 'Genie wants to review changed symbols';
                case 'findSymbolDefinition': {
                    const symbol = parsedArgs.symbol;
                    return `Genie wants to look up definition: ${typeof symbol === 'string' && symbol.trim() ? symbol : 'symbol'}`;
                }
                case 'findSymbolReferences': {
                    const symbol = parsedArgs.symbol;
                    return `Genie wants to find references: ${typeof symbol === 'string' && symbol.trim() ? symbol : 'symbol'}`;
                }
                case 'findCallers': {
                    const symbol = parsedArgs.symbol;
                    return `Genie wants to find callers: ${typeof symbol === 'string' && symbol.trim() ? symbol : 'symbol'}`;
                }
                case 'findCallees': {
                    const symbol = parsedArgs.symbol;
                    return `Genie wants to find callees: ${typeof symbol === 'string' && symbol.trim() ? symbol : 'symbol'}`;
                }
                case 'findImplementations': {
                    const symbol = parsedArgs.symbol;
                    return `Genie wants to find implementations: ${typeof symbol === 'string' && symbol.trim() ? symbol : 'symbol'}`;
                }
                case 'findTypeDefinition': {
                    const symbol = parsedArgs.symbol;
                    return `Genie wants to look up type: ${typeof symbol === 'string' && symbol.trim() ? symbol : 'symbol'}`;
                }
                case 'searchCode': {
                    const query = parsedArgs.query;
                    return `Genie wants to search code: ${typeof query === 'string' && query.trim() ? query : '…'}`;
                }
                case 'getCompressedContext':
                    return `Genie wants to analyze compressed context`;
                case 'commitStage': {
                    const stage = String(parsedArgs.stage || '').replace(/([A-Z])/g, ' $1').trim();
                    return `Commit stage: ${stage || 'unknown'}`;
                }
                case 'schemaValidation': {
                    const stage = String(parsedArgs.stage || '').replace(/([A-Z])/g, ' $1').trim();
                    const final = !!parsedArgs.finalFailure;
                    const prefix = parsedArgs.missingResponse
                        ? (final ? 'Structured output failed' : 'Structured output retry')
                        : (final ? 'Schema validation failed' : 'Schema validation retry');
                    return `${prefix}: ${stage || 'unknown'}`;
                }
                default:
                    return `Genie wants to use: ${toolName}`;
            }
        } catch {
            return `Genie wants to use: ${toolName}`;
        }
    }

    /**
     * Log API request (pending state)
     */
    public logApiRequest(repoPath?: string): string {
        // Create a unique ID for this request
        const logId = `api-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        const log: LogEntry = {
            id: logId,
            timestamp: Date.now(),
            type: LogType.ApiRequest,
            title: `API Request`,
            pending: true
        };
        if (repoPath) { (log as any).repoPath = repoPath; }
        this.sendLogToWebview(log);
        return logId;
    }

    /**
     * Update API request log with function call result.
     * Cost must come from CostTrackingService.recordCall — Logger does not price usage.
     */
    public logApiRequestWithResult(
        logId: string,
        provider: string,
        model: string,
        result: any,
        isFinal: boolean = false,
        repoPath?: string,
        requestType?: string,
        costQuote?: CostQuote,
    ): void {
        const content = typeof result === 'string' ? result : JSON.stringify(result);
        const failed = result !== null
            && typeof result === 'object'
            && typeof result.error === 'string';

        let reason: string | undefined;
        try {
            const parsed = typeof result === 'string' ? JSON.parse(result) : result;
            if (parsed && typeof parsed.reason === 'string') {
                reason = parsed.reason;
            }
        } catch {
            // ignore parsing errors
        }

        const log: LogEntry = {
            id: logId,
            timestamp: Date.now(),
            type: isFinal ? LogType.FinalResult : LogType.ApiRequest,
            title: failed
                ? `API request failed`
                : isFinal
                ? `Analysis Result`
                : (requestType ? `${getRequestTypeLabel(requestType)} API request` : `API Request`),
            content,
            costDisplay: costQuote ? costQuoteToDisplay(costQuote) : undefined,
            pending: false,
            ...(requestType ? { requestType } : {}),
        };
        if (repoPath) { (log as any).repoPath = repoPath; }
        this.sendLogToWebview(log);

        if (!isFinal && !log.cancelled && typeof reason === 'string' && reason.trim().length > 0) {
            const reasonLog: LogEntry = {
                id: `reason-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                timestamp: Date.now(),
                type: LogType.Reason,
                title: 'Reason',
                content: reason
            };
            if (repoPath) { (reasonLog as any).repoPath = repoPath; }
            this.sendLogToWebview(reasonLog);
        }
    }

    private formatMessagesAsMarkdown(messages: any[]): string {
        let markdown = '';

        for (const msg of messages) {
            const role = msg.role || 'unknown';
            const content = msg.content || '';

            markdown += `## ${role.toUpperCase()}\n\n`;

            if (typeof content === 'string') {
                markdown += `${content}\n\n`;
            } else if (Array.isArray(content)) {
                for (const part of content) {
                    if (part.type === 'text' && part.text) {
                        markdown += `${part.text}\n\n`;
                    } else if (part.type === 'tool_use' || part.type === 'tool_result') {
                        markdown += `\`\`\`json\n${JSON.stringify(part, null, 2)}\n\`\`\`\n\n`;
                    }
                }
            } else {
                markdown += `\`\`\`json\n${JSON.stringify(content, null, 2)}\n\`\`\`\n\n`;
            }

            markdown += '---\n\n';
        }

        return markdown;
    }

    public debug(message: string, ...args: any[]): void {
        this.log(LogLevel.Debug, message, ...args);
    }

    public info(message: string, ...args: any[]): void {
        this.log(LogLevel.Info, message, ...args);
    }

    public warn(message: string, ...args: any[]): void {
        this.log(LogLevel.Warning, message, ...args);
    }

    public error(message: string, error?: Error | any, ...args: any[]): void {
        if (error instanceof Error) {
            this.log(LogLevel.Error, `${message}: ${error.message}`, ...args);
            if (error.stack) {
                this.log(LogLevel.Error, `Stack trace: ${error.stack}`, ...args);
            }
        } else if (error) {
            this.log(LogLevel.Error, `${message}: ${String(error)}`, ...args);
        } else {
            this.log(LogLevel.Error, message, ...args);
        }
    }

    /**
     * Write token usage + cost line from an accounting quote.
     * Does not accumulate repository cost — CostTrackingService.recordCall already did.
     */
    public logUsageQuote(
        provider: string,
        modelName: string,
        quote: CostQuote,
        callType: string = '',
        callCount?: number,
    ): void {
        const name = modelName.replace(/-\d{8,}/, '').replace(/-\d{2}-\d{4}$/, '');
        let contextInfo = '';
        if (callType !== '') {
            if (callType === 'summarize' && callCount !== undefined) {
                contextInfo = `[${callType}-${callCount}]`;
            } else {
                contextInfo = `[${callType}]`;
            }
            this.lastCallType = callType;
        }

        if (!quote.usage) {
            this.info(
                `[${provider}]${contextInfo ? ` ${contextInfo}` : ''} Token usage information not available | Cost: ${formatCostQuoteLabel(quote)}`,
            );
            return;
        }

        const { inputTokens, outputTokens, totalTokens, cachedInputTokens } = quote.usage;
        const cachePercentage = inputTokens > 0 ? (cachedInputTokens / inputTokens) * 100 : 0;
        const message =
            `[${provider}] [${name}] ${contextInfo} Token Usage: input ${inputTokens} | output ${outputTokens} | ` +
            `total ${totalTokens} | Cache: ${cachePercentage.toFixed(2)}% | Cost: ${formatCostQuoteLabel(quote)}`;
        this.info(message);
    }

    private log(level: LogLevel, message: string, ...args: any[]): void {
        if (level < this.logLevel) {
            return;
        }

        const timestamp = this.getLocalTimestamp();
        const levelStr = this.getLevelString(level);
        const formattedMessage = args.length > 0
            ? `${this.prefix} [${timestamp}] ${levelStr}: ${message} ${args.map(arg => String(arg)).join(' ')}`
            : `${this.prefix} [${timestamp}] ${levelStr}: ${message}`;

        switch (level) {
            case LogLevel.Debug:
                console.debug(formattedMessage);
                break;
            case LogLevel.Info:
                console.log(formattedMessage);
                break;
            case LogLevel.Warning:
                console.warn(formattedMessage);
                break;
            case LogLevel.Error:
                console.error(formattedMessage);
                break;
        }

        if (this.outputChannel) {
            this.outputChannel.appendLine(formattedMessage);
        }
    }

    private getLocalTimestamp(): string {
        const d = new Date();
        const pad = (n: number) => n.toString().padStart(2, '0');
        const yyyy = d.getFullYear();
        const MM = pad(d.getMonth() + 1);
        const dd = pad(d.getDate());
        const hh = pad(d.getHours());
        const mm = pad(d.getMinutes());
        const ss = pad(d.getSeconds());
        return `${yyyy}-${MM}-${dd} ${hh}:${mm}:${ss}`;
    }

    private getLevelString(level: LogLevel): string {
        switch (level) {
            case LogLevel.Debug:
                return 'DEBUG';
            case LogLevel.Info:
                return 'INFO';
            case LogLevel.Warning:
                return 'WARN';
            case LogLevel.Error:
                return 'ERROR';
            default:
                return 'UNKNOWN';
        }
    }

    public show(): void {
        if (this.outputChannel) {
            this.outputChannel.show();
        }
    }

    public clear(): void {
        if (this.outputChannel) {
            this.outputChannel.clear();
        }
    }

    public dispose(): void {
        if (this.outputChannel) {
            this.outputChannel.dispose();
            this.outputChannel = null;
        }
    }
}

// Export a global logger instance
export const logger = Logger.getInstance();
