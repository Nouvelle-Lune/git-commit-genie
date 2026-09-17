import { describe, it, before, after } from 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

import { LLMService } from '../../services/llm/llmTypes';
import { TemplateService } from '../../template/templateService';
import { PRICING_TABLE } from '../../services/cost/pricing';
import { MODEL_MAX_CONTEXT_TOKENS } from '../../services/analysis/tools/modelContext';
import {
    OPENROUTER_MODEL_ALIAS_MAP,
    normalizeOpenRouterPricingAlias
} from '../../services/llm/providers/config/openrouterModels';
import { OpenAIService } from '../../services/llm/providers/openai';
import { DeepSeekService } from '../../services/llm/providers/deepseek';
import { AnthropicService } from '../../services/llm/providers/anthropic';
import { GeminiService } from '../../services/llm/providers/gemini';
import { QwenService } from '../../services/llm/providers/qwen';
import { GLMService } from '../../services/llm/providers/glm';
import { KimiService } from '../../services/llm/providers/kimi';
import { OpenRouterService } from '../../services/llm/providers/openrouter';
import { LocalService } from '../../services/llm/providers/local';

// ============================================================================
// Cross-table consistency tests for the curated LLM model catalogs.
//
// The three catalogs below are edited independently whenever a vendor refreshes
// its lineup, so they drift apart silently:
//   - provider listSupportedModels()      (what the user can pick)
//   - PRICING_TABLE                       (what a call costs)
//   - MODEL_MAX_CONTEXT_TOKENS            (how much context a call may use)
// plus the package.json enum that seeds the settings dropdown.
//
// These tests assert only on cross-table invariants, never on individual model
// ids, so refreshing a vendor lineup only needs the tables to stay in sync.
// ============================================================================

/** Repository root, derived from this file's compiled location (out/test/llm/<file>). */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const CONFIGURATION_SECTION = 'gitCommitGenie.repositoryAnalysis.model';
/** Cached endpoint model ids written by LocalService.validateApiKeyAndListModels(). */
const LOCAL_MODELS_CACHE_KEY = 'gitCommitGenie.localModelsCache';

interface ProviderCatalog {
    /** Provider key as registered in ServiceRegistry.llmServices. */
    name: string;
    /** Models the provider advertises to the UI. */
    models: string[];
}

/**
 * Static providers whose model list is curated in source and therefore must be
 * present in every table. `local` is intentionally absent: its list is whatever
 * the user's OpenAI-compatible endpoint reports at runtime.
 */
const STATIC_PROVIDER_FACTORIES: Array<{ name: string; create: (ctx: vscode.ExtensionContext, tpl: TemplateService) => LLMService }> = [
    { name: 'openai', create: (ctx, tpl) => new OpenAIService(ctx, tpl) },
    { name: 'deepseek', create: (ctx, tpl) => new DeepSeekService(ctx, tpl) },
    { name: 'anthropic', create: (ctx, tpl) => new AnthropicService(ctx, tpl) },
    { name: 'gemini', create: (ctx, tpl) => new GeminiService(ctx, tpl) },
    { name: 'qwen', create: (ctx, tpl) => new QwenService(ctx, tpl) },
    { name: 'glm', create: (ctx, tpl) => new GLMService(ctx, tpl) },
    { name: 'kimi', create: (ctx, tpl) => new KimiService(ctx, tpl) },
    { name: 'openrouter', create: (ctx, tpl) => new OpenRouterService(ctx, tpl) }
];

function createStubContext(globalStateValues: Record<string, unknown> = {}): vscode.ExtensionContext {
    return {
        subscriptions: [],
        secrets: {
            get: sinon.stub().resolves(undefined),
            store: sinon.stub().resolves(),
            delete: sinon.stub().resolves(),
            onDidChange: sinon.stub()
        },
        globalState: {
            get: sinon.stub().callsFake((key: string, fallback?: unknown) =>
                Object.prototype.hasOwnProperty.call(globalStateValues, key) ? globalStateValues[key] : fallback),
            update: sinon.stub().resolves(),
            keys: sinon.stub().returns([])
        },
        workspaceState: { get: sinon.stub().returns(undefined), update: sinon.stub().resolves() },
        extensionUri: vscode.Uri.file('/'),
        extensionPath: '/fake',
        storagePath: '/fake/storage',
        globalStoragePath: '/fake/global-storage',
        logPath: '/fake/log',
        extensionMode: vscode.ExtensionMode.Development,
        environmentVariableCollection: {} as any,
        languageModelAccessInformation: {} as any
    } as unknown as vscode.ExtensionContext;
}

function createStubTemplateService(): TemplateService {
    return {
        getActiveTemplate: sinon.stub().returns('')
    } as unknown as TemplateService;
}

