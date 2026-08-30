import OpenAI from 'openai';
import {
    AIMessage,
    AIProvider,
    AIRunRequest,
    AIRunResponse,
    AISession,
    AISessionOptions,
    AISessionSnapshot,
    AIThinkingConfig,
    OpenAIProviderConfig,
} from './types';
import { parseJsonObject, parseStructuredText } from './json';
import { applyOpenAIResponsesThinking } from './thinking';

/** Converts unified messages into Responses API input items. */
function toInputMessages(messages: AIMessage[]): Array<Record<string, unknown>> {
    return messages
        .filter(message => message.role !== 'system')
        .map(message => ({ role: message.role, content: message.content }));
}

class OpenAISession implements AISession {
    readonly provider = 'openai' as const;
    readonly model: string;
    private previousResponseId?: string;
    private readonly transcript: AIMessage[] = [];
    private readonly thinking?: AIThinkingConfig;

    constructor(
        private readonly client: OpenAI,
        options: AISessionOptions,
        private readonly systemInstruction?: string,
    ) {
        this.model = options.model;
        this.promptCacheKey = options.id;
        this.thinking = options.thinking;
    }
    private readonly promptCacheKey?: string;

    async run(request: AIRunRequest): Promise<AIRunResponse> {
        const messages = request.messages ?? [];
        this.transcript.push(...messages);
        const input: Array<Record<string, unknown>> = toInputMessages(messages);
        for (const result of request.toolResults ?? []) {
            input.push({ type: 'function_call_output', call_id: result.callId, output: result.output });
        }

        const body: Record<string, unknown> = {
            model: this.model,
            instructions: this.systemInstruction,
            input,
            previous_response_id: this.previousResponseId,
            prompt_cache_key: this.promptCacheKey,
            store: true,
            max_output_tokens: request.maxOutputTokens,
            tools: request.tools?.map(tool => ({
                type: 'function',
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
                strict: true,
            })),
            tool_choice: request.toolChoice,
            parallel_tool_calls: false,
        };
        const thinking = request.thinking ?? this.thinking;
        applyOpenAIResponsesThinking(body, thinking);
        if (request.responseFormat) {
            body.text = {
                format: {
                    type: 'json_schema',
                    name: request.responseFormat.name,
                    schema: request.responseFormat.schema,
                    strict: true,
                },
            };
        }
        const thinkingEnabled = thinking?.reasoning === true && thinking.level !== 'off';
        if (request.temperature !== undefined && !this.model.startsWith('gpt-5') && !thinkingEnabled) {
            body.temperature = request.temperature;
        }

        const response: any = await (this.client.responses.create as any)(body, {
            signal: request.signal,
        });
        this.previousResponseId = response.id;
        const text = String(response.output_text ?? '');
        const toolCalls = (response.output ?? [])
            .filter((item: any) => item?.type === 'function_call')
            .map((item: any) => ({
                id: String(item.call_id ?? item.id),
                name: String(item.name),
                arguments: typeof item.arguments === 'string' ? parseJsonObject(item.arguments) : item.arguments,
            }));
        const details = response.usage?.input_tokens_details;
        const outputDetails = response.usage?.output_tokens_details;
        const reasoningTokens = outputDetails?.reasoning_tokens;
        const outputTokens = response.usage?.output_tokens;
        const stopReasonRaw = response.incomplete_details?.reason ?? response.status;
        const stopReason = response.status === 'completed'
            ? 'completed' as const
            : response.incomplete_details?.reason === 'max_output_tokens'
                ? 'max_output_tokens' as const
                : response.incomplete_details?.reason === 'content_filter'
                    ? 'content_filter' as const
                    : response.status === 'incomplete'
                        ? 'unknown_length' as const
                        : 'unknown' as const;
        if (text) {
            this.transcript.push({ role: 'assistant', content: text });
        }
        return {
            text,
            structured: request.responseFormat ? parseStructuredText(text) : undefined,
            toolCalls,
            usage: response.usage ? {
                inputTokens: response.usage.input_tokens,
                outputTokens: response.usage.output_tokens,
                reasoningTokens,
                visibleOutputTokens: typeof outputTokens === 'number'
                    ? Math.max(0, outputTokens - (reasoningTokens ?? 0))
                    : undefined,
                totalTokens: response.usage.total_tokens,
                cachedInputTokens: details?.cached_tokens,
                cacheWriteInputTokens: details?.cache_write_tokens,
                raw: response.usage,
            } : undefined,
            stopReason,
            stopReasonRaw: String(stopReasonRaw ?? ''),
            continuation: { nativeId: response.id, serverManaged: true },
            raw: response,
        };
    }

    snapshot(): AISessionSnapshot {
        return {
            provider: this.provider,
            model: this.model,
            continuation: { nativeId: this.previousResponseId, serverManaged: true },
            transcript: [...this.transcript],
        };
    }
}

export class OpenAIProvider implements AIProvider {
    readonly kind = 'openai' as const;
    private readonly client: OpenAI;

    constructor(config: OpenAIProviderConfig, client?: OpenAI) {
        this.client = client ?? new OpenAI({ apiKey: config.apiKey });
    }

    createSession(options: AISessionOptions): AISession {
        return new OpenAISession(this.client, options, options.systemInstruction);
    }

    async listModels(): Promise<string[]> {
        const response = await this.client.models.list();
        return response.data.map(model => model.id).sort();
    }
}
