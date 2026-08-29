/** Provider-neutral contracts shared by the official and compatible adapters. */
export type ProviderKind = 'openai' | 'anthropic' | 'google' | 'custom';

export type AIMessageRole = 'system' | 'developer' | 'user' | 'assistant';

export interface AIMessage {
    role: AIMessageRole;
    content: string;
}

export interface AIFunctionTool {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

export interface AIToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}

export interface AIToolResult {
    callId: string;
    name: string;
    output: string;
    isError?: boolean;
}

export interface AIResponseFormat {
    name: string;
    schema: Record<string, unknown>;
}

export interface AIUsage {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    raw?: unknown;
}

export interface AIContinuation {
    /** Provider-owned response/interaction identifier when the API supports it. */
    nativeId?: string;
    /** True only when the next request can reference nativeId instead of replaying history. */
    serverManaged: boolean;
}

export interface AIRunRequest {
    messages?: AIMessage[];
    toolResults?: AIToolResult[];
    tools?: AIFunctionTool[];
    responseFormat?: AIResponseFormat;
    toolChoice?: 'auto' | 'required' | 'none';
    temperature?: number;
    maxOutputTokens?: number;
    signal?: AbortSignal;
}

export interface AIRunResponse {
    text: string;
    structured?: unknown;
    toolCalls: AIToolCall[];
    usage?: AIUsage;
    continuation: AIContinuation;
    raw: unknown;
}

export interface AISessionSnapshot {
    provider: ProviderKind;
    model: string;
    continuation: AIContinuation;
    transcript: AIMessage[];
}

export interface AISession {
    readonly provider: ProviderKind;
    readonly model: string;
    run(request: AIRunRequest): Promise<AIRunResponse>;
    snapshot(): AISessionSnapshot;
}

export interface AISessionOptions {
    /** Stable application session id used for provider-side cache routing. */
    id?: string;
    model: string;
    systemInstruction?: string;
}

export interface AIProvider {
    readonly kind: ProviderKind;
    createSession(options: AISessionOptions): AISession;
    listModels(signal?: AbortSignal): Promise<string[]>;
}

export interface OpenAIProviderConfig {
    apiKey: string;
}

export interface AnthropicProviderConfig {
    apiKey: string;
}

export interface GoogleProviderConfig {
    apiKey: string;
}

export interface CustomProviderConfig {
    apiKey: string;
    baseUrl: string;
}
