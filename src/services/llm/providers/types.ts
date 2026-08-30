/** Provider-neutral contracts shared by the official and compatible adapters. */
export type ProviderKind = 'openai' | 'anthropic' | 'google' | 'custom';

/** User-visible reasoning levels shared by every provider adapter. */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Stable ordering used by the thinking-level picker and clamping logic. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = Object.freeze([
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
]);

/**
 * Pi-style serialization profiles for OpenAI Chat Completions-compatible endpoints.
 * These are request formats, not provider identities; every profile uses the same
 * custom provider adapter.
 */
export type AIThinkingFormat =
    | 'off'
    | 'openai'
    | 'openrouter'
    | 'deepseek'
    | 'together'
    | 'baseten'
    | 'zai'
    | 'qwen'
    | 'chat-template'
    | 'qwen-chat-template'
    | 'string-thinking'
    | 'ant-ling';

/** Top-level field names used by local servers for a thinking token ceiling. */
export type AIThinkingTokenBudgetField =
    | 'thinking_token_budget'
    | 'thinking_budget'
    | 'thinking_budget_tokens';

/** Static or Pi-style dynamic value accepted by a chat template. */
export type AIChatTemplateValue =
    | string
    | number
    | boolean
    | null
    | {
        $var: 'thinking.enabled' | 'thinking.effort' | 'thinking.budget';
        omitWhenOff?: boolean;
    };

/** Provider-neutral model capability metadata. */
export interface AIModelThinkingMetadata {
    /** Whether the model exposes a configurable reasoning/thinking mode. */
    reasoning: boolean;
    /** Maps the shared level to the provider-native value; null marks that level unsupported. */
    thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
    /** Pi-compatible request serialization profile for OpenAI-compatible endpoints. */
    thinkingFormat?: AIThinkingFormat;
    /** Values sent as chat_template_kwargs for the generic chat-template profile. */
    chatTemplateKwargs?: Record<string, AIChatTemplateValue>;
    /** Values sent as chat_template_args for the Baseten profile. */
    chatTemplateArgs?: Record<string, AIChatTemplateValue>;
    /** Optional top-level field receiving the configured thinking token budget. */
    thinkingTokenBudgetField?: AIThinkingTokenBudgetField;
    /** Whether this endpoint also accepts the OpenAI-style reasoning_effort field. */
    supportsReasoningEffort?: boolean;
    /** Whether assistant replay must include reasoning_content for this endpoint. */
    requiresReasoningContentOnAssistantMessages?: boolean;
}

/** Resolved thinking options carried from the model configuration into a session. */
export interface AIThinkingConfig {
    reasoning: boolean;
    /** Unified logical level; raw custom values use an enabled level marker. */
    level: ThinkingLevel;
    mappedValue?: string | null;
    /** Optional raw native value supplied by a custom model-level override. */
    nativeValue?: string;
    budget?: number;
    format?: AIThinkingFormat;
    chatTemplateKwargs?: Record<string, AIChatTemplateValue>;
    chatTemplateArgs?: Record<string, AIChatTemplateValue>;
    thinkingTokenBudgetField?: AIThinkingTokenBudgetField;
    supportsReasoningEffort?: boolean;
    requiresReasoningContentOnAssistantMessages?: boolean;
}

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
    /** Provider-reported reasoning/thinking tokens contained in outputTokens when available. */
    reasoningTokens?: number;
    /** Visible response tokens excluding reasoning when the provider reports the split. */
    visibleOutputTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    raw?: unknown;
}

/** Provider-neutral termination reason used by retry and compaction policy. */
export type AIStopReason =
    | 'completed'
    | 'max_output_tokens'
    | 'context_window'
    | 'content_filter'
    | 'tool_call'
    | 'unknown_length'
    | 'unknown';

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
    thinking?: AIThinkingConfig;
    signal?: AbortSignal;
}

export interface AIRunResponse {
    text: string;
    /** Provider reasoning text normalized from reasoning_content/reasoning/reasoning_text. */
    reasoning?: string;
    structured?: unknown;
    toolCalls: AIToolCall[];
    usage?: AIUsage;
    stopReason: AIStopReason;
    /** Original provider reason retained for diagnostics. */
    stopReasonRaw?: string;
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
    thinking?: AIThinkingConfig;
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
