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
 * Repository analysis state
 * Manages the state of repository analysis feature
 */
export interface AnalysisState {
    /** Whether repository analysis feature is enabled */
    enabled: boolean;
    /** Whether analysis is currently running */
    running: boolean;
    /** Whether analysis markdown file is missing */
    missing: boolean;
    /** The provider used for analysis (may differ from generation provider) */
    modelId: string;
    label: string;
    provider: ProviderKind | null;
    /** The model used for analysis (may differ from generation model) */
    model: string | null;
    /** Whether the API key for analysis provider is configured */
    hasApiKey: boolean;
    /** The repository path being analyzed (when running) */
    runningRepoPath: string | null;
    /** The repository label being analyzed (when running) */
    runningRepoLabel: string | null;
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
 * Status bar icon types for analysis state
 */
export enum AnalysisIcon {
    /** Analysis is disabled */
    None = '',
    /** No Git repository found */
    NoRepo = '$(search-stop)',
    /** Configuration warning (missing API key or model) */
    Warning = '$(warning)',
    /** Analysis is running */
    Running = '$(sync~spin)',
    /** Analysis file is missing, needs refresh */
    Refresh = '$(refresh)',
    /** Analysis is complete and up-to-date */
    Complete = '$(check)'
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
