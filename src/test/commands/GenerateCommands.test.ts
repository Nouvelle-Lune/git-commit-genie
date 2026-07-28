import { describe, it, afterEach } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

import { GenerateCommands } from '../../commands/GenerateCommands';
import { ServiceRegistry } from '../../core/ServiceRegistry';
import { StatusBarManager } from '../../ui/StatusBarManager';

describe('GenerateCommands — lazy repository analysis', () => {
    const sandbox = sinon.createSandbox();

    afterEach(() => {
        sandbox.restore();
    });

    function createCommands(options: {
        enabled?: boolean;
        existingAnalysis?: unknown;
        initializeError?: Error;
    } = {}) {
        const getAnalysis = sandbox.stub().resolves(options.existingAnalysis ?? null);
        const initializeRepository = options.initializeError
            ? sandbox.stub().rejects(options.initializeError)
            : sandbox.stub().resolves('success');
        const setRepoAnalysisRunning = sandbox.stub();

        sandbox.stub(vscode.workspace, 'getConfiguration').returns({
            get: sandbox.stub().withArgs('enabled', true).returns(options.enabled ?? true),
        } as unknown as vscode.WorkspaceConfiguration);

        const registry = {
            getAnalysisService: () => ({
                getAnalysis,
                initializeRepository,
            }),
        } as unknown as ServiceRegistry;
        const statusBar = {
            setRepoAnalysisRunning,
        } as unknown as StatusBarManager;
        const commands = new GenerateCommands(
            {} as vscode.ExtensionContext,
            registry,
            statusBar
        );

        return {
            commands,
            getAnalysis,
            initializeRepository,
            setRepoAnalysisRunning,
        };
    }

    it('should not inspect or initialize analysis when the feature is disabled', async () => {
        const state = createCommands({ enabled: false });

        await (state.commands as any).initializeRepositoryAnalysis('/repo');

        assert.strictEqual(state.getAnalysis.called, false);
        assert.strictEqual(state.initializeRepository.called, false);
        assert.strictEqual(state.setRepoAnalysisRunning.called, false);
    });

    it('should not initialize analysis when the repository already has one', async () => {
        const state = createCommands({ existingAnalysis: { summary: 'existing' } });

        await (state.commands as any).initializeRepositoryAnalysis('/repo');

        assert.strictEqual(state.getAnalysis.calledOnceWithExactly('/repo'), true);
        assert.strictEqual(state.initializeRepository.called, false);
        assert.strictEqual(state.setRepoAnalysisRunning.called, false);
    });

    it('should initialize missing analysis for the generated repository', async () => {
        const state = createCommands();

        await (state.commands as any).initializeRepositoryAnalysis('/repo');

        assert.strictEqual(state.initializeRepository.calledOnceWithExactly('/repo'), true);
        assert.deepStrictEqual(
            state.setRepoAnalysisRunning.args,
            [[true, '/repo'], [false]]
        );
    });

    it('should clear the running state when initialization fails', async () => {
        const expectedError = new Error('analysis failed');
        const state = createCommands({ initializeError: expectedError });

        await assert.rejects(
            (state.commands as any).initializeRepositoryAnalysis('/repo'),
            expectedError
        );
        assert.deepStrictEqual(
            state.setRepoAnalysisRunning.args,
            [[true, '/repo'], [false]]
        );
    });
});
