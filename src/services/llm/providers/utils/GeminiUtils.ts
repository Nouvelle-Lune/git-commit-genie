import * as vscode from 'vscode';
import { BaseProviderUtils } from './baseProviderUtils';
import { logger } from '../../../logger/index';

import { Content, GoogleGenAI, GenerateContentConfig } from '@google/genai';
import { ChatMessage, RequestType } from '../../llmTypes';


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
            // Function calling (Gemini) support
            requestType?: RequestType;
            functionDeclarations?: any[];
            isFirstRequest?: boolean;
            // If needed later, we can add `functionResponse` parts support
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

                // Add structured output support for non-tool use cases
                if (options.responseSchema && !options.functionDeclarations) {
                    config.responseMimeType = 'application/json';
                    config.responseSchema = options.responseSchema;
                }

                // Add Gemini function calling when functionDeclarations provided
                if (Array.isArray(options.functionDeclarations) && options.functionDeclarations.length) {
                    (config as any).tools = [{ functionDeclarations: options.functionDeclarations }];
                    // Encourage the model to call functions rather than chat
                    (config as any).toolConfig = {
                        functionCallingConfig: {
                            mode: 'any'
                        }
                    };
                }

                config.systemInstruction = chatContents.systemInstruction;

                // Create AbortController for cancellation
                const controller = this.createAbortController(options.token);
                config.abortSignal = controller.signal;

                // Log API request (pending state) - include system prompt for first request
                const systemPrompt = typeof chatContents.systemInstruction === 'string'
                    ? chatContents.systemInstruction
                    : (chatContents.systemInstruction as any)?.parts?.[0]?.text;
                const isFirstRequest = options.isFirstRequest ?? false;
                const logId = logger.logApiRequest(options.provider, options.model, messages, systemPrompt, isFirstRequest);

                const response = await client.models.generateContent({
                    model: options.model,
                    contents: chatContents.content,
                    config: config,
                });

                const usage = options.trackUsage ? this.extractUsageFromResponse(response) : undefined;

                let parsedResponse: any = undefined;

                // Function calling path: normalize to repoAnalysisAction-like action objects
                if (Array.isArray(options.functionDeclarations) && options.functionDeclarations.length && options.requestType === 'repoAnalysisAction') {
                    const fcTop = (response as any)?.functionCalls;
                    let fnName: string | undefined;
                    let fnArgs: any = {};


                    fnName = String(fcTop[0]?.name || '');
                    fnArgs = (fcTop[0]?.args) ?? {};

                    if (!fnName) {
                        // No function call; retry
                        continue;
                    }

                    let reasonText = '';
                    if (typeof fnArgs?.reason === 'string') {
                        reasonText = String(fnArgs.reason);
                        try { delete fnArgs.reason; } catch { /* ignore */ }
                    }

                    if (fnName === 'finalize') {
                        parsedResponse = { action: 'final', final: fnArgs };
                    } else {
                        parsedResponse = { action: 'tool', toolName: fnName, args: fnArgs, reason: reasonText };
                    }

                    // Update log with function call result
                    const isFinal = fnName === 'finalize';
                    logger.logApiRequestWithResult(
                        logId,
                        options.provider,
                        options.model,
                        parsedResponse,
                        usage,
                        isFinal
                    );
                } else if (options.responseSchema) {
                    // Structured output path: extract and parse JSON from candidates
                    let jsonText = '';
                    try {
                        const candidates = (response as any)?.candidates || [];
                        const parts: any[] = candidates?.[0]?.content?.parts || [];
                        const texts = parts
                            .map((p: any) => typeof p?.text === 'string' ? p.text : '')
                            .filter(Boolean);
                        jsonText = texts.join('');
                        if (!jsonText) {
                            // Fallback to response.text if available
                            jsonText = (response as any)?.text || '';
                        }
                    } catch { /* ignore */ }

                    if (!jsonText) {
                        // No JSON returned; retry
                        continue;
                    }
                    try {
                        parsedResponse = JSON.parse(jsonText);
                    } catch {
                        // Retry on parse failure
                        continue;
                    }
                }

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
}
