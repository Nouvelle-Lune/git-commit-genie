import * as vscode from 'vscode';

export enum LogLevel {
    Debug = 0,
    Info = 1,
    Warning = 2,
    Error = 3
}

export class Logger {
    private static instance: Logger;
    private outputChannel: vscode.OutputChannel | null = null;
    private logLevel: LogLevel = LogLevel.Info;
    private readonly prefix = '[Git Commit Genie]';

    private constructor() { }

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
    //TODO: finish this usage calculation function 
    public usage(provider: string, usage: any, modelName: string, callType: string = '', callCount?: number): void {
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

        try {
            if (provider === 'OpenAI') {
                inputTokens = usage.input_tokens || 0;
                outputTokens = usage.output_tokens || 0;
                cachedTokens = usage.input_tokens_details?.cached_tokens || 0;
                cachePercentage = inputTokens > 0 ? (cachedTokens / inputTokens) * 100 : 0;
                totalTokens = usage.total_tokens || (inputTokens + outputTokens);
                cost = this.calculateCost(modelName || 'unknown', inputTokens, outputTokens);
            }
            if (provider === 'DeepSeek') {
                inputTokens = usage.prompt_tokens || 0;
                outputTokens = usage.completion_tokens || 0;
                cachedTokens = usage.prompt_cache_hit_tokens || 0;
                totalTokens = inputTokens + outputTokens;
                cachePercentage = inputTokens > 0 ? (cachedTokens / inputTokens) * 100 : 0;
                cost = this.calculateCost(modelName || 'unknown', inputTokens, outputTokens, cachedTokens);
            }
            if (provider === 'Anthropic') {
                inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
                outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
                cachedTokens = usage.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? 0;
                totalTokens = usage.total_tokens ?? (inputTokens + outputTokens);
                cachePercentage = inputTokens > 0 ? (cachedTokens / inputTokens) * 100 : 0;
                cost = this.calculateCost(modelName || 'unknown', inputTokens, outputTokens, cachedTokens);
            }
        } catch (e) {
            this.warn(`Failed to parse token usage for ${modelName}: ${e}`);
            return;
        }

        // Format output
        const formattedCost = cost.toFixed(6);
        const formattedCachePercentage = cachePercentage.toFixed(2);
        const contextInfo = callType ? ` [${callType}${callCount ? `-${callCount}` : ''}]` : '';
        const currency = provider === 'DeepSeek' ? '¥' : '$';
        const message = `[${provider}]${contextInfo} Token Usage: input ${inputTokens} | output ${outputTokens} | total ${totalTokens} | Cache: ${formattedCachePercentage}% | Cost: ${formattedCost}${currency}`;

        this.info(message);
    }

    /**
     * Pricing table (cost per 1M tokens). DeepSeek values are in CNY (RMB); others in USD.
     */
    private static readonly PRICING_TABLE = {
        // OpenAI (USD)
        'gpt-5': { input: 1.25, output: 10.0, cached: 0.125 },
        'gpt-5-mini': { input: 0.25, output: 2.0, cached: 0.025 },
        'gpt-5-nano': { input: 0.05, output: 0.4, cached: 0.005 },
        'gpt-4.1': { input: 2.0, output: 8.0, cached: 0.5 },
        'gpt-4.1-mini': { input: 0.4, output: 1.6, cached: 0.1 },
        'gpt-4o': { input: 2.5, output: 10.0, cached: 1.25 },
        'gpt-4o-mini': { input: 0.15, output: 0.6, cached: 0.075 },
        'o4-mini': { input: 1.10, output: 4.40, cached: 0.275 },

        // Anthropic Claude (USD)
        'claude-opus-4-1-20250805': { input: 15.0, output: 75.0, cached: 1.5 },
        'claude-opus-4-20250514': { input: 15.0, output: 75.0, cached: 1.5 },
        'claude-sonnet-4-20250514': { input: 3.0, output: 15.0, cached: 0.3 },
        'claude-3-7-sonnet-20250219': { input: 3.0, output: 15.0, cached: 0.3 },
        'claude-3-5-sonnet-20241022': { input: 3.0, output: 15.0, cached: 0.3 },
        'claude-3-5-sonnet-20240620': { input: 3.0, output: 15.0, cached: 0.3 },
        'claude-3-5-haiku-20241022': { input: 0.8, output: 4.0, cached: 0.08 },

        // Google Gemini (USD) — based on screenshots
        'gemini-2.5-pro': { input: 1.25, output: 10.0, cached: 0.31 },
        'gemini-2.5-flash': { input: 0.30, output: 2.50, cached: 0.075 },

        // DeepSeek (CNY/RMB)
        'deepseek-chat': { input: 4.0, output: 12.0, cached: 0.5 },
        'deepseek-reasoner': { input: 4.0, output: 12.0, cached: 0.5 },
    };

