import { strict as assert } from 'assert';
import { afterEach, beforeEach, describe, it } from 'mocha';
import sinon = require('sinon');
import * as vscode from 'vscode';
import { ModelCommands } from '../../commands/ModelCommands';
import {
    AI_MODELS_KEY,
    AIModelConfig,
    customSecretKey,
} from '../../services/llm/providers';
import { logger } from '../../services/logger';

type QuickPickValue = string | undefined;

function createMockContext() {
    const store = new Map<string, unknown>();
    const secretStore = new Map<string, string>();
    const eventLog: string[] = [];
    const subscriptions: { dispose(): void }[] = [];

    const globalState = {
        get<T>(key: string, defaultValue?: T): T {
            return (store.has(key) ? store.get(key) : defaultValue) as T;
        },
        async update(key: string, value: unknown): Promise<void> {
            eventLog.push(`globalState.update:${key}`);
            store.set(key, value);
        },
        keys(): readonly string[] {
            return [...store.keys()];
        },
    };

    const secrets = {
        async get(key: string): Promise<string | undefined> {
            return secretStore.get(key);
        },
        async store(key: string, value: string): Promise<void> {
            eventLog.push(`secrets.store:${key}`);
            secretStore.set(key, value);
        },
        async delete(key: string): Promise<void> {
            eventLog.push(`secrets.delete:${key}`);
            secretStore.delete(key);
        },
    };

    return {
        context: {
            globalState,
            secrets,
            subscriptions,
        } as unknown as vscode.ExtensionContext,
        store,
        secretStore,
        eventLog,
        subscriptions,
    };
}

function createServiceRegistryStub(models: AIModelConfig[], readPersistedModels: () => AIModelConfig[]) {
    const services = new Map<string, { setApiKey: sinon.SinonStub }>();
    const ensureService = (id: string) => {
        let service = services.get(id);
        if (!service) {
            service = { setApiKey: sinon.stub().resolves() };
            services.set(id, service);
        }
        return service;
    };

    return {
        getModels: (): AIModelConfig[] => [...models],
        getModel: (id: string): AIModelConfig | undefined => models.find(model => model.id === id),
        getLLMService: (id: string) => ensureService(id),
        reloadProviderServices: sinon.stub().callsFake(async () => {
            models.splice(0, models.length, ...readPersistedModels());
        }),
        updateCurrentLLMService: sinon.stub(),
        services,
    };
}

function createStatusBarStub() {
    return {
        refreshModelStates: sinon.stub().resolves(),
    };
}

/**
 * Script Manage Models UI: QuickPick returns are matched by item.value;
 * InputBox returns are consumed in order. `undefined` means dismiss/cancel.
 */
function stubModelUi(
    sandbox: sinon.SinonSandbox,
    options: {
        quickPickValues: QuickPickValue[];
        inputValues: Array<string | undefined>;
        warningValue?: string;
    },
) {
    const quickPickValues = [...options.quickPickValues];
    const inputValues = [...options.inputValues];

    const showQuickPick = sandbox.stub(vscode.window, 'showQuickPick').callsFake(async (
        items: readonly vscode.QuickPickItem[] | Thenable<readonly vscode.QuickPickItem[]>,
    ) => {
        const wanted = quickPickValues.shift();
        if (wanted === undefined) {
            return undefined;
        }
        const list = Array.isArray(items) ? items : await items;
        const match = (list as Array<vscode.QuickPickItem & { value?: string }>).find(
            item => item.value === wanted,
        );
        if (!match) {
            throw new Error(`QuickPick script missed value '${wanted}'. Remaining items: ${JSON.stringify(list)}`);
        }
        return match;
    });

    const showInputBox = sandbox.stub(vscode.window, 'showInputBox').callsFake(async () => {
        if (inputValues.length === 0) {
            throw new Error('showInputBox called with no scripted values remaining.');
        }
        return inputValues.shift();
    });

    const showWarningMessage = sandbox.stub(vscode.window, 'showWarningMessage').resolves(
        options.warningValue as never,
    );
    const showErrorMessage = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
    const showInformationMessage = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);

    return {
        showQuickPick,
        showInputBox,
        showWarningMessage,
        showErrorMessage,
        showInformationMessage,
    };
}

