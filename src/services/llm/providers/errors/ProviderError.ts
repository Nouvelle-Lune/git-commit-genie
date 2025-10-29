import * as vscode from 'vscode';
import { L10N_KEYS as I18N } from '../../../../i18n/keys';

/**
 * Standard error class for LLM provider operations
 * Provides consistent error handling with internationalization support
 */
export class ProviderError extends Error {
    public readonly statusCode: number;
    public readonly provider: string;
    public readonly originalError?: Error;

    constructor(
        message: string,
        statusCode: number,
        provider: string,
        originalError?: Error
    ) {
        super(message);
        this.name = 'ProviderError';
        this.statusCode = statusCode;
        this.provider = provider;
        this.originalError = originalError;

        // Maintain proper stack trace for where the error was thrown
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, ProviderError);
        }

        // Attach statusCode to error object for backward compatibility
        Object.defineProperty(this, 'statusCode', {
            value: statusCode,
            writable: false,
            enumerable: true
        });
    }

    /**
     * Create error for missing API key
     */
    static apiKeyNotSet(provider: string): ProviderError {
        const message = vscode.l10n.t(I18N.provider.apiKeyNotSet, provider);
        return new ProviderError(message, 401, provider);
    }

    /**
     * Create error for uninitialized client
     */
    static clientNotInitialized(provider: string): ProviderError {
        const message = vscode.l10n.t(I18N.provider.clientNotInitialized, provider);
        return new ProviderError(message, 500, provider);
    }

    /**
     * Create error for model not selected
     */
    static modelNotSelected(provider: string): ProviderError {
        const message = vscode.l10n.t(I18N.provider.modelNotSelected, provider);
        return new ProviderError(message, 400, provider);
    }

    /**
     * Create error for model not configured
     */
    static modelNotConfigured(provider: string): ProviderError {
        const message = vscode.l10n.t(I18N.provider.modelNotConfigured, provider);
        return new ProviderError(message, 400, provider);
    }

    /**
     * Create error for service not available
     */
    static serviceNotAvailable(provider: string): ProviderError {
        const message = vscode.l10n.t(I18N.provider.serviceNotAvailable, provider);
        return new ProviderError(message, 400, provider);
    }

    /**
     * Create error for unsupported method
     */
    static methodNotSupported(methodName: string): ProviderError {
        const message = vscode.l10n.t(I18N.provider.methodNotSupported, methodName);
        return new ProviderError(message, 501, 'unknown');
    }

    /**
     * Create error for failed chat JSON
     */
    static chatJsonFailed(provider: string, originalError?: Error): ProviderError {
        const message = vscode.l10n.t(I18N.provider.chatJsonFailed);
        return new ProviderError(message, 500, provider, originalError);
    }

    /**
     * Create error for failed chat text
     */
    static chatTextFailed(provider: string, originalError?: Error): ProviderError {
        const message = vscode.l10n.t(I18N.provider.chatTextFailed);
        return new ProviderError(message, 500, provider, originalError);
    }

    /**
     * Create error for generic chat failure
     */
    static chatFailed(provider: string, originalError?: Error): ProviderError {
        const message = vscode.l10n.t(I18N.provider.chatFailed, provider);
        return new ProviderError(message, 500, provider, originalError);
    }

    /**
     * Create error for validation failure
     */
    static validationFailed(provider: string): ProviderError {
        const message = vscode.l10n.t(I18N.provider.validationFailed, provider);
        return new ProviderError(message, 500, provider);
    }

    /**
     * Create error for commit message validation failure
     */
    static commitMessageValidationFailed(provider: string): ProviderError {
        const message = vscode.l10n.t(I18N.provider.commitMessageValidationFailed, provider);
        return new ProviderError(message, 500, provider);
    }

    /**
     * Create error for cancelled operations
     */
    static cancelled(): ProviderError {
        const message = vscode.l10n.t(I18N.provider.operationCancelled);
        return new ProviderError(message, 499, 'unknown');
    }

    /**
     * Create error for unknown errors
     */
    static unknown(provider: string, originalError?: Error): ProviderError {
        const message = vscode.l10n.t(I18N.provider.unknownError, provider);
        return new ProviderError(
            originalError?.message || message,
            500,
            provider,
            originalError
        );
    }

    /**
     * Wrap an unknown error into a ProviderError
     */
    static wrap(error: any, provider: string): ProviderError {
        if (error instanceof ProviderError) {
            return error;
        }

        const statusCode = error?.statusCode || error?.status || error?.code || 500;
        const message = error?.message || vscode.l10n.t(I18N.provider.unknownError, provider);

        return new ProviderError(message, statusCode, provider, error);
    }
}
