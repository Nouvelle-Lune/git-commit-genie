import * as vscode from 'vscode';
import OpenAI from 'openai';
import { zodTextFormat } from './openAiZodPatch';
import { BaseProviderUtils } from './baseProviderUtils';
import { logger } from '../../../logger';
import { ProviderError } from '../errors/providerError';

import { ChatMessage, RequestType } from "../../llmTypes";

import { commitMessageSchema, fileSummarySchema, validateAndFixResponseSchema, classifyAndDraftResponseSchema, repoAnalysisResponseSchema } from "../schemas/common";


interface OpenAIRequestOptions {
    model: string;
    instructions?: string;
    input: string;
    max_output_tokens?: number;
    temperature?: number;
    text?: any;
    response_format?: any;
    requestType: RequestType;
}


/**
 * Utilities for OpenAI-compatible API providers (OpenAI, DeepSeek, etc.)
 */
export class OpenAICompatibleUtils extends BaseProviderUtils {

    /**
     * Unified chat completion method with retry, error handling and cancellation support
     */
    async callChatCompletion(
        client: OpenAI,
        messages: ChatMessage[],
        options: {
            model: string;
            provider: string;
            token?: vscode.CancellationToken;
            temperature?: number;
            responseFormat?: any;
            trackUsage?: boolean;
            maxTokens?: number;
            requestType: RequestType;
        }
    ): Promise<{ parsedResponse?: any; usage?: any; parsedAssistantResponse?: any }> {
        if (!client) {
            throw ProviderError.clientNotInitialized(options.provider);
        }

        if (!options.model) {
            throw ProviderError.modelNotSelected(options.provider);
        }

        const controller = this.createAbortController(options.token);
        this.checkCancellation(options.token);

        let lastErr: any;
        const retries = this.getMaxRetries();
        const totalAttempts = Math.max(1, retries + 1);

        for (let attempt = 0; attempt < totalAttempts; attempt++) {
            try {
                const requestOptions = this.buildRequestOptions(options, messages);

                if (options.provider.toLowerCase() === 'openai') {
                    const response = await client.responses.parse(
                        requestOptions,
                        {
                            signal: controller.signal
                        }
                    );
                    const parsedResponse = response.output_parsed;
                    const usage = options.trackUsage ? response.usage : undefined;

                    return { parsedResponse, usage };

                }
                if (options.provider.toLowerCase() === 'deepseek' || options.provider.toLowerCase() === 'qwen') {
                    const response = await client.chat.completions.create(
                        requestOptions,
                        {
                            signal: controller.signal
                        }
                    );
                    const content = response.choices[0]?.message?.content ?? '';


                    const usage = options.trackUsage ? (response as any).usage : undefined;

                    // Token usage logging is handled at provider level to avoid duplication
                    const parsedResponse = content ? JSON.parse(content.trim()) : undefined;
                    const parsedAssistantResponse = response.choices[0]?.message;
                    return { parsedResponse, usage, parsedAssistantResponse };

                }
            } catch (e: any) {
                lastErr = e;
                const code = e?.status || e?.code;

                if (controller.signal.aborted) {
                    throw ProviderError.cancelled();
                }

                if (code === 429) {
                    await this.maybeWarnRateLimit(options.provider, options.model);
                    const wait = this.getRetryDelayMs(e);
                    logger.warn(`[Genie][${options.provider}] Rate limited. Retrying in ${wait}ms (attempt ${attempt + 1}/${totalAttempts})`);
                    await this.sleep(wait);
                    continue;
                }

                throw ProviderError.wrap(e, options.provider);
            }
        }

        throw ProviderError.chatFailed(options.provider, lastErr);
    }

    buildRequestOptions(
        options: {
            provider: string;
            model: string;
            temperature?: number;
            maxTokens?: number;
            requestType: RequestType;
        },
        messages: ChatMessage[]
    ) {
        if (options.provider.toLowerCase() === 'openai') {
            const requestTypeSchemaMap = new Map<RequestType, { schema: any; name: string }>([
                ['commitMessage', { schema: commitMessageSchema, name: 'commitMessage' }],
                ['summary', { schema: fileSummarySchema, name: 'fileSummary' }],
                ['draft', { schema: classifyAndDraftResponseSchema, name: 'classifyAndDraftResponse' }],
                ['fix', { schema: validateAndFixResponseSchema, name: 'validateAndFixResponse' }],
                ['repoAnalysis', { schema: repoAnalysisResponseSchema, name: 'repoAnalysisResponse' }],
                // Treat strictFix and enforceLanguage like commitMessage for schema purposes
                ['strictFix', { schema: commitMessageSchema, name: 'commitMessage' }],
                ['enforceLanguage', { schema: commitMessageSchema, name: 'commitMessage' }],
            ]);

            const baseOptions = {
                model: options.model,
                instructions: messages.find(m => m.role === 'system')?.content || '',
                input: messages.find(m => m.role === 'user')?.content || '',
                max_output_tokens: options.maxTokens,
            };

            // gpt-5 models do not support temperature
            if (!options.model.includes('gpt-5')) {
                (baseOptions as OpenAIRequestOptions).temperature = options.temperature ?? this.getTemperature();
            }

            const schemaConfig = requestTypeSchemaMap.get(options.requestType);
            if (schemaConfig) {
                (baseOptions as OpenAIRequestOptions).text = {
                    format: zodTextFormat(schemaConfig.schema, schemaConfig.name)
                };
            }

            return baseOptions;
        }

        if (options.provider.toLowerCase() === 'deepseek' || options.provider.toLowerCase() === 'qwen') {
            const baseOptions: any = {
                model: options.model,
                messages: messages,
                temperature: options.temperature ?? this.getTemperature(),
                response_format: {
                    'type': 'json_object'
                }
            };

            return baseOptions;
        }

        throw ProviderError.wrap(
            new Error(`Unsupported provider for OpenAI-compatible utils: ${options.provider}`),
            options.provider
        );
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
