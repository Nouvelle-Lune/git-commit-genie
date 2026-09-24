/**
 * Preset model catalog.
 *
 * Every entry is a vendor the extension can configure from one shared API key:
 * the transport it speaks (`responses` / `messages` / `gemini` / `chat`), the
 * endpoint that transport posts to, and the models the vendor currently serves.
 * Picking a preset model fills in the endpoint, the model id, the context window
 * and the rate card key, so a user only pastes one key per vendor. Manually
 * configured `custom` endpoints keep working exactly as before.
 *
 * Maintenance contract:
 * - `PRICING_TABLE` (src/services/cost/pricing.ts) needs a rate card for every
 *   preset model, filed under `pricingKey` whenever the vendor's card is not keyed
 *   by the bare model id (regional suffixes such as `:intl`, gateway rates).
 * - `MODEL_MAX_CONTEXT_TOKENS` (src/services/analysis/tools/modelContext.ts) mirrors
 *   the same ids for lookups that run without a preset vendor.
 * - Thinking metadata is only declared when the vendor documents a reversible
 *   switch. Everything else stays on `thinkingFormat: 'off'` so an unsupported
 *   reasoning field is never sent; users can still opt in per model through the
 *   advanced thinking compatibility menu.
 */
import { AIModelThinkingMetadata, ProviderKind } from './types';

/** Request family a preset model is served over. */
export type PresetTransport = 'responses' | 'messages' | 'gemini' | 'chat';

/** Vendors that ship a preset catalog. */
export type PresetVendorId =
    | 'openai'
    | 'anthropic'
    | 'google'
    | 'deepseek'
    | 'glm'
    | 'kimi'
    | 'qwen-intl'
    | 'qwen-china'
    | 'opencode-zen'
    | 'opencode-go';

/** Transport → provider adapter used for the request. */
export const PRESET_TRANSPORT_PROVIDERS: Readonly<Record<PresetTransport, ProviderKind>> = Object.freeze({
    responses: 'openai',
    messages: 'anthropic',
    gemini: 'google',
    chat: 'custom',
});

/** Human-readable transport names for the model management menus. */
export const PRESET_TRANSPORT_LABELS: Readonly<Record<PresetTransport, string>> = Object.freeze({
    responses: 'OpenAI Responses API',
    messages: 'Anthropic Messages API',
    gemini: 'Gemini Interactions API',
    chat: 'OpenAI-compatible chat completions',
});

export interface PresetModel {
    /** Model id sent to the endpoint. */
    readonly model: string;
    readonly label: string;
    readonly transport: PresetTransport;
    /** Context window the chain token budget may not exceed. */
    readonly contextTokens: number;
    /** Built-in rate card key; defaults to `model`. */
    readonly pricingKey?: string;
    readonly thinking?: AIModelThinkingMetadata;
}

export interface VendorPreset {
    readonly id: PresetVendorId;
    readonly label: string;
    readonly description: string;
    /** Endpoint per transport; a missing entry falls back to the provider default. */
    readonly endpoints?: Partial<Record<PresetTransport, string>>;
    readonly models: readonly PresetModel[];
}

/**
 * DeepSeek documents a reversible thinking switch, so the shared level maps onto it.
 * Effort strings stay off because the endpoint only accepts a subset of them.
 */
const DEEPSEEK_THINKING: AIModelThinkingMetadata = Object.freeze({
    reasoning: true,
    thinkingFormat: 'deepseek' as const,
    thinkingLevelMap: Object.freeze({
        off: 'disabled',
        minimal: 'enabled',
        low: 'enabled',
        medium: 'enabled',
        high: 'enabled',
    }),
});

/** Alibaba's compatible endpoint toggles thinking with `enable_thinking`. */
const QWEN_THINKING: AIModelThinkingMetadata = Object.freeze({
    reasoning: true,
    thinkingFormat: 'qwen' as const,
    thinkingLevelMap: Object.freeze({
        off: 'false',
        minimal: 'true',
        low: 'true',
        medium: 'true',
        high: 'true',
    }),
});

/** Vendors without a documented, reversible switch never receive thinking fields. */
const NO_THINKING: AIModelThinkingMetadata = Object.freeze({
    reasoning: false,
    thinkingFormat: 'off' as const,
});

