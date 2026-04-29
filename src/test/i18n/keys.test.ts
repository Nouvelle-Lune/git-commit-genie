import { describe, it } from 'mocha';
import * as assert from 'assert';
import { L10N_KEYS } from '../../i18n/keys';

// ============================================================================
// keys.test.ts — Unit tests for L10N_KEYS localization constants
// ============================================================================

describe('L10N_KEYS', () => {

  // =========================================================================
  // genieMenu
  // =========================================================================

  describe('genieMenu', () => {

    // ---- happy path ----

    it('should have toggleThinking with the correct label', () => {
      assert.strictEqual(
        L10N_KEYS.genieMenu.toggleThinking,
        '$(thinking) Enable / Disable thinking mode'
      );
    });

    it('should have all expected genieMenu keys', () => {
      const expectedKeys = [
        'placeholder',
        'manageModels',
        'cancelAnalysis',
        'refreshAnalysis',
        'openMarkdown',
        'toggleThinking',
      ];
      const actualKeys = Object.keys(L10N_KEYS.genieMenu).sort();
      assert.deepStrictEqual(actualKeys, expectedKeys.sort());
    });

    // ---- regression guard ----

    it('should NOT have the misspelled toggleThingking property', () => {
      assert.strictEqual(
        (L10N_KEYS.genieMenu as Record<string, unknown>)['toggleThingking'],
        undefined,
        'toggleThingking (misspelled) should not exist — use toggleThinking instead'
      );
    });

  });

  // =========================================================================
  // Structural integrity
  // =========================================================================

  describe('structural integrity', () => {

    it('should be a frozen/const object with expected top-level sections', () => {
      const topLevelKeys = Object.keys(L10N_KEYS).sort();
      // Verify genieMenu is present (the module under change)
      assert.ok(topLevelKeys.includes('genieMenu'));
      // Spot-check a few other sections exist
      assert.ok(topLevelKeys.includes('chain'));
      assert.ok(topLevelKeys.includes('statusBar'));
      assert.ok(topLevelKeys.includes('repoAnalysis'));
    });

    it('should have non-empty string values for all genieMenu entries', () => {
      for (const [key, value] of Object.entries(L10N_KEYS.genieMenu)) {
        assert.strictEqual(typeof value, 'string', `${key} should be a string`);
        assert.ok(value.length > 0, `${key} should not be empty`);
      }
    });

  });

});
