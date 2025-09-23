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