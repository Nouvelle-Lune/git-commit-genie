import { describe, it, beforeEach, afterEach } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { BaseProviderUtils } from '../../../../services/llm/providers/utils/BaseProviderUtils';

// Concrete subclass for testing abstract BaseProviderUtils
class TestableProviderUtils extends BaseProviderUtils {}

// ============================================================================
// getCommonConfig
// ============================================================================
describe('BaseProviderUtils.getCommonConfig', () => {
    let utils: TestableProviderUtils;
    let context: vscode.ExtensionContext;
    let getConfigStub: sinon.SinonStub;
    let configGetStub: sinon.SinonStub;

    beforeEach(() => {
        context = { globalState: { get: sinon.stub(), update: sinon.stub().resolves() } } as any;
        utils = new TestableProviderUtils(context);

        // Create a mock configuration object whose .get() returns defaults
        configGetStub = sinon.stub();
        const mockConfig = { get: configGetStub };
        getConfigStub = sinon.stub(vscode.workspace, 'getConfiguration').returns(mockConfig as any);
    });

    afterEach(() => {
        sinon.restore();
    });

    describe('happy path', () => {
        it('should use scoped gitCommitGenie configuration', () => {
            utils.getCommonConfig();
            assert.ok(getConfigStub.calledWith('gitCommitGenie'),
                'getConfiguration should be called with "gitCommitGenie" scope');
        });

        it('should use chain.enabled key with true default', () => {
            configGetStub.withArgs('chain.enabled', true).returns(true);
            const config = utils.getCommonConfig();
            assert.strictEqual(config.useChain, true);
        });

        it('should use chain.maxParallel key with 2 default', () => {
            configGetStub.withArgs('chain.maxParallel', 2).returns(5);
            const config = utils.getCommonConfig();
            assert.strictEqual(config.chainMaxParallel, 5);
        });

        it('should use llm.maxRetries key with 2 default', () => {
            configGetStub.withArgs('llm.maxRetries', 2).returns(3);
            const config = utils.getCommonConfig();
            assert.strictEqual(config.maxRetries, 3);
        });
    });

    describe('default values (no config set)', () => {
        it('should default useChain to true', () => {
            configGetStub.returns(undefined); // simulate no config values
            const config = utils.getCommonConfig();
            assert.strictEqual(config.useChain, true);
        });

        it('should default chainMaxParallel to 2', () => {
            configGetStub.returns(undefined);
            const config = utils.getCommonConfig();
            assert.strictEqual(config.chainMaxParallel, 2);
        });

        it('should default maxRetries to 2', () => {
            configGetStub.returns(undefined);
            const config = utils.getCommonConfig();
            assert.strictEqual(config.maxRetries, 2);
        });

        it('should fallback to default when key returns undefined', () => {
            // VS Code WorkspaceConfiguration.get() returns undefined for missing keys
            configGetStub.withArgs('chain.enabled', true).returns(undefined);
            configGetStub.withArgs('chain.maxParallel', 2).returns(undefined);
            configGetStub.withArgs('llm.maxRetries', 2).returns(undefined);
            const config = utils.getCommonConfig();
            assert.strictEqual(config.useChain, true);
            assert.strictEqual(config.chainMaxParallel, 2);
            assert.strictEqual(config.maxRetries, 2);
        });
    });

    describe('custom config values', () => {
        it('should read useChain as false when chain.enabled is false', () => {
            configGetStub.withArgs('chain.enabled', true).returns(false);
            const config = utils.getCommonConfig();
            assert.strictEqual(config.useChain, false);
        });

        it('should read chainMaxParallel from chain.maxParallel', () => {
            configGetStub.withArgs('chain.maxParallel', 2).returns(10);
            const config = utils.getCommonConfig();
            assert.strictEqual(config.chainMaxParallel, 10);
        });

        it('should read maxRetries from llm.maxRetries', () => {
            configGetStub.withArgs('llm.maxRetries', 2).returns(5);
            const config = utils.getCommonConfig();
            assert.strictEqual(config.maxRetries, 5);
        });
    });

    describe('edge cases', () => {
        it('should pass through chainMaxParallel value of 0 (no clamping)', () => {
            // After P1-17 fix, Math.max(1, ...) was removed to align with getProviderConfig()
            configGetStub.withArgs('chain.maxParallel', 2).returns(0);
            const config = utils.getCommonConfig();
            assert.strictEqual(config.chainMaxParallel, 0,
                'chainMaxParallel of 0 passes through without clamping');
        });

        it('should pass through maxRetries value of 0 (no clamping)', () => {
            // After P1-17 fix, Math.max(1, ...) was removed to align with getProviderConfig()
            configGetStub.withArgs('llm.maxRetries', 2).returns(0);
            const config = utils.getCommonConfig();
            assert.strictEqual(config.maxRetries, 0,
                'maxRetries of 0 passes through without clamping');
        });

        it('should pass through negative chainMaxParallel (no clamping)', () => {
            configGetStub.withArgs('chain.maxParallel', 2).returns(-1);
            const config = utils.getCommonConfig();
            assert.strictEqual(config.chainMaxParallel, -1);
        });

        it('should pass through negative maxRetries (no clamping)', () => {
            configGetStub.withArgs('llm.maxRetries', 2).returns(-1);
            const config = utils.getCommonConfig();
            assert.strictEqual(config.maxRetries, -1);
        });
    });

    describe('consistency with openaiChatCompletionsService.getProviderConfig', () => {
        it('should use same config keys as OpenAIChatCompletionsService', () => {
            // Verify that getCommonConfig config keys match those used in
            // OpenAIChatCompletionsService.getProviderConfig():
            //   chain.enabled, chain.maxParallel, llm.maxRetries
            configGetStub.withArgs('chain.enabled', sinon.match.any).returns(true);
            configGetStub.withArgs('chain.maxParallel', sinon.match.any).returns(2);
            configGetStub.withArgs('llm.maxRetries', sinon.match.any).returns(2);

            const config = utils.getCommonConfig();

            assert.ok(getConfigStub.calledWith('gitCommitGenie'),
                'should use scoped gitCommitGenie config');
            assert.ok(configGetStub.calledWith('chain.enabled', sinon.match.any),
                'should read chain.enabled');
            assert.ok(configGetStub.calledWith('chain.maxParallel', sinon.match.any),
                'should read chain.maxParallel');
            assert.ok(configGetStub.calledWith('llm.maxRetries', sinon.match.any),
                'should read llm.maxRetries');
        });

        it('should have same default values as OpenAIChatCompletionsService', () => {
            // OpenAIChatCompletionsService.getProviderConfig() defaults:
            //   chain.enabled → true
            //   chain.maxParallel → 2
            //   llm.maxRetries → 2
            configGetStub.returns(undefined);
            const config = utils.getCommonConfig();
            assert.strictEqual(config.useChain, true);
            assert.strictEqual(config.chainMaxParallel, 2);
            assert.strictEqual(config.maxRetries, 2);
        });

        it('should not use unscoped config (no gitCommitGenie prefix in key)', () => {
            // The scoped config is retrieved via getConfiguration('gitCommitGenie'),
            // so keys should NOT include the prefix
            configGetStub.returns(undefined);
            utils.getCommonConfig();

            // Keys must be chain.enabled, not gitCommitGenie.chain.enabled
            const allCalls = configGetStub.getCalls().map(c => c.args[0]);
            for (const key of allCalls) {
                assert.strictEqual(key.startsWith('gitCommitGenie.'), false,
                    `key "${key}" should NOT have gitCommitGenie. prefix`);
            }
        });
    });
});

