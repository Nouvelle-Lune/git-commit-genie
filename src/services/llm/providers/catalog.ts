import type { AIModelConfig } from './config';
import {
    AIModelThinkingMetadata,
    AIThinkingConfig,
    AIThinkingFormat,
    ProviderKind,
    ThinkingLevel,
    THINKING_LEVELS,
} from './types';

/** User-facing labels for the supported provider families. */
export const PROVIDER_LABELS: Readonly<Record<ProviderKind, string>> = Object.freeze({
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    google: 'Google Gemini',
    custom: 'Custom OpenAI-compatible',
});

/** Default token budgets used by providers that expose a numeric thinking budget. */
export const DEFAULT_THINKING_BUDGETS: Readonly<Record<Exclude<ThinkingLevel, 'off'>, number>> = Object.freeze({
    minimal: 1024,
    low: 4096,
    medium: 10240,
    high: 32768,
    xhigh: 65536,
    max: 131072,
});

const OPENAI_REASONING_MAP: Partial<Record<ThinkingLevel, string | null>> = Object.freeze({
    off: 'none',
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'xhigh',
});

const OPENAI_REASONING_NO_OFF_MAP: Partial<Record<ThinkingLevel, string | null>> = Object.freeze({
    // Older OpenAI reasoning models do not accept reasoning_effort="none".
    off: null,
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'xhigh',
});

const ANTHROPIC_THINKING_MAP: Partial<Record<ThinkingLevel, string | null>> = Object.freeze({
    off: 'disabled',
    minimal: 'enabled',
    low: 'enabled',
    medium: 'enabled',
    high: 'enabled',
    xhigh: 'enabled',
    max: 'enabled',
});

const GOOGLE_BUDGET_MAP: Partial<Record<ThinkingLevel, string | null>> = Object.freeze({
    off: '0',
    minimal: null,
    low: '1024',
    medium: '8192',
    high: '24576',
    xhigh: null,
    max: null,
});

const GOOGLE_LEVEL_MAP: Partial<Record<ThinkingLevel, string | null>> = Object.freeze({
    // Gemini 3 cannot reliably disable thinking; keep off unavailable instead of omitting it.
    off: null,
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: null,
    max: null,
});

function metadata(
    thinkingLevelMap: Partial<Record<ThinkingLevel, string | null>>,
    options: Partial<Omit<AIModelThinkingMetadata, 'reasoning' | 'thinkingLevelMap'>> = {},
): AIModelThinkingMetadata {
    return Object.freeze({
        reasoning: true,
        thinkingLevelMap,
        ...options,
    });
}

function catalogEntries(
    provider: Exclude<ProviderKind, 'custom'>,
    models: readonly string[],
    modelMetadata: AIModelThinkingMetadata,
): Record<string, AIModelThinkingMetadata> {
    return Object.fromEntries(models.map(model => [`${provider}/${model}`, modelMetadata]));
}

const OPENAI_REASONING_MODELS = [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.4-nano',
    'gpt-5.2',
    'gpt-5.2-pro',
] as const;

const OPENAI_REASONING_NO_OFF_MODELS = [
    'gpt-5',
    'gpt-5-mini',
    'gpt-5-nano',
    'o3',
    'o3-mini',
    'o4-mini',
] as const;

const ANTHROPIC_EXTENDED_THINKING_MODELS = [
    'claude-3-7-sonnet-20250219',
    'claude-3-7-sonnet-latest',
    'claude-sonnet-4-20250514',
    'claude-opus-4-20250514',
    'claude-opus-4-1-20250805',
    'claude-fable-5',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'claude-haiku-4-5',
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-5',
    'claude-opus-4-5',
] as const;

const GEMINI_BUDGET_MODELS = [
    'gemini-2.5-flash',
    'gemini-2.5-flash-preview-09-2025',
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash-lite-preview-09-2025',
] as const;

const GEMINI_BUDGET_NO_OFF_MODELS = [
    'gemini-2.5-pro',
] as const;

const GOOGLE_BUDGET_NO_OFF_MAP: Partial<Record<ThinkingLevel, string | null>> = Object.freeze({
    // Gemini 2.5 Pro requires thinking and has no valid zero-budget value.
    off: null,
    minimal: null,
    low: '1024',
    medium: '8192',
    high: '24576',
    xhigh: null,
    max: null,
});