/** Reads the settings enum for the repository analysis model from the extension manifest. */
function readRepositoryAnalysisModelProperty(): { values: string[]; descriptions: string[] } {
    const manifestPath = path.join(REPO_ROOT, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const property = manifest?.contributes?.configuration?.properties?.[CONFIGURATION_SECTION];
    assert.ok(
        property && Array.isArray(property.enum),
        `package.json property '${CONFIGURATION_SECTION}' with an enum array was not found at ${manifestPath}`
    );
    return { values: property.enum, descriptions: property.enumDescriptions };
}

/**
 * Resolves the PRICING_TABLE key used at runtime for an advertised OpenRouter model id.
 *
 * Mirrors Logger.normalizePricingModelForProvider(): the request id is mapped through
 * normalizeOpenRouterPricingAlias(), and OpenRouter's Qwen ids bill against the
 * international region table, so a canonical alias without a region suffix gains `:intl`.
 */
function resolveOpenRouterPricingKey(requestModelId: string): string {
    const canonical = normalizeOpenRouterPricingAlias(requestModelId);
    if (canonical.startsWith('qwen') && !canonical.includes(':')) {
        return `${canonical}:intl`;
    }
    return canonical;
}

describe('LLM model catalog cross-table consistency', () => {
    let catalogs: ProviderCatalog[];

    before(() => {
        const context = createStubContext();
        const templateService = createStubTemplateService();
        catalogs = STATIC_PROVIDER_FACTORIES.map(({ name, create }) => ({
            name,
            models: create(context, templateService).listSupportedModels()
        }));
    });

    after(() => {
        sinon.restore();
    });

    function modelsOf(providerName: string): string[] {
        const catalog = catalogs.find(entry => entry.name === providerName);
        assert.ok(catalog, `no catalog was built for provider '${providerName}'`);
        return catalog.models;
    }

    // =========================================================================
    // Fixture sanity — keeps the assertions below from passing vacuously
    // =========================================================================

    it('should build a non-empty catalog for every static provider', () => {
        // An empty model list would make every per-provider assertion below pass without checking
        // anything, so the catalogs themselves are asserted before their contents are trusted.
        const empty = catalogs.filter(catalog => catalog.models.length === 0).map(catalog => catalog.name);
        assert.deepStrictEqual(empty, [], `providers that advertise no models at all: ${empty.join(', ')}`);
        assert.strictEqual(
            catalogs.length,
            STATIC_PROVIDER_FACTORIES.length,
            'every registered static provider factory must produce a catalog'
        );
    });

    // =========================================================================
    // PRICING_TABLE
    // =========================================================================

    describe('PRICING_TABLE coverage', () => {
        // qwen is billed per region and openrouter ids are aliases, so both are covered by the
        // dedicated tests below instead of the direct key lookup.
        const directPricingProviders = STATIC_PROVIDER_FACTORIES
            .filter(({ name }) => name !== 'qwen' && name !== 'openrouter');

        for (const { name: providerName } of directPricingProviders) {
            it(`should have a PRICING_TABLE entry for every ${providerName} model`, () => {
                // Each selectable model must be priced, otherwise Logger.calculateCost logs
                // "Unknown model pricing" and records the call as costing 0.
                const missing = modelsOf(providerName).filter(model => !PRICING_TABLE[model]);
                assert.deepStrictEqual(
                    missing,
                    [],
                    `${providerName} models with no PRICING_TABLE entry: ${missing.join(', ')}`
                );
            });
        }

        it('should have both :intl and :china pricing keys for every qwen model', () => {
            // Qwen bills per region, so both regional keys must exist; a missing one makes calls
            // through that endpoint price at 0 instead of failing loudly.
            const missing: string[] = [];
            for (const model of modelsOf('qwen')) {
                for (const region of ['intl', 'china']) {
                    if (!PRICING_TABLE[`${model}:${region}`]) {
                        missing.push(`${model}:${region}`);
                    }
                }
            }
            assert.deepStrictEqual(
                missing,
                [],
                `qwen models with no regional PRICING_TABLE entry: ${missing.join(', ')}`
            );
        });

        it('should resolve every curated OpenRouter id to a PRICING_TABLE entry', () => {
            // OpenRouter request ids are aliases, so the price lookup only succeeds when the id
            // normalizes to a canonical alias that the pricing table actually carries.
            const missing = modelsOf('openrouter')
                .filter(id => !PRICING_TABLE[resolveOpenRouterPricingKey(id)])
                .map(id => `${id} -> ${resolveOpenRouterPricingKey(id)}`);
            assert.deepStrictEqual(
                missing,
                [],
                `OpenRouter ids that do not resolve to a PRICING_TABLE entry: ${missing.join(', ')}`
            );
        });

        it('should keep tiered pricing entries ascending and terminated with Infinity', () => {
            // Logger.calculateCost picks the first tier whose maxInputTokens covers the prompt.
            // An out-of-order list can select a cheap tier for a huge prompt, and a list without
            // an Infinity terminator returns 0 for prompts beyond the last bound.
            const problems: string[] = [];
            for (const [model, pricing] of Object.entries(PRICING_TABLE)) {
                if (!('tiers' in pricing)) {
                    continue;
                }
                const tiers = pricing.tiers;
                if (!tiers.length) {
                    problems.push(`${model}: empty tier list`);
                    continue;
                }
                for (let i = 1; i < tiers.length; i++) {
                    if (tiers[i].maxInputTokens <= tiers[i - 1].maxInputTokens) {
                        problems.push(`${model}: tier ${i} (${tiers[i].maxInputTokens}) does not exceed tier ${i - 1} (${tiers[i - 1].maxInputTokens})`);
                    }
                }
                if (tiers[tiers.length - 1].maxInputTokens !== Infinity) {
                    problems.push(`${model}: last tier ends at ${tiers[tiers.length - 1].maxInputTokens}, not Infinity`);
                }
            }
            assert.deepStrictEqual(problems, [], `malformed tiered pricing entries: ${problems.join('; ')}`);
        });
    });

    // =========================================================================
    // MODEL_MAX_CONTEXT_TOKENS
    // =========================================================================

    describe('MODEL_MAX_CONTEXT_TOKENS coverage', () => {
        // openrouter is excluded here because its list is exactly the alias-map keys asserted below.
        const directContextProviders = STATIC_PROVIDER_FACTORIES.filter(({ name }) => name !== 'openrouter');

        for (const { name: providerName } of directContextProviders) {
            it(`should have a positive MODEL_MAX_CONTEXT_TOKENS entry for every ${providerName} model`, () => {
                // getMaxContextByFunction() falls back to the per-function default budget when a model
                // has no positive entry, which silently shrinks the context window for that model.
                const missing = modelsOf(providerName).filter(model => !(MODEL_MAX_CONTEXT_TOKENS[model] > 0));
                assert.deepStrictEqual(
                    missing,
                    [],
                    `${providerName} models with no positive MODEL_MAX_CONTEXT_TOKENS entry: ${missing.join(', ')}`
                );
            });
        }

        it('should have a positive MODEL_MAX_CONTEXT_TOKENS entry for every OPENROUTER_MODEL_ALIAS_MAP key', () => {
            // The alias map is what OpenRouterService.listSupportedModels() returns, so each key is
            // a selectable OpenRouter model id and needs its own context limit.
            const missing = Object.keys(OPENROUTER_MODEL_ALIAS_MAP)
                .filter(key => !(MODEL_MAX_CONTEXT_TOKENS[key] > 0));
            assert.deepStrictEqual(
                missing,
                [],
                `OpenRouter model ids with no positive MODEL_MAX_CONTEXT_TOKENS entry: ${missing.join(', ')}`
            );
        });
    });

    // =========================================================================
    // package.json settings enum
    // =========================================================================

    describe('gitCommitGenie.repositoryAnalysis.model enum', () => {
        it('should declare one enumDescriptions entry per enum value', () => {
            // The settings UI pairs enum[] and enumDescriptions[] by index, so a mismatch
            // silently mislabels every option after the gap.
            const { values, descriptions } = readRepositoryAnalysisModelProperty();
            assert.strictEqual(
                descriptions.length,
                values.length,
                `'${CONFIGURATION_SECTION}' has ${values.length} enum values but ${descriptions.length} enumDescriptions entries`
            );
        });

        it('should only list values that at least one static provider catalog supports', () => {
            // ServiceRegistry.migrateUnsupportedModelSelections() resets the setting to 'general'
            // whenever no provider lists the selected value, so an enum entry that no provider
            // advertises would be silently reverted for the user right after they pick it.
            // 'general' is skipped because it means "let the registry choose the provider".
            const { values } = readRepositoryAnalysisModelProperty();
            assert.ok(
                values.includes('general'),
                `'${CONFIGURATION_SECTION}' no longer offers 'general', the value used when no provider is pinned`
            );

            const supported = new Set(catalogs.flatMap(catalog => catalog.models));
            const uncovered = values.filter(value => value !== 'general' && !supported.has(value));
            assert.deepStrictEqual(
                uncovered,
                [],
                `'${CONFIGURATION_SECTION}' values that no provider listSupportedModels() advertises: ${uncovered.join(', ')}`
            );
        });
    });

    // =========================================================================
    // local provider exclusion
    // =========================================================================

    describe('local provider', () => {
        it('should expose only the runtime-discovered endpoint models', () => {
            // LocalService curates nothing: its list is the endpoint's own model ids cached in
            // globalState, which is why `local` is excluded from every static table assertion here.
            const cachedModels = ['user-endpoint-model-a', 'user-endpoint-model-b'];
            const service = new LocalService(
                createStubContext({ [LOCAL_MODELS_CACHE_KEY]: cachedModels }),
                createStubTemplateService()
            );
            assert.deepStrictEqual(service.listSupportedModels(), cachedModels);
        });
    });
});
