import { AIModelThinkingMetadata, ProviderKind } from './types';
import type { FlatModelPricing } from '../../cost/costTypes';

/** Current persisted model configuration schema version. */
export const AI_CONFIG_VERSION = 2;
export const AI_CONFIG_VERSION_KEY = 'gitCommitGenie.ai.configVersion';
export const AI_MODELS_KEY = 'gitCommitGenie.ai.models';
export const GENERATION_MODEL_ID_KEY = 'gitCommitGenie.ai.generationModelId';

export const NATIVE_SECRET_KEYS: Readonly<Record<Exclude<ProviderKind, 'custom'>, string>> = Object.freeze({
    openai: 'gitCommitGenie.secret.ai.openai',
    anthropic: 'gitCommitGenie.secret.ai.anthropic',
    google: 'gitCommitGenie.secret.ai.google',
});

export interface AIModelConfig extends Partial<AIModelThinkingMetadata> {
    /** Stable identity referenced independently by each product workflow. */
    id: string;
    /** User-facing name for this configured model instance. */
    label: string;
    provider: ProviderKind;
    model: string;
    /** Required only for OpenAI-compatible custom providers. */
    baseUrl?: string;
    /**
     * Optional flat USD/1M-token override for this model instance.
     * Absent means use built-in PRICING_TABLE exact match, otherwise unpriced.
     * Editing label/endpoint/key must preserve this field; deleting the model removes it.
     */
    pricingOverride?: FlatModelPricing;
}

export function customSecretKey(id: string): string {
    return `gitCommitGenie.secret.ai.custom.${id}`;
}

export function modelSecretKey(model: AIModelConfig): string {
    return model.provider === 'custom'
        ? customSecretKey(model.id)
        : NATIVE_SECRET_KEYS[model.provider];
}

export function parseProviderKind(value: unknown): ProviderKind {
    if (value === 'openai' || value === 'anthropic' || value === 'google' || value === 'custom') {
        return value;
    }
    throw new Error(`Unsupported AI provider '${String(value)}'.`);
}
