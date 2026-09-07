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
    CustomProviderConfig,
} from './types';
import {
    structuredOutputPromptInjection,
    toolLoopTerminalPromptInjection,
} from '../structuredOutputPrompt';
import { assertHttpBaseUrl, parseJsonObject, parseStructuredText } from './json';
import { applyOpenAICompatibleThinking } from './thinking';

/** OpenAI-compatible message shape used by custom endpoints. */
type CustomMessage = {
    role: AIMessage['role'] | 'tool';
    content: string | null;
    tool_call_id?: string;
    tool_calls?: unknown[];
    reasoning?: string;
    reasoning_content?: string;
    reasoning_text?: string;
};

class CustomSession implements AISession {
    readonly provider = 'custom' as const;
    readonly model: string;
    private readonly transcript: AIMessage[] = [];
    private readonly messages: CustomMessage[] = [];
    private readonly thinking?: AIThinkingConfig;

    constructor(private readonly client: OpenAI, options: AISessionOptions) {
        this.model = options.model;
        this.thinking = options.thinking;
        if (options.systemInstruction) {
            this.messages.push({ role: 'system', content: options.systemInstruction });
        }
    }

    async run(request: AIRunRequest): Promise<AIRunResponse> {
        // Chat Completions requires every assistant tool call to be answered
        // before a later user message. AgentRuntime can submit the pending tool
        // results and the next-phase prompt together, so preserve that protocol
        // order when extending the persistent conversation history.
        for (const result of request.toolResults ?? []) {
            this.messages.push({ role: 'tool', content: result.output, tool_call_id: result.callId });
        }
        for (const message of request.messages ?? []) {
            this.transcript.push(message);
            if (message.role === 'system' || message.role === 'developer') {
                continue;
            }
            this.messages.push(message);
        }
        const requestMessages: CustomMessage[] = this.messages.map(message => ({ ...message }));
        const response: any = await this.createCompletion(request, requestMessages);
        const choice = response.choices?.[0]?.message;
        if (!choice) {
            throw new Error('Custom provider returned no assistant message.');
        }
        const reasoning = readReasoning(choice);
        const thinking = this.thinking;
        const assistantMessage: CustomMessage = {
            role: 'assistant',
            content: choice.content ?? null,
            tool_calls: choice.tool_calls,
        };
        if (thinking?.requiresReasoningContentOnAssistantMessages && thinking.reasoning && thinking.level !== 'off') {
            assistantMessage.reasoning_content = reasoning ?? '';
        }
        this.messages.push({
            ...assistantMessage,
        });
        const text = String(choice.content ?? '');
        const toolCalls = (choice.tool_calls ?? []).map((call: any) => ({
            id: String(call.id),
            name: String(call.function?.name),
            arguments: parseJsonObject(String(call.function?.arguments ?? '{}')),
        }));
        if (text) {
            this.transcript.push({ role: 'assistant', content: text });
        }
        const reasoningTokens = response.usage?.completion_tokens_details?.reasoning_tokens;
        const completionTokens = response.usage?.completion_tokens;
        const stopReasonRaw = String(response.choices?.[0]?.finish_reason ?? '');
        const stopReason = stopReasonRaw === 'stop'
            ? 'completed' as const
            : stopReasonRaw === 'tool_calls' || stopReasonRaw === 'function_call'
                ? 'tool_call' as const
                : stopReasonRaw === 'length'
                    ? typeof reasoningTokens === 'number'
                        ? 'max_output_tokens' as const
                        : 'unknown_length' as const
                    : stopReasonRaw === 'content_filter'
                        ? 'content_filter' as const
                        : 'unknown' as const;
        return {
            text,
            reasoning,
            structured: request.responseFormat ? parseStructuredText(text) : undefined,
            toolCalls,
            usage: response.usage ? {
                inputTokens: response.usage.prompt_tokens,
                outputTokens: response.usage.completion_tokens,
                reasoningTokens,
                visibleOutputTokens: typeof completionTokens === 'number'
                    ? Math.max(0, completionTokens - (reasoningTokens ?? 0))
                    : undefined,
                totalTokens: response.usage.total_tokens,
                cachedInputTokens: response.usage.prompt_tokens_details?.cached_tokens,
                raw: response.usage,
            } : undefined,
            stopReason,
            stopReasonRaw,
            continuation: { serverManaged: false },
            raw: response,
        };
    }

