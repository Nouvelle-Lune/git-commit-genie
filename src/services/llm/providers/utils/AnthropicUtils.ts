import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import { BaseProviderUtils } from './BaseProviderUtils';
import { logger } from '../../../logger';
import { ToolUseBlock } from '@anthropic-ai/sdk/resources';

/**
 * Utilities for Anthropic Claude API
 */
export class AnthropicUtils extends BaseProviderUtils {

    /**
     * Unified Anthropic chat completion method with retry, error handling and cancellation support
     */
    async callChatCompletion(
        client: Anthropic,
        messages: any[],
        options: {
            model: string;
            provider: string;
            token?: vscode.CancellationToken;
            temperature?: number;
            maxTokens?: number;
            trackUsage?: boolean;
            tools?: any[];
            toolChoice?: any;
        }
    ): Promise<{ parsedResponse: any; usage?: any; stop_reason?: string }> {
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
                const requestOptions: any = {
                    model: options.model,
                    messages,
                    temperature: options.temperature ?? 0,
                    max_tokens: options.maxTokens ?? 2048,
                };

                // Handle system messages for Anthropic format
                const systemMessages = messages.filter(m => m.role === 'system');
                if (systemMessages.length > 0) {
                    requestOptions.system = systemMessages.map(m => m.content).join('\n\n');
                    requestOptions.messages = messages.filter(m => m.role !== 'system');
                }

                // Add tools and tool_choice when provided
                if (options.tools && Array.isArray(options.tools) && options.tools.length > 0) {
                    requestOptions.tools = options.tools;
                }
                if (options.toolChoice) {
                    requestOptions.tool_choice = options.toolChoice;
                }
                if (typeof options.maxTokens === 'number') {
                    requestOptions.max_tokens = options.maxTokens;
                }

                // Handle cancellation
                const controller = this.createAbortController(options.token);

                const response = await client.messages.create(requestOptions, {
                    signal: controller.signal
                });

                const block = response.content[0] as ToolUseBlock;

                const parsedResponse = block?.input;

                const usage = options.trackUsage ? response.usage : undefined;

                return { parsedResponse, usage, stop_reason: (response as any).stop_reason };
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
     * Validate Anthropic API key by making a test request
     */
    async validateApiKey(
        client: any,
        testModel: string,
        provider: string
    ): Promise<void> {
        try {
            await client.messages.create({
                model: testModel,
                messages: [{ role: 'user', content: 'ping' }],
                max_tokens: 1,
            });
        } catch (err: any) {
            throw new Error(err?.message || `Failed to validate ${provider} API key.`);
        }
    }
}
