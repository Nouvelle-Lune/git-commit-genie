import { describe, it, beforeEach } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

import { RepositoryAnalysisService } from '../../services/analysis/repositoryAnalysisService';

// ============================================================================
// Helper: create a minimal-but-valid ExtensionContext stub
// ============================================================================
function createStubContext(): vscode.ExtensionContext {
    const secrets = { onDidChange: sinon.stub() } as any;
    const globalState = {
        get: sinon.stub().returns(undefined),
        update: sinon.stub().resolves(),
    };
    return {
        subscriptions: [],
        secrets,
        globalState,
        extensionUri: vscode.Uri.file('/'),
        extensionPath: '/fake',
        storagePath: '/fake/storage',
        globalStoragePath: '/fake/global-storage',
        logPath: '/fake/log',
        extensionMode: vscode.ExtensionMode.Development,
        environmentVariableCollection: {} as any,
        languageModelAccessInformation: {} as any,
    } as unknown as vscode.ExtensionContext;
}

// ============================================================================
// Helper: create a stub RepoService
// ============================================================================
function createStubRepoService() {
    return {
        getRepositoryGitMessageLog: sinon.stub().resolves([]),
        getRepositoryCommits: sinon.stub().resolves([]),
    } as any;
}

// ============================================================================
// Helper: minimal stub LLMService
// ============================================================================
function createStubLLMService() {
    return {
        getClient: sinon.stub().returns(null),
        getUtils: sinon.stub().returns({}),
        listSupportedModels: sinon.stub().returns([]),
        refreshFromSettings: sinon.stub().resolves(),
    } as any;
}

