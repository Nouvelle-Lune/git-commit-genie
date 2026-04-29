import { describe, it, beforeEach, afterEach } from 'mocha';
import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { EventManager } from '../../events/EventManager';
import { ServiceRegistry } from '../../core/ServiceRegistry';
import { StatusBarManager } from '../../ui/StatusBarManager';
import { Repository } from '../../services/git/git';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create a minimal mock vscode.ExtensionContext sufficient for EventManager.
 */
function createMockContext(): vscode.ExtensionContext {
    const subscriptions: vscode.Disposable[] = [];
    return {
        subscriptions,
        extensionPath: '/fake/ext/path',
        globalStoragePath: '/fake/global/storage',
        logPath: '/fake/log',
        storagePath: '/fake/storage',
        globalState: {
            get: () => undefined,
            update: () => Promise.resolve(),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        workspaceState: {
            get: () => undefined,
            update: () => Promise.resolve(),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        secrets: {
            get: () => Promise.resolve(undefined),
            store: () => Promise.resolve(),
            delete: () => Promise.resolve(),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onDidChange: (() => ({ dispose: () => { } })) as any,
        },
        extensionUri: vscode.Uri.file('/fake'),
        environmentVariableCollection: {
            replace: () => { },
            append: () => { },
            prepend: () => { },
            get: () => undefined,
            forEach: () => { },
            delete: () => { },
            clear: () => { },
            persistent: true,
            description: '',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        extensionMode: vscode.ExtensionMode.Production,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
}

/**
 * Create a mock vscode.Event that captures the registered listener.
 * Returns the event function (mimicking vscode.Event<T>) and a `fire` helper.
 */
function createMockEvent<T>(): { event: vscode.Event<T>; fire: (arg: T) => void; listeners: ((e: T) => any)[] } {
    const listeners: ((e: T) => any)[] = [];
    const event = ((listener: (e: T) => any, _thisArgs?: any, disposables?: vscode.Disposable[]) => {
        listeners.push(listener);
        const disposable = { dispose: () => { const idx = listeners.indexOf(listener); if (idx !== -1) { listeners.splice(idx, 1); } } };
        if (disposables) {
            disposables.push(disposable);
        }
        return disposable;
    }) as vscode.Event<T>;
    return {
        event,
        fire: (arg: T) => { for (const l of listeners) { l(arg); } },
        listeners,
    };
}

/**
 * Create a minimal mock Repository that satisfies the interface used by EventManager.
 * EventManager accesses: rootUri.fsPath, state.HEAD?.commit, state.onDidChange
 */
function createMockRepo(repoPath: string): {
    repo: Repository;
    headChangeEvent: ReturnType<typeof createMockEvent<void>>;
} {
    const headChangeEvent = createMockEvent<void>();
    const repo = {
        rootUri: vscode.Uri.file(repoPath),
        state: {
            HEAD: { commit: 'abc1234' },
            onDidChange: headChangeEvent.event,
        },
    } as unknown as Repository;
    return { repo, headChangeEvent };
}

// ============================================================================
// EventManager — constructor & dispose
// ============================================================================
describe('EventManager', () => {

    describe('constructor & initialization', () => {
        it('should initialize repoDisposables as an empty Map', () => {
            const em = new EventManager(
                createMockContext(),
                {} as ServiceRegistry,
                {} as StatusBarManager
            );
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const map = (em as any).repoDisposables as Map<string, vscode.Disposable>;
            assert.ok(map instanceof Map);
            assert.strictEqual(map.size, 0);
        });

        it('should initialize lastHeadByRepo as an empty Map', () => {
            const em = new EventManager(
                createMockContext(),
                {} as ServiceRegistry,
                {} as StatusBarManager
            );
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const map = (em as any).lastHeadByRepo as Map<string, string | undefined>;
            assert.ok(map instanceof Map);
            assert.strictEqual(map.size, 0);
        });
    });

    // ========================================================================
    // dispose()
    // ========================================================================
    describe('dispose()', () => {
        let em: EventManager;

        beforeEach(() => {
            em = new EventManager(
                createMockContext(),
                {} as ServiceRegistry,
                {} as StatusBarManager
            );
        });

        it('should dispose all tracked repoDisposables', () => {
            const disposed: string[] = [];
            const disposableA = { dispose: () => { disposed.push('a'); } };
            const disposableB = { dispose: () => { disposed.push('b'); } };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (em as any).repoDisposables.set('/repo/a', disposableA);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (em as any).repoDisposables.set('/repo/b', disposableB);

            em.dispose();

            assert.deepStrictEqual(disposed.sort(), ['a', 'b']);
        });

        it('should clear repoDisposables map after dispose', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (em as any).repoDisposables.set('/repo/a', { dispose: () => { } });
            await em.dispose();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            assert.strictEqual((em as any).repoDisposables.size, 0);
        });

        it('should clear lastHeadByRepo map after dispose', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (em as any).lastHeadByRepo.set('/repo/a', 'commit1');
            await em.dispose();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            assert.strictEqual((em as any).lastHeadByRepo.size, 0);
        });

        it('should handle empty maps without throwing', async () => {
            // Both maps are already empty (initialized in constructor)
            try {
                await em.dispose();
            } catch (e) {
                assert.fail(`dispose() should not throw on empty maps: ${e}`);
            }
        });

        it('should handle null repoDisposables key gracefully', () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const map = (em as any).repoDisposables as Map<string, vscode.Disposable>;
            map.set('/repo/a', { dispose: () => { } });
            // Simulate an abnormal entry (only for map iteration coverage)
            assert.strictEqual(map.size, 1);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (em as any).dispose();
            assert.strictEqual(map.size, 0);
        });
    });

    // ========================================================================
    // setupGitChangeListeners — attachRepoListeners
    // ========================================================================
    describe('setupGitChangeListeners (attachRepoListeners)', () => {
        let em: EventManager;
        let mockContext: ReturnType<typeof createMockContext>;
        let mockApi: any;
        let openRepoEvent: ReturnType<typeof createMockEvent<Repository>>;
        let closeRepoEvent: ReturnType<typeof createMockEvent<Repository>>;
        let sandbox: sinon.SinonSandbox;

        beforeEach(() => {
            sandbox = sinon.createSandbox();
            mockContext = createMockContext();

            openRepoEvent = createMockEvent<Repository>();
            closeRepoEvent = createMockEvent<Repository>();

            mockApi = {
                repositories: [] as Repository[],
                onDidOpenRepository: openRepoEvent.event,
                onDidCloseRepository: closeRepoEvent.event,
            };

            const mockGitExtension = {
                enabled: true,
                onDidChangeEnablement: createMockEvent<boolean>().event,
                getAPI: () => mockApi,
            };

            sandbox.stub(vscode.extensions, 'getExtension').callsFake((id: string) => {
                if (id === 'vscode.git') {
                    return { exports: mockGitExtension, id, extensionPath: '', extensionUri: vscode.Uri.file('/fake'), isActive: true, packageJSON: {}, extensionKind: vscode.ExtensionKind.Workspace, activate: () => Promise.resolve(mockGitExtension) } as unknown as vscode.Extension<any>;
                }
                return undefined;
            });

            // Stub file watcher creation to avoid side effects
            const mockWatcher = {
                onDidCreate: () => { },
                onDidChange: () => { },
                onDidDelete: () => { },
                dispose: () => { },
                ignoreCreateEvents: false,
                ignoreChangeEvents: false,
                ignoreDeleteEvents: false,
            };
            sandbox.stub(vscode.workspace, 'createFileSystemWatcher').returns(mockWatcher as unknown as vscode.FileSystemWatcher);

            // Stub configuration to disable repo analysis (so it doesn't try to call analysis service)
            sandbox.stub(vscode.workspace, 'getConfiguration').returns({
                get: (_section: string, defaultValue: any) => defaultValue,
                has: () => false,
                inspect: () => undefined,
                update: () => Promise.resolve(),
            } as unknown as vscode.WorkspaceConfiguration);

            const mockServiceRegistry = {
                getAnalysisService: () => ({
                    getAnalysis: () => Promise.resolve(undefined),
                    initializeRepository: () => Promise.resolve(),
                    updateAnalysis: () => Promise.resolve(),
                    shouldUpdateAnalysis: () => Promise.resolve(false),
                    syncAnalysisFromMarkdown: () => Promise.resolve(),
                    clearAnalysis: () => Promise.resolve(),
                }),
            } as unknown as ServiceRegistry;

            const mockStatusBarManager = {
                updateStatusBar: () => { },
                setRepoAnalysisRunning: () => { },
            } as unknown as StatusBarManager;

            em = new EventManager(mockContext, mockServiceRegistry, mockStatusBarManager);
        });

        afterEach(() => {
            sandbox.restore();
        });

        it('should store disposable in repoDisposables when repo is attached', () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const setupFn = (em as any).setupGitChangeListeners.bind(em);
            setupFn();

            const { repo } = createMockRepo('/fake/repo');
            openRepoEvent.fire(repo);

            // After firing onDidOpenRepository, repoDisposables should have an entry
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const repoDisposables = (em as any).repoDisposables as Map<string, vscode.Disposable>;
            assert.strictEqual(repoDisposables.size, 1);
            assert.ok(repoDisposables.has('/fake/repo'));
        });

        it('should NOT store disposable in context.subscriptions (prevents leak on extension deactivate)', () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const setupFn = (em as any).setupGitChangeListeners.bind(em);
            setupFn();

            const subCountBefore = mockContext.subscriptions.length;
            const { repo } = createMockRepo('/fake/repo-sub');
            openRepoEvent.fire(repo);

            // context.subscriptions should NOT increase for the repo listener
            // (the onDidOpenRepository subscription itself goes into context.subscriptions,
            // but the repo's onDidChange disposable goes to repoDisposables)
            const subCountAfter = mockContext.subscriptions.length;
            // Only the onDidOpenRepo and onDidCloseRepo subscriptions are added to context.subscriptions
            // (those were added in setupGitChangeListeners). Firing an event does NOT add more subscriptions.
            // The repo disposable is stored in repoDisposables, not pushed to context.subscriptions.
            assert.strictEqual(subCountAfter, subCountBefore);
        });

        it('should seed lastHeadByRepo with HEAD commit when repo is attached', () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const setupFn = (em as any).setupGitChangeListeners.bind(em);
            setupFn();

            const { repo } = createMockRepo('/fake/repo-head');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (repo.state.HEAD as any) = { commit: 'deadbeef' };
            openRepoEvent.fire(repo);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const lastHeadByRepo = (em as any).lastHeadByRepo as Map<string, string | undefined>;
            assert.strictEqual(lastHeadByRepo.get('/fake/repo-head'), 'deadbeef');
        });

        it('should handle undefined repoPath gracefully (no rootUri)', () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const setupFn = (em as any).setupGitChangeListeners.bind(em);
            setupFn();

            const repo = { rootUri: undefined, state: { HEAD: undefined } } as unknown as Repository;
            // Should not throw
            openRepoEvent.fire(repo);

            // repoDisposables should remain empty
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const repoDisposables = (em as any).repoDisposables as Map<string, vscode.Disposable>;
            assert.strictEqual(repoDisposables.size, 0);
        });

        it('should dispose previous listener when same repo is reopened', () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const setupFn = (em as any).setupGitChangeListeners.bind(em);
            setupFn();

            const { repo: repo1 } = createMockRepo('/fake/repo-reopen');
            openRepoEvent.fire(repo1);

            // Capture the first disposable
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const repoDisposables = (em as any).repoDisposables as Map<string, vscode.Disposable>;
            const firstDisposable = repoDisposables.get('/fake/repo-reopen');
            assert.ok(firstDisposable);

            let disposed = false;
            // Wrap the dispose to track
            const origDispose = firstDisposable!.dispose.bind(firstDisposable);
            firstDisposable!.dispose = () => { disposed = true; origDispose(); };

            // Fire open again for the same repo (simulating close + reopen)
            const { repo: repo2 } = createMockRepo('/fake/repo-reopen');
            openRepoEvent.fire(repo2);

            assert.strictEqual(disposed, true, 'old listener should be disposed when same repo is reopened');
        });

        it('should update lastHeadByRepo when HEAD changes via onDidChange', () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const setupFn = (em as any).setupGitChangeListeners.bind(em);
            setupFn();

            const { repo, headChangeEvent } = createMockRepo('/fake/repo-headchange');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (repo.state.HEAD as any) = { commit: 'initial123' };
            openRepoEvent.fire(repo);

            // Change HEAD
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (repo.state.HEAD as any) = { commit: 'updated456' };
            headChangeEvent.fire();

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const lastHeadByRepo = (em as any).lastHeadByRepo as Map<string, string | undefined>;
            assert.strictEqual(lastHeadByRepo.get('/fake/repo-headchange'), 'updated456');
        });

        it('should NOT update lastHeadByRepo when HEAD commit is unchanged', () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const setupFn = (em as any).setupGitChangeListeners.bind(em);
            setupFn();

            const { repo, headChangeEvent } = createMockRepo('/fake/repo-nochange');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (repo.state.HEAD as any) = { commit: 'samecommit' };
            openRepoEvent.fire(repo);

            // Fire change but HEAD is same
            headChangeEvent.fire();

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const lastHeadByRepo = (em as any).lastHeadByRepo as Map<string, string | undefined>;
            assert.strictEqual(lastHeadByRepo.get('/fake/repo-nochange'), 'samecommit');
        });

        it('should handle onDidChange when HEAD becomes undefined', () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const setupFn = (em as any).setupGitChangeListeners.bind(em);
            setupFn();

            const { repo, headChangeEvent } = createMockRepo('/fake/repo-headnull');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (repo.state.HEAD as any) = { commit: 'initial123' };
            openRepoEvent.fire(repo);

            // HEAD becomes undefined (e.g., repo in detached state)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (repo.state.HEAD as any) = undefined;
            // Should not throw
            try {
                headChangeEvent.fire();
            } catch (e) {
                assert.fail(`onDidChange with undefined HEAD should not throw: ${e}`);
            }
        });
    });

    // ========================================================================
    // setupGitChangeListeners — onDidCloseRepository
    // ========================================================================
    describe('setupGitChangeListeners (onDidCloseRepository)', () => {
        let em: EventManager;
        let mockContext: ReturnType<typeof createMockContext>;
        let mockApi: any;
        let openRepoEvent: ReturnType<typeof createMockEvent<Repository>>;
        let closeRepoEvent: ReturnType<typeof createMockEvent<Repository>>;
        let sandbox: sinon.SinonSandbox;

        beforeEach(() => {
            sandbox = sinon.createSandbox();
            mockContext = createMockContext();

            openRepoEvent = createMockEvent<Repository>();
            closeRepoEvent = createMockEvent<Repository>();

            mockApi = {
                repositories: [] as Repository[],
                onDidOpenRepository: openRepoEvent.event,
                onDidCloseRepository: closeRepoEvent.event,
            };

            const mockGitExtension = {
                enabled: true,
                onDidChangeEnablement: createMockEvent<boolean>().event,
                getAPI: () => mockApi,
            };

            sandbox.stub(vscode.extensions, 'getExtension').callsFake((id: string) => {
                if (id === 'vscode.git') {
                    return { exports: mockGitExtension, id, extensionPath: '', extensionUri: vscode.Uri.file('/fake'), isActive: true, packageJSON: {}, extensionKind: vscode.ExtensionKind.Workspace, activate: () => Promise.resolve(mockGitExtension) } as unknown as vscode.Extension<any>;
                }
                return undefined;
            });

            const mockWatcher = {
                onDidCreate: () => { },
                onDidChange: () => { },
                onDidDelete: () => { },
                dispose: () => { },
                ignoreCreateEvents: false,
                ignoreChangeEvents: false,
                ignoreDeleteEvents: false,
            };
            sandbox.stub(vscode.workspace, 'createFileSystemWatcher').returns(mockWatcher as unknown as vscode.FileSystemWatcher);

            sandbox.stub(vscode.workspace, 'getConfiguration').returns({
                get: (_section: string, defaultValue: any) => defaultValue,
                has: () => false,
                inspect: () => undefined,
                update: () => Promise.resolve(),
            } as unknown as vscode.WorkspaceConfiguration);

            const mockServiceRegistry = {
                getAnalysisService: () => ({
                    getAnalysis: () => Promise.resolve(undefined),
                    initializeRepository: () => Promise.resolve(),
                    updateAnalysis: () => Promise.resolve(),
                    shouldUpdateAnalysis: () => Promise.resolve(false),
                    syncAnalysisFromMarkdown: () => Promise.resolve(),
                    clearAnalysis: () => Promise.resolve(),
                }),
            } as unknown as ServiceRegistry;

            const mockStatusBarManager = {
                updateStatusBar: () => { },
                setRepoAnalysisRunning: () => { },
            } as unknown as StatusBarManager;

            em = new EventManager(mockContext, mockServiceRegistry, mockStatusBarManager);
        });

        afterEach(() => {
            sandbox.restore();
        });

        it('should delete repoPath from lastHeadByRepo when repo is closed', () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const setupFn = (em as any).setupGitChangeListeners.bind(em);
            setupFn();

            // Open a repo first
            const { repo } = createMockRepo('/fake/repo-close');
            openRepoEvent.fire(repo);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const lastHeadByRepo = (em as any).lastHeadByRepo as Map<string, string | undefined>;
            assert.ok(lastHeadByRepo.has('/fake/repo-close'), 'should have entry before close');

            // Now close it
            closeRepoEvent.fire(repo);

            assert.strictEqual(lastHeadByRepo.has('/fake/repo-close'), false, 'lastHeadByRepo should be cleaned up on close');
        });

        it('should dispose listener from repoDisposables when repo is closed', () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const setupFn = (em as any).setupGitChangeListeners.bind(em);
            setupFn();

            const { repo } = createMockRepo('/fake/repo-close-disp');
            openRepoEvent.fire(repo);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const repoDisposables = (em as any).repoDisposables as Map<string, vscode.Disposable>;
            const disposable = repoDisposables.get('/fake/repo-close-disp');
            assert.ok(disposable, 'disposable should exist before close');

            let disposed = false;
            const origDispose = disposable!.dispose.bind(disposable);
            disposable!.dispose = () => { disposed = true; origDispose(); };

            closeRepoEvent.fire(repo);

            assert.strictEqual(disposed, true, 'disposable should be disposed on repo close');
        });

        it('should remove disposable from repoDisposables when repo is closed', () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const setupFn = (em as any).setupGitChangeListeners.bind(em);
            setupFn();

            const { repo } = createMockRepo('/fake/repo-close-rm');
            openRepoEvent.fire(repo);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const repoDisposables = (em as any).repoDisposables as Map<string, vscode.Disposable>;
            assert.ok(repoDisposables.has('/fake/repo-close-rm'), 'should have entry before close');

            closeRepoEvent.fire(repo);

            assert.strictEqual(repoDisposables.has('/fake/repo-close-rm'), false, 'repoDisposables should be cleaned up on close');
        });

        it('should not throw when close event fires for repo with no rootUri', () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const setupFn = (em as any).setupGitChangeListeners.bind(em);
            setupFn();

            const repo = { rootUri: undefined } as unknown as Repository;
            try {
                closeRepoEvent.fire(repo);
            } catch (e) {
                assert.fail(`close event with undefined rootUri should not throw: ${e}`);
            }
        });

        it('should not throw when close event fires for repo not in repoDisposables', () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const setupFn = (em as any).setupGitChangeListeners.bind(em);
            setupFn();

            const { repo } = createMockRepo('/fake/repo-never-opened');
            try {
                closeRepoEvent.fire(repo);
            } catch (e) {
                assert.fail(`close event for unknown repo should not throw: ${e}`);
            }
        });

        it('should clean up both maps correctly for open-close-open cycle (no leak)', () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const setupFn = (em as any).setupGitChangeListeners.bind(em);
            setupFn();

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const repoDisposables = (em as any).repoDisposables as Map<string, vscode.Disposable>;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const lastHeadByRepo = (em as any).lastHeadByRepo as Map<string, string | undefined>;

            // First open
            const { repo: repoA } = createMockRepo('/fake/repo-cycle');
            openRepoEvent.fire(repoA);
            assert.strictEqual(repoDisposables.size, 1);
            assert.strictEqual(lastHeadByRepo.size, 1);

            // Close
            closeRepoEvent.fire(repoA);
            assert.strictEqual(repoDisposables.size, 0);
            assert.strictEqual(lastHeadByRepo.size, 0);

            // Reopen
            const { repo: repoB } = createMockRepo('/fake/repo-cycle');
            openRepoEvent.fire(repoB);
            assert.strictEqual(repoDisposables.size, 1);
            assert.strictEqual(lastHeadByRepo.size, 1);

            // Close again
            closeRepoEvent.fire(repoB);
            assert.strictEqual(repoDisposables.size, 0);
            assert.strictEqual(lastHeadByRepo.size, 0);
        });
    });

    // ========================================================================
    // setupGitChangeListeners — onDidCloseRepository subscription registration
    // ========================================================================
    describe('setupGitChangeListeners (subscription registration)', () => {
        let sandbox: sinon.SinonSandbox;
        let mockContext: ReturnType<typeof createMockContext>;

        beforeEach(() => {
            sandbox = sinon.createSandbox();
            mockContext = createMockContext();

            const openRepoEvent = createMockEvent<Repository>();
            const closeRepoEvent = createMockEvent<Repository>();

            const mockApi = {
                repositories: [] as Repository[],
                onDidOpenRepository: openRepoEvent.event,
                onDidCloseRepository: closeRepoEvent.event,
            };

            const mockGitExtension = {
                enabled: true,
                onDidChangeEnablement: createMockEvent<boolean>().event,
                getAPI: () => mockApi,
            };

            sandbox.stub(vscode.extensions, 'getExtension').callsFake((id: string) => {
                if (id === 'vscode.git') {
                    return { exports: mockGitExtension, id, extensionPath: '', extensionUri: vscode.Uri.file('/fake'), isActive: true, packageJSON: {}, extensionKind: vscode.ExtensionKind.Workspace, activate: () => Promise.resolve(mockGitExtension) } as unknown as vscode.Extension<any>;
                }
                return undefined;
            });

            const mockWatcher = {
                onDidCreate: () => { },
                onDidChange: () => { },
                onDidDelete: () => { },
                dispose: () => { },
                ignoreCreateEvents: false,
                ignoreChangeEvents: false,
                ignoreDeleteEvents: false,
            };
            sandbox.stub(vscode.workspace, 'createFileSystemWatcher').returns(mockWatcher as unknown as vscode.FileSystemWatcher);

            sandbox.stub(vscode.workspace, 'getConfiguration').returns({
                get: (_section: string, defaultValue: any) => defaultValue,
                has: () => false,
                inspect: () => undefined,
                update: () => Promise.resolve(),
            } as unknown as vscode.WorkspaceConfiguration);
        });

        afterEach(() => {
            sandbox.restore();
        });

        it('should register onDidCloseRepository subscription in context.subscriptions', () => {
            const mockServiceRegistry = {
                getAnalysisService: () => ({
                    getAnalysis: () => Promise.resolve(undefined),
                    initializeRepository: () => Promise.resolve(),
                    updateAnalysis: () => Promise.resolve(),
                    shouldUpdateAnalysis: () => Promise.resolve(false),
                    syncAnalysisFromMarkdown: () => Promise.resolve(),
                    clearAnalysis: () => Promise.resolve(),
                }),
            } as unknown as ServiceRegistry;

            const mockStatusBarManager = {
                updateStatusBar: () => { },
                setRepoAnalysisRunning: () => { },
            } as unknown as StatusBarManager;

            const em = new EventManager(mockContext, mockServiceRegistry, mockStatusBarManager);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (em as any).setupGitChangeListeners();

            // After setupGitChangeListeners, both onDidOpenRepo and onDidCloseRepo subscriptions
            // should be in context.subscriptions
            assert.strictEqual(
                mockContext.subscriptions.length,
                2,
                'context.subscriptions should contain onDidOpenRepo and onDidCloseRepo'
            );
        });
    });

    // ========================================================================
    // dispose() — integration: close repo, then dispose EventManager
    // ========================================================================
    describe('dispose() after repo lifecycle', () => {
        let sandbox: sinon.SinonSandbox;
        let mockContext: ReturnType<typeof createMockContext>;

        beforeEach(() => {
            sandbox = sinon.createSandbox();
            mockContext = createMockContext();

            const openRepoEvent = createMockEvent<Repository>();
            const closeRepoEvent = createMockEvent<Repository>();

            const mockApi = {
                repositories: [] as Repository[],
                onDidOpenRepository: openRepoEvent.event,
                onDidCloseRepository: closeRepoEvent.event,
            };

            const mockGitExtension = {
                enabled: true,
                onDidChangeEnablement: createMockEvent<boolean>().event,
                getAPI: () => mockApi,
            };

            sandbox.stub(vscode.extensions, 'getExtension').callsFake((id: string) => {
                if (id === 'vscode.git') {
                    return { exports: mockGitExtension, id, extensionPath: '', extensionUri: vscode.Uri.file('/fake'), isActive: true, packageJSON: {}, extensionKind: vscode.ExtensionKind.Workspace, activate: () => Promise.resolve(mockGitExtension) } as unknown as vscode.Extension<any>;
                }
                return undefined;
            });

            const mockWatcher = {
                onDidCreate: () => { },
                onDidChange: () => { },
                onDidDelete: () => { },
                dispose: () => { },
                ignoreCreateEvents: false,
                ignoreChangeEvents: false,
                ignoreDeleteEvents: false,
            };
            sandbox.stub(vscode.workspace, 'createFileSystemWatcher').returns(mockWatcher as unknown as vscode.FileSystemWatcher);

            sandbox.stub(vscode.workspace, 'getConfiguration').returns({
                get: (_section: string, defaultValue: any) => defaultValue,
                has: () => false,
                inspect: () => undefined,
                update: () => Promise.resolve(),
            } as unknown as vscode.WorkspaceConfiguration);
        });

        afterEach(() => {
            sandbox.restore();
        });

        it('should not dispose context.subscriptions on EventManager.dispose() (only repoDisposables)', () => {
            const mockServiceRegistry = {
                getAnalysisService: () => ({
                    getAnalysis: () => Promise.resolve(undefined),
                    initializeRepository: () => Promise.resolve(),
                    updateAnalysis: () => Promise.resolve(),
                    shouldUpdateAnalysis: () => Promise.resolve(false),
                    syncAnalysisFromMarkdown: () => Promise.resolve(),
                    clearAnalysis: () => Promise.resolve(),
                }),
            } as unknown as ServiceRegistry;

            const mockStatusBarManager = {
                updateStatusBar: () => { },
                setRepoAnalysisRunning: () => { },
            } as unknown as StatusBarManager;

            const em = new EventManager(mockContext, mockServiceRegistry, mockStatusBarManager);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (em as any).setupGitChangeListeners();

            const subCountBefore = mockContext.subscriptions.length;
            em.dispose();
            // EventManager.dispose() only cleans repoDisposables and lastHeadByRepo,
            // not context.subscriptions (those are owned by VS Code extension lifecycle)
            assert.strictEqual(mockContext.subscriptions.length, subCountBefore);
        });
    });
});
