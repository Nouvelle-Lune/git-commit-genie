import { strict as assert } from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import sinon = require('sinon');
import { describe, it } from 'mocha';
import { RepositorySnapshotReader, SnapshotIdentity, hashContent } from '../../services/git/repositorySnapshot';
import { LLMExecution, LLMService } from '../../services/llm/llmTypes';
import { AIRunRequest } from '../../services/llm/providers';
import { createConsolidationRunner, MemoryRun, RepositoryMemoryService } from '../../services/memory/service';
import { InvestigationEpisode } from '../../services/memory/types';

describe('repository memory lifecycle', function () {
    this.timeout(20_000);

    it('cancels foreground timers and aborts background work, then schedules after sixty idle seconds', async () => {
        await withTempStorage(async storageRoot => {
            await withMemorySettings({ enabled: false }, async () => {
                const context = makeContext(storageRoot);
                const service = new RepositoryMemoryService(context);
                const clock = sinon.useFakeTimers();
                const model = {} as LLMService;
                try {
                    service.beginForeground();
                    service.schedule('d'.repeat(64), model);
                    assert.equal((service as any).scheduled.get('d'.repeat(64)).timer, undefined);

                    const controller = new AbortController();
                    (service as any).scheduled.set('active', { model, controller });
                    service.beginForeground();
                    assert.equal(controller.signal.aborted, true);

                    service.endForeground();
                    service.endForeground();
                    const scheduled = (service as any).scheduled.get('d'.repeat(64));
                    assert.ok(scheduled?.timer);
                    await clock.tickAsync(59_999);
                    assert.ok((service as any).scheduled.get('d'.repeat(64))?.timer);
                    await clock.tickAsync(1);
                    assert.equal((service as any).scheduled.get('d'.repeat(64))?.timer, undefined);
                } finally {
                    clock.restore();
                    disposeContext(context);
                    service.dispose();
                }
            });
        });
    });

    it('does no memory I/O when disabled and detaches episode persistence from commit delivery', async () => {
        await withTempStorage(async storageRoot => {
            await withMemorySettings({ enabled: false }, async () => {
                const context = makeContext(storageRoot);
                const service = new RepositoryMemoryService(context);
                try {
                    const snapshot = makeSnapshot('e'.repeat(64), storageRoot);
                    assert.equal(await service.prepare(snapshot, 'model', []), undefined);
                    await assert.rejects(() => fs.access(path.join(storageRoot, 'repository-memory')), /ENOENT/);
                } finally {
                    disposeContext(context);
                    service.dispose();
                }
            });

            await withMemorySettings({ enabled: true }, async () => {
                const context = makeContext(storageRoot);
                const service = new RepositoryMemoryService(context);
                const schedule = sinon.stub(service, 'schedule');
                let resolveWrite!: () => void;
                const pendingWrite = new Promise<void>(resolve => { resolveWrite = resolve; });
                const run = {
                    store: { repositoryId: 'f'.repeat(64), recordEpisode: async () => pendingWrite },
                    epoch: 'epoch',
                } as unknown as MemoryRun;
                try {
                    service.publish(run, makeEpisode('f'.repeat(64)), {} as LLMService);
                    assert.equal(schedule.called, false, 'publish returns before durable I/O settles');
                    resolveWrite();
                    await pendingWrite;
                    await new Promise(resolve => setImmediate(resolve));
                    assert.equal(schedule.calledOnce, true);
                } finally {
                    schedule.restore();
                    disposeContext(context);
                    service.dispose();
                }
            });
        });
    });

    it('turns seal failures into warnings and times out memory retrieval at 100 ms', async () => {
        await withTempStorage(async storageRoot => {
            await withMemorySettings({ enabled: true }, async () => {
                const context = makeContext(storageRoot);
                const service = new RepositoryMemoryService(context);
                const warning = sinon.stub(service, 'warn');
                try {
                    const snapshot = makeSnapshot('1'.repeat(64), storageRoot);
                    const run = await service.prepare(snapshot, 'model', []);
                    assert.ok(run);
                    (run!.recorder as any).seal = () => { throw new Error('invalid recorder state'); };
                    assert.equal(run!.seal({ changedPaths: [], changedSymbols: [], questions: [], claims: [], status: 'error' }), undefined);
                    assert.equal(warning.calledOnce, true);

                    (run!.store as any).loadNavigation = () => new Promise<never>(() => undefined);
                    const clock = sinon.useFakeTimers();
                    try {
                        const pending = run!.loadMemory({ paths: [], symbols: [], keywords: [] });
                        await clock.tickAsync(101);
                        assert.equal(await pending, undefined);
                    } finally {
                        clock.restore();
                    }
                    assert.match(String(warning.lastCall?.args[0]), /100 ms/);
                } finally {
                    warning.restore();
                    disposeContext(context);
                    service.dispose();
                }
            });
        });
    });

    it('filters newly excluded paths before returning navigation and never returns their secret source', async () => {
        await withTempStorage(async storageRoot => {
            await withMemorySettings({ enabled: true, excludePatterns: [] }, async () => {
                const context = makeContext(storageRoot);
                const service = new RepositoryMemoryService(context);
                try {
                    const snapshot = makeSnapshot('2'.repeat(64), storageRoot);
                    const run = await service.prepare(snapshot, 'model', []);
                    assert.ok(run);
                    const safe = makeEpisode('2'.repeat(64), 'src/safe.ts');
                    const secret = makeEpisode('2'.repeat(64), 'secrets/token.ts');
                    const view = await run!.store.inspect();
                    (run!.store as any).loadNavigation = async () => ({
                        ...view,
                        episodes: [secret, safe],
                        handbook: [],
                    });
                    const config = vscode.workspace.getConfiguration('gitCommitGenie.memory');
                    await config.update('excludePatterns', ['secrets/**'], vscode.ConfigurationTarget.Global);
                    const retriever = await run!.loadMemory({ paths: ['secrets/token.ts'], symbols: [], keywords: [] });
                    assert.ok(retriever);
                    assert.equal(retriever!.view.episodes.some(episode => episode.changedPaths.includes('secrets/token.ts')), false);
                    assert.deepEqual(retriever!.retrieveNavigation({ paths: ['secrets/token.ts'], symbols: [], keywords: [] }), []);
                } finally {
                    disposeContext(context);
                    service.dispose();
                }
            });
        });
    });

    it('bounds consolidation prompt input, sends transportRetries zero, accounts unknown usage, and rejects incomplete output', async () => {
        const oversized = makeExecution(100);
        const oversizedRunner = createConsolidationRunner(oversized);
        await assert.rejects(
            () => oversizedRunner('x'.repeat(20_000), new AbortController().signal),
            /exceed the reserved input budget/,
        );

        let request: AIRunRequest | undefined;
        let accounted: unknown;
        const execution = makeExecution(16_000, {
            createSession: (() => ({
                run: async (input: AIRunRequest) => {
                    request = input;
                    return {
                        text: '', structured: {}, toolCalls: [], usage: undefined,
                        stopReason: 'max_output_tokens' as const, continuation: { serverManaged: false }, raw: {},
                    };
                },
                provider: 'custom', model: 'memory-test', snapshot: () => ({ provider: 'custom', model: 'memory-test', continuation: { serverManaged: false }, transcript: [] }),
            }) as any),
            accountCall: async usage => { accounted = usage; return { status: 'usage-not-reported' as const }; },
        });
        await assert.rejects(
            () => createConsolidationRunner(execution)('{}', new AbortController().signal),
            /stopped without a complete response: max_output_tokens/,
        );
        assert.equal(request?.transportRetries, 0);
        assert.equal(accounted, undefined, 'unknown provider usage is passed through for explicit accounting');
    });
});

