import { ProviderKind } from './types';

/** User-facing labels for the supported provider families. */
export const PROVIDER_LABELS: Readonly<Record<ProviderKind, string>> = Object.freeze({
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    google: 'Google Gemini',
    custom: 'Custom',
});
