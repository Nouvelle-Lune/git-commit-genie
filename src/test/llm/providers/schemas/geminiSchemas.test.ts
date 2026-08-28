import { describe, it } from 'mocha';
import * as assert from 'assert';
import { Type } from '@google/genai';
import {
    GeminiChangeExtractionSchema,
    GeminiEvidenceSummarySchema,
    GeminiInformationSelectionSchema,
    GeminiInvestigationActionSchema,
    GeminiInvestigationPlanSchema,
    GeminiSemanticAnalysisSchema,
} from '../../../../services/llm/providers/schemas/geminiSchemas';

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

describe('Gemini change-conditioned schemas', () => {
    it('keeps introducedSymbols and all sibling extraction lists primitive strings', () => {
        const properties = GeminiChangeExtractionSchema.properties as Record<string, any>;
        for (const field of [
            'introducedSymbols', 'removedSymbols', 'changedCalls', 'changedConfigs',
            'changedTypes', 'changedDependencies',
        ]) {
            assert.strictEqual(properties[field].items.type, Type.STRING, `${field} must contain strings`);
        }
        assert.strictEqual(properties.changedSymbols.items.type, Type.OBJECT);
    });

    it('defines every new chain stage as a structured Gemini object schema', () => {
        const schemas = [
            GeminiChangeExtractionSchema,
            GeminiInvestigationPlanSchema,
            GeminiInvestigationActionSchema,
            GeminiSemanticAnalysisSchema,
            GeminiInformationSelectionSchema,
        ];
        for (const schema of schemas) {
            assert.strictEqual(schema.type, 'OBJECT');
            assert.ok(Object.keys(schema.properties).length > 0);
            assert.ok(schema.required.length > 0);
        }
    });

    it('matches the required fields emitted by the Zod output schema', () => {
        assert.deepStrictEqual(GeminiInvestigationPlanSchema.required, ['targets', 'notes']);
        assert.deepStrictEqual(GeminiInvestigationActionSchema.required, [
            'action', 'tool', 'reason', 'symbol', 'filePath', 'dirPath', 'query',
            'searchType', 'useRegex', 'startLine', 'maxLines', 'maxResults', 'final',
        ]);
        assert.deepStrictEqual(
            GeminiInformationSelectionSchema.required,
            ['mustExpress', 'optional', 'omit', 'suggestedScope', 'notes']
        );
        const semantic = GeminiSemanticAnalysisSchema.properties;
        assert.deepStrictEqual(semantic.behaviorAnalysis.required, ['before', 'after', 'observableEffect']);
        assert.deepStrictEqual(semantic.capabilityContext.required, ['technicalCapability', 'productCapability']);
        assert.deepStrictEqual(semantic.intentAnalysis.required, ['primaryIntent', 'supportedBy', 'confidence']);
        assert.deepStrictEqual(semantic.changeClassification.required, [
            'existingBehaviorCorrected', 'newCapabilityAdded',
            'externalBehaviorChanged', 'structuralOnly', 'recommendedType', 'reason',
        ]);
    });
});