// ============================================================================
// getMaxRetries
// ============================================================================
describe('BaseProviderUtils.getMaxRetries', () => {
    let utils: TestableProviderUtils;
    let context: vscode.ExtensionContext;
    let getConfigStub: sinon.SinonStub;
    let configGetStub: sinon.SinonStub;

    beforeEach(() => {
        context = { globalState: { get: sinon.stub(), update: sinon.stub().resolves() } } as any;
        utils = new TestableProviderUtils(context);

        configGetStub = sinon.stub();
        const mockConfig = { get: configGetStub };
        getConfigStub = sinon.stub(vscode.workspace, 'getConfiguration').returns(mockConfig as any);
    });

    afterEach(() => {
        sinon.restore();
    });

    describe('happy path', () => {
        it('should use scoped gitCommitGenie configuration', () => {
            utils.getMaxRetries();
            assert.ok(getConfigStub.calledWith('gitCommitGenie'));
        });

        it('should read llm.maxRetries key with default 2', () => {
            utils.getMaxRetries();
            assert.ok(configGetStub.calledWith('llm.maxRetries', 2));
        });
    });

    describe('default value', () => {
        it('should return 2 when config is not set', () => {
            configGetStub.returns(undefined);
            const result = utils.getMaxRetries();
            assert.strictEqual(result, 2);
        });
    });

    describe('custom config value', () => {
        it('should return configured value', () => {
            configGetStub.withArgs('llm.maxRetries', 2).returns(4);
            const result = utils.getMaxRetries();
            assert.strictEqual(result, 4);
        });
    });

    describe('edge cases', () => {
        it('should pass through value of 0', () => {
            configGetStub.withArgs('llm.maxRetries', 2).returns(0);
            const result = utils.getMaxRetries();
            assert.strictEqual(result, 0);
        });

        it('should pass through negative value', () => {
            configGetStub.withArgs('llm.maxRetries', 2).returns(-3);
            const result = utils.getMaxRetries();
            assert.strictEqual(result, -3);
        });
    });

    describe('consistency', () => {
        it('should return same value as getCommonConfig().maxRetries', () => {
            configGetStub.withArgs('llm.maxRetries', sinon.match.any).returns(3);
            const fromGetMaxRetries = utils.getMaxRetries();
            const fromCommonConfig = utils.getCommonConfig();
            assert.strictEqual(fromGetMaxRetries, fromCommonConfig.maxRetries,
                'getMaxRetries() and getCommonConfig().maxRetries should return the same value');
        });

        it('should use the same config key as getCommonConfig().maxRetries', () => {
            // Both methods should read from the same config key
            configGetStub.withArgs('llm.maxRetries', sinon.match.any).returns(2);
            utils.getMaxRetries();
            utils.getCommonConfig();

            const calls = configGetStub.getCalls().filter(c => c.args[0] === 'llm.maxRetries');
            assert.strictEqual(calls.length, 2,
                'getMaxRetries and getCommonConfig should both call llm.maxRetries');
        });
    });
});

