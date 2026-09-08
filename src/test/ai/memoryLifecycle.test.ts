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
import { logger } from '../../services/logger';
import { createConsolidationRunner, MemoryRun, RepositoryMemoryService } from '../../services/memory/service';
import { MemoryStore } from '../../services/memory/store';
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
                    service.storeFor('d'.repeat(64), storageRoot);
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

    it('returns distinct cancellation states and keeps a running slot until the job releases it', async () => {
        await withTempStorage(async storageRoot => {
            await withMemorySettings({ enabled: true }, async () => {
                const context = makeContext(storageRoot);
                const service = new RepositoryMemoryService(context);
                const repositoryId = 'c'.repeat(64);
                const model = makeMemoryModel();
                try {
                    service.storeFor(repositoryId, '/tmp/memory-cancel-repository');
                    assert.equal(service.cancel(repositoryId), 'nothing-to-cancel');

                    const waitingTimer = setTimeout(() => undefined, 60_000);
                    (service as any).scheduled.set(repositoryId, { model, timer: waitingTimer });
                    assert.equal(service.cancel(repositoryId), 'scheduled-cancelled');
                    assert.equal((service as any).scheduled.has(repositoryId), false);

                    const controller = new AbortController();
                    (service as any).scheduled.set(repositoryId, { model, controller });
                    assert.equal(service.cancel(repositoryId), 'running-cancel-requested');
                    assert.equal(controller.signal.aborted, true);
                    assert.equal((service as any).scheduled.has(repositoryId), true);

                    (service as any).scheduled.delete(repositoryId);
                    assert.equal(service.cancel(repositoryId), 'nothing-to-cancel');
                } finally {
                    disposeContext(context);
                    service.dispose();
                }
            });
        });
    });

    it('separates automatic pause from manual consolidation and reports lifecycle outcomes', async () => {
        await withTempStorage(async storageRoot => {
            const repositoryId = 'd'.repeat(64);
            const model = makeMemoryModel();

            await withMemorySettings({ enabled: true, consolidationEnabled: false }, async () => {
                const context = makeContext(storageRoot);
                const service = new RepositoryMemoryService(context);
                try {
                    service.storeFor(repositoryId, '/tmp/memory-status-repository');
                    assert.deepEqual(await service.consolidate(repositoryId, model, 'automatic'), { status: 'automatic-paused' });
                    assert.deepEqual(await service.consolidate(repositoryId, model, 'manual'), {
                        status: 'not-ready', pendingCount: 0, threshold: 2,
                    });
                } finally {
                    disposeContext(context);
                    service.dispose();
                }
            });

            await withMemorySettings({ enabled: false, consolidationEnabled: true }, async () => {
                const context = makeContext(storageRoot);
                const service = new RepositoryMemoryService(context);
                try {
                    service.storeFor(repositoryId, '/tmp/memory-status-repository');
                    assert.deepEqual(await service.consolidate(repositoryId, model, 'manual'), { status: 'memory-disabled' });
                } finally {
                    disposeContext(context);
                    service.dispose();
                }
            });

            await withMemorySettings({ enabled: true, consolidationEnabled: true }, async () => {
                const context = makeContext(storageRoot);
                const service = new RepositoryMemoryService(context);
                try {
                    service.storeFor(repositoryId, '/tmp/memory-status-repository');
                    service.beginForeground();
                    assert.deepEqual(await service.consolidate(repositoryId, model, 'manual'), { status: 'foreground-busy' });
                    service.endForeground();
                    const waiting = (service as any).scheduled.get(repositoryId);
                    if (waiting?.timer) { clearTimeout(waiting.timer); }
                    (service as any).scheduled.delete(repositoryId);

                    const controller = new AbortController();
                    (service as any).scheduled.set(repositoryId, { model, controller });
                    assert.deepEqual(await service.consolidate(repositoryId, model, 'manual'), { status: 'already-running' });
                    controller.abort();
                    (service as any).scheduled.delete(repositoryId);

                    service.dispose();
                    assert.deepEqual(await service.consolidate(repositoryId, model, 'manual'), { status: 'cancelled' });
                } finally {
                    disposeContext(context);
                    service.dispose();
                }
            });
        });
    });

    it('cancels an actual delayed consolidation through public APIs and releases its running slot in finally', async () => {
        await withTempStorage(async storageRoot => {
            await withMemorySettings({ enabled: true, consolidationEnabled: true }, async () => {
                const repositoryId = '8'.repeat(64);
                const context = makeContext(storageRoot);
                const service = new RepositoryMemoryService(context);
                const store = service.storeFor(repositoryId, storageRoot);
                const episodes = makeEligibleEpisodes(repositoryId, 5);
                await recordEpisodes(store, episodes);
                let resolveStarted!: () => void;
                const started = new Promise<void>(resolve => { resolveStarted = resolve; });
                const execution = makeExecution(16_000, {
                    createSession: () => ({
                        provider: 'custom',
                        model: 'memory-test',
                        snapshot: () => ({ provider: 'custom', model: 'memory-test', continuation: { serverManaged: false }, transcript: [] }),
                        run: async (request: AIRunRequest) => {
                            resolveStarted();
                            const signal = request.signal;
                            if (!signal) { throw new Error('Consolidation request did not carry an abort signal.'); }
                            return new Promise<never>((_resolve, reject) => {
                                if (signal.aborted) { reject(signal.reason); return; }
                                signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                            });
                        },
                    }) as any,
                });
                const createExecution = sinon.stub().returns(execution);
                const model = { createExecution } as unknown as LLMService;
                const logToolCall = sinon.stub(logger, 'logToolCall');
                try {
                    const pending = service.consolidate(repositoryId, model, 'manual');
                    await started;
                    assert.equal(service.cancel(repositoryId), 'running-cancel-requested');
                    assert.equal(service.cancel(repositoryId), 'running-cancel-requested',
                        'the running slot remains registered until the consolidation finally block releases it');
                    assert.deepEqual(await pending, { status: 'cancelled' });
                    assert.equal(service.cancel(repositoryId), 'nothing-to-cancel');
                    assert.equal(createExecution.calledOnce, true);
                    assertConsolidationLifecycle(memoryLogEvents(logToolCall), 'cancelled');
                } finally {
                    logToolCall.restore();
                    disposeContext(context);
                    service.dispose();
                }
            });
        });
    });

    it('runs a real manual consolidation while automatic consolidation is paused and logs the published result', async () => {
        await withTempStorage(async storageRoot => {
            await withMemorySettings({ enabled: true, consolidationEnabled: false }, async () => {
                const repositoryId = '9'.repeat(64);
                const context = makeContext(storageRoot);
                const service = new RepositoryMemoryService(context);
                const store = service.storeFor(repositoryId, storageRoot);
                const episodes = makeEligibleEpisodes(repositoryId, 5);
                await recordEpisodes(store, episodes);
                let sessionRuns = 0;
                const execution = makeExecution(16_000, {
                    createSession: () => ({
                        provider: 'custom',
                        model: 'memory-test',
                        snapshot: () => ({ provider: 'custom', model: 'memory-test', continuation: { serverManaged: false }, transcript: [] }),
                        run: async (_request: AIRunRequest) => {
                            sessionRuns += 1;
                            return successfulConsolidationResponse(_request);
                        },
                    }) as any,
                });
                const createExecution = sinon.stub().returns(execution);
                const model = { createExecution } as unknown as LLMService;
                const logToolCall = sinon.stub(logger, 'logToolCall');
                try {
                    assert.deepEqual(await service.consolidate(repositoryId, model, 'automatic'), { status: 'automatic-paused' });
                    assert.equal(createExecution.called, false);

                    assert.deepEqual(await service.consolidate(repositoryId, model, 'manual'), {
                        status: 'published', groupCount: 1, handbookCount: 1, noFindingCount: 0,
                        failedGroupCount: 0, skippedGroups: 0, deferredPaths: [], retryCount: 0,
                        groupOutcomes: [{ path: 'src/safe.ts', status: 'published' }],
                    });
                    assert.equal(createExecution.calledOnce, true);
                    assert.equal(sessionRuns, 1);
                    const view = await store.inspect();
                    assert.equal(view.handbook.length, 1);
                    assert.equal(view.consolidated.length, 1);
                    assert.deepEqual(await service.consolidate(repositoryId, model, 'manual'), {
                        status: 'not-ready', pendingCount: 0, threshold: 2,
                    });
                    assert.equal(sessionRuns, 1, 'ordinary organization does not repeat a completed group');
                    assert.deepEqual(await service.consolidate(repositoryId, model, 'manual-recheck', ['src/safe.ts']), {
                        status: 'published', groupCount: 1, handbookCount: 1, noFindingCount: 0,
                        failedGroupCount: 0, skippedGroups: 0, deferredPaths: [], retryCount: 0,
                        groupOutcomes: [{ path: 'src/safe.ts', status: 'published' }],
                    });
                    assert.equal(sessionRuns, 2, 'manual recheck explicitly reruns the selected path group');
                    const events = memoryLogEvents(logToolCall);
                    assert.ok(events.some(event => event.status === 'automatic-paused'));
                    assertConsolidationLifecycle(events, 'published');
                } finally {
                    logToolCall.restore();
                    disposeContext(context);
                    service.dispose();
                }
            });
        });
    });

    it('returns a real budget-exhausted result without invoking the consolidation runner and logs the reason', async () => {
        await withTempStorage(async storageRoot => {
            await withMemorySettings({ enabled: true, consolidationEnabled: true, maxCalls: 1 }, async () => {
                const repositoryId = 'a'.repeat(64);
                const context = makeContext(storageRoot);
                const service = new RepositoryMemoryService(context);
                const store = service.storeFor(repositoryId, storageRoot);
                await recordEpisodes(store, makeEligibleEpisodes(repositoryId, 5));
                const reserved = await store.reserveConsolidation(await store.inspect(), 1);
                assert.equal(reserved.status, 'reserved');
                if (reserved.status !== 'reserved') { throw new Error('Expected an initial consolidation reservation.'); }
                await store.releaseJob(reserved.id);
                let sessionRuns = 0;
                const execution = makeExecution(16_000, {
                    createSession: () => ({
                        provider: 'custom',
                        model: 'memory-test',
                        snapshot: () => ({ provider: 'custom', model: 'memory-test', continuation: { serverManaged: false }, transcript: [] }),
                        run: async (_request: AIRunRequest) => {
                            sessionRuns += 1;
                            return successfulConsolidationResponse(_request);
                        },
                    }) as any,
                });
                const createExecution = sinon.stub().returns(execution);
                const model = { createExecution } as unknown as LLMService;
                const logToolCall = sinon.stub(logger, 'logToolCall');
                try {
                    const result = await service.consolidate(repositoryId, model, 'manual');
                    assert.equal(result.status, 'budget-exhausted');
                    if (result.status === 'budget-exhausted') {
                        assert.equal(result.limit, 1);
                        assert.ok(result.resumesAt > Date.now());
                    }
                    assert.equal(createExecution.calledOnce, true);
                    assert.equal(sessionRuns, 0);
                    assertConsolidationLifecycle(memoryLogEvents(logToolCall), 'budget-exhausted');
                } finally {
                    logToolCall.restore();
                    disposeContext(context);
                    service.dispose();
                }
            });
        });
    });

    it('rethrows a real model exception after logging a failed Webview memory event and releasing the job', async () => {
        await withTempStorage(async storageRoot => {
            await withMemorySettings({ enabled: true, consolidationEnabled: true }, async () => {
                const repositoryId = 'b'.repeat(64);
                const context = makeContext(storageRoot);
                const service = new RepositoryMemoryService(context);
                const store = service.storeFor(repositoryId, storageRoot);
                await recordEpisodes(store, makeEligibleEpisodes(repositoryId, 5));
                const execution = makeExecution(16_000, {
                    createSession: () => ({
                        provider: 'custom',
                        model: 'memory-test',
                        snapshot: () => ({ provider: 'custom', model: 'memory-test', continuation: { serverManaged: false }, transcript: [] }),
                        run: async (_request: AIRunRequest) => { throw new Error('provider unavailable'); },
                    }) as any,
                });
                const model = { createExecution: sinon.stub().returns(execution) } as unknown as LLMService;
                const logToolCall = sinon.stub(logger, 'logToolCall');
                try {
                    await assert.rejects(
                        () => service.consolidate(repositoryId, model, 'manual'),
                        /provider unavailable/,
                    );
                    assert.equal((await store.inspect()).handbook.length, 0);
                    const events = memoryLogEvents(logToolCall);
                    const failed = events.find(event => event.status === 'failed');
                    assert.ok(failed);
                    assert.equal(failed?.ok, false);
                    assert.match(String(failed?.summary), /provider unavailable/);
                    assertConsolidationLifecycle(events, 'failed');
                    assert.equal(service.cancel(repositoryId), 'nothing-to-cancel');
                } finally {
                    logToolCall.restore();
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

    it('freezes a run budget while applying changed settings to the next preparation', async () => {
        await withTempStorage(async storageRoot => {
            await withMemorySettings({ enabled: true, sourceMaxChunks: 1 }, async () => {
                const context = makeContext(storageRoot);
                const service = new RepositoryMemoryService(context);
                try {
                    const snapshot = makeSnapshot('9'.repeat(64), storageRoot);
                    const first = await service.prepare(snapshot, 'model', []);
                    assert.ok(first);
                    assert.equal(first!.settings['sources.maxChunks'], 1);

                    const config = vscode.workspace.getConfiguration('gitCommitGenie.memory');
                    await config.update('sources.maxChunks', 2, vscode.ConfigurationTarget.Global);
                    const retriever = await first!.loadMemory({ paths: [], symbols: [], keywords: [] });
                    assert.equal(retriever?.settings['sources.maxChunks'], 1);

                    const second = await service.prepare(snapshot, 'model', []);
                    assert.ok(second);
                    assert.equal(second!.settings['sources.maxChunks'], 2);
                } finally {
                    disposeContext(context);
                    service.dispose();
                }
            });
        });
    });

    it('turns seal failures into warnings and times out memory retrieval at 10 seconds', async () => {
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
                        await clock.tickAsync(10_001);
                        assert.equal(await pending, undefined);
                    } finally {
                        clock.restore();
                    }
                    assert.match(String(warning.lastCall?.args[0]), /10000 ms/);
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
        assert.equal(oversizedRunner.maxInputTokens, 100);
        assert.ok(oversizedRunner.estimateInputTokens('{}') > 0);
        await assert.rejects(
            () => oversizedRunner('x'.repeat(20_000), new AbortController().signal,
                () => ({ entries: [], processedGroupIds: [], findingGroupIds: [], noFindingGroupIds: [], issues: [] })),
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
            () => createConsolidationRunner(execution)('{}', new AbortController().signal,
                () => ({ entries: [], processedGroupIds: [], findingGroupIds: [], noFindingGroupIds: [], issues: [] })),
            /stopped without a complete response: max_output_tokens/,
        );
        assert.equal(request?.transportRetries, 0);
        assert.equal('thinking' in (request ?? {}), false);
        assert.equal(accounted, undefined, 'unknown provider usage is passed through for explicit accounting');
    });

    it('logs the complete response diagnostics for an incomplete consolidation attempt before failing', async () => {
        await withTempStorage(async storageRoot => {
            await withMemorySettings({ enabled: true, consolidationEnabled: true }, async () => {
                const repositoryId = 'c'.repeat(64);
                const context = makeContext(storageRoot);
                const service = new RepositoryMemoryService(context);
                const store = service.storeFor(repositoryId, storageRoot);
                await recordEpisodes(store, makeEligibleEpisodes(repositoryId, 5));
                let accounted = 0;
                const response = {
                    text: 'provider stopped before completion',
                    structured: undefined,
                    toolCalls: [],
                    usage: { inputTokens: 3, outputTokens: 2 },
                    stopReason: 'max_output_tokens' as const,
                    continuation: { serverManaged: false },
                    raw: { provider: 'raw-incomplete' },
                };
                const execution = makeExecution(16_000, {
                    createSession: () => ({
                        provider: 'custom',
                        model: 'memory-test',
                        snapshot: () => ({ provider: 'custom', model: 'memory-test', continuation: { serverManaged: false }, transcript: [] }),
                        run: async (_request: AIRunRequest) => response,
                    }) as any,
                    accountCall: async () => {
                        accounted += 1;
                        return { status: 'usage-not-reported' as const };
                    },
                });
                const model = { createExecution: sinon.stub().returns(execution) } as unknown as LLMService;
                const logToolCall = sinon.stub(logger, 'logToolCall');
                try {
                    await assert.rejects(
                        () => service.consolidate(repositoryId, model, 'manual'),
                        /stopped without a complete response: max_output_tokens/,
                    );
                    assert.equal(accounted, 1, 'each successful provider response is accounted exactly once');

                    const attemptCall = logToolCall.getCalls().find(call => {
                        const payload = JSON.parse(String(call.args[1])) as {
                            stage?: string;
                            data?: { tool?: string; status?: string; ok?: boolean };
                        };
                        return payload.stage === 'memoryStep' && payload.data?.tool === 'consolidation-attempt';
                    });
                    assert.ok(attemptCall, 'the attempt callback must be persisted before termination');
                    const payload = JSON.parse(String(attemptCall!.args[1])) as {
                        data?: { status?: string; ok?: boolean };
                    };
                    assert.equal(payload.data?.status, 'response-incomplete');
                    assert.equal(payload.data?.ok, false);
                    const rawData = attemptCall!.args[4] as {
                        output?: { details?: { response?: unknown; issues?: unknown[] } };
                    };
                    assert.deepEqual(rawData.output?.details?.response, response);
                    assert.ok((rawData.output?.details?.issues?.length ?? 0) > 0);
                } finally {
                    logToolCall.restore();
                    disposeContext(context);
                    service.dispose();
                }
            });
        });
    });

    it('reuses execution-bound thinking for consolidation and never puts thinking on the run request', async () => {
        const thinking = { reasoning: true, level: 'high' as const };
        let seenRequest: AIRunRequest | undefined;
        const execution = makeExecution(16_000, {
            thinking,
            createSession: (() => ({
                run: async (input: AIRunRequest) => {
                    seenRequest = input;
                    return {
                        text: '',
                        structured: { entries: [] },
                        toolCalls: [],
                        usage: { inputTokens: 1, outputTokens: 1 },
                        stopReason: 'completed' as const,
                        continuation: { serverManaged: false },
                        raw: {},
                    };
                },
                provider: 'custom',
                model: 'memory-test',
                snapshot: () => ({
                    provider: 'custom',
                    model: 'memory-test',
                    continuation: { serverManaged: false },
                    transcript: [],
                }),
            }) as any),
            accountCall: async () => ({ status: 'usage-not-reported' as const }),
        });

        await createConsolidationRunner(execution)('{}', new AbortController().signal,
            () => ({ entries: [], processedGroupIds: [], findingGroupIds: [], noFindingGroupIds: [], issues: [] }));

        assert.equal(execution.thinking, thinking);
        assert.equal(execution.thinking.level, 'high');
        assert.equal('thinking' in (seenRequest ?? {}), false);
    });
});

function makeExecution(hardInputTokens: number, overrides: Partial<LLMExecution> = {}): LLMExecution {
    return {
        thinking: { reasoning: false, level: 'off' },
        maxOutputTokens: 4_000,
        maxRetries: 0,
        tokenBudget: {
            hardInputTokens,
            effectiveContextTokens: 128_000,
            safetyTokens: 0,
            estimatedThinkingTokens: 0,
        } as LLMExecution['tokenBudget'],
        createSession: () => ({ run: async () => {
            throw new Error('session should not be called');
        } }) as any,
        accountCall: async () => ({ status: 'usage-not-reported' as const }),
        notifyUsageCostIfEnabled: () => undefined,
        ...overrides,
    } as LLMExecution;
}

function makeMemoryModel(): LLMService {
    return {
        createExecution: () => makeExecution(16_000),
    } as unknown as LLMService;
}

async function recordEpisodes(store: MemoryStore, episodes: InvestigationEpisode[]): Promise<void> {
    const epoch = await store.epoch();
    for (const episode of episodes) {
        await store.recordEpisode(episode, epoch);
    }
}

function makeEligibleEpisodes(repositoryId: string, count: number): InvestigationEpisode[] {
    return Array.from({ length: count }, (_, index) => ({
        ...makeEpisode(repositoryId, 'src/safe.ts', `${index + 1}`.repeat(64)),
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        createdAt: Date.now() + index,
    }));
}

function successfulConsolidationResponse(request: AIRunRequest): any {
    const input = JSON.parse(String(request.messages?.find(message => message.role === 'user')?.content ?? '{}')) as {
        groups: Array<{ id: string; sources: Array<{ id: string }> }>;
    };
    return {
        text: '',
        structured: {
            groups: input.groups.map(group => ({
                groupId: group.id,
                outcome: 'findings',
                rationale: 'The repeated sources support a stable concern.',
                concerns: [{
                    text: 'The parser state may be observed before publication.',
                    sourceIds: group.sources.slice(0, 2).map(source => source.id),
                }],
            })),
        },
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'completed',
        continuation: { serverManaged: false },
        raw: {},
    };
}

function memoryLogEvents(logToolCall: sinon.SinonStub): Array<Record<string, unknown>> {
    return logToolCall.getCalls().map(call => {
        assert.equal(call.args[0], 'commitStage');
        const payload = JSON.parse(String(call.args[1])) as { stage?: string; data?: Record<string, unknown> };
        return payload.stage === 'memoryStep' ? payload.data ?? {} : undefined;
    }).filter((event): event is Record<string, unknown> => event !== undefined);
}

function assertConsolidationLifecycle(events: Array<Record<string, unknown>>, terminalStatus: string): void {
    const running = events.find(event => event.tool === 'consolidate' && event.status === 'running');
    const terminal = events.find(event => event.tool === 'consolidate' && event.status === terminalStatus);
    assert.ok(running, `Expected a running consolidation event before ${terminalStatus}.`);
    assert.ok(terminal, `Expected a ${terminalStatus} consolidation event.`);
    assert.equal(typeof running?.operationId, 'string');
    assert.ok(String(running?.operationId ?? '').length > 0);
    assert.equal(terminal?.operationId, running?.operationId);
    assert.equal(typeof terminal?.operationId, 'string');
    assert.ok(String(terminal?.operationId ?? '').length > 0);
    if (terminalStatus === 'published' || terminalStatus === 'budget-exhausted') {
        assert.equal(running?.label, 'Organizing memory');
        assert.equal(running?.summary, 'Organizing memory');
    }
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
    enabled: boolean; excludePatterns?: string[]; consolidationEnabled?: boolean; maxCalls?: number; sourceMaxChunks?: number;
}, action: () => Promise<T>): Promise<T> {
    const memory = vscode.workspace.getConfiguration('gitCommitGenie.memory');
    const previous = {
        enabled: memory.get<boolean>('enabled', false),
        excludePatterns: memory.get<string[]>('excludePatterns', []),
        consolidationEnabled: memory.get<boolean>('consolidation.enabled', true),
        maxCalls: memory.get<number>('consolidation.maxCallsPer24h', 2),
        sourceMaxChunks: memory.get<number>('sources.maxChunks', 16),
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
    if (settings.sourceMaxChunks !== undefined) {
        await memory.update('sources.maxChunks', settings.sourceMaxChunks, vscode.ConfigurationTarget.Global);
    }
    try {
        return await action();
    } finally {
        await memory.update('enabled', previous.enabled, vscode.ConfigurationTarget.Global);
        await memory.update('excludePatterns', previous.excludePatterns, vscode.ConfigurationTarget.Global);
        await memory.update('consolidation.enabled', previous.consolidationEnabled, vscode.ConfigurationTarget.Global);
        await memory.update('consolidation.maxCallsPer24h', previous.maxCalls, vscode.ConfigurationTarget.Global);
        await memory.update('sources.maxChunks', previous.sourceMaxChunks, vscode.ConfigurationTarget.Global);
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

function makeEpisode(repositoryId: string, sourcePath = 'src/safe.ts', snapshotId = 'a'.repeat(64)): InvestigationEpisode {
    const excerpt = 'const value = 1;';
    const snapshot = { ...makeIdentity(repositoryId), id: snapshotId };
    return {
        version: 1, id: `00000000-0000-4000-8000-${repositoryId.slice(0, 12)}`, createdAt: Date.now(), snapshot,
        changedPaths: [sourcePath], changedSymbols: ['value'], questions: ['How is this used?'],
        observations: [{ step: 0, tool: 'readFileContent', arguments: { filePath: sourcePath }, ok: true, summary: 'read', durationMs: 1, truncated: false,
            evidence: [{ id: 'E1', source: { snapshotId: snapshot.id, path: sourcePath, side: 'after', blobOid: '1'.repeat(40), startLine: 1, endLine: 1, excerpt, contentHash: hashContent(excerpt), truncated: false, sourceType: 'text' } }] }],
        claims: [{ claim: 'value exists', evidenceRefs: ['E1'], disposition: 'must_express' }], status: 'complete', model: 'model', promptVersion: 'memory-1', toolsetVersion: 'snapshot-1',
    };
}
