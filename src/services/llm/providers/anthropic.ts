import Anthropic from '@anthropic-ai/sdk';
import {
    AIMessage,
    AIProvider,
    AIRunRequest,
    AIRunResponse,
    AISession,
    AISessionOptions,
    AISessionSnapshot,
    AIThinkingConfig,
    AnthropicProviderConfig,
} from './types';
import { parseStructuredText } from './json';
import { applyAnthropicThinking } from './thinking';

/** Anthropic Messages API adapter. */
type AnthropicMessage = { role: 'user' | 'assistant'; content: any };

class AnthropicSession implements AISession {
    readonly provider = 'anthropic' as const;
    readonly model: string;
    private readonly transcript: AIMessage[] = [];
    private readonly messages: AnthropicMessage[] = [];
    private lastResponseId?: string;
    private readonly thinking?: AIThinkingConfig;

    constructor(
        private readonly client: Anthropic,
        options: AISessionOptions,
        private readonly systemInstruction?: string,
    ) {
        this.model = options.model;
        this.thinking = options.thinking;
    }

    async run(request: AIRunRequest): Promise<AIRunResponse> {
        for (const message of request.messages ?? []) {
            this.transcript.push(message);
            if (message.role !== 'system' && message.role !== 'developer') {
                this.messages.push({ role: message.role, content: message.content });
            }
        }
        if (request.toolResults?.length) {
            this.messages.push({
                role: 'user',
                content: request.toolResults.map(result => ({
                    type: 'tool_result',
                    tool_use_id: result.callId,
                    content: result.output,
                    is_error: result.isError === true,
                })),
            });
        }

        const body: Record<string, unknown> = {
            model: this.model,
            max_tokens: request.maxOutputTokens ?? 8192,
            system: this.systemInstruction,
            messages: this.messages,
            tools: request.tools?.map(tool => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.parameters,
            })),
            temperature: request.temperature,
            cache_control: { type: 'ephemeral' },
        };
        applyAnthropicThinking(body, this.thinking);
        if (request.tools?.length) {
            body.tool_choice = request.toolChoice === 'required' ? { type: 'any' }
                : request.toolChoice === 'none' ? { type: 'none' }
                    : { type: 'auto' };
        }
        if (request.responseFormat) {
            body.output_config = {
                format: {
                    type: 'json_schema',
                    schema: request.responseFormat.schema,
                },
            };
        }

        const response: any = await (this.client.messages.create as any)(body, {
            signal: request.signal,
            ...(request.transportRetries === 0 ? { maxRetries: 0 } : {}),
        });
        this.lastResponseId = response.id;
        this.messages.push({ role: 'assistant', content: response.content });
        const text = (response.content ?? [])
            .filter((block: any) => block?.type === 'text')
            .map((block: any) => String(block.text))
            .join('');
        const toolCalls = (response.content ?? [])
            .filter((block: any) => block?.type === 'tool_use')
            .map((block: any) => ({ id: String(block.id), name: String(block.name), arguments: block.input }));
        const reasoning = (response.content ?? [])
            .filter((block: any) => block?.type === 'thinking')
            .map((block: any) => String(block.thinking ?? ''))
            .join('');
        if (text) {
            this.transcript.push({ role: 'assistant', content: text });
        }
        const stopReasonRaw = String(response.stop_reason ?? '');
        const stopReason = stopReasonRaw === 'end_turn' || stopReasonRaw === 'stop_sequence'
            ? 'completed' as const
            : stopReasonRaw === 'max_tokens'
                ? 'max_output_tokens' as const
                : stopReasonRaw === 'model_context_window_exceeded'
                    ? 'context_window' as const
                : stopReasonRaw === 'tool_use'
                    ? 'tool_call' as const
                    : stopReasonRaw
                        ? 'unknown' as const
                        : 'unknown_length' as const;
        const reasoningTokens = response.usage?.output_tokens_details?.thinking_tokens;
        const outputTokens = response.usage?.output_tokens;
        return {
            text,
            reasoning: reasoning || undefined,
            structured: request.responseFormat ? parseStructuredText(text) : undefined,
            toolCalls,
            usage: response.usage ? {
                inputTokens: response.usage.input_tokens,
                outputTokens: response.usage.output_tokens,
                reasoningTokens,
                visibleOutputTokens: typeof outputTokens === 'number' && typeof reasoningTokens === 'number'
                    ? Math.max(0, outputTokens - reasoningTokens)
                    : undefined,
                totalTokens: (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0),
                cachedInputTokens: response.usage.cache_read_input_tokens,
                cacheWriteInputTokens: response.usage.cache_creation_input_tokens,
                raw: response.usage,
            } : undefined,
            stopReason,
            stopReasonRaw,
            continuation: { nativeId: response.id, serverManaged: false },
            raw: response,
        };
    }

    snapshot(): AISessionSnapshot {
        return {
            provider: this.provider,
            model: this.model,
            continuation: { nativeId: this.lastResponseId, serverManaged: false },
            transcript: [...this.transcript],
        };
    }
}

export class AnthropicProvider implements AIProvider {
    readonly kind = 'anthropic' as const;
    private readonly client: Anthropic;

    constructor(config: AnthropicProviderConfig, client?: Anthropic) {
        this.client = client ?? new Anthropic({ apiKey: config.apiKey });
    }

    createSession(options: AISessionOptions): AISession {
        return new AnthropicSession(this.client, options, options.systemInstruction);
    }

    async listModels(): Promise<string[]> {
        const page: any = await (this.client.models.list as any)();
        return (page.data ?? []).map((model: any) => String(model.id)).sort();
    }
}
