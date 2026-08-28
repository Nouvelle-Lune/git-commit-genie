import { describe, it } from 'mocha';
import * as assert from 'assert';
import {
    AnthropicChangeExtractionTool,
    AnthropicEvidenceSummaryTool,
    AnthropicInformationSelectionTool,
    AnthropicInvestigationActionTool,
    AnthropicInvestigationPlanTool,
    AnthropicSemanticAnalysisTool,
} from '../../../../services/llm/providers/schemas/anthropicSchemas';

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

describe('Anthropic change-conditioned schemas', () => {
    it('keeps introducedSymbols and all sibling extraction lists primitive strings', () => {
        const properties = AnthropicChangeExtractionTool.input_schema.properties as Record<string, any>;
        for (const field of [
            'introducedSymbols', 'removedSymbols', 'changedCalls', 'changedConfigs',
            'changedTypes', 'changedDependencies',
        ]) {
            assert.strictEqual(properties[field].items.type, 'string', `${field} must contain strings`);
        }
        assert.strictEqual(properties.changedSymbols.items.type, 'object');
    });

    it('defines every new chain stage as a structured Anthropic tool', () => {
        const tools = [
            AnthropicChangeExtractionTool,
            AnthropicInvestigationPlanTool,
            AnthropicInvestigationActionTool,
            AnthropicSemanticAnalysisTool,
            AnthropicInformationSelectionTool,
        ];
        for (const tool of tools) {
            assert.strictEqual(tool.input_schema.type, 'object');
            assert.ok(Object.keys(tool.input_schema.properties).length > 0);
            assert.ok(tool.input_schema.required.length > 0);
        }
    });

    it('matches the required fields emitted by the Zod output schema', () => {
        assert.deepStrictEqual(AnthropicInvestigationPlanTool.input_schema.required, ['targets', 'notes']);
        assert.deepStrictEqual(AnthropicInvestigationActionTool.input_schema.required, [
            'action', 'tool', 'reason', 'symbol', 'filePath', 'dirPath', 'query',
            'searchType', 'useRegex', 'startLine', 'maxLines', 'maxResults', 'final',
        ]);
        assert.deepStrictEqual(
            AnthropicInformationSelectionTool.input_schema.required,
            ['mustExpress', 'optional', 'omit', 'suggestedScope', 'notes']
        );
        const semantic = AnthropicSemanticAnalysisTool.input_schema.properties;
        assert.deepStrictEqual(semantic.behaviorAnalysis.required, ['before', 'after', 'observableEffect']);
        assert.deepStrictEqual(semantic.capabilityContext.required, ['technicalCapability', 'productCapability']);
        assert.deepStrictEqual(semantic.intentAnalysis.required, ['primaryIntent', 'supportedBy', 'confidence']);
        assert.deepStrictEqual(semantic.changeClassification.required, [
            'existingBehaviorCorrected', 'newCapabilityAdded',
            'externalBehaviorChanged', 'structuralOnly', 'recommendedType', 'reason',
        ]);
    });
});
