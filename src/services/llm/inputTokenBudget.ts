import { MODEL_MAX_CONTEXT_TOKENS, estimateTokens } from '../analysis/tools/modelContext';
import type { RequestType } from './llmTypes';
import type { AIMessage, AIThinkingConfig, ProviderKind } from './providers';
import { StructuredOutputTerminatedError } from './structuredCompletion';

export const DEFAULT_CHAIN_CONTEXT_WINDOW_TOKENS = 128_000;
/** Target share of the post-safety window reserved for model output. */
export const OUTPUT_TOKEN_FRACTION = 0.25;
/** Guardrail for malformed or extreme custom windows. */
export const OUTPUT_TOKEN_CEILING = 65_536;

const MIN_DERIVED_OUTPUT_TOKENS = 256;
const MIN_INPUT_FRACTION = 0.55;

export interface ChainTokenBudget {
    configuredContextTokens: number;
    effectiveContextTokens: number;
    maxOutputTokens: number;
    estimatedThinkingTokens: number;
    safetyTokens: number;
    hardInputTokens: number;
    compressionTriggerTokens: number;
    compressionTargetTokens: number;
    outputAccounting: 'shared' | 'separate';
}

export interface ChainTokenBudgetOptions {
    provider: ProviderKind;
    model: string;
    contextWindowTokens: number;
    thinking?: AIThinkingConfig;
}

/** Splits the post-safety window between input and output proportionally. */
export function deriveMaxOutputTokens(spendableTokens: number): number {
    if (spendableTokens <= MIN_DERIVED_OUTPUT_TOKENS) {
        return MIN_DERIVED_OUTPUT_TOKENS;
    }
    const minInputReserve = Math.max(512, Math.floor(spendableTokens * MIN_INPUT_FRACTION));
    const maxOutputByInput = spendableTokens - minInputReserve;
    const targetOutput = Math.floor(spendableTokens * OUTPUT_TOKEN_FRACTION);
    return Math.min(
        OUTPUT_TOKEN_CEILING,
        maxOutputByInput,
        Math.max(MIN_DERIVED_OUTPUT_TOKENS, targetOutput),
    );
}

/** Resolves one budget shared by raw planning, every chain stage, and retries. */
export function resolveChainTokenBudget(options: ChainTokenBudgetOptions): ChainTokenBudget {
    const { provider, model, contextWindowTokens, thinking } = options;
    assertPositiveInteger('gitCommitGenie.chain.contextWindowTokens', contextWindowTokens);

    // Custom model ids are user-owned. Their configured window remains authoritative
    // even when the id happens to collide with a built-in registry entry.
    const registeredContext = provider === 'custom' ? undefined : MODEL_MAX_CONTEXT_TOKENS[model];
    const effectiveContextTokens = registeredContext
        ? Math.min(contextWindowTokens, registeredContext)
        : contextWindowTokens;
    const safetyTokens = Math.max(512, Math.ceil(effectiveContextTokens * 0.05));
    const outputAccounting = provider === 'google' ? 'separate' as const : 'shared' as const;
    const estimatedThinkingTokens = outputAccounting === 'separate'
        ? estimateSeparateThinkingTokens(thinking)
        : 0;
    const spendableTokens = effectiveContextTokens - safetyTokens - estimatedThinkingTokens;
    if (spendableTokens <= MIN_DERIVED_OUTPUT_TOKENS) {
        throw new ChainTokenBudgetConflictError(
            effectiveContextTokens,
            estimatedThinkingTokens,
            safetyTokens,
        );
    }
    const maxOutputTokens = deriveMaxOutputTokens(spendableTokens);
    const hardInputTokens = spendableTokens - maxOutputTokens;
    if (hardInputTokens <= 0) {
        throw new ChainTokenBudgetConflictError(
            effectiveContextTokens,
            estimatedThinkingTokens,
            safetyTokens,
        );
    }

    const compressionTriggerTokens = Math.min(
        Math.floor(effectiveContextTokens * 0.8),
        hardInputTokens,
    );
    const compressionTargetTokens = Math.max(1, Math.floor(compressionTriggerTokens * 0.9));
    return {
        configuredContextTokens: contextWindowTokens,
        effectiveContextTokens,
        maxOutputTokens,
        estimatedThinkingTokens,
        safetyTokens,
        hardInputTokens,
        compressionTriggerTokens,
        compressionTargetTokens,
        outputAccounting,
    };
}

export class ChainTokenBudgetConflictError extends Error {
    constructor(
        readonly contextWindowTokens: number,
        readonly estimatedThinkingTokens: number,
        readonly safetyTokens: number,
    ) {
        const suggestedContext = estimatedThinkingTokens + safetyTokens + 16_384;
        super(
            `The configured context window (${contextWindowTokens}) is too small after reserving ` +
            `thinking (${estimatedThinkingTokens}) and safety (${safetyTokens}). ` +
            `Raise gitCommitGenie.chain.contextWindowTokens (for example to ${suggestedContext}) ` +
            'or lower the thinking level.',
        );
        this.name = 'ChainTokenBudgetConflictError';
    }
}

export function estimateChatMessagesTokens(messages: AIMessage[]): number {
    return Math.ceil(estimateTokens(JSON.stringify(messages)));
}

export function assertChatMessagesWithinTokenBudget(
    messages: AIMessage[],
    budget: ChainTokenBudget,
    requestType?: RequestType,
): void {
    const estimatedTokens = estimateChatMessagesTokens(messages);
    if (estimatedTokens > budget.hardInputTokens) {
        throw new InputContextBudgetExceededError(
            requestType,
            estimatedTokens,
            budget.hardInputTokens,
            budget.effectiveContextTokens,
        );
    }
}

export class InputContextBudgetExceededError extends Error {
    constructor(
        readonly requestType: RequestType | undefined,
        readonly estimatedInputTokens: number,
        readonly hardInputTokens: number,
        readonly contextWindowTokens: number,
    ) {
        super(
            `Thinking request '${requestType || 'unknown'}' requires approximately ${estimatedInputTokens} input tokens, ` +
            `exceeding its safe input capacity (${hardInputTokens}) within the ${contextWindowTokens}-token context window.`,
        );
        this.name = 'InputContextBudgetExceededError';
    }
}

/** Recognizes local preflight failures and explicit provider context-window failures. */
export function isContextWindowFailure(error: unknown): boolean {
    if (error instanceof InputContextBudgetExceededError) {
        return true;
    }
    if (error instanceof StructuredOutputTerminatedError) {
        return error.kind === 'context_exhausted';
    }
    const message = String((error as { message?: unknown })?.message ?? error ?? '');
    return /maximum context|context (?:length|window).*(?:exceed|full|limit)|input token count.*exceed|too many input tokens|prompt is too long/i.test(message);
}

function estimateSeparateThinkingTokens(thinking: AIThinkingConfig | undefined): number {
    if (!thinking?.reasoning || thinking.level === 'off') {
        return 0;
    }
    if (thinking.budget !== undefined) {
        return thinking.budget;
    }
    const estimates: Record<Exclude<AIThinkingConfig['level'], 'off'>, number> = {
        minimal: 1_024,
        low: 4_096,
        medium: 10_240,
        high: 24_576,
        xhigh: 32_768,
        max: 65_536,
    };
    return estimates[thinking.level];
}

function assertPositiveInteger(name: string, value: number): void {
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer; received ${value}.`);
    }
}
