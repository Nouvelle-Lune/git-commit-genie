import OpenAI from 'openai';
import {
    AIMessage,
    AIProvider,
    AIRunRequest,
    AIRunResponse,
    AISession,
    AISessionOptions,
    AISessionSnapshot,
    CustomProviderConfig,
} from './types';
import { assertHttpBaseUrl, parseStructuredText } from './json';

/** OpenAI-compatible message shape used by custom endpoints. */
type CustomMessage = {
    role: AIMessage['role'] | 'tool';
    content: string | null;
    tool_call_id?: string;
    tool_calls?: unknown[];
};

class CustomSession implements AISession {
    readonly provider = 'custom' as const;
    readonly model: string;
    private readonly transcript: AIMessage[] = [];
    private readonly messages: CustomMessage[] = [];

    constructor(private readonly client: OpenAI, options: AISessionOptions) {
        this.model = options.model;
        if (options.systemInstruction) {
            this.messages.push({ role: 'system', content: options.systemInstruction });
        }
    }

    async run(request: AIRunRequest): Promise<AIRunResponse> {
        for (const message of request.messages ?? []) {
            this.transcript.push(message);
            this.messages.push(message);
        }
        for (const result of request.toolResults ?? []) {
            this.messages.push({ role: 'tool', content: result.output, tool_call_id: result.callId });
        }
        const body: Record<string, unknown> = {
            model: this.model,
            messages: this.messages,
            temperature: request.temperature,
            max_tokens: request.maxOutputTokens,
            response_format: request.responseFormat ? { type: 'json_object' } : undefined,
            tools: request.tools?.map(tool => ({
                type: 'function',
                function: { name: tool.name, description: tool.description, parameters: tool.parameters },
            })),
            tool_choice: request.toolChoice,
        };
        const response: any = await (this.client.chat.completions.create as any)(body, {
            signal: request.signal,
        });
        const choice = response.choices?.[0]?.message;
        if (!choice) {
            throw new Error('Custom provider returned no assistant message.');
        }
        this.messages.push({
            role: 'assistant',
            content: choice.content ?? null,
            tool_calls: choice.tool_calls,
        });
        const text = String(choice.content ?? '');
        const toolCalls = (choice.tool_calls ?? []).map((call: any) => ({
            id: String(call.id),
            name: String(call.function?.name),
            arguments: JSON.parse(String(call.function?.arguments ?? '{}')),
        }));
        return {
            text,
            structured: request.responseFormat ? parseStructuredText(text) : undefined,
            toolCalls,
            usage: response.usage ? {
                inputTokens: response.usage.prompt_tokens,
                outputTokens: response.usage.completion_tokens,
                totalTokens: response.usage.total_tokens,
                cachedInputTokens: response.usage.prompt_tokens_details?.cached_tokens,
                raw: response.usage,
            } : undefined,
            continuation: { serverManaged: false },
            raw: response,
        };
    }

    snapshot(): AISessionSnapshot {
        return {
            provider: this.provider,
            model: this.model,
            continuation: { serverManaged: false },
            transcript: [...this.transcript],
        };
    }
}

export class CustomProvider implements AIProvider {
    readonly kind = 'custom' as const;
    private readonly client: OpenAI;

    constructor(config: CustomProviderConfig, client?: OpenAI) {
        this.client = client ?? new OpenAI({ apiKey: config.apiKey, baseURL: assertHttpBaseUrl(config.baseUrl) });
    }

    createSession(options: AISessionOptions): AISession {
        return new CustomSession(this.client, options);
    }

    async listModels(): Promise<string[]> {
        const response = await this.client.models.list();
        return response.data.map(model => model.id).sort();
    }
}