    /**
     * Calculate API call cost
     */
    private calculateCost(modelName: string, inputTokens: number, outputTokens: number, cachedTokens?: number): number {
        const pricing = Logger.PRICING_TABLE[modelName as keyof typeof Logger.PRICING_TABLE];
        if (!pricing) {
            throw new Error("Unknown model pricing");
        }

        const inputCost = (inputTokens / 1000000) * pricing.input;
        const outputCost = (outputTokens / 1000000) * pricing.output;
        const cachedCost = cachedTokens ? (cachedTokens / 1000000) * pricing.cached : 0;
        return inputCost + outputCost + cachedCost;
    }

    /**
     * Log summarized token usage from multiple API calls
     * Consolidates multiple usage objects into a single summary with total cost calculation
     */
    public usageSummary(provider: string, usages: any[], modelName: string, callType: string = '', callCount?: number): void {
        if (!usages.length) {
            this.info(`[${provider}]${callType ? ` [${callType}${callCount ? `-${callCount}` : ''}]` : ''} No token usage data to summarize`);
            return;
        }

        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let totalCachedTokens = 0;
        let totalTokens = 0;
        let totalCost = 0;

        // Process each usage object
        for (const usage of usages) {
            if (!usage) {
                continue;
            }

            let inputTokens = 0;
            let outputTokens = 0;
            let cachedTokens = 0;

            try {
                if (provider === 'OpenAI') {
                    inputTokens = usage.input_tokens || 0;
                    outputTokens = usage.output_tokens || 0;
                    cachedTokens = usage.input_tokens_details?.cached_tokens || 0;
                } else if (provider === 'DeepSeek') {
                    inputTokens = usage.prompt_tokens || 0;
                    outputTokens = usage.completion_tokens || 0;
                    cachedTokens = usage.prompt_cache_hit_tokens || 0;
                } else {
                    // Fallback to legacy format for other providers
                    inputTokens = usage.prompt_tokens || usage.input_tokens || 0;
                    outputTokens = usage.completion_tokens || usage.output_tokens || 0;
                    cachedTokens = usage.cached_tokens || usage.input_tokens_details?.cached_tokens || 0;
                }

                // Accumulate totals
                totalInputTokens += inputTokens;
                totalOutputTokens += outputTokens;
                totalCachedTokens += cachedTokens;
                totalTokens += usage.total_tokens || (inputTokens + outputTokens);

                // Calculate cost for this usage
                totalCost += this.calculateCost(modelName, inputTokens, outputTokens, cachedTokens);
            } catch (e) {
                this.warn(`Failed to parse token usage in summary for ${modelName}: ${e}`);
                continue;
            }
        }

        // Calculate cache percentage
        const cachePercentage = totalInputTokens > 0 ? (totalCachedTokens / totalInputTokens) * 100 : 0;

        // Format output
        const formattedCost = totalCost.toFixed(6);
        const formattedCachePercentage = cachePercentage.toFixed(5);
        const contextInfo = callType ? ` [${callType}${callCount ? `-${callCount}` : ''}]` : '';
        const currency = provider === 'DeepSeek' ? '¥' : '$';
        const message = `[${provider}]${contextInfo} Total Token Usage: input ${totalInputTokens} | output ${totalOutputTokens} | total ${totalTokens} | Cache: ${formattedCachePercentage}% | Cost: ${formattedCost}${currency} (${usages.length} calls)`;

        this.info(message);
    }

    private log(level: LogLevel, message: string, ...args: any[]): void {
        if (level < this.logLevel) {
            return;
        }

        const timestamp = new Date().toISOString();
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
