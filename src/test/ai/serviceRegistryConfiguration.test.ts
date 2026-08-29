import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import * as vscode from 'vscode';
import {
    AI_MODELS_KEY,
    GENERATION_MODEL_ID_KEY,
    REPOSITORY_ANALYSIS_MODEL_ID_KEY,
} from '../../services/llm/providers';
import { ServiceRegistry } from '../../core/ServiceRegistry';
import { RepositoryAnalysisService } from '../../services/analysis/repository/repositoryAnalysisService';
import { ModelCommands } from '../../commands/ModelCommands';

describe('ServiceRegistry model-instance selection', () => {
    it('switches between independent model instances from the same or different providers', () => {
        const state = new Map<string, unknown>([
            [AI_MODELS_KEY, [
                { id: 'gpt-fast', label: 'GPT Fast', provider: 'openai', model: 'gpt-fast' },
                { id: 'gpt-deep', label: 'GPT Deep', provider: 'openai', model: 'gpt-deep' },
                { id: 'claude-analysis', label: 'Claude Analysis', provider: 'anthropic', model: 'claude-analysis' },
            ]],
            [GENERATION_MODEL_ID_KEY, 'gpt-fast'],
        ]);
        const context = {
            globalState: {
                get: <T>(key: string, defaultValue?: T): T => (
                    state.has(key) ? state.get(key) : defaultValue
                ) as T,
            },
        } as unknown as vscode.ExtensionContext;
        const registry = new ServiceRegistry(context);
        const fastService = { id: 'fast' };
        const deepService = { id: 'deep' };
        const claudeService = { id: 'claude' };
        (registry as any).llmServices.set('gpt-fast', fastService);
        (registry as any).llmServices.set('gpt-deep', deepService);
        (registry as any).llmServices.set('claude-analysis', claudeService);

        registry.updateCurrentLLMService();
        assert.equal(registry.getGenerationModel()?.id, 'gpt-fast');
        assert.equal(registry.getCurrentLLMService(), fastService);

        state.set(GENERATION_MODEL_ID_KEY, 'gpt-deep');
        registry.updateCurrentLLMService();
        assert.equal(registry.getGenerationModel()?.id, 'gpt-deep');
        assert.equal(registry.getCurrentLLMService(), deepService);

        state.set(GENERATION_MODEL_ID_KEY, 'claude-analysis');
        registry.updateCurrentLLMService();
        assert.equal(registry.getCurrentLLMService(), claudeService);
        assert.equal(registry.getModels().length, 3);
    });

    it('keeps model management available when no generation model is selected', () => {
        const context = {
            globalState: {
                get: <T>(_key: string, defaultValue?: T): T => defaultValue as T,
            },
        } as unknown as vscode.ExtensionContext;
        const registry = new ServiceRegistry(context);

        assert.doesNotThrow(() => registry.updateCurrentLLMService());
        assert.equal(registry.getGenerationModel(), undefined);
        assert.throws(() => registry.getCurrentLLMService(), /No active AI model is configured/);
    });

    it('resolves repository analysis by its own model id instead of the generation selection', () => {
        const models = [
            { id: 'generation', label: 'Generation', provider: 'openai', model: 'gpt-generation' },
            { id: 'analysis', label: 'Analysis', provider: 'anthropic', model: 'claude-analysis' },
        ];
        const state = new Map<string, unknown>([
            [AI_MODELS_KEY, models],
            [GENERATION_MODEL_ID_KEY, 'generation'],
            [REPOSITORY_ANALYSIS_MODEL_ID_KEY, 'analysis'],
        ]);
        const analysisService = Object.create(RepositoryAnalysisService.prototype) as any;
        const selectedService = { id: 'analysis-service' };
        analysisService.context = {
            globalState: {
                get: <T>(key: string, defaultValue?: T): T => (
                    state.has(key) ? state.get(key) : defaultValue
                ) as T,
            },
        };
        analysisService.resolveLLMService = (modelId: string) => modelId === 'analysis' ? selectedService : undefined;

        const selected = analysisService.pickRepoAnalysisService();
        assert.equal(selected.provider, 'anthropic');
        assert.equal(selected.service, selectedService);
        assert.equal(analysisService.getActiveModelForProvider('anthropic'), 'claude-analysis');
    });

    it('applies a workflow selection immediately to state, service binding, and status UI', async () => {
        const state = new Map<string, unknown>([
            [AI_MODELS_KEY, [
                { id: 'first', label: 'First', provider: 'openai', model: 'gpt-first' },
                { id: 'second', label: 'Second', provider: 'openai', model: 'gpt-second' },
            ]],
            [GENERATION_MODEL_ID_KEY, 'first'],
        ]);
        const context = {
            globalState: {
                get: <T>(key: string, defaultValue?: T): T => (
                    state.has(key) ? state.get(key) : defaultValue
                ) as T,
                update: async (key: string, value: unknown) => { state.set(key, value); },
            },
        } as unknown as vscode.ExtensionContext;
        const registry = new ServiceRegistry(context);
        const firstService = { id: 'first-service' };
        const secondService = { id: 'second-service' };
        (registry as any).llmServices.set('first', firstService);
        (registry as any).llmServices.set('second', secondService);
        registry.updateCurrentLLMService();
        let refreshCount = 0;
        const statusBar = { refreshModelStates: async () => { refreshCount += 1; } };
        const commands = new ModelCommands(context, registry, statusBar as any);

        await (commands as any).assignModel('generation', 'second');

        assert.equal(state.get(GENERATION_MODEL_ID_KEY), 'second');
        assert.equal(registry.getCurrentLLMService(), secondService);
        assert.equal(refreshCount, 1);
    });
});