const GEMINI_LEVEL_MODELS = [
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.1-pro-preview',
    'gemini-3.1-flash-lite',
    'gemini-3-flash-preview',
    'gemini-3-pro-preview',
] as const;

/**
 * Static metadata for the official provider APIs. Unknown model ids are
 * intentionally closed by default instead of being inferred from their name.
 */
export const MODEL_THINKING_CATALOG: Readonly<Record<string, AIModelThinkingMetadata>> = Object.freeze({
    ...catalogEntries('openai', OPENAI_REASONING_MODELS, metadata(OPENAI_REASONING_MAP)),
    ...catalogEntries('openai', OPENAI_REASONING_NO_OFF_MODELS, metadata(OPENAI_REASONING_NO_OFF_MAP)),
    ...catalogEntries('anthropic', ANTHROPIC_EXTENDED_THINKING_MODELS, metadata(ANTHROPIC_THINKING_MAP)),
    ...catalogEntries('google', GEMINI_BUDGET_MODELS, metadata(GOOGLE_BUDGET_MAP)),
    ...catalogEntries('google', GEMINI_BUDGET_NO_OFF_MODELS, metadata(GOOGLE_BUDGET_NO_OFF_MAP)),
    ...catalogEntries('google', GEMINI_LEVEL_MODELS, metadata(GOOGLE_LEVEL_MAP)),
});

function customThinkingMetadata(
    model: Pick<AIModelConfig, 'reasoning' | 'thinkingLevelMap' | 'thinkingFormat' | 'chatTemplateKwargs' | 'chatTemplateArgs' | 'thinkingTokenBudgetField' | 'supportsReasoningEffort' | 'requiresReasoningContentOnAssistantMessages'>,
): AIModelThinkingMetadata {
    const thinkingFormat = model.thinkingFormat ?? 'openai';
    return {
        // Custom capability is declared by the selected format. The explicit
        // off profile is the only custom configuration that disables the adapter.
        reasoning: thinkingFormat !== 'off',
        thinkingLevelMap: model.thinkingLevelMap ?? OPENAI_REASONING_MAP,
        thinkingFormat,
        ...(model.chatTemplateKwargs !== undefined ? { chatTemplateKwargs: model.chatTemplateKwargs } : {}),
        ...(model.chatTemplateArgs !== undefined ? { chatTemplateArgs: model.chatTemplateArgs } : {}),
        ...(model.thinkingTokenBudgetField !== undefined ? { thinkingTokenBudgetField: model.thinkingTokenBudgetField } : {}),
        ...(model.supportsReasoningEffort !== undefined
            ? { supportsReasoningEffort: model.supportsReasoningEffort }
            : defaultSupportsReasoningEffort(thinkingFormat) !== undefined
                ? { supportsReasoningEffort: defaultSupportsReasoningEffort(thinkingFormat) }
                : {}),
        requiresReasoningContentOnAssistantMessages: model.requiresReasoningContentOnAssistantMessages
            ?? thinkingFormat === 'deepseek',
    };
}

function defaultSupportsReasoningEffort(format: AIThinkingFormat): boolean | undefined {
    return format === 'openai' ? true : undefined;
}

/**
 * Resolves model metadata without probing the provider or guessing from a
 * model name. Custom providers are OpenAI Chat Completions compatibles by
 * contract, so they inherit the global thinking level automatically. Standard
 * endpoints need no transport configuration; a model stores a profile only
 * when its Chat Completions implementation uses non-standard thinking fields.
 */
