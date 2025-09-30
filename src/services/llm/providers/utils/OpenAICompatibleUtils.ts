import * as vscode from 'vscode';
import OpenAI from 'openai';
import { zodTextFormat } from './openAiZodPatch';
import { BaseProviderUtils } from './BaseProviderUtils';
import { logger } from '../../../logger';

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
    ): Promise<{ parsedResponse?: any; usage?: any }> {
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
                const requestOptions = this.buildRequestOptions(options, messages);

                if (options.provider === 'OpenAI') {
                    const response = await client.responses.parse(requestOptions, {
                        signal: controller.signal
                    });
                    const parsedResponse = response.output_parsed;
                    const usage = options.trackUsage ? response.usage : undefined;

                    return { parsedResponse, usage };

                }
                if (options.provider === 'DeepSeek') {
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
                    return { parsedResponse, usage };

                }
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
        if (options.provider === 'OpenAI') {
            const requestTypeSchemaMap = new Map<RequestType, { schema: any; name: string }>([
                ['commitMessage', { schema: commitMessageSchema, name: 'commitMessage' }],
                ['summary', { schema: fileSummarySchema, name: 'fileSummary' }],
                ['draft', { schema: classifyAndDraftResponseSchema, name: 'classifyAndDraftResponse' }],
                ['fix', { schema: validateAndFixResponseSchema, name: 'validateAndFixResponse' }],
                ['repoAnalysis', { schema: repoAnalysisResponseSchema, name: 'repoAnalysisResponse' }]
            ]);

            const baseOptions = {
                model: options.model,
                instructions: messages.find(m => m.role === 'system')?.content || '',
                input: messages.find(m => m.role === 'user')?.content || '',
                max_output_tokens: options.maxTokens,
            };

            // gpt-5 models do not support temperature
            if (!options.model.includes('gpt-5')) {
                (baseOptions as OpenAIRequestOptions).temperature = options.temperature ?? 0.2;
            }

            const schemaConfig = requestTypeSchemaMap.get(options.requestType);
            if (schemaConfig) {
                (baseOptions as OpenAIRequestOptions).text = {
                    format: zodTextFormat(schemaConfig.schema, schemaConfig.name)
                };
            }

            return baseOptions;
        }

        if (options.provider === 'DeepSeek') {
            const baseOptions: any = {
                model: options.model,
                messages: messages,
                temperature: options.temperature ?? 0.2,
                response_format: {
                    'type': 'json_object'
                }
            };

            return baseOptions;
        }

        throw new Error(`Unsupported provider: ${options.provider}`);
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