function makeExecution(hardInputTokens: number, overrides: Partial<LLMExecution> = {}): LLMExecution {
    return {
        tokenBudget: { hardInputTokens } as LLMExecution['tokenBudget'],
        createSession: () => ({ run: async () => {
            throw new Error('session should not be called');
        } }) as any,
        accountCall: async () => ({ status: 'usage-not-reported' as const }),
        ...overrides,
    } as LLMExecution;
}

function makeContext(storageRoot: string): vscode.ExtensionContext {
    return {
        subscriptions: [],
        globalStorageUri: vscode.Uri.file(storageRoot),
    } as unknown as vscode.ExtensionContext;
}

function disposeContext(context: vscode.ExtensionContext): void {
    for (const subscription of context.subscriptions) {
        subscription.dispose();
    }
}

async function withMemorySettings<T>(settings: {
    enabled: boolean; excludePatterns?: string[]; consolidationEnabled?: boolean; maxCalls?: number;
}, action: () => Promise<T>): Promise<T> {
    const memory = vscode.workspace.getConfiguration('gitCommitGenie.memory');
    const previous = {
        enabled: memory.get<boolean>('enabled', false),
        excludePatterns: memory.get<string[]>('excludePatterns', []),
        consolidationEnabled: memory.get<boolean>('consolidation.enabled', true),
        maxCalls: memory.get<number>('consolidation.maxCallsPer24h', 2),
    };
    await memory.update('enabled', settings.enabled, vscode.ConfigurationTarget.Global);
    if (settings.excludePatterns !== undefined) {
        await memory.update('excludePatterns', settings.excludePatterns, vscode.ConfigurationTarget.Global);
    }
    if (settings.consolidationEnabled !== undefined) {
        await memory.update('consolidation.enabled', settings.consolidationEnabled, vscode.ConfigurationTarget.Global);
    }
    if (settings.maxCalls !== undefined) {
        await memory.update('consolidation.maxCallsPer24h', settings.maxCalls, vscode.ConfigurationTarget.Global);
    }
    try {
        return await action();
    } finally {
        await memory.update('enabled', previous.enabled, vscode.ConfigurationTarget.Global);
        await memory.update('excludePatterns', previous.excludePatterns, vscode.ConfigurationTarget.Global);
        await memory.update('consolidation.enabled', previous.consolidationEnabled, vscode.ConfigurationTarget.Global);
        await memory.update('consolidation.maxCallsPer24h', previous.maxCalls, vscode.ConfigurationTarget.Global);
    }
}