export function getModelThinkingMetadata(
    model: Pick<AIModelConfig, 'provider' | 'model' | 'reasoning' | 'thinkingLevelMap' | 'thinkingFormat' | 'chatTemplateKwargs' | 'chatTemplateArgs' | 'thinkingTokenBudgetField' | 'supportsReasoningEffort' | 'requiresReasoningContentOnAssistantMessages'>,
): AIModelThinkingMetadata {
    if (model.provider === 'custom') {
        return customThinkingMetadata(model);
    }

    const hasExplicitMetadata = model.reasoning !== undefined || model.thinkingLevelMap !== undefined;
    if (hasExplicitMetadata) {
        return {
            reasoning: model.reasoning === true,
            ...(model.thinkingLevelMap !== undefined ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
        };
    }

    return MODEL_THINKING_CATALOG[`${model.provider}/${model.model}`] ?? { reasoning: false };
}

/** Returns levels that the model can expose, matching Pi's null/omitted map semantics. */
export function getSupportedThinkingLevels(model: AIModelThinkingMetadata): ThinkingLevel[] {
    if (!model.reasoning) {
        return ['off'];
    }
    return THINKING_LEVELS.filter(level => {
        const mappedValue = model.thinkingLevelMap?.[level];
        if (mappedValue === null) { return false; }
        // Extended levels are opt-in; standard levels use provider defaults when omitted.
        if (level === 'xhigh' || level === 'max') { return mappedValue !== undefined; }
        return true;
    });
}

export interface ThinkingSettingsValues {
    defaultThinkingLevel: unknown;
    modelThinkingLevels: unknown;
    thinkingBudgets: unknown;
}

/** Returns the persisted model override or the global unified level before parsing it. */
export function getRequestedThinkingValue(model: AIModelConfig, settings: ThinkingSettingsValues): unknown {
    const modelOverride = getModelThinkingOverride(model, settings);
    return modelOverride.present ? modelOverride.value : settings.defaultThinkingLevel;
}

/** Returns the persisted level before validating it against model capabilities. */
export function getRequestedThinkingLevel(model: AIModelConfig, settings: ThinkingSettingsValues): ThinkingLevel {
    return parseThinkingLevel(getRequestedThinkingValue(model, settings));
}

/**
 * Resolves user settings into the exact thinking payload bound to one LLMExecution.
 * Official models with known capabilities fail hard on unsupported levels; custom
 * models keep the logical level or native override verbatim with no capability probing.
 */
export function resolveThinkingConfig(model: AIModelConfig, settings: ThinkingSettingsValues): AIThinkingConfig {
    const metadata = getModelThinkingMetadata(model);
    const modelOverride = getModelThinkingOverride(model, settings);
    const requestedValue = getRequestedThinkingValue(model, settings);
    const customNativeValue = resolveCustomNativeValue(model, metadata, requestedValue, modelOverride.present);
    if (customNativeValue !== undefined) {
        const level = getCustomLogicalLevel(customNativeValue);
        return {
            reasoning: metadata.reasoning,
            // Preserve the explicit custom override instead of translating it through the default map.
            level,
            nativeValue: customNativeValue,
            ...thinkingTransport(metadata),
            budget: resolveThinkingBudget(model, metadata, level, settings),
        };
    }

    const level = parseThinkingLevel(requestedValue);
    assertOfficialThinkingLevelSupported(model, metadata, level);
    const mappedValue = metadata.thinkingLevelMap?.[level];
    return {
        reasoning: metadata.reasoning,
        level,
        mappedValue,
        ...thinkingTransport(metadata),
        budget: resolveThinkingBudget(model, metadata, level, settings),
    };
}

/**
 * Official catalog models must use a supported logical level exactly. Custom
 * endpoints skip this check so unsupported values surface as provider errors.
 */
function assertOfficialThinkingLevelSupported(
    model: AIModelConfig,
    metadata: AIModelThinkingMetadata,
    level: ThinkingLevel,
): void {
    if (model.provider === 'custom') {
        return;
    }
    const supported = getSupportedThinkingLevels(metadata);
    if (supported.includes(level)) {
        return;
    }
    throw new Error(
        `Model '${model.provider}/${model.model}' does not support thinking level '${level}'. ` +
        `Supported levels: ${supported.join(', ') || '(none)'}.`,
    );
}

function thinkingTransport(metadata: AIModelThinkingMetadata): Pick<
    AIThinkingConfig,
    'format' | 'chatTemplateKwargs' | 'chatTemplateArgs' | 'thinkingTokenBudgetField' | 'supportsReasoningEffort' | 'requiresReasoningContentOnAssistantMessages'
> {
    return {
        ...(metadata.thinkingFormat !== undefined ? { format: metadata.thinkingFormat } : {}),
        ...(metadata.chatTemplateKwargs !== undefined ? { chatTemplateKwargs: metadata.chatTemplateKwargs } : {}),
        ...(metadata.chatTemplateArgs !== undefined ? { chatTemplateArgs: metadata.chatTemplateArgs } : {}),
        ...(metadata.thinkingTokenBudgetField !== undefined ? { thinkingTokenBudgetField: metadata.thinkingTokenBudgetField } : {}),
        ...(metadata.supportsReasoningEffort !== undefined ? { supportsReasoningEffort: metadata.supportsReasoningEffort } : {}),
        ...(metadata.requiresReasoningContentOnAssistantMessages !== undefined
            ? { requiresReasoningContentOnAssistantMessages: metadata.requiresReasoningContentOnAssistantMessages }
            : {}),
    };
}

function resolveThinkingBudget(
    model: AIModelConfig,
    metadata: AIModelThinkingMetadata,
    level: ThinkingLevel,
    settings: ThinkingSettingsValues,
): number | undefined {
    if (!metadata.reasoning || level === 'off') {
        return undefined;
    }
    const mappedValue = metadata.thinkingLevelMap?.[level];
    const usesNumericBudget = model.provider === 'anthropic'
        || (model.provider === 'google' && typeof mappedValue === 'string' && /^\d+$/.test(mappedValue));
    const usesCustomBudget = metadata.thinkingTokenBudgetField !== undefined
        || hasThinkingBudgetVariable(metadata.chatTemplateKwargs)
        || hasThinkingBudgetVariable(metadata.chatTemplateArgs);
    if (!usesNumericBudget && !usesCustomBudget) {
        return undefined;
    }
    const budgets = asRecord('thinkingBudgets', settings.thinkingBudgets);
    return parseThinkingBudget(level as Exclude<ThinkingLevel, 'off'>, budgets[level]);
}

function hasThinkingBudgetVariable(values: Record<string, unknown> | undefined): boolean {
    return Object.values(values ?? {}).some(value => (
        value !== null
        && typeof value === 'object'
        && !Array.isArray(value)
        && (value as { $var?: unknown }).$var === 'thinking.budget'
    ));
}

function resolveCustomNativeValue(
    model: AIModelConfig,
    metadata: AIModelThinkingMetadata,
    value: unknown,
    isModelOverride: boolean,
): string | undefined {
    if (!isModelOverride || model.provider !== 'custom' || metadata.thinkingFormat === 'off' || typeof value !== 'string') {
        return undefined;
    }
    const nativeValue = value.trim();
    if (!nativeValue) {
        throw new Error('Custom model thinking level must be a non-empty string.');
    }
    // Standard values remain logical levels so the selected format can map
    // them to the endpoint-native value, such as llama.cpp off -> "none".
    if (THINKING_LEVELS.includes(nativeValue as ThinkingLevel)) {
        return undefined;
    }
    return nativeValue;
}

function getCustomLogicalLevel(value: string): ThinkingLevel {
    if (THINKING_LEVELS.includes(value as ThinkingLevel)) {
        return value as ThinkingLevel;
    }
    return isNativeOffValue(value) ? 'off' : 'medium';
}

function getModelThinkingOverride(
    model: AIModelConfig,
    settings: ThinkingSettingsValues,
): { present: boolean; value: unknown } {
    const modelLevels = asRecord('modelThinkingLevels', settings.modelThinkingLevels);
    const modelKey = `${model.provider}/${model.model}`;
    const present = Object.prototype.hasOwnProperty.call(modelLevels, modelKey);
    return { present, value: present ? modelLevels[modelKey] : undefined };
}

function isNativeOffValue(value: string): boolean {
    return ['off', 'none', 'false', 'disabled', '0'].includes(value.toLowerCase());
}

/** Parses a persisted thinking level without silently accepting invalid values. */
export function parseThinkingLevel(value: unknown): ThinkingLevel {
    if (typeof value !== 'string' || !THINKING_LEVELS.includes(value as ThinkingLevel)) {
        throw new Error(`Invalid thinking level '${String(value)}'.`);
    }
    return value as ThinkingLevel;
}

function parseThinkingBudget(level: Exclude<ThinkingLevel, 'off'>, value: unknown): number {
    const budget = value === undefined ? DEFAULT_THINKING_BUDGETS[level] : value;
    if (typeof budget !== 'number' || !Number.isInteger(budget) || budget <= 0) {
        throw new Error(`thinkingBudgets.${level} must be a positive integer; received ${String(budget)}.`);
    }
    return budget;
}

function asRecord(name: string, value: unknown): Record<string, unknown> {
    if (value === undefined) {
        return {};
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`gitCommitGenie.${name} must be an object.`);
    }
    return value as Record<string, unknown>;
}