// ============================================================================
// activeCancelSources Map management — core P1-14 fix
// ============================================================================
describe('RepositoryAnalysisService — cancelCurrentAnalysis (P1-14 fix)', () => {

    let service: RepositoryAnalysisService;

    beforeEach(() => {
        const ctx = createStubContext();
        const llmSvc = createStubLLMService();
        const repoSvc = createStubRepoService();
        service = new RepositoryAnalysisService(ctx, llmSvc, repoSvc);
    });

    describe('cancelCurrentAnalysis with multiple active sources', () => {
        it('should cancel all CancellationTokenSource entries in the Map', () => {
            // Arrange: create 3 mock token sources and register them in the Map
            const mockSource1 = { cancel: sinon.stub(), token: { isCancellationRequested: false } } as any;
            const mockSource2 = { cancel: sinon.stub(), token: { isCancellationRequested: false } } as any;
            const mockSource3 = { cancel: sinon.stub(), token: { isCancellationRequested: false } } as any;

            const map = (service as any).activeCancelSources as Map<string, vscode.CancellationTokenSource>;
            map.set('repoA', mockSource1);
            map.set('repoB', mockSource2);
            map.set('repoC', mockSource3);

            // Act
            service.cancelCurrentAnalysis();

            // Assert: every source's cancel() was called exactly once
            assert.strictEqual(mockSource1.cancel.callCount, 1, 'repoA cancel should be called once');
            assert.strictEqual(mockSource2.cancel.callCount, 1, 'repoB cancel should be called once');
            assert.strictEqual(mockSource3.cancel.callCount, 1, 'repoC cancel should be called once');
        });
    });

    describe('cancelCurrentAnalysis with empty Map', () => {
        it('should not throw when no active sources exist', () => {
            // The Map starts empty after service construction.
            // cancelCurrentAnalysis should iterate nothing and not throw.
            assert.doesNotThrow(() => {
                service.cancelCurrentAnalysis();
            });
        });

        it('should not throw when Map is empty after all sources were removed', () => {
            const map = (service as any).activeCancelSources as Map<string, vscode.CancellationTokenSource>;
            const mockSource = { cancel: sinon.stub(), token: { isCancellationRequested: false } } as any;
            map.set('repoA', mockSource);
            map.delete('repoA');

            assert.doesNotThrow(() => {
                service.cancelCurrentAnalysis();
            });
        });
    });

    describe('cancelCurrentAnalysis error resilience', () => {
        it('should continue cancelling remaining sources after one source throws', () => {
            // Arrange: source "repoB" throws on cancel, but "repoA" and "repoC" should still be cancelled
            const mockSourceA = { cancel: sinon.stub(), token: { isCancellationRequested: false } } as any;
            const mockSourceB = { cancel: sinon.stub().throws(new Error('cancel failed')), token: { isCancellationRequested: false } } as any;
            const mockSourceC = { cancel: sinon.stub(), token: { isCancellationRequested: false } } as any;

            const map = (service as any).activeCancelSources as Map<string, vscode.CancellationTokenSource>;
            map.set('repoA', mockSourceA);
            map.set('repoB', mockSourceB);
            map.set('repoC', mockSourceC);

            // Act
            service.cancelCurrentAnalysis();

            // Assert: A and C are still cancelled despite B throwing
            assert.strictEqual(mockSourceA.cancel.callCount, 1);
            assert.strictEqual(mockSourceB.cancel.callCount, 1);
            assert.strictEqual(mockSourceC.cancel.callCount, 1);
        });

        it('should not throw even if all sources throw on cancel', () => {
            const mockSource1 = { cancel: sinon.stub().throws(new Error('fail1')), token: {} } as any;
            const mockSource2 = { cancel: sinon.stub().throws(new Error('fail2')), token: {} } as any;

            const map = (service as any).activeCancelSources as Map<string, vscode.CancellationTokenSource>;
            map.set('repoA', mockSource1);
            map.set('repoB', mockSource2);

            assert.doesNotThrow(() => {
                service.cancelCurrentAnalysis();
            });

            assert.strictEqual(mockSource1.cancel.callCount, 1);
            assert.strictEqual(mockSource2.cancel.callCount, 1);
        });
    });

    describe('Map key-based per-repository isolation', () => {
        it('should use repositoryPath as Map keys for independent cancel sources', () => {
            const map = (service as any).activeCancelSources as Map<string, vscode.CancellationTokenSource>;
            const sourceA = { cancel: sinon.stub(), token: { isCancellationRequested: false } } as any;
            const sourceB = { cancel: sinon.stub(), token: { isCancellationRequested: false } } as any;

            map.set('/home/user/project-a', sourceA);
            map.set('/home/user/project-b', sourceB);

            assert.strictEqual(map.size, 2);
            assert.notStrictEqual(map.get('/home/user/project-a'), map.get('/home/user/project-b'));
        });

        it('should allow same repoPath overwrite (last writer wins)', () => {
            const map = (service as any).activeCancelSources as Map<string, vscode.CancellationTokenSource>;
            const sourceFirst = { cancel: sinon.stub(), token: {} } as any;
            const sourceSecond = { cancel: sinon.stub(), token: {} } as any;

            map.set('/home/user/project', sourceFirst);
            map.set('/home/user/project', sourceSecond);

            // Same key should map to the latest value
            assert.strictEqual(map.get('/home/user/project'), sourceSecond);
            assert.strictEqual(map.size, 1);
        });
    });

    describe('Map size tracking', () => {
        it('should reflect the correct number of active sources after set and delete', () => {
            const map = (service as any).activeCancelSources as Map<string, vscode.CancellationTokenSource>;
            assert.strictEqual(map.size, 0, 'Map should start empty');

            map.set('A', {} as any);
            assert.strictEqual(map.size, 1);

            map.set('B', {} as any);
            assert.strictEqual(map.size, 2);

            map.delete('A');
            assert.strictEqual(map.size, 1);

            map.delete('B');
            assert.strictEqual(map.size, 0);
        });
    });

    describe('cancelCurrentAnalysis does NOT mutate the Map', () => {
        it('should leave entries in the Map after cancellation (cleanup is the caller’s responsibility)', () => {
            const map = (service as any).activeCancelSources as Map<string, vscode.CancellationTokenSource>;
            const mockSource = { cancel: sinon.stub(), token: { isCancellationRequested: false } } as any;
            map.set('repoA', mockSource);

            service.cancelCurrentAnalysis();

            // cancelCurrentAnalysis only cancels; it does not remove entries
            assert.strictEqual(map.has('repoA'), true);
            assert.strictEqual(mockSource.cancel.callCount, 1);
        });
    });
});