// ============================================================================
// getTemperature
// ============================================================================
describe('BaseProviderUtils.getTemperature', () => {
    let utils: TestableProviderUtils;
    let context: vscode.ExtensionContext;
    let getConfigStub: sinon.SinonStub;
    let configGetStub: sinon.SinonStub;

    beforeEach(() => {
        context = { globalState: { get: sinon.stub(), update: sinon.stub().resolves() } } as any;
        utils = new TestableProviderUtils(context);

        configGetStub = sinon.stub();
        const mockConfig = { get: configGetStub };
        getConfigStub = sinon.stub(vscode.workspace, 'getConfiguration').returns(mockConfig as any);
    });

    afterEach(() => {
        sinon.restore();
    });

    describe('happy path', () => {
        it('should use scoped gitCommitGenie configuration', () => {
            utils.getTemperature();
            assert.ok(getConfigStub.calledWith('gitCommitGenie'));
        });

        it('should read llm.temperature key with default 1', () => {
            utils.getTemperature();
            assert.ok(configGetStub.calledWith('llm.temperature', 1));
        });
    });

    describe('default value', () => {
        it('should return 1 when config is not set', () => {
            configGetStub.returns(undefined);
            const result = utils.getTemperature();
            assert.strictEqual(result, 1);
        });
    });

    describe('custom config value', () => {
        it('should return configured value', () => {
            configGetStub.withArgs('llm.temperature', 1).returns(0.7);
            const result = utils.getTemperature();
            assert.strictEqual(result, 0.7);
        });

        it('should return 0 when configured', () => {
            configGetStub.withArgs('llm.temperature', 1).returns(0);
            const result = utils.getTemperature();
            assert.strictEqual(result, 0);
        });
    });

    describe('edge cases', () => {
        it('should pass through high temperature value', () => {
            configGetStub.withArgs('llm.temperature', 1).returns(2);
            const result = utils.getTemperature();
            assert.strictEqual(result, 2);
        });

        it('should pass through negative temperature', () => {
            configGetStub.withArgs('llm.temperature', 1).returns(-0.5);
            const result = utils.getTemperature();
            assert.strictEqual(result, -0.5);
        });
    });

    describe('consistency with openaiChatCompletionsService', () => {
        it('should use same config key and default as OpenAIChatCompletionsService.getProviderConfig', () => {
            // OpenAIChatCompletionsService.getProviderConfig() reads:
            //   temperature: cfg.get<number>('llm.temperature', 1)
            const result = utils.getTemperature();
            assert.ok(configGetStub.calledWith('llm.temperature', 1));
            assert.strictEqual(result, 1);
        });
    });
});

