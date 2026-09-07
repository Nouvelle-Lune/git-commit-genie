import { strict as assert } from 'assert';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'mocha';
import { hashContent, SnapshotIdentity } from '../../services/git/repositorySnapshot';
import { consolidatePending, ConsolidationRunner, projectConsolidation, validateConsolidation } from '../../services/memory/consolidator';
import { LLMExecution } from '../../services/llm/llmTypes';
import { AIRunRequest } from '../../services/llm/providers';
import { MemoryStore } from '../../services/memory/store';
import { HandbookEntry, InvestigationEpisode } from '../../services/memory/types';
import { MEMORY_DEFAULTS, MemorySettings } from '../../services/memory/settings';

describe('memory consolidation validation', () => {
    it('resolves valid T/F/S ids and rejects unknown or unsupported handles', () => {
        const episode = makeEpisode();
        const valid = makeEntry([episode]);
        const validated = validateConsolidation(valid, [episode]);
        assert.equal(validated.length, 1);
        assert.deepEqual(validated[0].supports, [{ episodeId: episode.id, evidenceId: 'E1' }]);
        assert.deepEqual(validated[0].triggers, ['src/parser.ts', 'parse']);
        assert.deepEqual(validated[0].targetPaths, ['src/parser.ts']);

        assert.throws(
            () => validateConsolidation(makeEntry([episode], { targetPathIds: ['F999'] }), [episode]),
            /invented target path ID: F999/,
        );
        assert.throws(
            () => validateConsolidation(makeEntry([episode], { sourceIds: ['S999'] }), [episode]),
            /invented source ID/,
        );
        assert.throws(
            () => validateConsolidation(makeEntry([episode], { triggerIds: ['T999'] }), [episode]),
            /invented trigger ID: T999/,
        );
    });

    it('rejects proposals that still carry the legacy per-entry questions key', () => {
        const episode = makeEpisode();
        const proposal = makeEntry([episode]);
        // Positive control: the concerns-keyed proposal parses and validates.
        assert.equal(validateConsolidation(proposal, [episode]).length, 1);

        // A model returning the retired per-entry key must fail the strict proposal schema.
        const legacyEntry = { ...proposal.entries[0], questions: proposal.entries[0].concerns };
        assert.throws(
            () => validateConsolidation({ entries: [legacyEntry] }, [episode]),
            (error: unknown) => error instanceof Error
                && /unrecognized_keys/.test(error.message)
                && /Unrecognized key/.test(error.message)
                && error.message.includes('questions'),
        );
    });

    it('rejects catalog handles that are valid globally but unrelated to selected supports', () => {
        const episodes = makeEpisodes(2, index => ({
            sourcePath: `src/${index === 0 ? 'parser' : 'client'}.ts`,
            changedPaths: [`src/${index === 0 ? 'parser' : 'client'}.ts`],
            changedSymbols: [index === 0 ? 'parse' : 'callParse'],
        }));
        const projection = projectConsolidation(episodes);
        const firstTriggerId = idForValue(projection.triggers, episodes[0].changedSymbols[0]);
        const secondTriggerId = idForValue(projection.triggers, episodes[1].changedSymbols[0]);
        const firstTargetPathId = idForValue(projection.targetPaths, episodes[0].observations[0].evidence[0].source.path);
        const secondTargetPathId = idForValue(projection.targetPaths, episodes[1].observations[0].evidence[0].source.path);
        const firstSourceId = [...projection.refs.keys()][0];

        assert.throws(
            () => validateConsolidation(makeEntry(episodes, {
                triggerIds: [secondTriggerId], targetPathIds: [firstTargetPathId], sourceIds: [firstSourceId],
            }), episodes),
            /invented a trigger/,
        );
        assert.throws(
            () => validateConsolidation(makeEntry(episodes, {
                triggerIds: [firstTriggerId], targetPathIds: [secondTargetPathId], sourceIds: [firstSourceId],
            }), episodes),
            /invented a target path/,
        );
    });

    it('requires two independent snapshots for concerns and rejects memory-only support', () => {
        const oneSnapshot = makeEpisodes(1, () => ({ snapshotId: '1'.repeat(64) }));
        assert.throws(
            () => validateConsolidation(makeEntry(oneSnapshot, { concerns: ['A stable parser invariant.'] }), oneSnapshot),
            /Historical concerns require two independently investigated snapshots/,
        );

        const twoSnapshots = makeEpisodes(2, index => ({ snapshotId: `${index + 1}`.repeat(64) }));
        const accepted = validateConsolidation(
            makeEntry(twoSnapshots, { concerns: ['A stable parser invariant.'] }),
            twoSnapshots,
        );
        assert.deepEqual(accepted[0].concerns, ['A stable parser invariant.']);
        assert.equal(new Set(accepted[0].supports.map(item => item.episodeId)).size, 2);

        const memoryOnly = makeEpisodes(2, index => ({
            snapshotId: `${index + 3}`.repeat(64),
            includeMemoryObservation: true,
        }));
        assert.throws(
            () => validateConsolidation(
                makeEntry(memoryOnly, { concerns: ['A stable parser invariant.'], evidenceId: 'E2' }),
                memoryOnly,
            ),
            /Historical concerns require two independently investigated snapshots/,
        );
    });

    it('projects catalogs and short IDs instead of asking the model to copy source values', async () => {
        const episodes = makeEpisodes(2, index => ({
            sourcePath: `src/deidentified-${index}.ts`,
            changedPaths: [`src/deidentified-${index}.ts`],
        }));
        const projection = projectConsolidation(episodes);
        const input = JSON.parse(projection.input) as {
            triggerCatalog: Array<{ id: string; value: string }>;
            targetPathCatalog: Array<{ id: string; value: string }>;
            episodes: Array<Record<string, unknown>>;
        };
        assert.equal(input.triggerCatalog.every(item => /^T\d+$/.test(item.id)), true);
        assert.equal(input.targetPathCatalog.every(item => /^F\d+$/.test(item.id)), true);
        assert.equal(input.episodes.every(episode => 'changedPathTriggerIds' in episode
            && 'changedSymbolTriggerIds' in episode
            && !('changedPaths' in episode)
            && !('changedSymbols' in episode)), true);
        assert.equal(input.episodes.every(episode => Array.isArray(episode.sources)
            && (episode.sources as Array<Record<string, unknown>>).every(source => 'targetPathId' in source && !('path' in source))), true);

        const requests: AIRunRequest[] = [];
        const runner = loadConsolidationRunner()(makeConsolidationExecution(requests), MEMORY_DEFAULTS);
        await runner(projection.input, new AbortController().signal);
        const systemPrompt = String(requests[0].messages?.find(message => message.role === 'system')?.content ?? '');
        assert.match(systemPrompt, /Select only supplied T\* IDs into triggerIds, F\* IDs into targetPathIds, and S\* IDs into sourceIds/);
        assert.doesNotMatch(systemPrompt, /Copy only supplied trigger strings, paths/);
    });

    it('requires three independently investigated snapshots for procedure entries', () => {
        const independent = makeEpisodes(3, index => ({ snapshotId: `${index + 1}`.repeat(64) }));
        const valid = makeEntry(independent, { kind: 'procedure' });
        const validated = validateConsolidation(valid, independent);
        assert.equal(validated[0].kind, 'procedure');
        assert.equal(new Set(validated[0].supports.map(item => item.episodeId)).size, 3);

        const duplicateSnapshot = makeEpisodes(3, () => ({ snapshotId: 'd'.repeat(64) }));
        assert.throws(
            () => validateConsolidation(makeEntry(duplicateSnapshot, { kind: 'procedure' }), duplicateSnapshot),
            /three independently investigated snapshots/,
        );

        const navigationOnlySources = makeEpisodes(3, index => ({
            snapshotId: `${index + 4}`.repeat(64),
            includeMemoryObservation: true,
        }));
        assert.throws(
            () => validateConsolidation(makeEntry(navigationOnlySources, { kind: 'procedure', evidenceId: 'E2' }), navigationOnlySources),
            /three independently investigated snapshots/,
        );
    });

    it('instructs the runner to return one object instance with only top-level entries', async () => {
        const requests: AIRunRequest[] = [];
        const runner = loadConsolidationRunner()(makeConsolidationExecution(requests), MEMORY_DEFAULTS);

        await runner('{"episodes":[]}', new AbortController().signal);

        const systemPrompt = String(requests[0].messages?.find(message => message.role === 'system')?.content ?? '');
        assert.match(systemPrompt, /Return exactly one JSON object matching the response schema\./);
        assert.match(systemPrompt, /The top-level object must contain only entries/);
        assert.match(systemPrompt, /do not return the JSON Schema definition itself/);
        assert.doesNotMatch(systemPrompt, /Return the strict JSON schema\./);
    });

    it('instructs the runner that concerns are cross-change and never task questions', async () => {
        const requests: AIRunRequest[] = [];
        const runner = loadConsolidationRunner()(makeConsolidationExecution(requests), MEMORY_DEFAULTS);

        await runner('{"episodes":[]}', new AbortController().signal);

        const systemPrompt = String(requests[0].messages?.find(message => message.role === 'system')?.content ?? '');
        assert.match(systemPrompt, /Concerns are stable, repository-level behaviors, risks, invariants, or relationships/);
        assert.match(systemPrompt, /Do not copy or paraphrase task-specific investigation questions into concerns/);
        assert.match(systemPrompt, /Concerns must remain useful across different future changes to the same region/);
        assert.match(systemPrompt, /Write "Cancellation may race with delayed result publication\.", not "Does cancellation propagate correctly in this change\?"/);
        assert.match(systemPrompt, /Do not claim complete callers, passing tests, or unchanged dependencies\./);
        assert.doesNotMatch(systemPrompt, /Use questions, not assertions/);
    });
});

