/**
 * LLM Service Layer - Unified Exports
 * 
 * This module exports all types and base classes for LLM service providers.
 */

// Type definitions and interfaces
export {
    RequestType,
    LLMExecution,
    LLMRunOptions,
    LLMResponse,
    LLMError,
    GenerateCommitMessageOptions,
    LLMService
} from './llmTypes';

// Base implementation class
export { BaseLLMService } from './baseLLMService';
export { UnifiedLLMService } from './unifiedLLMService';
export * from './providers';

// Error handling
export { ProviderError } from './providers/errors/providerError';
