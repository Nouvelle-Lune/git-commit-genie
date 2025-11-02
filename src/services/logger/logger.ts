import * as vscode from 'vscode';
import { CostTrackingService } from "../cost/costTrackingService";
import { PRICING_TABLE } from '../cost/pricing';
import { WebviewProvider } from '../../ui/WebviewProvider';
import { LogType, LogEntry } from '../../ui/types/messages';

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

    private costTracker: CostTrackingService | null = null;
    private webviewProvider: WebviewProvider | null = null;

    private constructor() { }

    // Get singleton instance
    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    public initialize(outputChannel: vscode.OutputChannel, logLevel: LogLevel = LogLevel.Info): void {
        this.outputChannel = outputChannel;
        this.logLevel = logLevel;

        this.info('Logger initialized');
    }

    public setLogLevel(level: LogLevel): void {
        this.logLevel = level;
    }

    /**
     * setCostTracker
     */
    public setCostTracker(costTracker: CostTrackingService): void {
        this.costTracker = costTracker;
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
        try { this.webviewProvider?.cancelPendingLogs(); } catch { /* ignore */ }
    }

    /**
     * Send log entry to webview
     */
    private sendLogToWebview(log: LogEntry): void {
        if (this.webviewProvider) {
            this.webviewProvider.sendMessage({
                type: 'addLog',
                log
            });
        }
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
        this.sendLogToWebview(log);
        this.info(`[AnalysisStart] ${repositoryPath}`);
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
        this.sendLogToWebview(log);
        this.debug(`[FileRead] ${filePath} - ${reason}`);
    }

    /**
     * Log tool call operation
     */
    public logToolCall(toolName: string, args: string, reason?: string): void {
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
                case 'readFileContent':
                    return `Genie wants to read: ${parsedArgs.path?.split('/').pop() || 'file'}`;
                case 'searchFiles':
                    return `Genie wants to search for: ${parsedArgs.pattern || 'files'}`;
                case 'listDirectory':
                    return `Genie wants to explore: ${parsedArgs.path?.split('/').pop() || 'directory'}`;
                case 'searchInFiles':
                    return `Genie wants to search in files: ${parsedArgs.searchTerm || ''}`;
                case 'getCompressedContext':
                    return `Genie wants to analyze compressed context`;
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
    public logApiRequest(provider: string, model: string, messages: any[], systemPrompt?: string, isFirstRequest: boolean = false): string {
        // Create a unique ID for this request
        const logId = `api-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        const content = undefined;

        const log: LogEntry = {
            id: logId,
            timestamp: Date.now(),
            type: LogType.ApiRequest,
            title: `API Request`,
            content,
            pending: true
        };
        this.sendLogToWebview(log);
        return logId;
    }

    /**
     * Update API request log with function call result
     */
    public logApiRequestWithResult(logId: string, provider: string, model: string, result: any, usage?: any, isFinal: boolean = false): void {
        // Format result as JSON string for parsing in frontend
        const content = typeof result === 'string' ? result : JSON.stringify(result);

        // Extract reason from result if available
        let reason: string | undefined;
        try {
            const parsed = typeof result === 'string' ? JSON.parse(result) : result;
            if (parsed && typeof parsed.reason === 'string') {
                reason = parsed.reason;
            }
        } catch {
            // ignore parsing errors
        }

        // Calculate cost if usage is provided
        let cost: number | undefined;
        if (usage) {
            const providerLower = provider.toLowerCase();
            let inputTokens = 0;
            let outputTokens = 0;
            let cachedTokens = 0;

            try {
                if (providerLower === 'openai') {
                    inputTokens = usage.input_tokens || 0;
                    outputTokens = usage.output_tokens || 0;
                    cachedTokens = usage.input_tokens_details?.cached_tokens || 0;
                    cost = this.calculateCost(model, inputTokens, outputTokens, cachedTokens);
                } else if (providerLower === 'deepseek') {
                    inputTokens = usage.prompt_tokens || 0;
                    outputTokens = usage.completion_tokens || 0;
                    cachedTokens = usage.prompt_cache_hit_tokens || 0;
                    cost = this.calculateCost(model, inputTokens, outputTokens, cachedTokens);
                } else if (providerLower === 'anthropic') {
                    inputTokens = usage.input_tokens || 0;
                    outputTokens = usage.output_tokens || 0;
                    cachedTokens = usage.cache_read_input_tokens || 0;
                    cost = this.calculateCost(model, inputTokens, outputTokens, cachedTokens);
                } else if (providerLower === 'gemini') {
                    inputTokens = usage.promptTokenCount || 0;
                    outputTokens = usage.candidatesTokenCount || 0;
                    cachedTokens = usage.cachedContentTokenCount || 0;
                    cost = this.calculateCost(model, inputTokens, outputTokens, cachedTokens);
                } else if (providerLower === 'qwen') {
                    inputTokens = usage.input_tokens || 0;
                    outputTokens = usage.output_tokens || 0;
                    cost = this.calculateCost(model, inputTokens, outputTokens);
                }
            } catch (err) {
                // ignore cost calculation errors
            }
        }

        const log: LogEntry = {
            id: logId,
            timestamp: Date.now(),
            type: isFinal ? LogType.FinalResult : LogType.ApiRequest,
            title: isFinal ? `Analysis Result` : `API Request`,
            content,
            // inline reason moved to a separate log entry
            cost,
            pending: false
        };
        this.sendLogToWebview(log);

        // Emit a separate Reason log when present and not a final result
        if (!isFinal && typeof reason === 'string' && reason.trim().length > 0) {
            const reasonLog: LogEntry = {
                id: `reason-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                timestamp: Date.now(),
                type: LogType.Reason,
                title: 'Reason',
                content: reason
            };
            this.sendLogToWebview(reasonLog);
        }
    }

    /**
     * Format chat messages as markdown
     */
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


    /**
     * Add cost to repository total using cost tracking service
     */
    private async addCost(cost: number, repoPath: string): Promise<void> {
        if (this.costTracker) {
            await this.costTracker.addToRepositoryCost(cost, repoPath);
        }
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
     * Log token usage information with cost calculation and formatting
     * Consolidates token usage, cache percentage, and cost into a single line
     */
    public usage(
        repoPath: string,
        provider: string,
        usage: any,
        modelName: string,
        callType: string = '',
        callCount?: number,
        region?: string,
        thinkingMode?: boolean
    ): void {
        if (!usage) {
            this.info(`[${provider}]${callType ? ` [${callType}${callCount ? `-${callCount}` : ''}]` : ''} Token usage information not available`);
            return;
        }

        let inputTokens = 0;
        let outputTokens = 0;
        let cachedTokens = 0;
        let totalTokens = 0;
        let cachePercentage = 0;
        let cost = 0;

        const providerLower = provider.toLowerCase();

        try {
            if (providerLower === 'openai') {
                inputTokens = usage.input_tokens || 0;
                outputTokens = usage.output_tokens || 0;
                cachedTokens = usage.input_tokens_details?.cached_tokens || 0;
                cachePercentage = inputTokens > 0 ? (cachedTokens / inputTokens) * 100 : 0;
                totalTokens = usage.total_tokens || (inputTokens + outputTokens);
                cost = this.calculateCost(modelName || 'unknown', inputTokens, outputTokens);
            }
            if (providerLower === 'deepseek') {
                inputTokens = usage.prompt_tokens || 0;
                outputTokens = usage.completion_tokens || 0;
                cachedTokens = usage.prompt_cache_hit_tokens || 0;
                totalTokens = inputTokens + outputTokens;
                cachePercentage = inputTokens > 0 ? (cachedTokens / inputTokens) * 100 : 0;
                cost = this.calculateCost(modelName || 'unknown', inputTokens, outputTokens, cachedTokens);
            }
            if (providerLower === 'anthropic') {
                inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
                outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
                cachedTokens = usage.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? 0;
                totalTokens = usage.total_tokens ?? (inputTokens + outputTokens);
                cachePercentage = inputTokens > 0 ? (cachedTokens / inputTokens) * 100 : 0;
                cost = this.calculateCost(modelName || 'unknown', inputTokens, outputTokens, cachedTokens);
            }
            if (providerLower === 'gemini') {
                inputTokens = usage.prompt_tokens ?? 0;
                outputTokens = usage.completion_tokens ?? 0;
                totalTokens = usage.total_tokens ?? (inputTokens + outputTokens);
                cachedTokens = usage.cached_content_tokens ?? 0;
                cachePercentage = inputTokens > 0 ? (cachedTokens / inputTokens) * 100 : 0;
                cost = this.calculateCost(modelName || 'unknown', inputTokens, outputTokens, cachedTokens);
            }
            if (providerLower === 'qwen') {
                inputTokens = usage.prompt_tokens || 0;
                outputTokens = usage.completion_tokens || 0;
                cachedTokens = usage.prompt_tokens_details?.cached_tokens || 0;
                totalTokens = inputTokens + outputTokens;
                cachePercentage = inputTokens > 0 ? (cachedTokens / inputTokens) * 100 : 0;
                cost = this.calculateCost(modelName || 'unknown', inputTokens, outputTokens, cachedTokens, region, thinkingMode);
            }
        } catch (e) {
            this.warn(`Failed to parse token usage for ${modelName}: ${e}`);
            return;
        }

        // Format output
        // Remove date suffixes: -20241022 (Anthropic) or -09-2025 (Gemini), but keep "preview"
        const name = modelName.replace(/-\d{8,}/, "").replace(/-\d{2}-\d{4}$/, "");
        const formattedCost = cost.toFixed(6);
        const formattedCachePercentage = cachePercentage.toFixed(2);

        let contextInfo = '';
        if (callType !== '') {
            if (callType === 'summarize' && callCount !== undefined) {
                contextInfo = `[${callType}-${callCount}]`;
            } else {
                contextInfo = `[${callType}]`;
            }
            this.lastCallType = callType;
        }

        const currency = '$';
        const message = `[${provider}] [${name}] ${contextInfo} Token Usage: input ${inputTokens} | output ${outputTokens} | total ${totalTokens} | Cache: ${formattedCachePercentage}% | Cost: ${formattedCost}${currency}`;

        // Add to repository cost
        if (repoPath) {
            this.addCost(cost, repoPath);
        }

        this.info(message);
    }

    /**
     * Calculate API call cost
     * @param modelName - Model name, can include region suffix for Qwen (e.g., 'qwen3-max:china')
     * @param inputTokens - Number of input tokens
     * @param outputTokens - Number of output tokens
     * @param cachedTokens - Number of cached tokens (optional)
     * @param region - Region for Qwen models ('china' or 'intl'), will be appended to modelName
     * @param thinkingMode - Whether Qwen Plus is using thinking/reasoning mode (higher output cost)
     */
    private calculateCost(
        modelName: string,
        inputTokens: number,
        outputTokens: number,
        cachedTokens?: number,
        region?: string,
        thinkingMode?: boolean
    ): number {
        // For Qwen models, append region to model name if provided
        let pricingKey = modelName;
        if (region && modelName.startsWith('qwen')) {
            pricingKey = `${modelName}:${region}`;
            // Append thinking mode suffix if enabled for qwen-plus models
            if (thinkingMode && modelName.includes('qwen-plus')) {
                pricingKey = `${pricingKey}:thinking`;
            }
        }

        const pricing = PRICING_TABLE[pricingKey];
        if (!pricing) {
            this.warn(`Unknown model pricing for: ${pricingKey}`);
            return 0;
        }

        // Check if this is tiered pricing
        if ('tiers' in pricing) {
            // Find the appropriate tier based on input tokens
            const tier = pricing.tiers.find((t) => inputTokens <= t.maxInputTokens);
            if (!tier) {
                this.warn(`No pricing tier found for ${pricingKey} with ${inputTokens} input tokens`);
                return 0;
            }
            const nonCachedInputTokens = cachedTokens ? inputTokens - cachedTokens : inputTokens;
            const inputCost = (nonCachedInputTokens / 1000000) * tier.input;
            const outputCost = (outputTokens / 1000000) * tier.output;
            const cachedCost = cachedTokens ? (cachedTokens / 1000000) * tier.cached : 0;

            return inputCost + outputCost + cachedCost;
        } else {
            const nonCachedInputTokens = cachedTokens ? inputTokens - cachedTokens : inputTokens;
            const inputCost = (nonCachedInputTokens / 1000000) * pricing.input;
            const outputCost = (outputTokens / 1000000) * pricing.output;
            const cachedCost = cachedTokens ? (cachedTokens / 1000000) * pricing.cached : 0;

            return inputCost + outputCost + cachedCost;
        }
    }

    /**
     * Log summarized token usage from multiple API calls
     * Consolidates multiple usage objects into a single summary with total cost calculation
     */
    public usageSummary(
        repoPath: string,
        provider: string,
        usages: any[],
        modelName: string,
        callType: string = '',
        callCount?: number,
        addToCost: boolean = true,
        region?: string,
        thinkingMode?: boolean
    ): void {
        if (!usages.length) {
            this.info(`[${provider}]${callType ? ` [${callType}${callCount ? `-${callCount}` : ''}]` : ''} No token usage data to summarize`);
            return;
        }

        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let totalCachedTokens = 0;
        let totalTokens = 0;
        let totalCost = 0;

        const providerLower = provider.toLowerCase();

        // Process each usage object
        for (const usage of usages) {
            if (!usage) {
                continue;
            }

            let inputTokens = 0;
            let outputTokens = 0;
            let cachedTokens = 0;

            try {
                if (providerLower === 'openai') {
                    inputTokens = usage.input_tokens || 0;
                    outputTokens = usage.output_tokens || 0;
                    cachedTokens = usage.input_tokens_details?.cached_tokens || 0;
                } else if (providerLower === 'deepseek') {
                    inputTokens = usage.prompt_tokens || 0;
                    outputTokens = usage.completion_tokens || 0;
                    cachedTokens = usage.prompt_cache_hit_tokens || 0;
                } else if (providerLower === 'anthropic') {
                    inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
                    outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
                    cachedTokens = usage.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? 0;
                } else if (providerLower === 'gemini') {
                    inputTokens = usage.prompt_tokens ?? 0;
                    outputTokens = usage.completion_tokens ?? 0;
                    cachedTokens = usage.cached_content_tokens ?? 0;
                } else if (providerLower === 'qwen') {
                    inputTokens = usage.prompt_tokens || 0;
                    outputTokens = usage.completion_tokens || 0;
                    cachedTokens = usage.prompt_tokens_details?.cached_tokens || 0;
                }
                else {
                    this.warn(`Unknown provider for usage summary: ${provider}`);
                    continue;
                }

                // Accumulate totals
                totalInputTokens += inputTokens;
                totalOutputTokens += outputTokens;
                totalCachedTokens += cachedTokens;
                totalTokens += usage.total_tokens || (inputTokens + outputTokens);

                // Calculate cost for this usage
                totalCost += this.calculateCost(modelName, inputTokens, outputTokens, cachedTokens, region, thinkingMode);
            } catch (e) {
                this.warn(`Failed to parse token usage in summary for ${modelName}: ${e}`);
                continue;
            }
        }

        // Calculate cache percentage
        const cachePercentage = totalInputTokens > 0 ? (totalCachedTokens / totalInputTokens) * 100 : 0;

        // Format output
        const formattedCost = totalCost.toFixed(6);
        const formattedCachePercentage = cachePercentage.toFixed(2);
        const contextInfo = callType ? `[${callType}${callCount ? `-${callCount}` : ''}]` : '';
        const currency = '$';
        const message = `[${provider}] [${modelName}] ${contextInfo} Total Token Usage: input ${totalInputTokens} | output ${totalOutputTokens} | total ${totalTokens} | Cache: ${formattedCachePercentage}% | Cost: ${formattedCost}${currency} (${usages.length} calls)`;

        this.info(message);

        // Add to repository cost unless caller indicates it was already counted per-step
        if (addToCost && repoPath) {
            this.addCost(totalCost, repoPath);
        }

        // Show notification for cost summary
        const cfg = vscode.workspace.getConfiguration('gitCommitGenie');
        if (cfg.get('showUsageCost', false)) {
            this.showCostNotification(callType, formattedCost, formattedCachePercentage);
        }
    }

    /**
     * Show cost notification popup
     */
    private showCostNotification(callType: string, cost: string, cachePercentage: string): void {
        let messageKey: string;

        // Determine operation type based on callType
        if (callType === 'RepoAnalysis') {
            messageKey = 'Repository analysis: ${0} | Cache hit: {1}%';
        } else {
            // All other cases are commit message generation related
            messageKey = 'Commit message generation: ${0} | Cache hit: {1}%';
        }

        // Use vscode.l10n.t for internationalization
        const message = vscode.l10n.t(messageKey, cost, cachePercentage);

        // Show simple information message without buttons
        vscode.window.showInformationMessage(message);
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

        // Output to Console (visible during development)
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

        // Output to OutputChannel (visible to users)
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