async function invokeManageModels(commands: ModelCommands): Promise<void> {
    await (commands as unknown as { manageModels(): Promise<void> }).manageModels();
}

describe('ModelCommands manage models persistence', () => {
    let sandbox: sinon.SinonSandbox;

    beforeEach(() => {
        sandbox = sinon.createSandbox();
    });

    afterEach(() => {
        sandbox.restore();
    });

    it('persists a custom model without /models membership validation', async () => {
        const { context, store } = createMockContext();
        const models: AIModelConfig[] = [];
        const registry = createServiceRegistryStub(
            models,
            () => store.get(AI_MODELS_KEY) as AIModelConfig[] ?? [],
        );
        const statusBar = createStatusBarStub();

        stubModelUi(sandbox, {
            // Root → Custom → Add → dismiss model menu → dismiss provider → dismiss root.
            // Endpoint has no usable /models catalog; persistence must succeed without membership checks.
            quickPickValues: ['custom', '__add__', undefined, undefined, undefined],
            inputValues: [
                'Local Llama',
                'http://127.0.0.1:8080/v1',
                'llama-3.2',
                'sk-test-custom',
            ],
        });

        const commands = new ModelCommands(
            context,
            registry as never,
            statusBar as never,
        );
        await invokeManageModels(commands);

        const persisted = store.get(AI_MODELS_KEY) as AIModelConfig[];
        assert.ok(Array.isArray(persisted));
        assert.equal(persisted.length, 1);
        assert.equal(persisted[0].provider, 'custom');
        assert.equal(persisted[0].label, 'Local Llama');
        assert.equal(persisted[0].baseUrl, 'http://127.0.0.1:8080/v1');
        assert.equal(persisted[0].model, 'llama-3.2');
        assert.ok(persisted[0].id);

        const service = registry.getLLMService(persisted[0].id);
        assert.equal(service.setApiKey.callCount, 1);
        assert.equal(service.setApiKey.firstCall.args[0], 'sk-test-custom');
        assert.equal(registry.reloadProviderServices.callCount, 1);
        assert.equal(statusBar.refreshModelStates.callCount, 1);
    });

    it('updates custom model fields while preserving pricingOverride and thinking metadata', async () => {
        const existing: AIModelConfig = {
            id: 'custom-model-1',
            label: 'Old Label',
            provider: 'custom',
            model: 'old-model',
            baseUrl: 'http://127.0.0.1:8000/v1',
            pricingOverride: {
                unit: 'USD_PER_1M_TOKENS',
                input: 1.5,
                output: 2.5,
                cachedInput: 0.75,
            },
            thinkingFormat: 'deepseek',
            thinkingTokenBudgetField: 'thinking_budget',
            reasoning: true,
        };
        const { context, store } = createMockContext();
        store.set(AI_MODELS_KEY, [existing]);
        const models: AIModelConfig[] = [{ ...existing }];
        const registry = createServiceRegistryStub(
            models,
            () => store.get(AI_MODELS_KEY) as AIModelConfig[] ?? [],
        );
        const statusBar = createStatusBarStub();

        stubModelUi(sandbox, {
            // Custom → model → Edit → dismiss model → dismiss provider → dismiss root
            quickPickValues: ['custom', existing.id, 'edit', undefined, undefined, undefined],
            inputValues: [
                'New Label',
                'https://api.example.com/v1',
                'new-model',
            ],
        });

        const commands = new ModelCommands(
            context,
            registry as never,
            statusBar as never,
        );
        await invokeManageModels(commands);

        const persisted = store.get(AI_MODELS_KEY) as AIModelConfig[];
        assert.equal(persisted.length, 1);
        assert.equal(persisted[0].id, existing.id);
        assert.equal(persisted[0].provider, 'custom');
        assert.equal(persisted[0].label, 'New Label');
        assert.equal(persisted[0].baseUrl, 'https://api.example.com/v1');
        assert.equal(persisted[0].model, 'new-model');
        assert.deepEqual(persisted[0].pricingOverride, existing.pricingOverride);
        assert.equal(persisted[0].thinkingFormat, 'deepseek');
        assert.equal(persisted[0].thinkingTokenBudgetField, 'thinking_budget');
        assert.equal(persisted[0].reasoning, true);
        assert.equal(registry.updateCurrentLLMService.callCount, 1);
        assert.ok(statusBar.refreshModelStates.called);
    });

    it('surfaces manageModels failures through showErrorMessage', async () => {
        const { context, subscriptions } = createMockContext();
        const models: AIModelConfig[] = [];
        const registry = createServiceRegistryStub(models, () => []);
        const statusBar = createStatusBarStub();

        const registered = new Map<string, (...args: unknown[]) => unknown>();
        sandbox.stub(vscode.commands, 'registerCommand').callsFake(((
            command: string,
            callback: (...args: unknown[]) => unknown,
        ) => {
            registered.set(command, callback);
            return { dispose() { /* no-op */ } };
        }) as typeof vscode.commands.registerCommand);

        sandbox.stub(vscode.window, 'showQuickPick').rejects(new Error('catalog unavailable'));
        const showErrorMessage = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        const logError = sandbox.stub(logger, 'error');

        const commands = new ModelCommands(
            context,
            registry as never,
            statusBar as never,
        );
        await commands.register();
        assert.equal(subscriptions.length, 1);

        const handler = registered.get('git-commit-genie.manageModels');
        assert.ok(handler, 'manageModels command handler was not registered');
        await handler();

        assert.equal(showErrorMessage.callCount, 1);
        const message = String(showErrorMessage.firstCall.args[0]);
        assert.match(message, /Manage Models failed:/);
        assert.match(message, /catalog unavailable/);
        assert.ok(logError.calledOnce);
        assert.match(String(logError.firstCall.args[0]), /Manage Models failed/);
    });

    it('deletes custom secret before removing the model from globalState', async () => {
        const existing: AIModelConfig = {
            id: 'custom-to-delete',
            label: 'Delete Me',
            provider: 'custom',
            model: 'temp',
            baseUrl: 'http://127.0.0.1:9000/v1',
        };
        const { context, store, secretStore, eventLog } = createMockContext();
        store.set(AI_MODELS_KEY, [existing]);
        secretStore.set(customSecretKey(existing.id), 'sk-delete-me');
        const models: AIModelConfig[] = [{ ...existing }];
        const registry = createServiceRegistryStub(
            models,
            () => store.get(AI_MODELS_KEY) as AIModelConfig[] ?? [],
        );
        const statusBar = createStatusBarStub();

        stubModelUi(sandbox, {
            // Custom → model → Delete → dismiss provider → dismiss root
            quickPickValues: ['custom', existing.id, 'delete', undefined, undefined],
            inputValues: [],
            warningValue: 'Delete',
        });

        const commands = new ModelCommands(
            context,
            registry as never,
            statusBar as never,
        );
        await invokeManageModels(commands);

        const secretDeleteIndex = eventLog.indexOf(`secrets.delete:${customSecretKey(existing.id)}`);
        const stateUpdateIndex = eventLog.indexOf(`globalState.update:${AI_MODELS_KEY}`);
        assert.ok(secretDeleteIndex >= 0, 'custom secret was not deleted');
        assert.ok(stateUpdateIndex >= 0, 'model globalState was not updated');
        assert.ok(
            secretDeleteIndex < stateUpdateIndex,
            `secret delete must precede globalState update; log=${JSON.stringify(eventLog)}`,
        );

        const persisted = store.get(AI_MODELS_KEY) as AIModelConfig[];
        assert.deepEqual(persisted, []);
        assert.equal(secretStore.has(customSecretKey(existing.id)), false);
    });
});
