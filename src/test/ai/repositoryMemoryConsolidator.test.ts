import { strict as assert } from 'assert';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'mocha';
import { hashContent, SnapshotIdentity } from '../../services/git/repositorySnapshot';
import { consolidatePending, validateConsolidation } from '../../services/memory/consolidator';
import { MemoryStore } from '../../services/memory/store';
import { HandbookEntry, InvestigationEpisode } from '../../services/memory/types';

describe('memory consolidation validation', () => {
    it('accepts a supported navigation entry and rejects forged target, support, or trigger data', () => {
        const episode = makeEpisode();
        const valid = { entries: [makeEntry([episode])] };
        assert.deepEqual(validateConsolidation(valid, [episode]), valid.entries);

        assert.throws(
            () => validateConsolidation({ entries: [makeEntry([episode], { targetPaths: ['src/other.ts'] })] }, [episode]),
            /invented a target path/,
        );
        assert.throws(
            () => validateConsolidation({ entries: [makeEntry([episode], { supportEpisodeId: randomUUID() })] }, [episode]),
            /invented or used ineligible evidence support/,
        );
        assert.throws(
            () => validateConsolidation({ entries: [makeEntry([episode], { triggers: ['unrelatedTrigger'] })] }, [episode]),
            /invented a trigger/,
        );
    });

    it('requires three independently investigated snapshots for procedure entries', () => {
        const independent = makeEpisodes(3, index => ({ snapshotId: `${index + 1}`.repeat(64) }));
        const valid = makeEntry(independent, { kind: 'procedure' });
        assert.deepEqual(validateConsolidation({ entries: [valid] }, independent), [valid]);

        const duplicateSnapshot = makeEpisodes(3, () => ({ snapshotId: 'd'.repeat(64) }));
        assert.throws(
            () => validateConsolidation({ entries: [makeEntry(duplicateSnapshot, { kind: 'procedure' })] }, duplicateSnapshot),
            /three independently investigated snapshots/,
        );

        const navigationOnlySources = makeEpisodes(3, index => ({
            snapshotId: `${index + 4}`.repeat(64),
            includeMemoryObservation: true,
        }));
        assert.throws(
            () => validateConsolidation({ entries: [makeEntry(navigationOnlySources, { kind: 'procedure', supportEvidenceId: 'E2' })] }, navigationOnlySources),
            /three independently investigated snapshots/,
        );
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

            const result = await consolidatePending(store, async () => {
                calls += 1;
                return { entries: [] };
            }, new AbortController().signal);

            assert.equal(result, 'not-ready');
            assert.equal(calls, 0);
        });
    });

    it('does not call the runner when the paid consolidation budget is exhausted', async () => {
        await withTempStorage(async storageRoot => {
            const repositoryId = '2'.repeat(64);
            const store = new MemoryStore(storageRoot, repositoryId);
            await recordAll(store, makeEpisodes(5, () => ({ snapshotId: undefined, repositoryId })));
            const view = await store.inspect();
            const firstJob = await store.reserveConsolidation(view, 1);
            assert.ok(firstJob);
            await store.releaseJob(firstJob);
            let calls = 0;

            const result = await consolidatePending(store, async () => {
                calls += 1;
                return { entries: [] };
            }, new AbortController().signal, 1);

            assert.equal(result, 'budget-exhausted');
            assert.equal(calls, 0);
        });
    });

    it('rejects consolidation budgets outside the integer range from zero through two', async () => {
        await withTempStorage(async storageRoot => {
            const store = new MemoryStore(storageRoot, '2'.repeat(64));
            const view = await store.inspect();

            await assert.rejects(
                () => store.reserveConsolidation(view, -1),
                /Invalid consolidation call budget/,
            );
            await assert.rejects(
                () => store.reserveConsolidation(view, 3),
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
            const setupJob = await store.reserveConsolidation(beforePublish, 2);
            assert.ok(setupJob);
            const existingEntry = makeEntry([existingEpisode]);
            await store.publishHandbook(beforePublish, setupJob, [existingEntry], [existingEpisode.id]);

            let calls = 0;
            await assert.rejects(
                () => consolidatePending(store, async () => {
                    calls += 1;
                    throw new Error('provider unavailable');
                }, new AbortController().signal, 2),
                /provider unavailable/,
            );

            const afterFailure = await store.inspect();
            assert.equal(calls, 1);
            assert.deepEqual(afterFailure.handbook, [existingEntry]);
            assert.equal(afterFailure.episodes.length, 6);
            const manifest = JSON.parse(await fs.readFile(path.join(store.directory, 'current.json'), 'utf8')) as { job: unknown };
            assert.equal(manifest.job, null);

            const retryJob = await store.reserveConsolidation(afterFailure, 2);
            assert.equal(retryJob, null);
        });
    });

    it('rejects publication when clear wins the race while the runner is active', async () => {
        await withTempStorage(async storageRoot => {
            const repositoryId = '4'.repeat(64);
            const store = new MemoryStore(storageRoot, repositoryId);
            await recordAll(store, makeEpisodes(5, index => ({ snapshotId: `${index + 1}`.repeat(64), repositoryId })));

            await assert.rejects(
                () => consolidatePending(store, async () => {
                    await store.clear();
                    return { entries: [] };
                }, new AbortController().signal, 2),
                /lost its publication lease or source generation/,
            );

            const view = await store.inspect();
            assert.deepEqual(view.episodes, []);
            assert.deepEqual(view.handbook, []);
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
            arguments: { supports: [{ episodeId: 'historical', evidenceId: 'E2' }] },
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
        targetPaths?: string[];
        triggers?: string[];
        supportEpisodeId?: string;
        supportEvidenceId?: string;
    } = {},
): HandbookEntry {
    return {
        id: randomUUID(),
        triggers: options.triggers ?? [episodes[0].changedSymbols[0]],
        targetPaths: options.targetPaths ?? [episodes[0].changedPaths[0]],
        questions: ['How should this change be investigated?'],
        supports: episodes.map(episode => ({
            episodeId: options.supportEpisodeId ?? episode.id,
            evidenceId: options.supportEvidenceId ?? 'E1',
        })),
        kind: options.kind ?? 'navigation',
    };
}
