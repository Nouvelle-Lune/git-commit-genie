import * as vscode from 'vscode';
import OpenAI from 'openai';
import { zodTextFormat } from './openAiZodPatch';
import { BaseProviderUtils } from './baseProviderUtils';
import { logger } from '../../../logger';
import { ProviderError } from '../errors/providerError';

import { ChatMessage, RequestType } from "../../llmTypes";

import { commitMessageSchema, fileSummarySchema, validateAndFixResponseSchema, classifyAndDraftResponseSchema, repoAnalysisResponseSchema, repoAnalysisActionSchema } from "../schemas/common";
import { OpenAIRepoAnalysisFunctions } from "../schemas/openaiFunctions";


interface OpenAIRequestOptions {
    model: string;
    instructions?: string;
    input: any;
    max_output_tokens?: number;
    temperature?: number;
    text?: any;
    response_format?: any;
    requestType: RequestType;
    previous_response_id?: string;
    store?: boolean;
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
            previousResponseId?: string;
            store?: boolean;
            toolOutputs?: Array<{ call_id: string; output: string }>; // For OpenAI Responses function_call_output
        }
    ): Promise<{ parsedResponse?: any; usage?: any; parsedAssistantResponse?: any; responseId?: string; functionCallId?: string }> {
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
                    // Use Responses API with function calling for OpenAI
                    const response = await client.responses.create(
                        requestOptions as any,
                        { signal: controller.signal }
                    );
                    const output: any[] = (response as any)?.output || [];
                    // Find first function call item, if any
                    const fnCall = output.find((it: any) => it?.type === 'function_call');
                    // Try to capture a brief reason from any assistant message in this response
                    let reasonText = '';
                    const msg = output.filter((it: any) => it?.type === 'message').pop();
                    if (msg && Array.isArray(msg.content)) {
                        const texts = msg.content.filter((c: any) => c?.type === 'output_text').map((c: any) => c?.text || '').filter(Boolean);
                        reasonText = texts.join('\n').slice(0, 500);
                    }
                    if (fnCall && fnCall?.name) {
                        const name = String(fnCall.name);
                        const argsStr = String(fnCall.arguments || '{}');
                        let args: any = {};
                        try { args = JSON.parse(argsStr); } catch { args = {}; }
                        const argReason = typeof args?.reason === 'string' ? args.reason : '';
                        if (argReason) { reasonText = argReason; delete args.reason; }
                        if (name === 'finalize') {
                            const final = args || {};
                            return { parsedResponse: { action: 'final', final }, usage: (response as any).usage, responseId: (response as any)?.id, functionCallId: String(fnCall.call_id || fnCall.id || '') };
                        }
                        return { parsedResponse: { action: 'tool', toolName: name, args, reason: reasonText }, usage: (response as any).usage, responseId: (response as any)?.id, functionCallId: String(fnCall.call_id || fnCall.id || '') };
                    }
                    // If no function call, treat as an error 
                    throw new Error('OpenAI did not return a function call.');
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
            previousResponseId?: string;
            store?: boolean;
            toolOutputs?: Array<{ call_id: string; output: string }>;
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
                ['repoAnalysisAction', { schema: repoAnalysisActionSchema, name: 'repoAnalysisAction' }],
                // Treat strictFix and enforceLanguage like commitMessage for schema purposes
                ['strictFix', { schema: commitMessageSchema, name: 'commitMessage' }],
                ['enforceLanguage', { schema: commitMessageSchema, name: 'commitMessage' }],
            ]);

            // Responses API supports either a string or a list of message-like items for `input`.
            // Map our ChatMessage[] to EasyInputMessage[] and provide system guidance via `instructions`.
            const systemMsg = messages.find(m => m.role === 'system')?.content || '';
            const inputItems: any[] = messages
                .filter(m => m.role !== 'system')
                .map(m => ({ role: m.role, content: m.content }));
            // Append function_call_output items if provided
            if (options.toolOutputs && Array.isArray(options.toolOutputs) && options.toolOutputs.length) {
                for (const item of options.toolOutputs) {
                    if (item && typeof item.call_id === 'string' && typeof item.output === 'string') {
                        inputItems.push({ type: 'function_call_output', call_id: item.call_id, output: item.output });
                    }
                }
            }
            const baseOptions: any = {
                model: options.model,
                instructions: systemMsg || undefined,
                input: inputItems,
                max_output_tokens: options.maxTokens,
            };

            // gpt-5 models do not support temperature
            if (!options.model.includes('gpt-5')) {
                (baseOptions as OpenAIRequestOptions).temperature = options.temperature ?? this.getTemperature();
            }

            const schemaConfig = requestTypeSchemaMap.get(options.requestType);
            if (schemaConfig && options.requestType !== 'repoAnalysisAction') {
                (baseOptions as OpenAIRequestOptions).text = {
                    format: zodTextFormat(schemaConfig.schema, schemaConfig.name)
                };
            }

            // Enable OpenAI function calling for repoAnalysisAction
            if (options.requestType === 'repoAnalysisAction') {
                (baseOptions as any).tools = [...OpenAIRepoAnalysisFunctions];
                // Force exactly one function call per turn and avoid free-form text responses.
                (baseOptions as any).tool_choice = 'required';
                (baseOptions as any).parallel_tool_calls = false;
            }

            // Chain responses using previous_response_id when provided
            if (options.previousResponseId) {
                (baseOptions as any).previous_response_id = options.previousResponseId;
            }
            if (typeof options.store === 'boolean') {
                (baseOptions as any).store = options.store;
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