// ============================================================================
// initializeRepository cancel lifecycle — BUG verification
// ============================================================================
describe('RepositoryAnalysisService — initializeRepository cancel lifecycle', () => {

    let service: RepositoryAnalysisService;
    let stubContext: vscode.ExtensionContext;

    beforeEach(() => {
        stubContext = createStubContext();
        const llmSvc = createStubLLMService();
        const repoSvc = createStubRepoService();
        service = new RepositoryAnalysisService(stubContext, llmSvc, repoSvc);
    });

    describe('cancelSource registration and cleanup contract', () => {
        it('should NOT register a cancelSource in the Map when initializeRepository is disabled (cfg.enabled=false)', async () => {
            const map = (service as any).activeCancelSources as Map<string, vscode.CancellationTokenSource>;

            // Simulate VSCode config: enabled=false
            const getConfigStub = sinon.stub(vscode.workspace, 'getConfiguration').returns({
                get: sinon.stub()
                    .withArgs('enabled', true).returns(false)  // disabled
                    .withArgs('model', 'general').returns('general'),
            } as any);

            try {
                await service.initializeRepository('/test-repo');

                // When cfg.enabled is false, initializeRepository returns 'skipped' before
                // creating a cancelSource. The Map must remain clean — no leaked entries.
                const hasEntry = map.has('/test-repo');
                assert.strictEqual(hasEntry, false,
                    'cancelSource should NOT be registered when cfg.enabled is false — ' +
                    'the early return happens before cancelSource creation'
                );
            } finally {
                getConfigStub.restore();
            }
        });

        it('should clean up cancelSource from Map when analysis completes successfully', async () => {
            const map = (service as any).activeCancelSources as Map<string, vscode.CancellationTokenSource>;

            // Simulate VSCode config: enabled=true
            // But mock getAnalysis to return existing (so init skips early)
            const getConfigStub = sinon.stub(vscode.workspace, 'getConfiguration').returns({
                get: sinon.stub()
                    .withArgs('enabled', true).returns(true)
                    .withArgs('model', 'general').returns('general'),
            } as any);

            // Provide an existing analysis so init returns 'skipped' early
            const origGetAnalysis = (service as any).getAnalysis.bind(service);
            const getAnalysisStub = sinon.stub(service as any, 'getAnalysis').resolves({
                repositoryPath: '/test-repo',
                summary: 'existing',
            });

            try {
                await service.initializeRepository('/test-repo');

                // The 'existing' path returns 'skipped' inside try block, so finally runs.
                // Map entry should be cleaned up.
                assert.strictEqual(map.has('/test-repo'), false,
                    'cancelSource should be cleaned up from Map when analysis completes'
                );
            } finally {
                getConfigStub.restore();
                getAnalysisStub.restore();
            }
        });

        it('should clean up cancelSource from Map when analysis fails', async () => {
            const map = (service as any).activeCancelSources as Map<string, vscode.CancellationTokenSource>;

            const getConfigStub = sinon.stub(vscode.workspace, 'getConfiguration').returns({
                get: sinon.stub()
                    .withArgs('enabled', true).returns(true)
                    .withArgs('model', 'general').returns('general'),
            } as any);

            // Make getAnalysis throw to trigger the catch path
            const getAnalysisStub = sinon.stub(service as any, 'getAnalysis').rejects(new Error('simulated failure'));

            try {
                await service.initializeRepository('/test-repo');

                // Even on error, finally should clean up the Map entry
                assert.strictEqual(map.has('/test-repo'), false,
                    'cancelSource should be cleaned up from Map even on error'
                );
            } finally {
                getConfigStub.restore();
                getAnalysisStub.restore();
            }
        });

        it('should expose the cancel token via activeCancelSources for per-repo lookup', () => {
            const map = (service as any).activeCancelSources as Map<string, vscode.CancellationTokenSource>;

            const mockToken = { isCancellationRequested: false, onCancellationRequested: sinon.stub() };
            const mockSource = { cancel: sinon.stub(), token: mockToken, dispose: sinon.stub() };
            map.set('/repo-x', mockSource as any);

            const retrieved = map.get('/repo-x');
            assert.notStrictEqual(retrieved, undefined);
            assert.strictEqual((retrieved as any).token, mockToken);
        });
    });
});