// ============================================================================
// getProviderConfig
// ============================================================================
describe('BaseProviderUtils.getProviderConfig', () => {
    let utils: TestableProviderUtils;
    let context: vscode.ExtensionContext;
    let globalStateGet: sinon.SinonStub;
    let getConfigStub: sinon.SinonStub;
    let configGetStub: sinon.SinonStub;

    beforeEach(() => {
        globalStateGet = sinon.stub();
        context = {
            globalState: { get: globalStateGet, update: sinon.stub().resolves() }
        } as any;
        utils = new TestableProviderUtils(context);

        configGetStub = sinon.stub();
        const mockConfig = { get: configGetStub };
        getConfigStub = sinon.stub(vscode.workspace, 'getConfiguration').returns(mockConfig as any);
    });

    afterEach(() => {
        sinon.restore();
    });

    describe('happy path', () => {
        it('should combine common config with provider-specific model', () => {
            configGetStub.withArgs('chain.enabled', true).returns(true);
            configGetStub.withArgs('chain.maxParallel', 2).returns(2);
            configGetStub.withArgs('llm.maxRetries', 2).returns(2);
            globalStateGet.withArgs('gitCommitGenie.openaiModel').returns('gpt-4o');

            const config = utils.getProviderConfig('gitCommitGenie', 'openaiModel');

            assert.strictEqual(config.model, 'gpt-4o');
            assert.strictEqual(config.useChain, true);
            assert.strictEqual(config.chainMaxParallel, 2);
            assert.strictEqual(config.maxRetries, 2);
        });

        it('should use providerKey and modelStateKey to construct globalState key', () => {
            configGetStub.returns(undefined);
            utils.getProviderConfig('myProvider', 'myModelState');

            assert.ok(globalStateGet.calledWith('myProvider.myModelState'),
                'globalState key should be providerKey.modelStateKey');
        });
    });

    describe('model fallback', () => {
        it('should default model to empty string when not set in globalState', () => {
            globalStateGet.returns(undefined);
            configGetStub.returns(undefined);
            const config = utils.getProviderConfig('gitCommitGenie', 'openaiModel');
            assert.strictEqual(config.model, '');
        });
    });

    describe('config isolation', () => {
        it('should read common config via getCommonConfig internal call', () => {
            // Set up specific values and verify they propagate through getProviderConfig
            configGetStub.withArgs('chain.enabled', true).returns(false);
            configGetStub.withArgs('chain.maxParallel', 2).returns(8);
            configGetStub.withArgs('llm.maxRetries', 2).returns(5);
            globalStateGet.returns('test-model');

            const config = utils.getProviderConfig('pre', 'model');

            assert.strictEqual(config.useChain, false);
            assert.strictEqual(config.chainMaxParallel, 8);
            assert.strictEqual(config.maxRetries, 5);
            assert.strictEqual(config.model, 'test-model');
        });
    });
});
