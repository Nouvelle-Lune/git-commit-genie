import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
    AI_CONFIG_VERSION,
    AI_CONFIG_VERSION_KEY,
    AI_MODELS_KEY,
    GENERATION_MODEL_ID_KEY,
    REPOSITORY_ANALYSIS_MODEL_ID_KEY,
    customSecretKey,
} from '../../services/llm/providers';
import { migrateAIConfiguration } from '../../services/llm/configMigration';

describe('AI configuration migration', () => {
    it('moves a legacy Qwen configuration into the model registry and deletes removed state', async () => {
        const fixture = createContext({
            'gitCommitGenie.provider': 'qwen',
            'gitCommitGenie.qwenRegion': 'intl',
            'gitCommitGenie.qwenModel': 'qwen-test',
        }, {
            'gitCommitGenie.secret.qwenApiKeyIntl': 'secret',
        });
        const configuration = stubConfiguration('general');
        try {
            await migrateAIConfiguration(fixture.context);
        } finally {
            configuration.stub.restore();
        }

        assert.equal(fixture.state.get(AI_CONFIG_VERSION_KEY), AI_CONFIG_VERSION);
        assert.equal(fixture.state.get(GENERATION_MODEL_ID_KEY), 'migrated-qwen-intl');
        assert.equal(fixture.state.get(REPOSITORY_ANALYSIS_MODEL_ID_KEY), 'migrated-qwen-intl');
        assert.deepEqual(fixture.state.get(AI_MODELS_KEY), [{
            id: 'migrated-qwen-intl',
            label: 'Qwen International',
            provider: 'custom',
            baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
            model: 'qwen-test',
        }]);
        assert.equal(fixture.secrets.get(customSecretKey('migrated-qwen-intl')), 'secret');
        assert.equal(fixture.state.has('gitCommitGenie.provider'), false);
        assert.equal(fixture.secrets.has('gitCommitGenie.secret.qwenApiKeyIntl'), false);
        sinon.assert.calledWith(configuration.update, 'model', undefined, vscode.ConfigurationTarget.Global);
    });

    it('migrates v1 models and keeps generation and repository analysis assignments independent', async () => {
        const fixture = createContext({
            [AI_CONFIG_VERSION_KEY]: 1,
            'gitCommitGenie.ai.provider': 'openai',
            'gitCommitGenie.ai.openaiModel': 'gpt-generation',
            'gitCommitGenie.ai.customModels': [{
                id: 'local-analysis',
                label: 'Local Analysis',
                baseUrl: 'http://127.0.0.1:8000/v1',
                model: 'analysis-model',
            }],
        }, {});
        const configuration = stubConfiguration('custom:local-analysis');
        try {
            await migrateAIConfiguration(fixture.context);
        } finally {
            configuration.stub.restore();
        }

        assert.equal(fixture.state.get(GENERATION_MODEL_ID_KEY), 'migrated-openai');
        assert.equal(fixture.state.get(REPOSITORY_ANALYSIS_MODEL_ID_KEY), 'local-analysis');
        assert.deepEqual(fixture.state.get(AI_MODELS_KEY), [
            { id: 'migrated-openai', label: 'gpt-generation', provider: 'openai', model: 'gpt-generation' },
            {
                id: 'local-analysis',
                label: 'Local Analysis',
                provider: 'custom',
                baseUrl: 'http://127.0.0.1:8000/v1',
                model: 'analysis-model',
            },
        ]);
        assert.equal(fixture.state.has('gitCommitGenie.ai.provider'), false);
        assert.equal(fixture.state.has('gitCommitGenie.ai.customModels'), false);
    });

    it('uses the Qwen region that actually has the migrated credential', async () => {
        const fixture = createContext({
            'gitCommitGenie.provider': 'qwen',
            'gitCommitGenie.qwenRegion': 'intl',
            'gitCommitGenie.qwenModel': 'qwen-test',
        }, {
            'gitCommitGenie.secret.qwenApiKeyChina': 'china-secret',
        });
        const configuration = stubConfiguration('general');
        try {
            await migrateAIConfiguration(fixture.context);
        } finally {
            configuration.stub.restore();
        }

        assert.equal(fixture.state.get(GENERATION_MODEL_ID_KEY), 'migrated-qwen-china');
        assert.equal(fixture.state.get(REPOSITORY_ANALYSIS_MODEL_ID_KEY), 'migrated-qwen-china');
    });

    it('preserves removed Local and Kimi endpoint defaults as custom model instances', async () => {
        const localFixture = createContext({
            'gitCommitGenie.provider': 'local',
            'gitCommitGenie.localModel': 'local-model',
        }, {});
        const localConfiguration = stubConfiguration('general');
        try {
            await migrateAIConfiguration(localFixture.context);
        } finally {
            localConfiguration.stub.restore();
        }
        assert.deepEqual(localFixture.state.get(AI_MODELS_KEY), [{
            id: 'migrated-local',
            label: 'Local',
            provider: 'custom',
            baseUrl: 'http://127.0.0.1:11434/v1',
            model: 'local-model',
        }]);

        const kimiFixture = createContext({
            'gitCommitGenie.provider': 'kimi',
            'gitCommitGenie.kimiModel': 'kimi-model',
        }, {
            'gitCommitGenie.secret.kimiApiKey': 'kimi-secret',
        });
        const kimiConfiguration = stubConfiguration('general');
        try {
            await migrateAIConfiguration(kimiFixture.context);
        } finally {
            kimiConfiguration.stub.restore();
        }
        assert.deepEqual(kimiFixture.state.get(AI_MODELS_KEY), [{
            id: 'migrated-kimi',
            label: 'Kimi',
            provider: 'custom',
            baseUrl: 'https://api.moonshot.cn/v1',
            model: 'kimi-model',
        }]);
    });

    it('rejects an ambiguous repository analysis model instead of selecting one silently', async () => {
        const fixture = createContext({
            'gitCommitGenie.provider': 'openai',
            'gitCommitGenie.openaiModel': 'same-model',
            'gitCommitGenie.anthropicModel': 'same-model',
        }, {});
        const configuration = stubConfiguration('same-model');
        try {
            await assert.rejects(
                migrateAIConfiguration(fixture.context),
                /expected one configured model, found 2/,
            );
        } finally {
            configuration.stub.restore();
        }
        assert.equal(fixture.state.has(AI_CONFIG_VERSION_KEY), false);
        assert.equal(fixture.state.has('gitCommitGenie.provider'), true);
    });
});

function createContext(initialState: Record<string, unknown>, initialSecrets: Record<string, string>) {
    const state = new Map<string, unknown>(Object.entries(initialState));
    const secrets = new Map<string, string>(Object.entries(initialSecrets));
    const context = {
        globalState: {
            get: <T>(key: string, defaultValue?: T): T => (state.has(key) ? state.get(key) : defaultValue) as T,
            update: async (key: string, value: unknown) => {
                if (value === undefined) { state.delete(key); } else { state.set(key, value); }
            },
        },
        secrets: {
            get: async (key: string) => secrets.get(key),
            store: async (key: string, value: string) => { secrets.set(key, value); },
            delete: async (key: string) => { secrets.delete(key); },
        },
    } as unknown as vscode.ExtensionContext;
    return { context, state, secrets };
}

function stubConfiguration(model: string) {
    const update = sinon.stub().resolves();
    const stub = sinon.stub(vscode.workspace, 'getConfiguration').callsFake(section => ({
        get: (_key: string, defaultValue: unknown) => section === 'gitCommitGenie.repositoryAnalysis' ? model : defaultValue,
        update,
    } as any));
    return { stub, update };
}
