export const GENERATION_MODES = ['auto', 'fast', 'deep'] as const;

export type GenerationMode = typeof GENERATION_MODES[number];

/**
 * Names these two modes shipped under before the product rename, still accepted from existing
 * settings so an upgrade never invalidates a user's configuration.
 *
 * `onePrompt` described the mechanism (a single prompt, no pipeline) and `chain` described the
 * implementation (the multi-stage chain), neither of which tells a user what they are choosing.
 * The values are now the names users see: `fast` and `deep`.
 */
export const LEGACY_GENERATION_MODE_ALIASES: Readonly<Record<string, GenerationMode>> = {
    onePrompt: 'fast',
    chain: 'deep',
};

export function parseGenerationMode(value: unknown): GenerationMode {
    if (typeof value === 'string') {
        if ((GENERATION_MODES as readonly string[]).includes(value)) {
            return value as GenerationMode;
        }
        const migrated = LEGACY_GENERATION_MODE_ALIASES[value];
        if (migrated) {
            return migrated;
        }
    }
    throw new Error(`Invalid Git Commit Genie generation mode: ${String(value)}`);
}

/**
 * The value a pre-rename setting should be rewritten to, or `undefined` when the value is already
 * current. VS Code validates the setting against the published `enum`, so a stored legacy value
 * would otherwise be flagged as "not accepted" in the settings editor.
 */
export function migrateGenerationMode(value: unknown): GenerationMode | undefined {
    if (typeof value !== 'string' || (GENERATION_MODES as readonly string[]).includes(value)) {
        return undefined;
    }
    return LEGACY_GENERATION_MODE_ALIASES[value];
}
