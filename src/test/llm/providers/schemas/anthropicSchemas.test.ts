import { describe, it } from 'mocha';
import * as assert from 'assert';
import { AnthropicEvidenceSummaryTool } from '../../../../services/llm/providers/schemas/anthropicSchemas';

describe('AnthropicEvidenceSummaryTool', () => {
    it('requires all evidence collection fields', () => {
        const properties = AnthropicEvidenceSummaryTool.input_schema.properties as Record<string, unknown>;

        for (const field of ['changes', 'tests', 'breakingSignals', 'uncertainties']) {
            assert.ok(field in properties, `Anthropic schema is missing ${field}`);
        }
        const uncertaintySchema = properties.uncertainties as { items: { properties: Record<string, unknown> } };
        assert.ok('evidenceHunkIds' in uncertaintySchema.items.properties);
        assert.deepStrictEqual(AnthropicEvidenceSummaryTool.input_schema.required, [
            'changes', 'tests', 'breakingSignals', 'uncertainties',
        ]);
    });
});
