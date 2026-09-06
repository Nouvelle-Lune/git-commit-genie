import {
    AIMessage,
    AIProvider,
    AIRunRequest,
    AIRunResponse,
    AISession,
    AISessionOptions,
    AISessionSnapshot,
    AIThinkingConfig,
    GoogleProviderConfig,
} from './types';
import { parseStructuredText } from './json';
import { applyGoogleThinking } from './thinking';

const INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
/** Fetch implementation injected for deterministic provider testing. */
type Fetch = typeof fetch;

function messageText(messages: AIMessage[]): string {
    return messages
        .filter(message => message.role !== 'system')
        .map(message => `${message.role}: ${message.content}`)
        .join('\n\n');
}

class GoogleSession implements AISession {
    readonly provider = 'google' as const;
    readonly model: string;
    private previousInteractionId?: string;
    private readonly transcript: AIMessage[] = [];
    private readonly thinking?: AIThinkingConfig;

    constructor(
        private readonly apiKey: string,
        options: AISessionOptions,
        private readonly systemInstruction?: string,
        private readonly fetchFn: Fetch = fetch,
    ) {
        this.model = options.model;
        this.thinking = options.thinking;
    }

    async run(request: AIRunRequest): Promise<AIRunResponse> {
        const messages = request.messages ?? [];
        this.transcript.push(...messages);
        const toolResults = request.toolResults?.map(result => ({
            type: 'function_result',
            call_id: result.callId,
            name: result.name,
            result: [{ type: 'text', text: result.output }],
        }));
        const input: unknown = toolResults?.length ? toolResults : messageText(messages);
        const body: Record<string, unknown> = {
            model: this.model,
            input,
            previous_interaction_id: this.previousInteractionId,
            store: true,
            system_instruction: this.systemInstruction,
            tools: request.tools?.map(tool => ({
                type: 'function',
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            })),
            tool_choice: request.toolChoice === 'required' ? 'any' : request.toolChoice,
            generation_config: {
                temperature: request.temperature,
                max_output_tokens: request.maxOutputTokens,
            },
        };
        applyGoogleThinking(body, this.thinking, this.model);
        if (request.responseFormat) {
            body.response_format = {
                type: 'text',
                mime_type: 'application/json',
                schema: request.responseFormat.schema,
            };
        }

        const response = await this.fetchFn(INTERACTIONS_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
            body: JSON.stringify(body),
            signal: request.signal,
        });
        if (!response.ok) {
            throw new Error(`Google Gemini request failed (${response.status}): ${await response.text()}`);
        }
        const interaction: any = await response.json();
        this.previousInteractionId = interaction.id;
        const modelOutputs = (interaction.steps ?? []).filter((step: any) => step?.type === 'model_output');
        const text = modelOutputs
            .flatMap((step: any) => step.content ?? [])
            .filter((content: any) => content?.type === 'text')
            .map((content: any) => String(content.text))
            .join('');
        const toolCalls = (interaction.steps ?? [])
            .filter((step: any) => step?.type === 'function_call')
            .map((step: any) => ({
                id: String(step.id),
                name: String(step.name),
                arguments: step.arguments ?? {},
            }));
        const usage = interaction.usage;
        const stopReasonRaw = String(
            interaction.finish_reason
            ?? modelOutputs.at(-1)?.finish_reason
            ?? interaction.status
            ?? '',
        );
        const normalizedStop = stopReasonRaw.toLowerCase();
        const stopReason = ['completed', 'complete', 'stop', 'stop_sequence'].includes(normalizedStop)
            ? 'completed' as const
            : ['max_tokens', 'max_output_tokens', 'max_output_length'].includes(normalizedStop)
                ? 'max_output_tokens' as const
                : ['context_length', 'context_window', 'input_too_long'].includes(normalizedStop)
                    ? 'context_window' as const
                    : normalizedStop.includes('safety') || normalizedStop.includes('filter')
                        ? 'content_filter' as const
                        : normalizedStop
                            ? 'unknown' as const
                            : 'unknown_length' as const;
        if (text) {
            this.transcript.push({ role: 'assistant', content: text });
        }
        return {
            text,
            structured: request.responseFormat ? parseStructuredText(text) : undefined,
            toolCalls,
            usage: usage ? {
                inputTokens: usage.total_input_tokens,
                outputTokens: usage.total_output_tokens,
                reasoningTokens: usage.total_thought_tokens,
                visibleOutputTokens: usage.total_output_tokens,
                totalTokens: usage.total_tokens,
                cachedInputTokens: usage.total_cached_tokens,
                raw: usage,
            } : undefined,
            stopReason,
            stopReasonRaw,
            continuation: { nativeId: interaction.id, serverManaged: true },
            raw: interaction,
        };
    }

    snapshot(): AISessionSnapshot {
        return {
            provider: this.provider,
            model: this.model,
            continuation: { nativeId: this.previousInteractionId, serverManaged: true },
            transcript: [...this.transcript],
        };
    }
}

export class GoogleProvider implements AIProvider {
    readonly kind = 'google' as const;

    constructor(private readonly config: GoogleProviderConfig, private readonly fetchFn: Fetch = fetch) {}

    createSession(options: AISessionOptions): AISession {
        return new GoogleSession(this.config.apiKey, options, options.systemInstruction, this.fetchFn);
    }

    async listModels(signal?: AbortSignal): Promise<string[]> {
        const response = await this.fetchFn('https://generativelanguage.googleapis.com/v1beta/models', {
            headers: { 'x-goog-api-key': this.config.apiKey },
            signal,
        });
        if (!response.ok) {
            throw new Error(`Google Gemini model listing failed (${response.status}): ${await response.text()}`);
        }
        const payload: any = await response.json();
        return (payload.models ?? [])
            .map((model: any) => String(model.name ?? '').replace(/^models\//, ''))
            .filter(Boolean)
            .sort();
    }
}