describe('consolidatePending', function () {
    this.timeout(20_000);

    it('does not call the runner before five pending episodes share an area', async () => {
        await withTempStorage(async storageRoot => {
            const repositoryId = '1'.repeat(64);
            const store = new MemoryStore(storageRoot, repositoryId);
            await recordAll(store, makeEpisodes(4, () => ({ snapshotId: undefined, repositoryId })));
            let calls = 0;

            const result = await consolidatePending(store, makeRunner(async () => {
                calls += 1;
                return { entries: [] };
            }), new AbortController().signal);

            assert.deepEqual(result, { status: 'not-ready', pendingCount: 4, threshold: 5 });
            assert.equal(calls, 0);
        });
    });

    it('does not call the runner when the paid consolidation budget is exhausted', async () => {
        await withTempStorage(async storageRoot => {
            const repositoryId = '2'.repeat(64);
            const store = new MemoryStore(storageRoot, repositoryId);
            await recordAll(store, makeEpisodes(5, () => ({ snapshotId: undefined, repositoryId })));
            const view = await store.inspect();
            const firstReservation = await store.reserveConsolidation(view, 1);
            assert.equal(firstReservation.status, 'reserved');
            if (firstReservation.status !== 'reserved') { throw new Error('Expected a consolidation reservation.'); }
            await store.releaseJob(firstReservation.id);
            let calls = 0;

            const result = await consolidatePending(store, makeRunner(async () => {
                calls += 1;
                return { entries: [] };
            }), new AbortController().signal, makeSettings({ 'consolidation.maxCallsPer24h': 1 }));

            assert.equal(result.status, 'budget-exhausted');
            if (result.status === 'budget-exhausted') {
                assert.equal(result.limit, 1);
                assert.ok(result.resumesAt > Date.now());
            }
            assert.equal(calls, 0);
        });
    });

    it('rejects non-positive or fractional consolidation call budgets', async () => {
        await withTempStorage(async storageRoot => {
            const store = new MemoryStore(storageRoot, '2'.repeat(64));
            const view = await store.inspect();

            await assert.rejects(
                () => store.reserveConsolidation(view, -1),
                /Invalid consolidation call budget/,
            );
            await assert.rejects(
                () => store.reserveConsolidation(view, 0),
                /Invalid consolidation call budget/,
            );
            await assert.rejects(
                () => store.reserveConsolidation(view, 1.5),
                /Invalid consolidation call budget/,
            );
        });
    });

    it('preserves existing handbook entries and releases the job when the runner fails', async () => {
        await withTempStorage(async storageRoot => {
            const repositoryId = '3'.repeat(64);
            const store = new MemoryStore(storageRoot, repositoryId);
            const existingEpisode = makeEpisode({ repositoryId, sourcePath: 'src/other.ts', changedPaths: ['src/other.ts'] });
            const pending = makeEpisodes(5, index => ({
                snapshotId: `${index + 1}`.repeat(64),
                repositoryId,
                sourcePath: 'src/parser.ts',
                changedPaths: ['src/parser.ts'],
            }));
            await recordAll(store, [existingEpisode, ...pending]);
            const beforePublish = await store.inspect();
            const setupReservation = await store.reserveConsolidation(beforePublish, 2);
            assert.equal(setupReservation.status, 'reserved');
            if (setupReservation.status !== 'reserved') { throw new Error('Expected a consolidation reservation.'); }
            const existingEntry = makeEntry([existingEpisode]);
            const existingValidated = validateConsolidation(existingEntry, [existingEpisode]);
            await store.publishHandbook(beforePublish, setupReservation.id, existingValidated, [existingEpisode.id]);

            let calls = 0;
            await assert.rejects(
                () => consolidatePending(store, makeRunner(async () => {
                    calls += 1;
                    throw new Error('provider unavailable');
                }), new AbortController().signal, makeSettings({ 'consolidation.maxCallsPer24h': 2 })),
                /provider unavailable/,
            );

            const afterFailure = await store.inspect();
            assert.equal(calls, 1);
            assert.deepEqual(afterFailure.handbook, existingValidated);
            assert.equal(afterFailure.episodes.length, 6);
            const manifest = JSON.parse(await fs.readFile(path.join(store.directory, 'current.json'), 'utf8')) as { job: unknown };
            assert.equal(manifest.job, null);

            const retryReservation = await store.reserveConsolidation(afterFailure, 2);
            assert.equal(retryReservation.status, 'budget-exhausted');
        });
    });

    it('rejects publication when clear wins the race while the runner is active', async () => {
        await withTempStorage(async storageRoot => {
            const repositoryId = '4'.repeat(64);
            const store = new MemoryStore(storageRoot, repositoryId);
            const pending = makeEpisodes(5, index => ({ snapshotId: `${index + 1}`.repeat(64), repositoryId }));
            await recordAll(store, pending);

            await assert.rejects(
                () => consolidatePending(store, makeRunner(async () => {
                    await store.clear();
                    return makeEntry(pending);
                }), new AbortController().signal, makeSettings({ 'consolidation.maxCallsPer24h': 2 })),
                /lost its publication lease or source generation/,
            );

            const view = await store.inspect();
            assert.deepEqual(view.episodes, []);
            assert.deepEqual(view.handbook, []);
        });
    });

    it('uses the real runner estimator for a complete default-budget episode batch', async () => {
        await withTempStorage(async storageRoot => {
            const repositoryId = '5'.repeat(64);
            const store = new MemoryStore(storageRoot, repositoryId);
            const episodes = makeEpisodes(5, index => ({
                repositoryId,
                episodeId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
                sourcePath: `src/deidentified-${index}.ts`,
                changedPaths: [`src/deidentified-${index}.ts`],
            }));
            await recordAll(store, episodes);
            const requests: AIRunRequest[] = [];
            const runner = loadConsolidationRunner()(makeConsolidationExecution(requests), MEMORY_DEFAULTS);
            const projection = projectConsolidation(episodes);
            assert.equal(runner.maxInputTokens, MEMORY_DEFAULTS['consolidation.maxInputTokens']);
            assert.ok(runner.estimateInputTokens(projection.input) <= runner.maxInputTokens);

            const result = await consolidatePending(store, runner, new AbortController().signal);

            assert.deepEqual(result, { status: 'published', episodeCount: 5, handbookCount: 5, skippedEpisodes: 0 });
            assert.equal(requests.length, 1);
            const input = JSON.parse(String(requests[0].messages?.find(message => message.role === 'user')?.content)) as {
                triggerCatalog: Array<{ id: string; value: string }>;
                targetPathCatalog: Array<{ id: string; value: string }>;
                episodes: Array<{ id: string; changedPathTriggerIds: string[]; changedSymbolTriggerIds: string[]; questions: string[]; sources: Array<{ id: string; targetPathId: string; excerpt: string }> }>;
            };
            assert.deepEqual(input.episodes.map(episode => episode.id), ['P1', 'P2', 'P3', 'P4', 'P5']);
            assert.equal(input.triggerCatalog.every(item => /^T\d+$/.test(item.id)), true);
            assert.equal(input.targetPathCatalog.every(item => /^F\d+$/.test(item.id)), true);
            assert.equal(input.episodes.every(episode => episode.changedPathTriggerIds.length === 1
                && episode.changedSymbolTriggerIds.length === 1 && episode.questions.length === 1), true);
            assert.equal(input.episodes.every(episode => episode.sources.length === 1
                && episode.sources[0].id.startsWith('S') && /^F\d+$/.test(episode.sources[0].targetPathId)), true);
            const view = await store.inspect();
            assert.equal(view.handbook.length, 5);
            assert.equal(view.consolidated.length, 5);
        });
    });

    it('skips an oversized episode without spending budget or publishing it as consolidated', async () => {
        await withTempStorage(async storageRoot => {
            const repositoryId = '6'.repeat(64);
            const store = new MemoryStore(storageRoot, repositoryId);
            const oversized = makeLargeEpisode({
                repositoryId,
                episodeId: '00000000-0000-4000-8000-000000000006',
                sourcePath: 'src/deidentified-large.ts',
                changedPaths: ['src/deidentified-large.ts'],
            });
            const small = makeEpisodes(4, index => ({
                repositoryId,
                episodeId: `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
                sourcePath: `src/deidentified-small-${index}.ts`,
                changedPaths: [`src/deidentified-small-${index}.ts`],
            }));
            await recordAll(store, [oversized, ...small]);
            const requests: AIRunRequest[] = [];
            const runner = loadConsolidationRunner()(makeConsolidationExecution(requests), MEMORY_DEFAULTS);
            assert.ok(runner.estimateInputTokens(projectConsolidation([oversized]).input) > runner.maxInputTokens);

            const result = await consolidatePending(store, runner, new AbortController().signal);

            assert.deepEqual(result, { status: 'published', episodeCount: 4, handbookCount: 4, skippedEpisodes: 1 });
            assert.equal(requests.length, 1);
            const input = JSON.parse(String(requests[0].messages?.find(message => message.role === 'user')?.content)) as {
                episodes: Array<{ sources: Array<{ excerpt: string }> }>;
            };
            assert.equal(input.episodes.length, 4);
            assert.equal(input.episodes.some(episode => episode.sources.some(source => source.excerpt.length === 12_000)), false);
            const view = await store.inspect();
            assert.equal(view.consolidated.includes(oversized.id), false);
            assert.equal(view.consolidated.length, 4);
        });
    });
});

async function withTempStorage<T>(action: (storageRoot: string) => Promise<T>): Promise<T> {
    const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'genie-consolidator-test-'));
    try {
        return await action(storageRoot);
    } finally {
        await fs.rm(storageRoot, { recursive: true, force: true });
    }
}

async function recordAll(store: MemoryStore, episodes: InvestigationEpisode[]): Promise<void> {
    const epoch = await store.epoch();
    for (const episode of episodes) {
        await store.recordEpisode(episode, epoch);
    }
}

function makeRunner(run: (input: string, signal: AbortSignal) => Promise<unknown>, maxInputTokens = 100_000): ConsolidationRunner {
    return Object.assign(run, {
        maxInputTokens,
        estimateInputTokens: (_input: string) => 0,
    });
}

function makeConsolidationExecution(requests: AIRunRequest[]): LLMExecution {
    const tokenBudget = {
        configuredContextTokens: 128_000,
        effectiveContextTokens: 128_000,
        maxOutputTokens: 32_000,
        estimatedThinkingTokens: 0,
        safetyTokens: 512,
        hardInputTokens: 16_000,
        compressionTriggerTokens: 16_000,
        compressionTargetTokens: 14_400,
        outputAccounting: 'shared' as const,
    };
    return {
        model: 'consolidation-test',
        temperature: 0,
        maxOutputTokens: 4_000,
        maxRetries: 0,
        thinking: { reasoning: false, level: 'off' },
        tokenBudget,
        createSession: () => ({
            provider: 'custom',
            model: 'consolidation-test',
            run: async (request: AIRunRequest) => {
                requests.push(request);
                const content = String(request.messages?.find(message => message.role === 'user')?.content ?? '');
                const projected = JSON.parse(content) as { episodes: Array<{
                    changedPathTriggerIds: string[];
                    changedSymbolTriggerIds: string[];
                    questions: string[];
                    sources: Array<{ id: string; targetPathId: string }>;
                }> };
                return {
                    text: '',
                    toolCalls: [],
                    stopReason: 'completed' as const,
                    continuation: { serverManaged: false },
                    raw: {},
                    structured: {
                        entries: projected.episodes.map(episode => ({
                            triggerIds: [episode.changedPathTriggerIds[0] ?? episode.changedSymbolTriggerIds[0]],
                            targetPathIds: [episode.sources[0].targetPathId],
                            // The fixture emits no cross-episode concerns unless a test
                            // explicitly exercises the independent-snapshot rule.
                            concerns: [],
                            sourceIds: [episode.sources[0].id],
                            kind: 'navigation' as const,
                        })),
                    },
                };
            },
            snapshot: () => ({
                provider: 'custom',
                model: 'consolidation-test',
                continuation: { serverManaged: false },
                transcript: [],
            }),
        } as any),
        run: async () => { throw new Error('not used'); },
        accountCall: async () => ({ status: 'pricing-not-configured' as const }),
        getRecordedQuotes: () => [],
        notifyUsageCostIfEnabled: () => undefined,
    };
}

function loadConsolidationRunner(): typeof import('../../services/memory/service')['createConsolidationRunner'] {
    const moduleLoader = require('module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = (request, parent, isMain) => request === 'vscode' ? {} : originalLoad(request, parent, isMain);
    try {
        return (require('../../services/memory/service') as typeof import('../../services/memory/service')).createConsolidationRunner;
    } finally {
        moduleLoader._load = originalLoad;
    }
}

function makeSettings(overrides: Partial<MemorySettings> = {}): MemorySettings {
    return Object.freeze({ ...MEMORY_DEFAULTS, ...overrides });
}

function makeEpisodes(
    count: number,
    customize: (index: number) => Parameters<typeof makeEpisode>[0] = () => ({}),
): InvestigationEpisode[] {
    return Array.from({ length: count }, (_, index) => makeEpisode(customize(index)));
}

function makeEpisode(options: {
    episodeId?: string;
    snapshotId?: string;
    repositoryId?: string;
    sourcePath?: string;
    changedPaths?: string[];
    changedSymbols?: string[];
    includeMemoryObservation?: boolean;
} = {}): InvestigationEpisode {
    const snapshot = makeSnapshot(options.snapshotId ?? 'a'.repeat(64), options.repositoryId ?? 'a'.repeat(64));
    const sourcePath = options.sourcePath ?? 'src/parser.ts';
    const excerpt = `evidence for ${sourcePath}`;
    const observations: InvestigationEpisode['observations'] = [{
        step: 0,
        tool: 'readFileContent',
        arguments: { filePath: sourcePath, startLine: 1, maxLines: 1 },
        ok: true,
        summary: 'read source',
        evidence: [{ id: 'E1', source: makeSource(snapshot, sourcePath, excerpt) }],
        durationMs: 1,
        truncated: false,
    }];
    if (options.includeMemoryObservation) {
        observations.push({
            step: 1,
            tool: 'readMemorySources',
            arguments: { memoryIds: ['M1'] },
            ok: true,
            summary: 'read historical source',
            evidence: [{ id: 'E2', source: makeSource(snapshot, sourcePath, excerpt) }],
            durationMs: 1,
            truncated: false,
        });
    }
    return {
        version: 1,
        id: options.episodeId ?? randomUUID(),
        createdAt: Date.now(),
        snapshot,
        changedPaths: options.changedPaths ?? [sourcePath],
        changedSymbols: options.changedSymbols ?? ['parse'],
        questions: ['How should this change be investigated?'],
        observations,
        claims: [{ claim: 'Source explains the change.', evidenceRefs: ['E1'], disposition: 'must_express' }],
        status: 'complete',
        model: 'consolidator-test',
        promptVersion: 'memory-1',
        toolsetVersion: 'snapshot-1',
    };
}

function makeLargeEpisode(options: NonNullable<Parameters<typeof makeEpisode>[0]>): InvestigationEpisode {
    const episode = makeEpisode(options);
    const observation = episode.observations[0];
    const excerpt = 'deidentified source content '.repeat(500).slice(0, 12_000);
    return {
        ...episode,
        observations: [{
            ...observation,
            evidence: Array.from({ length: 8 }, (_, index) => ({
                id: `E${index + 1}`,
                source: makeSource(episode.snapshot, options.sourcePath ?? 'src/parser.ts', excerpt),
            })),
        }],
    };
}

function makeSnapshot(snapshotId: string, repositoryId: string): SnapshotIdentity {
    return {
        id: snapshotId,
        repositoryId,
        worktreeId: 'b'.repeat(64),
        head: 'c'.repeat(40),
        beforeTree: 'd'.repeat(40),
        afterTree: 'e'.repeat(40),
        indexFingerprint: 'f'.repeat(64),
        autoStaged: false,
    };
}

function makeSource(snapshot: SnapshotIdentity, sourcePath: string, excerpt: string) {
    return {
        snapshotId: snapshot.id,
        path: sourcePath,
        side: 'after' as const,
        blobOid: '1'.repeat(40),
        startLine: 1,
        endLine: 1,
        excerpt,
        contentHash: hashContent(excerpt),
        truncated: false,
        sourceType: 'text' as const,
    };
}

function makeEntry(
    episodes: InvestigationEpisode[],
    options: {
        kind?: HandbookEntry['kind'];
        targetPathIds?: string[];
        triggerIds?: string[];
        concerns?: string[];
        sourceIds?: string[];
        evidenceId?: string;
    } = {},
): { entries: Array<{
    triggerIds: string[];
    targetPathIds: string[];
    concerns: string[];
    sourceIds: string[];
    kind: HandbookEntry['kind'];
}> } {
    const projection = projectConsolidation(episodes);
    const refs = projection.refs;
    const firstEpisode = episodes[0];
    const firstSourcePath = firstEpisode.observations
        .flatMap(observation => observation.evidence)
        .map(evidence => evidence.source.path)[0];
    const sourceIds = options.sourceIds ?? [...refs.entries()]
        .filter(([, ref]) => ref.evidenceId === (options.evidenceId ?? 'E1'))
        .map(([id]) => id);
    const triggerIds = options.triggerIds ?? [
        idForValue(projection.triggers, firstEpisode.changedPaths[0]),
        idForValue(projection.triggers, firstEpisode.changedSymbols[0]),
    ];
    const targetPathIds = options.targetPathIds ?? [idForValue(projection.targetPaths, firstSourcePath)];
    return { entries: [{
        triggerIds,
        targetPathIds,
        concerns: options.concerns ?? [],
        sourceIds,
        kind: options.kind ?? 'navigation',
    }] };
}

function idForValue(catalog: Map<string, string>, value: string): string {
    const entry = [...catalog.entries()].find(([, candidate]) => candidate === value);
    if (!entry) { throw new Error(`Test catalog does not contain '${value}'.`); }
    return entry[0];
}
