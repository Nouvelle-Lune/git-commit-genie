import { describe, it } from 'mocha';
import * as assert from 'assert';
import { GeminiEvidenceSummarySchema } from '../../../../services/llm/providers/schemas/geminiSchemas';

describe('GeminiEvidenceSummarySchema', () => {
    it('requires all evidence collection fields', () => {
        const properties = GeminiEvidenceSummarySchema.properties as Record<string, unknown>;

        for (const field of ['changes', 'tests', 'breakingSignals', 'uncertainties']) {
            assert.ok(field in properties, `Gemini schema is missing ${field}`);
        }
        const uncertaintySchema = properties.uncertainties as { items: { properties: Record<string, unknown> } };
        assert.ok('evidenceHunkIds' in uncertaintySchema.items.properties);
        assert.deepStrictEqual(GeminiEvidenceSummarySchema.required, [
            'changes', 'tests', 'breakingSignals', 'uncertainties',
        ]);
    });
});
