import * as vscode from 'vscode';
import { BaseProviderUtils } from './baseProviderUtils';
import { logger } from '../../../logger/index';
import { ProviderError } from '../errors/providerError';

import { Content, GoogleGenAI, GenerateContentConfig } from '@google/genai';
import { ChatMessage } from '../../llmTypes';


// Global type definitions for @google/genai compatibility
declare global {
    interface ErrorEvent {
        error: any;
        message: string;
        filename?: string;
        lineno?: number;
        colno?: number;
    }

    interface CloseEvent {
        code: number;
        reason: string;
        wasClean: boolean;
    }
}

interface GeminiChatContents {
    content: Content;
    systemInstruction: string;
}

/**
 * Utilities for Google Gemini API using @google/genai
 */
export class GeminiUtils extends BaseProviderUtils {

    /**
     * Unified Gemini chat completion method with retry, error handling and cancellation support
     * Now supports structured output via responseSchema
     */
    async callChatCompletion(
        client: GoogleGenAI,
        messages: any[],
        options: {
            model: string;
            provider: string;
            token?: vscode.CancellationToken;
            temperature?: number;
            maxTokens?: number;
            trackUsage?: boolean;
            responseSchema?: any;
            systemInstruction?: string;
        }
    ): Promise<{ parsedResponse?: any; usage?: any }> {

        if (!client) {
            throw new Error(`${options.provider} client is not initialized`);
        }

        if (!options.model) {
            throw new Error(`${options.provider} model is not selected`);
        }

        this.checkCancellation(options.token);

        let lastErr: any;
        const retries = this.getMaxRetries();
        const totalAttempts = Math.max(1, retries + 1);
        for (let attempt = 0; attempt < totalAttempts; attempt++) {
            try {
                // Convert messages to Gemini format
                const chatContents: GeminiChatContents = this.convertMessagesToGeminiFormat(messages, options.systemInstruction);

                const config: GenerateContentConfig = {
                    temperature: options.temperature ?? this.getTemperature()
                };

                if (options.maxTokens) {
                    config.maxOutputTokens = options.maxTokens;
                }

                // Add structured output support
                if (options.responseSchema) {
                    config.responseMimeType = 'application/json';
                    config.responseSchema = options.responseSchema;
                }

                config.systemInstruction = chatContents.systemInstruction;

                // Create AbortController for cancellation
                const controller = this.createAbortController(options.token);
                config.abortSignal = controller.signal;

                const response = await client.models.generateContent({
                    model: options.model,
                    contents: chatContents.content,
                    config: config,
                });

                const content = response.text ?? '';
                const usage = options.trackUsage ? this.extractUsageFromResponse(response) : undefined;

                // Parse JSON response if responseSchema is provided
                let parsedResponse;
                if (options.responseSchema && content) {
                    try {
                        parsedResponse = JSON.parse(content);
                    } catch (error) {
                        continue; // Retry on JSON parse error
                    }
                }

                // Token usage logging is handled at provider level to avoid duplication

                return { parsedResponse, usage };
            } catch (e: any) {
                lastErr = e;
                const code = e?.status || e?.statusCode || e?.code;

                if (e.name === 'AbortError' || e.message?.includes('aborted')) {
                    throw new Error('Cancelled');
                }

                if (code === 429) {
                    await this.maybeWarnRateLimit(options.provider, options.model);
                    const wait = this.getRetryDelayMs(e);
                    logger.warn(`[Genie][${options.provider}] Rate limited. Retrying in ${wait}ms (attempt ${attempt + 1}/${totalAttempts})`);
                    await this.sleep(wait);
                    continue;
                }

                throw e;
            }
        }

        throw lastErr || new Error(`${options.provider} chat failed after retries`);
    }

    /**
     * Convert messages to Gemini's expected format
     * Now supports explicit system instruction parameter
     * Gemini contents structure:
     * ```typescript
     * {
     *   role: 'user' | 'model',
     *   parts: [{ text: string }]
     * }
     * ```
     */
    private convertMessagesToGeminiFormat(messages: ChatMessage[], explicitSystemInstruction?: string): GeminiChatContents {
        ;
        let systemInstruction = explicitSystemInstruction || '';
        let userContent: Content = { parts: [], role: 'user' };
        for (const message of messages) {
            if (message.role === 'system') {
                // Gemini handles system messages differently - they become systemInstruction
                systemInstruction += (systemInstruction ? '\n\n' : '') + message.content;
            } else if (message.role === 'user') {
                userContent.parts!.push({ text: message.content });
            }
        }
        return {
            content: userContent,
            systemInstruction: systemInstruction.trim()
        };
    }

