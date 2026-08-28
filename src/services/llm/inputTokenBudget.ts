import { MODEL_MAX_CONTEXT_TOKENS, estimateTokens } from '../analysis/tools/modelContext';
import { ChatMessage, RequestType } from './llmTypes';

export const DEFAULT_CHAIN_MAX_INPUT_TOKENS = 32_000;

export function resolveChainInputTokenBudget(model: string, configuredBudget: number): number {
    if (!Number.isInteger(configuredBudget) || configuredBudget <= 0) {
        throw new Error(`gitCommitGenie.chain.maxInputTokens must be a positive integer; received ${configuredBudget}.`);
    }

    // Only reject limits for models whose context size is explicitly known.
    // Local and OpenAI-compatible model ids are user-defined, so the configured
    // value remains authoritative when the shared registry has no matching id.
    const modelContextTokens = MODEL_MAX_CONTEXT_TOKENS[model];
    if (modelContextTokens && configuredBudget > modelContextTokens) {
        throw new Error(
            `gitCommitGenie.chain.maxInputTokens (${configuredBudget}) exceeds the registered context limit ` +
            `for model '${model}' (${modelContextTokens}).`
        );
    }

    return configuredBudget;
}

export function estimateChatMessagesTokens(messages: ChatMessage[]): number {
    return Math.ceil(estimateTokens(JSON.stringify(messages)));
}

export function assertChatMessagesWithinTokenBudget(
    messages: ChatMessage[],
    maxInputTokens: number,
    requestType?: RequestType
): void {
    const estimatedTokens = estimateChatMessagesTokens(messages);
    if (estimatedTokens > maxInputTokens) {
        throw new Error(
            `Thinking request '${requestType || 'unknown'}' requires approximately ${estimatedTokens} input tokens, ` +
            `which exceeds gitCommitGenie.chain.maxInputTokens (${maxInputTokens}).`
        );
    }
}