async function withTempStorage<T>(action: (storageRoot: string) => Promise<T>): Promise<T> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genie-memory-lifecycle-'));
    try {
        return await action(root);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
}

function makeSnapshot(repositoryId: string, root: string): RepositorySnapshotReader {
    return { root, identity: makeIdentity(repositoryId) } as unknown as RepositorySnapshotReader;
}

function makeIdentity(repositoryId: string): SnapshotIdentity {
    return {
        id: 'a'.repeat(64), repositoryId, worktreeId: 'b'.repeat(64), head: 'c'.repeat(40),
        beforeTree: 'd'.repeat(40), afterTree: 'e'.repeat(40), indexFingerprint: 'f'.repeat(64), autoStaged: false,
    };
}

function makeEpisode(repositoryId: string, sourcePath = 'src/safe.ts'): InvestigationEpisode {
    const excerpt = 'const value = 1;';
    const snapshot = makeIdentity(repositoryId);
    return {
        version: 1, id: `00000000-0000-4000-8000-${repositoryId.slice(0, 12)}`, createdAt: Date.now(), snapshot,
        changedPaths: [sourcePath], changedSymbols: ['value'], questions: ['How is this used?'],
        observations: [{ step: 0, tool: 'readFileContent', arguments: { filePath: sourcePath }, ok: true, summary: 'read', durationMs: 1, truncated: false,
            evidence: [{ id: 'E1', source: { snapshotId: snapshot.id, path: sourcePath, side: 'after', blobOid: '1'.repeat(40), startLine: 1, endLine: 1, excerpt, contentHash: hashContent(excerpt), truncated: false, sourceType: 'text' } }] }],
        claims: [{ claim: 'value exists', evidenceRefs: ['E1'], disposition: 'must_express' }], status: 'complete', model: 'model', promptVersion: 'memory-1', toolsetVersion: 'snapshot-1',
    };
}
