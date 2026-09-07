/** User-adjustable operational budgets. Storage identity and evidence rules are separate. */
export const MEMORY_DEFAULTS = Object.freeze({
    'navigation.maxTokens': 1500,
    'navigation.maxInputPercent': 5,
    'search.maxCalls': 3,
    'sources.maxChunks': 16,
    'sources.timeoutMs': 1500,
    'sources.maxResultTokens': 4096,
    'consolidation.maxInputTokens': 16000,
    'consolidation.maxOutputTokens': 4000,
    'consolidation.maxCallsPer24h': 2,
    maxStorageMiB: 256,
    'storage.maxEpisodes': 2000,
    'storage.maxEpisodeKiB': 256,
    'storage.maxManifestMiB': 8,
});

export type MemorySettings = Readonly<{ [K in keyof typeof MEMORY_DEFAULTS]: number }>;

/** Resolve once per operation so edits to Settings cannot change an in-flight budget. */
export function resolveMemorySettings(config: { get<T>(key: string, defaultValue: T): T }): MemorySettings {
    const result = { ...MEMORY_DEFAULTS } as { -readonly [K in keyof MemorySettings]: number };
    for (const key of Object.keys(MEMORY_DEFAULTS) as Array<keyof MemorySettings>) {
        const value = config.get<number>(key, MEMORY_DEFAULTS[key]);
        const minimum = key === 'search.maxCalls' ? 0 : 1;
        if (!Number.isSafeInteger(value) || value < minimum ||
            (key === 'navigation.maxInputPercent' && value > 100) ||
            (key === 'sources.timeoutMs' && value > 2147483647) ||
            ((key.endsWith('MiB') || key.endsWith('KiB')) && !Number.isSafeInteger(value * 1048576))) {
            throw new Error(`Invalid gitCommitGenie.memory.${key}: ${String(value)}.`);
        }
        result[key] = value;
    }
    return Object.freeze(result);
}

/** Only these expected model request errors may be returned in-band. */
export class MemoryRequestError extends Error {
    constructor(readonly code: 'invalid_arguments' | 'unknown_memory_id' | 'source_budget_exceeded' | 'search_budget_exceeded' | 'result_budget_exceeded',
        message: string, readonly details: Record<string, unknown> = {}) {
        super(message);
        this.name = 'MemoryRequestError';
    }
}
