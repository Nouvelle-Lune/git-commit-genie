/**
 * Types for StatusBarManager
 */

import { PROVIDER_LABELS as AI_PROVIDER_LABELS, ProviderKind } from '../services/llm/providers';

/**
 * Provider configuration state
 * Represents the current LLM provider and model selection for commit message generation
 */
export interface ProviderState {
    modelId: string;
    label: string;
    provider: ProviderKind | null;
    /** The selected model name */
    model: string;
    /** Whether the API key for this provider is configured */
    hasApiKey: boolean;
}

/**
 * Git repository state
 * Tracks the current Git repository information
 */
export interface GitState {
    /** Whether a Git repository exists in the workspace */
    hasRepo: boolean;
    /** Absolute path to the repository root, null if no repo */
    repoPath: string | null;
    /** Human-readable label for the repository (usually the folder name) */
    repoLabel: string;
}

/**
 * LLM Provider types supported by the extension
 */
export type LLMProvider = ProviderKind;

/**
 * Provider display labels
 */
export const PROVIDER_LABELS: Record<LLMProvider, string> = { ...AI_PROVIDER_LABELS };

/**
 * Secret storage keys for each provider
 */