    private async createCompletion(request: AIRunRequest, requestMessages: CustomMessage[]): Promise<unknown> {
        if (!request.responseFormat) {
            return this.requestCompletion(request, requestMessages, undefined);
        }

        const hasCallableTools = Boolean(request.tools?.length) && request.toolChoice !== 'none';
        if (hasCallableTools) {
            // llama.cpp and similar Chat Completions servers build different
            // grammars for native tool calls and response_format. Combining the
            // two can leave tagged Qwen tool calls to a failing post-generation
            // parser. Keep the tool turn unconstrained and validate its eventual
            // terminal JSON locally; schema repair runs later without tools.
            const toolLoopMessages = this.withPromptSchemaInstruction(
                requestMessages,
                request.responseFormat,
                toolLoopTerminalPromptInjection,
            );
            return this.requestCompletion(request, toolLoopMessages, undefined);
        }

        // The schema instruction is injected for the strict attempt as well as
        // the fallback. A custom endpoint that advertises json_schema support may
        // still enforce it loosely, and the two requests must not present the
        // model with different contracts: whichever one the server accepts, the
        // caller validates the same schema locally.
        const promptMessages = this.withPromptSchemaInstruction(requestMessages, request.responseFormat);
        try {
            return await this.requestCompletion(request, promptMessages, {
                type: 'json_schema',
                json_schema: {
                    name: request.responseFormat.name,
                    schema: request.responseFormat.schema,
                    strict: true,
                },
            });
        } catch (error) {
            if (!isUnsupportedStructuredOutputError(error)) {
                throw error;
            }
            return this.requestCompletion(request, promptMessages, { type: 'json_object' });
        }
    }

    private withPromptSchemaInstruction(
        requestMessages: CustomMessage[],
        responseFormat: NonNullable<AIRunRequest['responseFormat']>,
        buildInstruction = structuredOutputPromptInjection,
    ): CustomMessage[] {
        const messages = requestMessages.map(message => ({ ...message }));
        const formatInstruction = buildInstruction(responseFormat.schema);
        const systemMessage = messages.find(message => message.role === 'system');
        if (systemMessage) {
            systemMessage.content = `${systemMessage.content ?? ''}\n\n${formatInstruction}`;
        } else {
            messages.unshift({ role: 'system', content: formatInstruction });
        }
        return messages;
    }

    private requestCompletion(
        request: AIRunRequest,
        requestMessages: CustomMessage[],
        responseFormat: Record<string, unknown> | undefined,
    ): Promise<unknown> {
        const callableTools = request.toolChoice === 'none' ? undefined : request.tools;
        const body: Record<string, unknown> = {
            model: this.model,
            messages: requestMessages,
            temperature: request.temperature,
            max_tokens: request.maxOutputTokens,
            response_format: responseFormat,
            tools: callableTools?.map(tool => ({
                type: 'function',
                function: { name: tool.name, description: tool.description, parameters: tool.parameters },
            })),
            tool_choice: request.toolChoice,
            parallel_tool_calls: callableTools?.length ? false : undefined,
        };
        applyOpenAICompatibleThinking(body, this.thinking);
        return (this.client.chat.completions.create as any)(body, {
            signal: request.signal,
            ...(request.transportRetries === 0 ? { maxRetries: 0 } : {}),
        });
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

/** Reads the first non-empty reasoning field exposed by OpenAI-compatible APIs. */
function readReasoning(message: Record<string, unknown>): string | undefined {
    for (const field of ['reasoning_content', 'reasoning', 'reasoning_text']) {
        const value = message[field];
        if (typeof value === 'string' && value.length > 0) {
            return value;
        }
    }
    return undefined;
}

function isUnsupportedStructuredOutputError(error: unknown): boolean {
    const status = (error as { status?: number })?.status;
    if (status !== undefined && status !== 400 && status !== 404 && status !== 422) {
        return false;
    }
    const code = String(
        (error as { code?: string })?.code
        ?? (error as { error?: { code?: string } })?.error?.code
        ?? '',
    );
    const message = String((error as { message?: string })?.message ?? error ?? '');
    if (/unsupported.*(?:response_format|json_schema)|(?:response_format|json_schema).*(?:not\s+(?:supported|available)|unknown)|unknown.*response_format/i.test(message)) {
        return true;
    }
    return code === 'invalid_request_error' && /response_format|json_schema/i.test(message);
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
