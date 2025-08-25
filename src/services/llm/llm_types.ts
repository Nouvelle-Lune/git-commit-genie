import { DiffData } from '../git/git_types';

/**
 * Represents the response from the LLM service.
 */
export interface LLMResponse {
  content: string;
}

/**
 * Represents an error from the LLM service.
 */
export interface LLMError {
  message: string;
  statusCode?: number;
}

/**
 * Interface for an LLM service provider.
 */
export interface LLMProvider {
  generateCommitMessage(diff: DiffData): Promise<LLMResponse | LLMError>;
}