    /**
     * Extract usage information from Gemini response
     */
    private extractUsageFromResponse(response: any): any {
        const usageMetadata = response.usageMetadata;
        if (!usageMetadata) {
            return undefined;
        }

        return {
            prompt_tokens: usageMetadata.promptTokenCount || 0,
            completion_tokens: usageMetadata.candidatesTokenCount + usageMetadata.thoughtsTokenCount || 0,
            total_tokens: usageMetadata.totalTokenCount || 0,
            cachedTokens: usageMetadata.cachedContentTokenCount || 0
        };
    }

    /**
     * Validate Gemini API key by making a test request
     */
    async validateApiKey(
        client: GoogleGenAI,
        testModel: string,
        provider: string
    ): Promise<void> {
        try {
            await client.models.generateContent({
                model: testModel,
                contents: "ping",
                config: {
                    maxOutputTokens: 10
                }
            });
        } catch (err: any) {
            throw new Error(err?.message || `Failed to validate ${provider} API key.`);
        }
    }

    /**
     * Raw JSON chat for tool-driven scenarios without business logic
     */
    async rawChatJson(
        client: GoogleGenAI,
        messages: any[],
        options: {
            model: string;
            token?: vscode.CancellationToken;
            temperature?: number;
        }
    ): Promise<any> {
        this.validateClient(client, 'Gemini');
        this.validateModel(options.model, 'Gemini');

        this.checkCancellation(options.token);

        let lastErr: any;
        const retries = this.getMaxRetries();
        const totalAttempts = Math.max(1, retries + 1);

        for (let attempt = 0; attempt < totalAttempts; attempt++) {
            try {
                const chatContents: GeminiChatContents = this.convertMessagesToGeminiFormat(messages, undefined);

                const config: GenerateContentConfig = {
                    temperature: options.temperature ?? this.getTemperature(),
                    responseMimeType: 'application/json'
                };

                config.systemInstruction = chatContents.systemInstruction;

                const controller = this.createAbortController(options.token);
                config.abortSignal = controller.signal;

                const response = await client.models.generateContent({
                    model: options.model,
                    contents: chatContents.content,
                    config: config,
                });

                const content = response.text ?? '';

                // Extract JSON from response
                const start = content.indexOf('{');
                const end = content.lastIndexOf('}');
                if (start >= 0 && end > start) {
                    return JSON.parse(content.slice(start, end + 1));
                }
                return JSON.parse(content || '{}');
            } catch (e: any) {
                lastErr = e;
                const code = e?.status || e?.statusCode || e?.code;

                if (e.name === 'AbortError' || e.message?.includes('aborted')) {
                    throw ProviderError.cancelled();
                }

                if (code === 429) {
                    await this.maybeWarnRateLimit('Gemini', options.model);
                    const wait = this.getRetryDelayMs(e);
                    logger.warn(`[Genie][Raw Chat] Rate limited. Retrying in ${wait}ms (attempt ${attempt + 1}/${totalAttempts})`);
                    await this.sleep(wait);
                    continue;
                }

                throw ProviderError.wrap(e, 'Gemini');
            }
        }

        throw ProviderError.chatJsonFailed('Gemini', lastErr);
    }

    /**
     * Raw text chat for tool-driven scenarios without business logic
     */
    async rawChatText(
        client: GoogleGenAI,
        messages: any[],
        options: {
            model: string;
            token?: vscode.CancellationToken;
            temperature?: number;
        }
    ): Promise<string> {
        this.validateClient(client, 'Gemini');
        this.validateModel(options.model, 'Gemini');

        this.checkCancellation(options.token);

        let lastErr: any;
        const retries = this.getMaxRetries();
        const totalAttempts = Math.max(1, retries + 1);

        for (let attempt = 0; attempt < totalAttempts; attempt++) {
            try {
                const chatContents: GeminiChatContents = this.convertMessagesToGeminiFormat(messages, undefined);

                const config: GenerateContentConfig = {
                    temperature: options.temperature ?? this.getTemperature()
                };

                config.systemInstruction = chatContents.systemInstruction;

                const controller = this.createAbortController(options.token);
                config.abortSignal = controller.signal;

                const response = await client.models.generateContent({
                    model: options.model,
                    contents: chatContents.content,
                    config: config,
                });

                return response.text ?? '';
            } catch (e: any) {
                lastErr = e;
                const code = e?.status || e?.statusCode || e?.code;

                if (e.name === 'AbortError' || e.message?.includes('aborted')) {
                    throw ProviderError.cancelled();
                }

                if (code === 429) {
                    await this.maybeWarnRateLimit('Gemini', options.model);
                    const wait = this.getRetryDelayMs(e);
                    logger.warn(`[Genie][Raw Chat] Rate limited. Retrying in ${wait}ms (attempt ${attempt + 1}/${totalAttempts})`);
                    await this.sleep(wait);
                    continue;
                }

                throw ProviderError.wrap(e, 'Gemini');
            }
        }

        throw ProviderError.chatTextFailed('Gemini', lastErr);
    }
}

