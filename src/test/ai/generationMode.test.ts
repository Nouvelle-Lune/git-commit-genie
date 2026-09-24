import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import {
    GENERATION_MODES,
    LEGACY_GENERATION_MODE_ALIASES,
    migrateGenerationMode,
    parseGenerationMode,
} from '../../services/router/generationMode';

describe('generation mode parser', () => {
    it('accepts exactly the three public generation modes without rewriting them', () => {
        // The public enum values must round-trip unchanged so configuration and command selection share one contract.
        assert.deepEqual(GENERATION_MODES, ['auto', 'fast', 'deep']);
        for (const mode of GENERATION_MODES) {
            assert.equal(parseGenerationMode(mode), mode);
        }
    });

    it('still accepts the pre-rename names so an upgrade never invalidates a stored setting', () => {
        // `onePrompt`/`chain` shipped before the product rename; a user who never opens settings again
        // must keep routing the way they chose instead of hitting an error mid-generation.
        assert.deepEqual(LEGACY_GENERATION_MODE_ALIASES, { onePrompt: 'fast', chain: 'deep' });
        assert.equal(parseGenerationMode('onePrompt'), 'fast');
        assert.equal(parseGenerationMode('chain'), 'deep');
    });

    it('reports which legacy values need rewriting, and nothing for current ones', () => {
        // The settings editor validates against the published enum, so legacy values are migrated on
        // activation; anything already current must be left alone (no write, no churn in settings.json).
        assert.equal(migrateGenerationMode('onePrompt'), 'fast');
        assert.equal(migrateGenerationMode('chain'), 'deep');
        for (const value of [...GENERATION_MODES, '', 'AUTO', null, undefined, 1, true, {}, []]) {
            assert.equal(migrateGenerationMode(value), undefined, `expected no migration for ${String(value)}`);
        }
    });

    it('rejects legacy booleans and every unknown generation mode', () => {
        // Removed boolean configuration and unknown strings must fail loudly instead of silently selecting a route.
        for (const value of [true, false, '', 'enabled', 'disabled', 'AUTO', null, undefined, 1, {}, []]) {
            assert.throws(
                () => parseGenerationMode(value),
                /Invalid Git Commit Genie generation mode/,
                `expected rejection for ${String(value)}`,
            );
        }
    });
});