/** Builds the model list of one vendor that shares a single transport profile. */
function vendorModels(
    transport: PresetTransport,
    thinking: AIModelThinkingMetadata | undefined,
    entries: ReadonlyArray<readonly [string, string, number] | readonly [string, string, number, string]>,
): PresetModel[] {
    return entries.map(([model, label, contextTokens, pricingKey]) => ({
        model,
        label,
        transport,
        contextTokens,
        ...(pricingKey !== undefined ? { pricingKey } : {}),
        ...(thinking !== undefined ? { thinking } : {}),
    }));
}

/** Gateway catalogs mix transports under one key and price every model per vendor. */
function gatewayModels(
    vendorId: string,
    entries: ReadonlyArray<readonly [string, string, PresetTransport, number]>,
): PresetModel[] {
    return entries.map(([model, label, transport, contextTokens]) => ({
        model,
        label,
        transport,
        contextTokens,
        pricingKey: `${vendorId}:${model}`,
        thinking: NO_THINKING,
    }));
}


/** Vendors in menu order: official APIs first, then compatible endpoints and gateways. */
export const VENDOR_PRESETS: readonly VendorPreset[] = [
    {
        id: 'openai',
        label: 'OpenAI',
        description: 'Official OpenAI API',
        models: vendorModels('responses', undefined, [
            ['gpt-6-astra', 'GPT-6 Astra', 1_050_000],
            ['gpt-6-sol', 'GPT-6 Sol', 1_050_000],
            ['gpt-6-luna', 'GPT-6 Luna', 1_050_000],
            ['gpt-5.6-sol', 'GPT-5.6 Sol', 1_050_000],
            ['gpt-5.6-terra', 'GPT-5.6 Terra', 1_050_000],
            ['gpt-5.6-luna', 'GPT-5.6 Luna', 1_050_000],
            ['gpt-5.5', 'GPT-5.5', 1_050_000],
            ['gpt-5.4', 'GPT-5.4', 1_050_000],
            ['gpt-5.4-mini', 'GPT-5.4 mini', 400_000],
            ['gpt-5.4-nano', 'GPT-5.4 nano', 400_000],
            ['gpt-5.2', 'GPT-5.2', 400_000],
            ['gpt-5.2-pro', 'GPT-5.2 pro', 400_000],
            ['gpt-5', 'GPT-5', 400_000],
            ['gpt-5-mini', 'GPT-5 mini', 400_000],
            ['gpt-5-nano', 'GPT-5 nano', 400_000],
        ]),
    },
    {
        id: 'anthropic',
        label: 'Anthropic',
        description: 'Official Claude API',
        models: vendorModels('messages', undefined, [
            ['claude-fable-5-1', 'Claude Fable 5.1', 1_000_000],
            ['claude-opus-5-5', 'Claude Opus 5.5', 1_000_000],
            ['claude-sonnet-5', 'Claude Sonnet 5', 1_000_000],
            ['claude-haiku-4-5', 'Claude Haiku 4.5', 200_000],
        ]),
    },
    {
        id: 'google',
        label: 'Google Gemini',
        description: 'Official Gemini API',
        models: vendorModels('gemini', undefined, [
            ['gemini-3.8-flash', 'Gemini 3.8 Flash', 1_048_576],
            ['gemini-3.7-flash', 'Gemini 3.7 Flash', 1_048_576],
            ['gemini-3.6-flash', 'Gemini 3.6 Flash', 1_048_576],
            ['gemini-3.5-flash', 'Gemini 3.5 Flash', 1_048_576],
            ['gemini-3.1-pro-preview', 'Gemini 3.1 Pro', 1_048_576],
            ['gemini-2.5-pro', 'Gemini 2.5 Pro', 1_048_576],
            ['gemini-2.5-flash', 'Gemini 2.5 Flash', 1_048_576],
        ]),
    },
    {
        id: 'deepseek',
        label: 'DeepSeek',
        description: 'api.deepseek.com',
        endpoints: { chat: 'https://api.deepseek.com' },
        models: vendorModels('chat', DEEPSEEK_THINKING, [
            ['deepseek-flash', 'DeepSeek V4.1 Flash', 1_000_000],
            ['deepseek-v4-pro', 'DeepSeek V4 Pro', 1_000_000],
        ]),
    },
    {
        id: 'glm',
        label: 'GLM (BigModel)',
        description: 'open.bigmodel.cn',
        endpoints: { chat: 'https://open.bigmodel.cn/api/paas/v4' },
        models: vendorModels('chat', NO_THINKING, [
            ['glm-5.3', 'GLM-5.3', 1_000_000],
            ['glm-5.3-flash', 'GLM-5.3 Flash', 1_000_000],
            ['glm-5.3-flashx', 'GLM-5.3 FlashX', 1_000_000],
        ]),
    },
    {
        id: 'kimi',
        label: 'Kimi (Moonshot AI)',
        description: 'api.moonshot.ai',
        endpoints: { chat: 'https://api.moonshot.ai/v1' },
        models: vendorModels('chat', NO_THINKING, [
            ['kimi-k3', 'Kimi K3', 1_048_576],
            ['kimi-k2.7-code', 'Kimi K2.7 Code', 262_144],
            ['kimi-k2.7-code-highspeed', 'Kimi K2.7 Code Highspeed', 262_144],
            ['kimi-k2.6', 'Kimi K2.6', 262_144],
        ]),
    },
    {
        id: 'qwen-intl',
        label: 'Qwen (International)',
        description: 'dashscope-intl · Singapore',
        endpoints: { chat: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
        models: vendorModels('chat', QWEN_THINKING, [
            ['qwen3.8-max', 'Qwen3.8 Max', 1_000_000, 'qwen3.8-max:intl'],
            ['qwen3.8-flash', 'Qwen3.8 Flash', 1_000_000, 'qwen3.8-flash:intl'],
            ['qwen3.7-max', 'Qwen3.7 Max', 1_000_000, 'qwen3.7-max:intl'],
            ['qwen3.7-plus', 'Qwen3.7 Plus', 1_000_000, 'qwen3.7-plus:intl'],
            ['qwen3.7-flash', 'Qwen3.7 Flash', 1_000_000, 'qwen3.7-flash:intl'],
        ]),
    },
    {
        id: 'qwen-china',
        label: 'Qwen (China)',
        description: 'dashscope · Beijing',
        endpoints: { chat: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
        models: vendorModels('chat', QWEN_THINKING, [
            ['qwen3.8-max', 'Qwen3.8 Max', 1_000_000, 'qwen3.8-max:china'],
            ['qwen3.8-flash', 'Qwen3.8 Flash', 1_000_000, 'qwen3.8-flash:china'],
            ['qwen3.7-max', 'Qwen3.7 Max', 1_000_000, 'qwen3.7-max:china'],
            ['qwen3.7-plus', 'Qwen3.7 Plus', 1_000_000, 'qwen3.7-plus:china'],
            ['qwen3.7-flash', 'Qwen3.7 Flash', 1_000_000, 'qwen3.7-flash:china'],
        ]),
    },
    {
        id: 'opencode-zen',
        label: 'OpenCode Zen',
        description: 'opencode.ai/zen · pay as you go',
        endpoints: { responses: 'https://opencode.ai/zen/v1', chat: 'https://opencode.ai/zen/v1', messages: 'https://opencode.ai/zen' },
        models: gatewayModels('opencode-zen', [
            ['claude-fable-5', 'Claude Fable 5', 'messages', 1_000_000],
            ['claude-fable-5-1', 'Claude Fable 5.1', 'messages', 1_000_000],
            ['claude-haiku-4-5', 'Claude Haiku 4.5', 'messages', 200_000],
            ['claude-opus-4-5', 'Claude Opus 4.5', 'messages', 200_000],
            ['claude-opus-4-6', 'Claude Opus 4.6', 'messages', 1_000_000],
            ['claude-opus-4-7', 'Claude Opus 4.7', 'messages', 1_000_000],
            ['claude-opus-4-8', 'Claude Opus 4.8', 'messages', 1_000_000],
            ['claude-opus-5', 'Claude Opus 5', 'messages', 1_000_000],
            ['claude-opus-5-5', 'Claude Opus 5.5', 'messages', 1_000_000],
            ['claude-sonnet-4-5', 'Claude Sonnet 4.5', 'messages', 1_000_000],
            ['claude-sonnet-4-6', 'Claude Sonnet 4.6', 'messages', 1_000_000],
            ['claude-sonnet-5', 'Claude Sonnet 5', 'messages', 1_000_000],
            ['qwen3.5-plus', 'Qwen3.5 Plus', 'messages', 262_144],
            ['qwen3.6-plus', 'Qwen3.6 Plus', 'messages', 262_144],
            ['qwen3.8-flash', 'Qwen3.8 Flash', 'messages', 1_000_000],
            ['gpt-5', 'GPT-5', 'responses', 400_000],
            ['gpt-5-nano', 'GPT-5 Nano', 'responses', 400_000],
            ['gpt-5.1', 'GPT-5.1', 'responses', 400_000],
            ['gpt-5.2', 'GPT-5.2', 'responses', 400_000],
            ['gpt-5.3-codex', 'GPT-5.3 Codex', 'responses', 400_000],
            ['gpt-5.3-codex-spark', 'GPT-5.3 Codex Spark', 'responses', 128_000],
            ['gpt-5.4', 'GPT-5.4', 'responses', 1_050_000],
            ['gpt-5.4-mini', 'GPT-5.4 Mini', 'responses', 400_000],
            ['gpt-5.4-nano', 'GPT-5.4 Nano', 'responses', 400_000],
            ['gpt-5.4-pro', 'GPT-5.4 Pro', 'responses', 1_050_000],
            ['gpt-5.5', 'GPT-5.5', 'responses', 1_050_000],
            ['gpt-5.5-pro', 'GPT-5.5 Pro', 'responses', 1_050_000],
            ['gpt-5.6-luna', 'GPT-5.6 Luna', 'responses', 1_050_000],
            ['gpt-5.6-sol', 'GPT-5.6 Sol', 'responses', 1_050_000],
            ['gpt-5.6-terra', 'GPT-5.6 Terra', 'responses', 1_050_000],
            ['gpt-6-astra', 'GPT-6 Astra', 'responses', 1_050_000],
            ['gpt-6-luna', 'GPT-6 Luna', 'responses', 1_050_000],
            ['gpt-6-sol', 'GPT-6 Sol', 'responses', 1_050_000],
            ['grok-4.5', 'Grok 4.5', 'responses', 500_000],
            ['grok-4.6', 'Grok 4.6', 'responses', 500_000],
            ['grok-4.7', 'Grok 4.7 (30% Off)', 'responses', 500_000],
            ['grok-build-0.1', 'Grok Build 0.1', 'responses', 256_000],
            ['muse-spark-1.2', 'Muse Spark 1.2', 'responses', 1_048_576],
            ['muse-spark-1.3', 'Muse Spark 1.3', 'responses', 1_048_576],
            ['deepseek-v4-flash', 'DeepSeek V4 Flash', 'chat', 1_000_000],
            ['deepseek-v4-flash-vision-exp', 'DeepSeek V4 Flash Vision Exp', 'chat', 1_000_000],
            ['deepseek-v4-pro', 'DeepSeek V4 Pro', 'chat', 1_000_000],
            ['deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', 'chat', 1_000_000],
            ['glm-5.1', 'GLM-5.1', 'chat', 204_800],
            ['glm-5.2', 'GLM-5.2', 'chat', 1_000_000],
            ['glm-5.3', 'GLM-5.3', 'chat', 1_000_000],
            ['glm-5.3-flash', 'GLM-5.3-Flash', 'chat', 1_000_000],
            ['kimi-k2.6', 'Kimi K2.6', 'chat', 262_144],
            ['kimi-k2.7-code', 'Kimi K2.7 Code', 'chat', 262_144],
            ['kimi-k3', 'Kimi K3', 'chat', 1_048_576],
            ['minimax-m2.7', 'MiniMax-M2.7', 'chat', 204_800],
            ['minimax-m3', 'MiniMax-M3', 'chat', 512_000],
        ]),
    },
    {
        id: 'opencode-go',
        label: 'OpenCode Go',
        description: 'opencode.ai/zen/go · subscription',
        endpoints: { responses: 'https://opencode.ai/zen/go/v1', chat: 'https://opencode.ai/zen/go/v1', messages: 'https://opencode.ai/zen/go' },
        models: gatewayModels('opencode-go', [
            ['minimax-m2.5', 'MiniMax-M2.5', 'messages', 204_800],
            ['minimax-m2.7', 'MiniMax-M2.7', 'messages', 204_800],
            ['minimax-m3', 'MiniMax-M3', 'messages', 1_000_000],
            ['qwen3.6-plus', 'Qwen3.6 Plus', 'messages', 1_000_000],
            ['qwen3.7-max', 'Qwen3.7 Max', 'messages', 1_000_000],
            ['qwen3.7-plus', 'Qwen3.7 Plus', 'messages', 1_000_000],
            ['qwen3.8-flash', 'Qwen3.8 Flash', 'messages', 1_000_000],
            ['qwen3.8-max', 'Qwen3.8 Max', 'messages', 1_000_000],
            ['gpt-5.6-luna', 'GPT-5.6 Luna', 'responses', 1_050_000],
            ['gpt-6-luna', 'GPT-6 Luna', 'responses', 1_050_000],
            ['grok-4.6', 'Grok 4.6', 'responses', 500_000],
            ['grok-4.7', 'Grok 4.7', 'responses', 500_000],
            ['muse-spark-1.2-contributor', 'Muse Spark 1.2 Contributor', 'responses', 1_048_576],
            ['muse-spark-1.3-contributor', 'Muse Spark 1.3 Contributor', 'responses', 1_048_576],
            ['deepseek-v4-flash', 'DeepSeek V4 Flash', 'chat', 1_000_000],
            ['deepseek-v4-flash-vision-exp', 'DeepSeek V4 Flash Vision Exp', 'chat', 1_000_000],
            ['deepseek-v4-pro', 'DeepSeek V4 Pro (New)', 'chat', 1_000_000],
            ['deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', 'chat', 1_000_000],
            ['glm-5.1', 'GLM-5.1', 'chat', 202_752],
            ['glm-5.2', 'GLM-5.2', 'chat', 1_000_000],
            ['glm-5.3', 'GLM-5.3', 'chat', 1_000_000],
            ['glm-5.3-flash', 'GLM-5.3-Flash', 'chat', 1_000_000],
            ['hy3', 'Hy3', 'chat', 256_000],
            ['hy4-preview', 'Hy4 preview', 'chat', 1_024_000],
            ['kimi-k2.6', 'Kimi K2.6', 'chat', 262_144],
            ['kimi-k2.7-code', 'Kimi K2.7 Code', 'chat', 262_144],
            ['kimi-k3', 'Kimi K3', 'chat', 1_048_576],
            ['longcat-2.0', 'LongCat-2.0', 'chat', 1_000_000],
            ['mimo-v2.5', 'MiMo V2.5', 'chat', 1_000_000],
            ['mimo-v2.5-pro', 'MiMo V2.5 Pro', 'chat', 1_048_576],
            ['mimo-v2.6-flash', 'MiMo-V2.6-Flash', 'chat', 1_048_576],
            ['mimo-v2.6-pro', 'MiMo-V2.6-Pro', 'chat', 1_048_576],
        ]),
    },
];

const VENDOR_PRESET_INDEX: ReadonlyMap<string, VendorPreset> = new Map(
    VENDOR_PRESETS.map(vendor => [vendor.id, vendor]),
);

/** Returns the preset vendor, or undefined for a manually configured model. */
export function getVendorPreset(vendorId: string | undefined): VendorPreset | undefined {
    return vendorId === undefined ? undefined : VENDOR_PRESET_INDEX.get(vendorId);
}

/** Returns the preset entry backing one configured model instance. */
export function getPresetModel(vendorId: string | undefined, model: string): PresetModel | undefined {
    return getVendorPreset(vendorId)?.models.find(entry => entry.model === model);
}

/** Built-in rate card key for a model instance: the vendor card when one exists. */
export function pricingKeyForModel(model: { vendor?: string; model: string }): string {
    return getPresetModel(model.vendor, model.model)?.pricingKey ?? model.model;
}

/** Registered context window for a preset model; undefined keeps the user's own window. */
export function presetContextTokens(model: { vendor?: string; model: string }): number | undefined {
    return getPresetModel(model.vendor, model.model)?.contextTokens;
}
