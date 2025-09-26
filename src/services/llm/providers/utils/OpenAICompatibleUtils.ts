import * as vscode from 'vscode';
import OpenAI from 'openai';
import { BaseProviderUtils } from './BaseProviderUtils';
import { logger } from '../../../logger';

/**
 * Utilities for OpenAI-compatible API providers (OpenAI, DeepSeek, etc.)
 */
export class OpenAICompatibleUtils extends BaseProviderUtils {

    /**
     * Unified chat completion method with retry, error handling and cancellation support
     */
    async callChatCompletion(
        client: OpenAI,
        messages: any[],
        options: {
            model: string;
            provider: string;
            token?: vscode.CancellationToken;
            temperature?: number;
            responseFormat?: any;
            trackUsage?: boolean;
            maxTokens?: number;
        }
    ): Promise<{ content: string; usage?: any }> {
        if (!client) {
            throw new Error(`${options.provider} client is not initialized`);
        }

        if (!options.model) {
            throw new Error(`${options.provider} model is not selected`);
        }

        const controller = this.createAbortController(options.token);
        this.checkCancellation(options.token);

        let lastErr: any;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const requestOptions: any = {
                    model: options.model,
                    messages,
                    temperature: options.temperature ?? 0
                };

                if (options.responseFormat) {
                    requestOptions.response_format = options.responseFormat;
                }

                if (options.maxTokens) {
                    requestOptions.max_tokens = options.maxTokens;
                }

                const response = await client.chat.completions.create(requestOptions, {
                    signal: controller.signal
                });

                const content = response.choices[0]?.message?.content ?? '';
                const usage = options.trackUsage ? (response as any).usage : undefined;

                // Token usage logging is handled at provider level to avoid duplication

                return { content, usage };
            } catch (e: any) {
                lastErr = e;
                const code = e?.status || e?.code;

                if (controller.signal.aborted) {
                    throw new Error('Cancelled');
                }

                if (code === 429) {
                    await this.maybeWarnRateLimit(options.provider, options.model);
                    const wait = this.getRetryDelayMs(e);
                    logger.warn(`[Genie][${options.provider}] Rate limited. Retrying in ${wait}ms (attempt ${attempt + 1}/2)`);
                    await this.sleep(wait);
                    continue;
                }

                throw e;
            }
        }

        throw lastErr || new Error(`${options.provider} chat failed after retries`);
    }

    /**
     * Validate API key by making a test request
     */
    async validateApiKey(
        client: OpenAI,
        testModel: string,
        provider: string
    ): Promise<void> {
        try {
            await client.chat.completions.create({
                model: testModel,
                messages: [{ role: 'user', content: 'ping' }],
                max_tokens: 1,
            });
        } catch (err: any) {
            throw new Error(err?.message || `Failed to validate ${provider} API key.`);
        }
    }

    /**
     * Try to list models, fallback to preferred list if not supported
     */
    async tryListModels(
        client: OpenAI,
        preferredModels: string[],
        provider: string
    ): Promise<string[]> {
        try {
            const list = await client.models.list();
            const ids = list.data?.map(m => (m as any).id) || [];
            const available = preferredModels.filter(id => ids.includes(id));
            return available.length ? available : preferredModels;
        } catch (inner: any) {
            // Fallback: validate API key with a minimal request
            await this.validateApiKey(client, preferredModels[0], provider);
            return preferredModels;
        }
    }
}