// ============================================================================
// updateAnalysis cancel lifecycle — control flow consistency with initializeRepository
// ============================================================================
describe('RepositoryAnalysisService — updateAnalysis cancel lifecycle', () => {

    let service: RepositoryAnalysisService;

    beforeEach(() => {
        const ctx = createStubContext();
        const llmSvc = createStubLLMService();
        const repoSvc = createStubRepoService();
        service = new RepositoryAnalysisService(ctx, llmSvc, repoSvc);
    });

    describe('cancelSource registration and cleanup contract', () => {
        it('should NOT register a cancelSource in the Map when updateAnalysis is disabled (cfg.enabled=false)', async () => {
            const map = (service as any).activeCancelSources as Map<string, vscode.CancellationTokenSource>;

            // Simulate VSCode config: enabled=false
            const getConfigStub = sinon.stub(vscode.workspace, 'getConfiguration').returns({
                get: sinon.stub()
                    .withArgs('enabled', true).returns(false)  // disabled
                    .withArgs('model', 'general').returns('general'),
            } as any);

            try {
                await service.updateAnalysis('/test-repo');

                // When cfg.enabled is false, updateAnalysis returns 'skipped' before
                // creating a cancelSource — same pattern as initializeRepository.
                const hasEntry = map.has('/test-repo');
                assert.strictEqual(hasEntry, false,
                    'cancelSource should NOT be registered when cfg.enabled is false — ' +
                    'the early return happens before cancelSource creation'
                );
            } finally {
                getConfigStub.restore();
            }
        });

        it('should clean up cancelSource from Map when updateAnalysis completes successfully', async () => {
            const map = (service as any).activeCancelSources as Map<string, vscode.CancellationTokenSource>;

            const getConfigStub = sinon.stub(vscode.workspace, 'getConfiguration').returns({
                get: sinon.stub()
                    .withArgs('enabled', true).returns(true)
                    .withArgs('model', 'general').returns('general'),
            } as any);

            // Provide an existing analysis so update proceeds past the init-fallback check
            const getAnalysisStub = sinon.stub(service as any, 'getAnalysis').resolves({
                repositoryPath: '/test-repo',
                summary: 'existing',
            });

            // getCommitHistory must also succeed to reach the end
            const getCommitHistoryStub = sinon.stub(service as any, 'getCommitHistory').resolves([]);

            try {
                await service.updateAnalysis('/test-repo');

                // The 'existing' path returns 'skipped' (no recent commits to analyze),
                // which happens inside the try block, so finally runs and cleans up.
                assert.strictEqual(map.has('/test-repo'), false,
                    'cancelSource should be cleaned up from Map when updateAnalysis completes'
                );
            } finally {
                getConfigStub.restore();
                getAnalysisStub.restore();
                getCommitHistoryStub.restore();
            }
        });

        it('should clean up cancelSource from Map when updateAnalysis fails', async () => {
            const map = (service as any).activeCancelSources as Map<string, vscode.CancellationTokenSource>;

            const getConfigStub = sinon.stub(vscode.workspace, 'getConfiguration').returns({
                get: sinon.stub()
                    .withArgs('enabled', true).returns(true)
                    .withArgs('model', 'general').returns('general'),
            } as any);

            // Make getAnalysis throw to trigger the catch path
            const getAnalysisStub = sinon.stub(service as any, 'getAnalysis').rejects(new Error('simulated failure'));

            try {
                await service.updateAnalysis('/test-repo');

                // Even on error, finally should clean up the Map entry
                assert.strictEqual(map.has('/test-repo'), false,
                    'cancelSource should be cleaned up from Map even on error in updateAnalysis'
                );
            } finally {
                getConfigStub.restore();
                getAnalysisStub.restore();
            }
        });
    });
});

// ============================================================================
// cancelCurrentAnalysis vs initializeRepository end-to-end pattern
// ============================================================================
describe('RepositoryAnalysisService — cancel during multi-repo analysis', () => {

    let service: RepositoryAnalysisService;

    beforeEach(() => {
        const ctx = createStubContext();
        const llmSvc = createStubLLMService();
        const repoSvc = createStubRepoService();
        service = new RepositoryAnalysisService(ctx, llmSvc, repoSvc);
    });

    it('should cancel ALL repos when cancelCurrentAnalysis is called mid-analysis', () => {
        const map = (service as any).activeCancelSources as Map<string, vscode.CancellationTokenSource>;

        const sourceRepo1 = { cancel: sinon.stub(), token: { isCancellationRequested: false } } as any;
        const sourceRepo2 = { cancel: sinon.stub(), token: { isCancellationRequested: false } } as any;

        // Simulate two repos being analyzed simultaneously
        map.set('/projects/repo1', sourceRepo1);
        map.set('/projects/repo2', sourceRepo2);

        // User triggers cancel
        service.cancelCurrentAnalysis();

        // Both should be cancelled — this is the core P1-14 fix
        assert.strictEqual(sourceRepo1.cancel.callCount, 1);
        assert.strictEqual(sourceRepo2.cancel.callCount, 1);
    });

    it('should reflect cancellation state when token is checked after cancel', () => {
        const map = (service as any).activeCancelSources as Map<string, vscode.CancellationTokenSource>;

        // Use real vscode CancellationTokenSource to verify the cancel() actually sets isCancellationRequested
        const realSource = new vscode.CancellationTokenSource();
        assert.strictEqual(realSource.token.isCancellationRequested, false);

        map.set('/projects/repo-real', realSource);

        service.cancelCurrentAnalysis();

        assert.strictEqual(realSource.token.isCancellationRequested, true,
            'cancelCurrentAnalysis should set isCancellationRequested to true on real CancellationTokenSource'
        );
    });
});
