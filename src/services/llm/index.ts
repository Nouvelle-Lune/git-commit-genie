/**
 * LLM Service Layer - Unified Exports
 * 
 * This module exports all types and base classes for LLM service providers.
 */

// Type definitions and interfaces
export {
    ChatRole,
    ChatMessage,
    RequestType,
    ChatFn,
    LLMResponse,
    LLMError,
    GenerateCommitMessageOptions,
    LLMService
} from './llmTypes';

// Base implementation class
export { BaseLLMService } from './baseLLMService';

// Provider implementations
export { OpenAIService } from './providers/openai';
export { DeepSeekService } from './providers/deepseek';
export { QwenService } from './providers/qwen';
export { AnthropicService } from './providers/anthropic';
export { GeminiService } from './providers/gemini';

// Error handling
export { ProviderError } from './providers/errors/providerError';
