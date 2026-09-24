import { strict as assert } from 'assert';
import { afterEach, describe, it } from 'mocha';
import sinon = require('sinon');
import * as vscode from 'vscode';
import { migrateAIConfiguration } from '../../../services/llm/configMigration';
import {
    AI_CONFIG_VERSION,
    AI_CONFIG_VERSION_KEY,
    AI_MODELS_KEY,
    GENERATION_MODEL_ID_KEY,
    NATIVE_SECRET_KEYS,
    customSecretKey,
    modelSecretKey,
    parseProviderKind,
    type AIModelConfig,
} from '../../../services/llm/providers';

/**
 * Persistence contract around the provider identity.
 *
 * The registered model list, the selected generation model and one secret per provider id are what a user's
 * configuration actually *is*. Replacing the transport family changes provider ids and credential keys, so
 * the migration and the key mapping are pinned here: they must keep producing the same stored shapes and must
 * keep refusing unsupported layouts instead of silently dropping a key.
 *
 * Migration note: nothing here touches a provider; it is the configuration contract the swap has to honor.
 */

describe('AI configuration and credential contract', () => {
    afterEach(() => sinon.restore());

    it('migrates the original layout into model instances, credentials and a clean state', async () => {
        const context = fakeContext({
            state: {
                'gitCommitGenie.openaiModel': 'gpt-5.4',
                'gitCommitGenie.anthropicModel': 'claude-sonnet-4-5',
                'gitCommitGenie.geminiModel': 'gemini-2.5-pro',
                'gitCommitGenie.deepseekModel': 'deepseek-chat',
                'gitCommitGenie.glmModel': 'glm-4.6',
                'gitCommitGenie.provider': 'deepseek',
            },
            secrets: {
                'gitCommitGenie.secret.openaiApiKey': 'openai-key',
                'gitCommitGenie.secret.deepseekApiKey': 'deepseek-key',
                'gitCommitGenie.secret.glmApiKey': 'glm-key',
            },
        });

        await migrateAIConfiguration(context);

        assert.deepEqual(context.state.get(AI_MODELS_KEY), [
            { id: 'migrated-openai', label: 'gpt-5.4', provider: 'openai', model: 'gpt-5.4' },
            { id: 'migrated-anthropic', label: 'claude-sonnet-4-5', provider: 'anthropic', model: 'claude-sonnet-4-5' },
            { id: 'migrated-google', label: 'gemini-2.5-pro', provider: 'google', model: 'gemini-2.5-pro' },
            { id: 'migrated-deepseek', label: 'DeepSeek', provider: 'custom', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
            { id: 'migrated-glm', label: 'GLM', provider: 'custom', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6' },
        ]);
        assert.equal(context.state.get(GENERATION_MODEL_ID_KEY), 'migrated-deepseek');
        assert.equal(context.state.get(AI_CONFIG_VERSION_KEY), AI_CONFIG_VERSION);
        // Native keys move to their provider slot, custom keys to the per-instance slot.
        assert.equal(await context.secrets.get(NATIVE_SECRET_KEYS.openai), 'openai-key');
        assert.equal(await context.secrets.get(customSecretKey('migrated-deepseek')), 'deepseek-key');
        assert.equal(await context.secrets.get(customSecretKey('migrated-glm')), 'glm-key');
        // Removed keys and state must not survive the migration.
        assert.deepEqual([...context.secrets.keys()].sort(), [
            NATIVE_SECRET_KEYS.openai,
            customSecretKey('migrated-deepseek'),
            customSecretKey('migrated-glm'),
        ].sort());
        for (const key of ['gitCommitGenie.openaiModel', 'gitCommitGenie.deepseekModel', 'gitCommitGenie.provider']) {
            assert.equal(context.state.get(key), undefined, key);
        }
    });

    it('migrates the removed model-registry layout without touching it again', async () => {
        const context = fakeContext({
            state: {
                [AI_CONFIG_VERSION_KEY]: 1,
                'gitCommitGenie.ai.openaiModel': 'gpt-5.4',
                'gitCommitGenie.ai.provider': 'custom',
                'gitCommitGenie.ai.activeCustomModel': 'c1',
                'gitCommitGenie.ai.customModels': [
                    { id: 'c1', label: 'Local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3' },
                ],
            },
        });

        await migrateAIConfiguration(context);

        assert.deepEqual(context.state.get(AI_MODELS_KEY), [
            { id: 'migrated-openai', label: 'gpt-5.4', provider: 'openai', model: 'gpt-5.4' },
            { id: 'c1', label: 'Local', provider: 'custom', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3' },
        ]);
        assert.equal(context.state.get(GENERATION_MODEL_ID_KEY), 'c1');
        assert.equal(context.state.get('gitCommitGenie.ai.customModels'), undefined);
    });

    it('leaves a current configuration untouched and refuses an unsupported version', async () => {
        const current = fakeContext({ state: { [AI_CONFIG_VERSION_KEY]: AI_CONFIG_VERSION, [AI_MODELS_KEY]: [] } });
        await migrateAIConfiguration(current);
        assert.deepEqual(current.state.writeLog, []);
        assert.deepEqual(current.secrets.writeLog, []);

        const future = fakeContext({ state: { [AI_CONFIG_VERSION_KEY]: AI_CONFIG_VERSION + 1 } });
        await assert.rejects(
            migrateAIConfiguration(future),
            new RegExp(`Unsupported AI configuration version '${AI_CONFIG_VERSION + 1}'`),
        );
        assert.deepEqual(future.state.writeLog, []);
    });

    it('refuses to migrate a credential without the model it belongs to', async () => {
        const context = fakeContext({ secrets: { 'gitCommitGenie.secret.glmApiKey': 'glm-key' } });

        await assert.rejects(
            migrateAIConfiguration(context),
            /Cannot migrate GLM: an API key exists but no model is selected\./,
        );
        assert.equal(context.state.get(AI_CONFIG_VERSION_KEY), undefined);
    });

    it('reads the removed local endpoint from settings when migrating it', async () => {
        sinon.stub(vscode.workspace, 'getConfiguration').callsFake(() => ({
            get<T>(key: string, defaultValue?: T): T | undefined {
                return key === 'local.baseUrl' ? ('http://127.0.0.1:8080/v1' as unknown as T) : defaultValue;
            },
        } as vscode.WorkspaceConfiguration));
        const context = fakeContext({
            state: { 'gitCommitGenie.localModel': 'qwen3-30b' },
            secrets: { 'gitCommitGenie.secret.localApiKey': 'local-key' },
        });

        await migrateAIConfiguration(context);

        const models = context.state.get<AIModelConfig[]>(AI_MODELS_KEY) ?? [];
        assert.deepEqual(models.find(model => model.id === 'migrated-local'), {
            id: 'migrated-local',
            label: 'Local',
            provider: 'custom',
            baseUrl: 'http://127.0.0.1:8080/v1',
            model: 'qwen3-30b',
        });
    });

    it('maps every provider family onto its own credential slot', () => {
        // One secret per provider id, one per custom instance: a transport that changes either key would
        // orphan saved credentials for existing users.
        assert.deepEqual(NATIVE_SECRET_KEYS, {
            openai: 'gitCommitGenie.secret.ai.openai',
            anthropic: 'gitCommitGenie.secret.ai.anthropic',
            google: 'gitCommitGenie.secret.ai.google',
        });
        assert.equal(modelSecretKey({ provider: 'anthropic' } as AIModelConfig), NATIVE_SECRET_KEYS.anthropic);
        assert.equal(modelSecretKey({ provider: 'custom', id: 'c1' } as AIModelConfig), customSecretKey('c1'));
        assert.equal(modelSecretKey({ provider: 'custom', id: 'c2' } as AIModelConfig), 'gitCommitGenie.secret.ai.custom.c2');
        assert.equal(parseProviderKind('google'), 'google');
        assert.throws(() => parseProviderKind('gemini'), /Unsupported AI provider 'gemini'\./);
        assert.throws(() => parseProviderKind(7), /Unsupported AI provider '7'\./);
    });
});

interface FakeContextOptions {
    state?: Record<string, unknown>;
    secrets?: Record<string, string>;
}

interface FakeContext {
    readonly state: FakeMemento;
    readonly secrets: FakeSecretStorage;
}

/** Minimal Memento/SecretStorage pair that records every write so a no-op migration stays observable. */
class FakeMemento {
    readonly writeLog: string[] = [];
    private readonly values = new Map<string, unknown>();

    constructor(initial: Record<string, unknown>) {
        for (const [key, value] of Object.entries(initial)) {
            this.values.set(key, value);
        }
    }

    get<T>(key: string, defaultValue?: T): T {
        return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
    }

    async update(key: string, value: unknown): Promise<void> {
        this.writeLog.push(key);
        if (value === undefined) {
            this.values.delete(key);
            return;
        }
        this.values.set(key, value);
    }
}

class FakeSecretStorage {
    readonly writeLog: string[] = [];
    private readonly values = new Map<string, string>();

    constructor(initial: Record<string, string>) {
        for (const [key, value] of Object.entries(initial)) {
            this.values.set(key, value);
        }
    }

    async get(key: string): Promise<string | undefined> {
        return this.values.get(key);
    }

    async store(key: string, value: string): Promise<void> {
        this.writeLog.push(key);
        this.values.set(key, value);
    }

    async delete(key: string): Promise<void> {
        this.writeLog.push(key);
        this.values.delete(key);
    }

    keys(): string[] {
        return [...this.values.keys()];
    }
}

function fakeContext(options: FakeContextOptions): vscode.ExtensionContext & FakeContext {
    const state = new FakeMemento(options.state ?? {});
    const secrets = new FakeSecretStorage(options.secrets ?? {});
    // The migration reads globalState/secrets, plus workspace settings for the removed Local entry.
    return { globalState: state, state, secrets } as unknown as vscode.ExtensionContext & FakeContext;
}
